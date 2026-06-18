/*
 * AssessBank — client-side bug reporter (vanilla, no framework).
 *
 * Captures window errors, unhandled promise rejections, intercepted
 * console.error/warn, and failed fetch() responses (4xx/5xx, skip 401/403),
 * batches them, and POSTs to the app's own /bug-report endpoint. The server
 * forwards to BUG_LRS — the browser never sees any BUG_LRS credentials.
 *
 * Guarantees:
 *   1. Never crashes the app — everything is wrapped in try/catch.
 *   2. Reporter logs are skipped during console interception via the
 *      "[BugReporter]" prefix guard (avoids an infinite loop).
 *   3. Flushes reliably on page hide using navigator.sendBeacon, wired to both
 *      pagehide and visibilitychange→hidden (beforeunload is unreliable on
 *      mobile and loses reports on tab close).
 */
(function () {
  'use strict';

  var ENDPOINT = '/bug-report';
  var LOG_PREFIX = '[BugReporter]';
  var MAX_QUEUE = 20;
  var FLUSH_MS = 3000;
  var DEDUP_TTL_MS = 60 * 1000;

  var queue = [];
  var dedup = {}; // key -> expiry
  var flushTimer = null;

  function now() { return Date.now(); }

  function isDuplicate(key) {
    var exp = dedup[key];
    var t = now();
    if (exp && exp > t) return true;
    dedup[key] = t + DEDUP_TTL_MS;
    return false;
  }

  function enqueue(report) {
    try {
      if (queue.length >= MAX_QUEUE) return; // drop on overflow
      var key = (report.source || '') + ':' + (report.message || '');
      if (isDuplicate(key)) return;
      report.context = report.context || {};
      report.context.userAgent = navigator.userAgent;
      report.context.url = location.href;
      report.context.timestamp = new Date().toISOString();
      report.route = location.pathname;
      queue.push(report);
      scheduleFlush();
    } catch (e) { /* never throw */ }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(false); }, FLUSH_MS);
  }

  function drain() {
    var batch = queue.slice(0, MAX_QUEUE);
    queue = [];
    return batch;
  }

  function flush(useBeacon) {
    try {
      if (!queue.length) return;
      var batch = drain();
      // The endpoint accepts a single report or an array; send the batch.
      var payload = JSON.stringify({ reports: batch });
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
        return;
      }
      var headers = { 'Content-Type': 'application/json' };
      var token = getAuthToken();
      if (token) headers['Authorization'] = 'Bearer ' + token;
      fetch(ENDPOINT, { method: 'POST', headers: headers, body: payload, keepalive: true })
        .catch(function () { /* swallow — reporting must never surface errors */ });
    } catch (e) { /* never throw */ }
  }

  function getAuthToken() {
    // Best-effort; this app has no client token today. Kept for forward-compat.
    try { return window.__AUTH_TOKEN__ || null; } catch (e) { return null; }
  }

  // -- Capture: global errors -------------------------------------------------
  window.addEventListener('error', function (e) {
    var msg = e && e.message ? e.message : 'Unknown error';
    var stack = e && e.error && e.error.stack ? e.error.stack : undefined;
    enqueue({ source: 'client', severity: 'error', message: String(msg), stack: stack });
  });

  // -- Capture: unhandled promise rejections ----------------------------------
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var msg = reason && reason.message ? reason.message : String(reason);
    var stack = reason && reason.stack ? reason.stack : undefined;
    enqueue({ source: 'client', severity: 'error', message: msg, stack: stack,
      context: { kind: 'unhandledrejection' } });
  });

  // -- Capture: console.error / console.warn (with self-loop guard) -----------
  ['error', 'warn'].forEach(function (method) {
    var original = console[method].bind(console);
    var severity = method === 'warn' ? 'warning' : 'error';
    console[method] = function () {
      var args = Array.prototype.slice.call(arguments);
      original.apply(console, args);
      try {
        if (typeof args[0] === 'string' && args[0].indexOf(LOG_PREFIX) === 0) return;
        var message = args.map(function (a) {
          if (a instanceof Error) return a.message;
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        var stack = null;
        for (var i = 0; i < args.length; i++) if (args[i] instanceof Error) { stack = args[i].stack; break; }
        enqueue({ source: 'client', severity: severity, message: message, stack: stack || undefined,
          context: { kind: 'console.' + method } });
      } catch (e) { /* never throw */ }
    };
  });

  // -- Capture: failed fetch responses (4xx/5xx, skip 401/403) ----------------
  if (window.fetch) {
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      return originalFetch(input, init).then(function (res) {
        try {
          if (res && !res.ok && res.status !== 401 && res.status !== 403) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            // Don't report our own telemetry calls.
            if (url.indexOf(ENDPOINT) === -1) {
              enqueue({
                source: 'client',
                severity: res.status >= 500 ? 'error' : 'warning',
                message: 'HTTP ' + res.status + ' from ' + url,
                statusCode: res.status,
                context: { kind: 'fetch', method: (init && init.method) || 'GET' },
              });
            }
          }
        } catch (e) { /* never throw */ }
        return res;
      });
    };
  }

  // -- Flush on page hide (sendBeacon survives navigation) --------------------
  window.addEventListener('pagehide', function () { flush(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
})();
