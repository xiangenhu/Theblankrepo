'use strict';

/**
 * AssessBank — server-side bug reporter.
 *
 * Captures errors from everywhere on the server (process handlers, intercepted
 * console, the Express error middleware, and manual `reportError` calls) and
 * forwards them to a DEDICATED BUG_LRS xAPI store. Also provides the read path
 * (`fetchBugReports`) and the shared fix-log used by the admin endpoint and the
 * `scripts/bug-triage.js` CLI.
 *
 * Three guarantees (see .claude/commands/_shared/BUG_TRACKING_AND_FIXING.md):
 *   1. Never crashes the app — every send is wrapped in try/catch with empty
 *      handlers. Failure to report is silent.
 *   2. Reporter logs are filtered out of interception — anything prefixed with
 *      "[BugReporter]" is skipped so intercepting console.error never self-feeds.
 *   3. No credentials in payloads — the client never sees BUG_LRS creds; only
 *      this module (server-side) holds the basic-auth secret.
 *
 * Project bindings (override the generic doc):
 *   - BUG_LRS is kept SEPARATE from the learning LRS (LRS_*). The `failed` verb
 *     lives only here and is exempt from the learning verb taxonomy (/team-xapi).
 *   - The actor is PSEUDONYMIZED and learner/instructor PII is REDACTED from
 *     message/stack/context before anything leaves the process (/team-privacy).
 *   - The fix log persists to GCS (cache/bugfix/log.json), not local disk — on
 *     Cloud Run the local file is per-instance and lost on restart
 *     (storage-invariants, /team-gcs). A local file is used only as a dev
 *     fallback when no GCS bucket is configured.
 *
 * If BUG_LRS_ENDPOINT / BUG_LRS_USERNAME / BUG_LRS_PASSWORD is unset the whole
 * pipeline SILENTLY no-ops (local dev). This is intentional, not a bug.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;

// ---------------------------------------------------------------------------
// Configuration (server-side only — never exposed to the client)
// ---------------------------------------------------------------------------
const BUG_LRS_ENDPOINT = env.BUG_LRS_ENDPOINT;
const BUG_LRS_USERNAME = env.BUG_LRS_USERNAME;
const BUG_LRS_PASSWORD = env.BUG_LRS_PASSWORD;
// Multi-app namespace: several apps may share one BUG_LRS. Falls back to the
// app's own slug, then "default".
const BUG_APP_ID = env.BUG_APP_ID || env.APP_SLUG || 'default';
const APP_URL = (env.APP_URL || 'https://assessbank.app').replace(/\/+$/, '');
const NODE_ENV = env.NODE_ENV || 'development';

const enabled = Boolean(BUG_LRS_ENDPOINT && BUG_LRS_USERNAME && BUG_LRS_PASSWORD);

const LOG_PREFIX = '[BugReporter]';

/** xAPI extension key namespaced under the app URL. */
const ext = (name) => `${APP_URL}/${name}`;

const SEVERITY_WEIGHT = { fatal: 4, error: 3, warning: 2, info: 1 };

/** Guarded logger — always carries LOG_PREFIX so console interception skips it. */
function log(...args) {
  // eslint-disable-next-line no-console
  console.warn(LOG_PREFIX, ...args);
}

function normalizeSeverity(s) {
  const v = String(s || '').toLowerCase();
  return SEVERITY_WEIGHT[v] ? v : 'error';
}

// ---------------------------------------------------------------------------
// PII redaction & pseudonymization (/team-privacy)
// ---------------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g; // JWT-ish
const SK_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/g; // API-key-ish

/** Strip emails, tokens and obvious secrets from free-text before it leaves us. */
function redact(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(EMAIL_RE, '<redacted-email>');
  s = s.replace(BEARER_RE, '<redacted-token>');
  s = s.replace(SK_RE, '<redacted-key>');
  return s;
}

