'use strict';

const bus = require('../agent/bus');
const log = require('../logger');

// v4: Server-Sent Events endpoint. Each connected client subscribes to
// the bus and gets events as `event: <name>\ndata: <json>\n\n` frames.
// The connection stays open for the lifetime of the page; the browser
// auto-reconnects on disconnect, and the next request picks up fresh
// state (so we don't need to buffer missed events on the server).
//
// Smart heartbeat: interval scales between 2s (imminent fire or in-flight
// fire) and 30s (no fire within 5 min). See scheduler.heartbeatIntervalMs.
// Re-evaluated on every heartbeat so the cadence adapts as the next fire
// approaches and recedes.
//
// Defensive: every write to the response is wrapped in a try/catch. A
// failed write marks the subscriber dead and the bus cleans it up. The
// heartbeat timer is cleared on close. req.on('close') and res.on('close')
// both unsubscribe (the underlying socket might be half-closed).
//
// The endpoint requires admin auth (cookie-based, since EventSource
// can't set custom headers in the browser).

const HEARTBEAT_MIN_MS = 2_000;

function sseHandler(req, res) {
  // 1. Auth — reuse the existing requireAdmin middleware
  // (caller wraps us in it). At this point we know the user is an admin.
  // 2. SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tell nginx (Caddy) not to buffer — events should flush immediately.
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable Nagle's algorithm on the underlying socket so small writes
  // (heartbeats) flush promptly.
  if (req.socket && typeof req.socket.setNoDelay === 'function') {
    req.socket.setNoDelay(true);
  }
  res.statusCode = 200;
  // Flush the headers immediately so the client knows the connection
  // is established (EventSource fires 'open' on first byte).
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 3. Subscriber
  const sub = {
    dead: false,
    buffer: [],
    droppedEvents: 0,
    write(eventName, data) {
      if (res.writableEnded || res.destroyed) {
        throw new Error('response closed');
      }
      // SSE frame: event: <name>\ndata: <data>\n\n
      res.write(`event: ${eventName}\ndata: ${data}\n\n`);
    },
    close() {
      try { res.end(); } catch {}
    },
  };
  const unsubscribe = bus.subscribe(sub);
  log.info('sse.connect', { user: req.session?.user?.username });

  // 4. Heartbeat loop. Each tick: write a comment, re-evaluate the
  // interval, and reschedule. The comment (a line starting with ':') is
  // ignored by EventSource but keeps the connection alive through
  // proxies and helps detect half-closed sockets.
  let heartbeatTimer = null;
  let closed = false;
  function scheduleHeartbeat() {
    if (closed) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    let interval;
    try {
      interval = Math.max(HEARTBEAT_MIN_MS, require('./scheduler').heartbeatIntervalMs());
    } catch (e) {
      interval = 30_000;
    }
    heartbeatTimer = setTimeout(() => {
      if (closed) return;
      try {
        if (!res.writableEnded && !res.destroyed) {
          // SSE comment line = heartbeat. Browsers ignore it.
          res.write(`: heartbeat ${Date.now()}\n\n`);
        }
      } catch (e) {
        sub.dead = true;
        cleanup('write-failed');
        return;
      }
      scheduleHeartbeat();
    }, interval);
  }
  function cleanup(reason) {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    unsubscribe();
    try { res.end(); } catch {}
    log.info('sse.disconnect', { user: req.session?.user?.username, reason: reason || 'client-closed' });
  }
  req.on('close', () => cleanup('req-close'));
  res.on('close', () => cleanup('res-close'));
  // Also catch socket errors (write to a closed socket throws EPIPE)
  res.on('error', (e) => cleanup('res-error:' + e.code));
  req.on('error', (e) => cleanup('req-error:' + e.code));

  // Kick off
  scheduleHeartbeat();
}

module.exports = sseHandler;
