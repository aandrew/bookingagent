/*
 * v5 sidebar — open/close + accordion behaviour.
 *
 * Loaded as <script src="/public/sidebar.js"> from partials/header.ejs
 * (added in v5). Pure vanilla JS, no deps.
 *
 * State machine:
 *   - Desktop (>= 1024px): sidebar is visible by default. The user can
 *     collapse it to an icons-only strip (toggle is in the top nav as
 *     the hamburger). State persists in localStorage.
 *   - Mobile (< 1024px): sidebar is hidden by default. The hamburger
 *     in the top nav opens it as a full-width overlay. The backdrop
 *     dims the content. Click-outside (backdrop) or Escape closes.
 *   - When the user is on a child page (e.g. /bookings), the parent
 *     accordion auto-expands on render (server-rendered aria-expanded).
 *   - Single accordion open at a time (classic accordion UX).
 *
 * Persisted state keys (localStorage):
 *   - v5.sidebar.collapsed: '1' if icons-only, '0' / missing if full.
 *   - v5.sidebar.closed:    '1' if the sidebar is fully closed. Only
 *     meaningful on mobile (where it persists across navigations).
 *
 * Defensive: every public method is wrapped in try/catch and logged via
 * console.error so a thrown handler can never break the page. Same
 * pattern as live.js.
 */