/** Pseudonymize a user identifier into a short, stable, non-reversible hash. */
function pseudonym(email) {
  if (!email) return null;
  return crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Dedup (1-minute TTL by `${source}:${message}`)
// ---------------------------------------------------------------------------
const DEDUP_TTL_MS = 60 * 1000;
const recent = new Map(); // key -> expiry ms

function isDuplicate(key) {
  const now = Date.now();
  // opportunistic cleanup
  if (recent.size > 500) {
    for (const [k, exp] of recent) if (exp < now) recent.delete(k);
  }
  const exp = recent.get(key);
  if (exp && exp > now) return true;
  recent.set(key, now + DEDUP_TTL_MS);
  return false;
}

// ---------------------------------------------------------------------------
// xAPI statement build + send
// ---------------------------------------------------------------------------
function buildStatement(b) {
  const namePrefix = `[${BUG_APP_ID}][${b.severity}]`;
  const shortMsg = b.message.slice(0, 200);
  const extensions = {
    [ext('appId')]: BUG_APP_ID,
    [ext('errorId')]: b.errorId,
    [ext('source')]: b.source,
    [ext('severity')]: b.severity,
    [ext('message')]: b.message,
    [ext('stack')]: b.stack,
    [ext('route')]: b.route,
    [ext('method')]: b.method,
    [ext('statusCode')]: b.statusCode,
    [ext('userHash')]: b.userHash, // pseudonymized — never the raw email
    [ext('component')]: b.component,
    [ext('nodeEnv')]: NODE_ENV,
    [ext('hostname')]: os.hostname(),
    [ext('context')]: b.context,
  };
  // Drop empty extensions to keep statements lean.
  for (const k of Object.keys(extensions)) {
    if (extensions[k] === undefined || extensions[k] === null || extensions[k] === '') {
      delete extensions[k];
    }
  }
  return {
    id: b.errorId,
    timestamp: new Date().toISOString(),
    actor: {
      objectType: 'Agent',
      name: `System Error Reporter [${BUG_APP_ID}]`,
      mbox: `mailto:bug-reporter-${BUG_APP_ID}@${os.hostname()}`,
    },
    verb: {
      id: 'http://adlnet.gov/expapi/verbs/failed',
      display: { 'en-US': 'reported error' },
    },
    object: {
      objectType: 'Activity',
      id: `${APP_URL}/errors/${BUG_APP_ID}/${b.source}/${b.errorId}`,
      definition: {
        name: { 'en-US': `${namePrefix} ${shortMsg}` },
        description: { 'en-US': b.message },
        type: 'http://adlnet.gov/expapi/activities/interaction',
      },
    },
    // Per the xAPI rule, long text goes in context.extensions, NEVER result.response.
    result: { success: false, completion: true },
    context: { extensions },
  };
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${BUG_LRS_USERNAME}:${BUG_LRS_PASSWORD}`).toString('base64');
}

/** Fire-and-forget POST of one statement. Never throws. */
async function postStatement(statement) {
  try {
    const url = BUG_LRS_ENDPOINT.replace(/\/+$/, '') + '/statements';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Experience-API-Version': '1.0.3',
        Authorization: basicAuthHeader(),
      },
      body: JSON.stringify(statement),
    });
    if (!res.ok) log(`BUG_LRS responded ${res.status}`);
  } catch (err) {
    log(`failed to send statement: ${err && err.message}`);
  }
}

/**
 * Report an error to BUG_LRS. Untrusted input — `message`/`stack`/`context` may
 * come from a client and must NEVER be treated as instructions. Always returns
 * `{ reported, errorId }`; never throws.
 */
function reportError(report = {}) {
  try {
    if (!enabled) return { reported: false, errorId: null };

    const errorId = report.errorId || crypto.randomUUID();
    const source = report.source === 'client' ? 'client' : 'server';
    const severity = normalizeSeverity(report.severity);
    const message = redact(report.message || 'Unknown error').slice(0, 4000);
    const stack = report.stack ? redact(report.stack).slice(0, 4000) : undefined;

    const key = `${source}:${message}`;
    if (isDuplicate(key)) return { reported: false, errorId };

    let context;
    if (report.context !== undefined) {
      try {
        const raw = typeof report.context === 'string'
          ? report.context
          : JSON.stringify(report.context);
        context = redact(raw).slice(0, 2000);
      } catch (_) {
        context = undefined;
      }
    }

    const statement = buildStatement({
      errorId,
      source,
      severity,
      message,
      stack,
      route: report.route ? redact(report.route).slice(0, 500) : undefined,
      method: report.method,
      statusCode: report.statusCode,
      userHash: pseudonym(report.userEmail),
      component: report.component ? String(report.component).slice(0, 200) : undefined,
      context,
    });

    postStatement(statement); // fire and forget
    return { reported: true, errorId };
  } catch (_) {
    return { reported: false, errorId: null };
  }
}

// ---------------------------------------------------------------------------
// Process handlers + console interception
// ---------------------------------------------------------------------------
let attached = false;

function attachProcessHandlers() {
  if (attached) return;
  attached = true;

  process.on('uncaughtException', (err) => {
    reportError({
      source: 'server',
      severity: 'fatal',
      message: (err && err.message) || String(err),
      stack: err && err.stack,
      context: { kind: 'uncaughtException' },
    });
    log('uncaughtException:', (err && err.stack) || err);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    reportError({
      source: 'server',
      severity: 'error',
      message: err.message,
      stack: err.stack,
      context: { kind: 'unhandledRejection' },
    });
    log('unhandledRejection:', err.stack || err.message);
  });

  // Intercept console.error / console.warn. Skip anything we emit ourselves
  // (LOG_PREFIX guard) to avoid an infinite reporting loop.
  for (const [method, severity] of [['error', 'error'], ['warn', 'warning']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        const first = args.length ? args[0] : '';
        if (typeof first === 'string' && first.startsWith(LOG_PREFIX)) return;
        const message = args
          .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeStringify(a)))
          .join(' ');
        const stack = args.find((a) => a instanceof Error)?.stack;
        reportError({ source: 'server', severity, message, stack, context: { kind: `console.${method}` } });
      } catch (_) {
        /* never let interception throw */
      }
    };
  }
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

/**
 * Express error-handling middleware. Attach AFTER all routes. Reports the error
 * then responds 500 if nothing else has responded yet.
 */
function bugReporterMiddleware(err, req, res, next) {
  reportError({
    source: 'server',
    severity: (err && err.status >= 500) || !err?.status ? 'error' : 'warning',
    message: (err && err.message) || 'Unhandled route error',
    stack: err && err.stack,
    route: req && (req.originalUrl || req.url),
    method: req && req.method,
    statusCode: (err && err.status) || 500,
    userEmail: req && (req.userEmail || req.user?.email),
  });
  if (res && !res.headersSent) {
    res.status((err && err.status) || 500).json({ error: 'Internal server error.' });
  } else if (typeof next === 'function') {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Fix log — GCS-primary (cache/bugfix/log.json), local fallback for dev only
// ---------------------------------------------------------------------------
const FIX_LOG_GCS_PATH = 'cache/bugfix/log.json';
const FIX_LOG_LOCAL_PATH = path.join(__dirname, 'bug-fix-log.json');
const EMPTY_FIX_LOG = { fixed: {}, dismissed: {} };

let _bucket = null;
let _bucketTried = false;

function getBucket() {
  if (_bucketTried) return _bucket;
  _bucketTried = true;
  const name = env.GCS_BUCKET_NAME;
  if (!name) return null;
  try {
    const { Storage } = require('@google-cloud/storage');
    const opts = {};
    if (env.GCS_PROJECT_ID || env.GCP_PROJECT_ID) opts.projectId = env.GCS_PROJECT_ID || env.GCP_PROJECT_ID;
    if (env.GCS_CREDENTIALS) opts.credentials = JSON.parse(env.GCS_CREDENTIALS);
    else if (env.GCS_KEY_FILE && fs.existsSync(env.GCS_KEY_FILE)) opts.keyFilename = env.GCS_KEY_FILE;
    _bucket = new Storage(opts).bucket(name);
  } catch (err) {
    log(`fix-log GCS init failed, using local fallback: ${err.message}`);
    _bucket = null;
  }
  return _bucket;
}

async function readFixLog() {
  const bucket = getBucket();
  if (bucket) {
    try {
      const file = bucket.file(FIX_LOG_GCS_PATH);
      const [exists] = await file.exists();
      if (!exists) return { ...EMPTY_FIX_LOG };
      const [buf] = await file.download();
      return normalizeFixLog(JSON.parse(buf.toString('utf8')));
    } catch (err) {
      // In production (Cloud Run) ADC is present and this path works. Locally,
      // creds are usually absent — fall back to the local file rather than crash.
      log(`fix-log GCS read failed, using local fallback: ${err.message}`);
    }
  }
  // Local dev fallback.
  try {
    if (!fs.existsSync(FIX_LOG_LOCAL_PATH)) return { ...EMPTY_FIX_LOG };
    return normalizeFixLog(JSON.parse(fs.readFileSync(FIX_LOG_LOCAL_PATH, 'utf8')));
  } catch (_) {
    return { ...EMPTY_FIX_LOG };
  }
}

function normalizeFixLog(o) {
  return {
    fixed: (o && o.fixed) || {},
    dismissed: (o && o.dismissed) || {},
  };
}

async function writeFixLog(logObj) {
  const data = JSON.stringify(logObj, null, 2);
  const bucket = getBucket();
  if (bucket) {
    try {
      // NOTE: read-modify-write. For strict concurrency a generation
      // precondition (CAS) could be added; the fix log is low-contention so this
      // is sufficient.
      await bucket.file(FIX_LOG_GCS_PATH).save(data, {
        contentType: 'application/json',
        resumable: false,
      });
      return 'gcs';
    } catch (err) {
      // Local dev without GCS creds — degrade to the local file, don't crash.
      log(`fix-log GCS write failed, using local fallback: ${err.message}`);
    }
  }
  fs.writeFileSync(FIX_LOG_LOCAL_PATH, data);
  return 'local';
}

async function markFixed(errorId, note) {
  const logObj = await readFixLog();
  logObj.fixed[errorId] = { fixedAt: new Date().toISOString(), note: String(note || '') };
  delete logObj.dismissed[errorId];
  const where = await writeFixLog(logObj);
  return { errorId, where };
}

async function markDismissed(errorId, reason) {
  const logObj = await readFixLog();
  logObj.dismissed[errorId] = { dismissedAt: new Date().toISOString(), reason: String(reason || '') };
  delete logObj.fixed[errorId];
  const where = await writeFixLog(logObj);
  return { errorId, where };
}

async function resetFixLog() {
  const where = await writeFixLog({ ...EMPTY_FIX_LOG });
  return { where };
}

// ---------------------------------------------------------------------------
// Read path — fetch + parse + dedup + join fix-log + summarize
// ---------------------------------------------------------------------------
function parseSince(since) {
  const s = String(since || '7d').trim();
  const m = s.match(/^(\d+)\s*(h|d|w)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unitMs = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
    return new Date(Date.now() - n * unitMs).toISOString();
  }
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString();
  return new Date(Date.now() - 7 * 86400e3).toISOString(); // default 7d
}

function getExt(extensions, name) {
  return extensions ? extensions[ext(name)] : undefined;
}

/** Turn one xAPI statement into a parsed bug (or null if not ours / not a bug). */
function parseStatement(st) {
  try {
    const extensions = st?.context?.extensions || {};
    if (getExt(extensions, 'appId') !== BUG_APP_ID) return null;
    return {
      errorId: getExt(extensions, 'errorId') || st.id,
      source: getExt(extensions, 'source') || 'server',
      severity: getExt(extensions, 'severity') || 'error',
      message: getExt(extensions, 'message') || '',
      stack: getExt(extensions, 'stack') || '',
      route: getExt(extensions, 'route') || '',
      method: getExt(extensions, 'method') || '',
      statusCode: getExt(extensions, 'statusCode') || '',
      component: getExt(extensions, 'component') || '',
      userHash: getExt(extensions, 'userHash') || '',
      context: getExt(extensions, 'context') || '',
      timestamp: st.timestamp,
    };
  } catch (_) {
    return null;
  }
}

async function fetchStatements(sinceIso) {
  const url = new URL(BUG_LRS_ENDPOINT.replace(/\/+$/, '') + '/statements');
  url.searchParams.set('since', sinceIso);
  url.searchParams.set('limit', '500');
  const out = [];
  let next = url.toString();
  let guard = 0;
  while (next && guard < 20) {
    guard += 1;
    const res = await fetch(next, {
      headers: {
        'X-Experience-API-Version': '1.0.3',
        Authorization: basicAuthHeader(),
      },
    });
    if (!res.ok) {
      log(`BUG_LRS read responded ${res.status}`);
      break;
    }
    const data = await res.json();
    const statements = Array.isArray(data?.statements) ? data.statements : [];
    out.push(...statements);
    // xAPI "more" is a relative IRL.
    next = data?.more ? new URL(data.more, BUG_LRS_ENDPOINT).toString() : null;
  }
  return out;
}

/**
 * Fetch + parse + dedup + join the fix log. Returns the canonical shape used by
 * the admin endpoint, the CLI, and the skill. Never throws.
 */
async function fetchBugReports({ since = '7d' } = {}) {
  if (!enabled) {
    return { configured: false, since: null, bugs: [], summary: emptySummary() };
  }
  const sinceIso = parseSince(since);
  let statements = [];
  try {
    statements = await fetchStatements(sinceIso);
  } catch (err) {
    log(`fetchBugReports failed: ${err.message}`);
    return { configured: true, since: sinceIso, bugs: [], summary: emptySummary() };
  }

  const fixLog = await readFixLog();
  const byKey = new Map();
  for (const st of statements) {
    const bug = parseStatement(st);
    if (!bug) continue;
    const key = `${bug.source}:${bug.message}:${bug.route}:${bug.statusCode}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (bug.timestamp < existing.firstSeen) existing.firstSeen = bug.timestamp;
      if (bug.timestamp > existing.lastSeen) existing.lastSeen = bug.timestamp;
    } else {
      byKey.set(key, {
        ...bug,
        occurrences: 1,
        firstSeen: bug.timestamp,
        lastSeen: bug.timestamp,
      });
    }
  }

  const bugs = [];
  for (const bug of byKey.values()) {
    const id = bug.errorId;
    let status = 'open';
    let fixNote = '';
    if (fixLog.fixed[id]) { status = 'fixed'; fixNote = fixLog.fixed[id].note; }
    else if (fixLog.dismissed[id]) { status = 'dismissed'; fixNote = fixLog.dismissed[id].reason; }
    bug.category = categorize(bug);
    bug.score = SEVERITY_WEIGHT[bug.severity] * Math.min(bug.occurrences, 10);
    bugs.push({ ...bug, status, fixNote });
  }

  bugs.sort((a, b) => b.score - a.score);
  return { configured: true, since: sinceIso, bugs, summary: summarize(bugs) };
}

