// v4: live push client (browser-side EventSource wrapper).
//
// Loaded as a plain <script> from partials/footer.ejs. Exposes a global
// `KoorooLive` object the rest of the page can register handlers on:
//
//   KoorooLive.on('booking_created', (b) => { ... });
//
// Defensive guarantees:
//   - Every handler is invoked inside a try/catch. A thrown handler
//     NEVER breaks the page or the connection.
//   - The EventSource itself is wrapped — if addEventListener throws
//     (which it can if the browser is in a bad state), we log and
//     fall back to "no live updates" without breaking the page.
//   - Malformed event JSON is logged and ignored.
//   - The page renders its initial state from server-rendered EJS
//     (so it works with no JS at all). Events UPDATE in place —
//     they never replace the whole view, never wipe a form the
//     user is filling out, never lose state.
//   - The connection auto-reconnects with exponential backoff. The
//     page keeps working (just static) if the connection is down.

(function () {
  'use strict';

  // -- state ---------------------------------------------------------------

  var state = {
    connected: false,         // EventSource is open
    reconnectAttempt: 0,      // how many times we've tried to reconnect
    lastEventTime: 0,         // ms timestamp of the last received event
    lastError: null,          // last error message (if any)
    suppressConnect: false,   // disable the live connection (test hook)
  };

  var handlers = Object.create(null); // { eventName: [fn, ...] }
  var es = null;                       // the EventSource instance
  var listeners = [];                  // { eventName, fn, opts } for cleanup

  // Exponential backoff: 2s, 4s, 8s, 16s, 30s cap.
  function nextBackoff(attempt) {
    var ms = Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempt - 1)));
    return ms;
  }

  // -- handler API ---------------------------------------------------------

  function on(type, fn) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(fn);
    return function off() {
      var arr = handlers[type] || [];
      var i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  function off(type, fn) {
    var arr = handlers[type] || [];
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  function fire(type, data) {
    var arr = handlers[type];
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](data); } catch (e) { safeLog('handler error', type, e); }
    }
  }

  // -- connection ----------------------------------------------------------

  function connect() {
    if (state.suppressConnect) return;
    if (es) try { es.close(); } catch (e) {}
    es = null;
    try {
      es = new EventSource('/api/events', { withCredentials: true });
    } catch (e) {
      safeLog('EventSource construction failed', e);
      scheduleReconnect();
      return;
    }
    // EventSource's auto-reconnect handles reconnection itself, but
    // we want to control the backoff. So override the default by
    // listening for error and closing + reopening manually.
    var knownEventTypes = [
      'account_updated', 'fire_event_created',
      'booking_created', 'booking_updated',
      'recurring_created', 'recurring_updated',
      'error_appeared', 'error_dismissed',
      'scheduler_status',
    ];
    es.addEventListener('open', function () {
      state.connected = true;
      state.reconnectAttempt = 0;
      state.lastError = null;
      fire('_live_status', snapshot());
    });
    es.addEventListener('error', function () {
      state.connected = false;
      state.reconnectAttempt++;
      // EventSource's readyState is either CLOSED (1) or CONNECTING (0)
      // on error. If CLOSED, we need to manually reconnect.
      if (es && es.readyState === EventSource.CLOSED) {
        safeLog('SSE closed by server; reconnecting', es.readyState);
        scheduleReconnect();
      } else {
        // CONNECTING — EventSource will auto-reconnect. Just notify UI.
        fire('_live_status', snapshot());
      }
    });
    for (var i = 0; i < knownEventTypes.length; i++) {
      (function (type) {
        var fn = function (ev) {
          try {
            var data = JSON.parse(ev.data);
            state.lastEventTime = Date.now();
            fire(type, data);
            fire('_live_status', snapshot());
          } catch (e) {
            safeLog('event parse error', type, e);
          }
        };
        try { es.addEventListener(type, fn); } catch (e) { safeLog('addEventListener failed', type, e); }
        listeners.push({ eventName: type, fn: fn });
      })(knownEventTypes[i]);
    }
  }

  function scheduleReconnect() {
    if (state.suppressConnect) return;
    var delay = nextBackoff(state.reconnectAttempt);
    state.connected = false;
    fire('_live_status', snapshot());
    setTimeout(function () {
      if (state.suppressConnect) return;
      connect();
    }, delay);
  }

  function disconnect() {
    state.suppressConnect = true;
    state.connected = false;
    if (es) { try { es.close(); } catch (e) {} es = null; }
  }

  function reconnect() {
    state.suppressConnect = false;
    state.reconnectAttempt = 0;
    connect();
  }

  // -- snapshot for the UI ------------------------------------------------

  function snapshot() {
    return {
      connected: state.connected,
      reconnectAttempt: state.reconnectAttempt,
      lastEventTime: state.lastEventTime,
      lastError: state.lastError,
      stale: state.lastEventTime > 0 && (Date.now() - state.lastEventTime) > 60000,
    };
  }

  function safeLog(label, type, err) {
    // Don't crash the page; use console.error (visible in devtools).
    try {
      if (err && err.stack) console.error('[KoorooLive]', label, type, err.message, err.stack);
      else console.error('[KoorooLive]', label, type, err);
    } catch (e) { /* nothing we can do */ }
  }

  // -- expose --------------------------------------------------------------

  window.KoorooLive = {
    on: on,
    off: off,
    connect: connect,
    disconnect: disconnect,
    reconnect: reconnect,
    snapshot: snapshot,
    // Test hooks
    _reset: function () { state.suppressConnect = false; state.connected = false; state.reconnectAttempt = 0; state.lastEventTime = 0; state.lastError = null; handlers = Object.create(null); if (es) { try { es.close(); } catch (e) {} es = null; } },
  };

  // Auto-connect unless the page explicitly opted out (e.g. for the
  // print view, error page, or login).
  if (document.body && document.body.dataset.liveUpdates !== 'off') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', connect);
    } else {
      connect();
    }
  }
})();