(function () {
  'use strict';

  var STORAGE_COLLAPSED = 'v5.sidebar.collapsed';
  var STORAGE_CLOSED = 'v5.sidebar.closed';
  var DESKTOP_MIN = 1024;

  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
  }
  function isDesktop() { return window.innerWidth >= DESKTOP_MIN; }

  function setBodyClass(cls, on) {
    document.body.classList[on ? 'add' : 'remove'](cls);
  }

  function readBodyClasses() {
    return {
      open: document.body.classList.contains('has-sidebar-open'),
      closed: document.body.classList.contains('has-sidebar-closed'),
      collapsed: document.body.classList.contains('has-sidebar-collapsed'),
    };
  }

  // --- Public API --------------------------------------------------------

  var api = {
    open: function () {
      setBodyClass('has-sidebar-open', true);
      setBodyClass('has-sidebar-closed', false);
      if (!isDesktop()) safeStorageSet(STORAGE_CLOSED, '0');
      syncHamburgerAria();
    },
    close: function () {
      setBodyClass('has-sidebar-open', false);
      setBodyClass('has-sidebar-closed', true);
      if (!isDesktop()) safeStorageSet(STORAGE_CLOSED, '1');
      syncHamburgerAria();
    },
    toggle: function () {
      var s = readBodyClasses();
      if (isDesktop()) {
        // Desktop: toggle the icons-only state.
        if (s.collapsed) {
          setBodyClass('has-sidebar-collapsed', false);
          safeStorageSet(STORAGE_COLLAPSED, '0');
        } else {
          setBodyClass('has-sidebar-collapsed', true);
          safeStorageSet(STORAGE_COLLAPSED, '1');
        }
      } else {
        // Mobile: toggle the overlay.
        if (s.open) api.close(); else api.open();
      }
      syncHamburgerAria();
    },
    setAccordion: function (name, open) {
      var parent = document.querySelector('[data-sidebar-parent="' + name + '"]');
      var children = document.querySelector('[data-sidebar-children="' + name + '"]');
      if (!parent || !children) return;
      // Single-accordion UX: collapse others when opening one.
      if (open) {
        document.querySelectorAll('.v5-sidebar-item[aria-expanded="true"]').forEach(function (p) {
          if (p !== parent) {
            p.setAttribute('aria-expanded', 'false');
            var c = document.querySelector('[data-sidebar-children="' + p.getAttribute('data-sidebar-parent') + '"]');
            if (c) c.setAttribute('aria-expanded', 'false');
          }
        });
      }
      parent.setAttribute('aria-expanded', open ? 'true' : 'false');
      children.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
    snapshot: function () {
      var s = readBodyClasses();
      return {
        open: s.open,
        closed: s.closed,
        collapsed: s.collapsed,
        viewport: isDesktop() ? 'desktop' : 'mobile',
      };
    },
    // Test hook: reset to a known state.
    _reset: function () {
      setBodyClass('has-sidebar-open', false);
      setBodyClass('has-sidebar-closed', false);
      setBodyClass('has-sidebar-collapsed', false);
    },
  };

  function syncHamburgerAria() {
    var ham = document.querySelector('.v5-hamburger');
    if (!ham) return;
    var s = readBodyClasses();
    if (isDesktop()) {
      ham.setAttribute('aria-expanded', s.collapsed ? 'false' : 'true');
      ham.setAttribute('title', s.collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    } else {
      ham.setAttribute('aria-expanded', s.open ? 'true' : 'false');
      ham.setAttribute('title', s.open ? 'Close menu' : 'Open menu');
    }
  }

  // --- Wiring -----------------------------------------------------------

  function init() {
    // Apply persisted state
    var collapsed = safeStorageGet(STORAGE_COLLAPSED) === '1';

    if (isDesktop()) {
      // Desktop default: sidebar open. The icons-only state is the
      // user's explicit "I want a narrower sidebar" preference; it
      // persists across page loads.
      setBodyClass('has-sidebar-open', true);
      if (collapsed) setBodyClass('has-sidebar-collapsed', true);
    } else {
      // Mobile default: sidebar closed. We don't persist an "I want
      // it open by default on mobile" preference — the user can open
      // it manually each session and it dismisses when they tap the
      // backdrop or Escape. Simpler UX, no surprise reopens.
      setBodyClass('has-sidebar-open', false);
      setBodyClass('has-sidebar-closed', true);
    }
    syncHamburgerAria();

    // Hamburger
    var ham = document.querySelector('.v5-hamburger');
    if (ham) {
      ham.addEventListener('click', function () { api.toggle(); });
    }

    // Accordion parents — items that have the data-sidebar-parent
    // attribute (Bookings, Settings). The whole row is the click
    // target, including the arrow indicator on the right.
    document.querySelectorAll('.v5-sidebar-item[data-sidebar-parent]').forEach(function (parent) {
      parent.addEventListener('click', function (ev) {
        ev.preventDefault();
        var name = parent.getAttribute('data-sidebar-parent');
        var isOpen = parent.getAttribute('aria-expanded') === 'true';
        api.setAccordion(name, !isOpen);
      });
    });

    // Backdrop click — close the sidebar (mobile only; on desktop the
    // backdrop is display:none so this is a no-op).
    var backdrop = document.getElementById('v5-sidebar-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', function () { api.close(); });
    }

    // Escape key — close on mobile
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !isDesktop()) {
        var s = readBodyClasses();
        if (s.open) { api.close(); ev.preventDefault(); }
      }
    });

    // Resize: when crossing the desktop/mobile boundary, reset to
    // the canonical default (desktop=open, mobile=closed). The user's
    // explicit localStorage choice for collapse/expand is preserved
    // across the boundary.
    var lastDesktop = isDesktop();
    window.addEventListener('resize', function () {
      var nowDesktop = isDesktop();
      if (nowDesktop !== lastDesktop) {
        lastDesktop = nowDesktop;
        if (nowDesktop) {
          setBodyClass('has-sidebar-open', true);
          setBodyClass('has-sidebar-closed', false);
        } else {
          // On mobile, only keep the sidebar open if the user had it
          // open before (otherwise close on viewport change).
          if (safeStorageGet(STORAGE_CLOSED) !== '1') {
            setBodyClass('has-sidebar-open', true);
          } else {
            setBodyClass('has-sidebar-open', false);
            setBodyClass('has-sidebar-closed', true);
          }
        }
        syncHamburgerAria();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for the test suite (test/smoke.test.js runs the file in a
  // vm sandbox and asserts on the API surface).
  window.KoorooSidebar = api;
})();