function emptySummary() {
  return {
    appId: BUG_APP_ID, total: 0, unique: 0, open: 0, fixed: 0, dismissed: 0,
    bySeverity: { fatal: 0, error: 0, warning: 0, info: 0 },
    bySource: { server: 0, client: 0 },
  };
}

function summarize(bugs) {
  const s = emptySummary();
  s.unique = bugs.length;
  for (const b of bugs) {
    s.total += b.occurrences;
    if (b.status === 'open') s.open += 1;
    else if (b.status === 'fixed') s.fixed += 1;
    else if (b.status === 'dismissed') s.dismissed += 1;
    if (s.bySeverity[b.severity] !== undefined) s.bySeverity[b.severity] += 1;
    if (s.bySource[b.source] !== undefined) s.bySource[b.source] += 1;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Categorization (by message + route content)
// ---------------------------------------------------------------------------
function categorize(bug) {
  const hay = `${bug.message} ${bug.route} ${bug.context}`.toLowerCase();
  const rules = [
    ['Authentication', /auth|unauthor|forbidden|401|403|token|login|jwt/],
    ['Not Found', /not found|404|enoent|no such/],
    ['Rate Limiting', /rate limit|429|too many/],
    ['Storage/GCS', /gcs|bucket|storage|@google-cloud|cloud storage/],
    ['xAPI/LRS', /xapi|lrs|statement|experience-api/],
    ['LLM/AI', /llm|provider|openai|anthropic|gemini|zai|glm|model|completion|generation/],
    ['Assessment', /assessbank|item bank|assessment|stem|rationale|standard/],
    ['Data Parsing', /json|parse|unexpected token|syntaxerror/],
    ['Payload Size', /payload|entity too large|413|limit.*mb/],
    ['Client Console', /console\.(error|warn)/],
    ['Server Error', /500|internal server|unhandled/],
  ];
  for (const [name, re] of rules) if (re.test(hay)) return name;
  return 'Other';
}

module.exports = {
  enabled,
  appId: BUG_APP_ID,
  reportError,
  attachProcessHandlers,
  bugReporterMiddleware,
  fetchBugReports,
  markFixed,
  markDismissed,
  resetFixLog,
  readFixLog,
  parseSince,
  categorize,
  // exported for tests / the CLI
  _internals: { redact, pseudonym, SEVERITY_WEIGHT },
};
