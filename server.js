'use strict';

/**
 * AssessBank — backend server
 *
 * Serves the static frontend and exposes a small JSON API:
 *   GET  /api/config              -> public, non-secret runtime config (providers)
 *   POST /api/assessbank          -> generate aligned assessment items via an LLM
 *   POST /api/assessbank/save     -> persist a generated item bank to Google Cloud Storage
 *   GET  /api/assessbank/banks    -> list saved item banks from Google Cloud Storage
 *   GET  /api/assessbank/banks/:id-> fetch a single saved bank
 *   GET  /healthz                 -> liveness probe for Cloud Run
 *
 * All secrets and configuration are read from process.env (loaded from .env in
 * development). Nothing secret is ever sent to the browser.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve the app at the root.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assessbank.html'));
});

// ---------------------------------------------------------------------------
// Configuration (server-side only — never exposed to the client)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;

// Which provider to use by default. Can be overridden per-request (only to a
// provider that is actually configured).
const DEFAULT_PROVIDER = (process.env.LLM_PROVIDER || 'zai').toLowerCase();

// ---------------------------------------------------------------------------
// LLM provider registry
// ---------------------------------------------------------------------------
// Each provider exposes:
//   label      human-readable name (sent to the browser)
//   model      the model/deployment in use (sent to the browser)
//   configured whether the necessary secrets are present
//   chat(messages) async -> string  (the raw model text)
//
// OpenAI-compatible providers (OpenAI, Azure, Groq, Together, Mistral,
// DeepSeek, Z.ai, OpenRouter, ...) all speak the /chat/completions shape, so
// they share one helper. Anthropic and Google have their own request shapes.

const env = process.env;

async function openAICompatChat({ url, key, model, messages, headerStyle }) {
  const headers = { 'Content-Type': 'application/json' };
  if (headerStyle === 'azure') headers['api-key'] = key;
  else headers['Authorization'] = `Bearer ${key}`;

  const body = { temperature: 0.7, messages, max_tokens: 4096 };
  // Azure puts the deployment in the URL; everyone else needs `model`.
  if (model) body.model = model;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
}

async function anthropicChat({ key, model, messages, baseUrl }) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const res = await fetch(`${(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 4096, temperature: 0.7, system, messages: rest }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data?.content)
    ? data.content.map((c) => c.text || '').join('')
    : '';
}

async function googleChat({ key, model, messages }) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const userText = messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n\n');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.7 },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
}

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    model: env.OPENAI_MODEL || 'gpt-4o',
    configured: Boolean(env.OPENAI_API_KEY),
    chat: (messages) =>
      openAICompatChat({
        url: `${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`,
        key: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL || 'gpt-4o',
        messages,
      }),
  },
  azure: {
    label: 'Azure OpenAI',
    model: env.AZURE_OPENAI_DEPLOYMENT || '',
    configured: Boolean(
      env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_DEPLOYMENT
    ),
    chat: (messages) =>
      openAICompatChat({
        url:
          `${(env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '')}` +
          `/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT}/chat/completions` +
          `?api-version=${env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview'}`,
        key: env.AZURE_OPENAI_API_KEY,
        model: null, // deployment is in the URL
        messages,
        headerStyle: 'azure',
      }),
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    configured: Boolean(env.ANTHROPIC_API_KEY),
    chat: (messages) =>
      anthropicChat({
        key: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        baseUrl: env.ANTHROPIC_BASE_URL,
        messages,
      }),
  },
  google: {
    label: 'Google (Gemini)',
    model: env.GOOGLE_MODEL || env.GEMINI_MODEL || 'gemini-2.5-pro',
    configured: Boolean(env.GOOGLE_API_KEY || env.GEMINI_API_KEY),
    chat: (messages) =>
      googleChat({
        key: env.GOOGLE_API_KEY || env.GEMINI_API_KEY,
        model: env.GOOGLE_MODEL || env.GEMINI_MODEL || 'gemini-2.5-pro',
        messages,
      }),
  },
  mistral: {
    label: 'Mistral',
    model: env.MISTRAL_MODEL || 'mistral-large-latest',
    configured: Boolean(env.MISTRAL_API_KEY),
    chat: (messages) =>
      openAICompatChat({
        url: `${(env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/+$/, '')}/chat/completions`,
        key: env.MISTRAL_API_KEY,
        model: env.MISTRAL_MODEL || 'mistral-large-latest',
        messages,
      }),
  },
  cohere: {
    label: 'Cohere',
    model: env.COHERE_MODEL || 'command-r-plus',
    configured: Boolean(env.COHERE_API_KEY),
    chat: (messages) =>
      // Cohere exposes an OpenAI-compatible endpoint.
      openAICompatChat({
        url: 'https://api.cohere.ai/compatibility/v1/chat/completions',
        key: env.COHERE_API_KEY,
        model: env.COHERE_MODEL || 'command-r-plus',
        messages,
      }),
  },
  together: {
    label: 'Together AI',
    model: env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    configured: Boolean(env.TOGETHER_API_KEY),
    chat: (messages) =>
      openAICompatChat({
        url: `${(env.TOGETHER_BASE_URL || 'https://api.together.xyz/v1').replace(/\/+$/, '')}/chat/completions`,
        key: env.TOGETHER_API_KEY,
        model: env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        messages,
      }),
  },
  groq: {
    label: 'Groq',
    model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    configured: Boolean(env.GROQ_API_KEY),
    chat: (messages) =>
      openAICompatChat({
        url: `${(env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '')}/chat/completions`,
        key: env.GROQ_API_KEY,
        model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages,
      }),
  },
  zai: {
    label: 'Z.ai (GLM)',
    model: env.ZAI_MODEL || 'glm-4.6',
    configured: Boolean(env.ZAI_API_KEY),
    chat: (messages) =>
      openAICompatChat({
        url: env.ZAI_API_URL || 'https://api.z.ai/api/paas/v4/chat/completions',
        key: env.ZAI_API_KEY,
        model: env.ZAI_MODEL || 'glm-4.6',
        messages,
      }),
  },
};

/** Pick a provider key: requested (if configured) else default else first configured. */
function resolveProvider(requested) {
  const want = String(requested || '').toLowerCase();
  if (want && PROVIDERS[want] && PROVIDERS[want].configured) return want;
  if (PROVIDERS[DEFAULT_PROVIDER] && PROVIDERS[DEFAULT_PROVIDER].configured) return DEFAULT_PROVIDER;
  const firstConfigured = Object.keys(PROVIDERS).find((k) => PROVIDERS[k].configured);
  return firstConfigured || null;
}

function configuredProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.configured)
    .map(([id, p]) => ({ id, label: p.label, model: p.model }));
}

// ---------------------------------------------------------------------------
// Google Cloud Storage (lazy — only initialised when a bucket is configured)
// ---------------------------------------------------------------------------
const GCS_BUCKET_NAME = env.GCS_BUCKET_NAME;

let bucket = null;
if (GCS_BUCKET_NAME) {
  try {
    const { Storage } = require('@google-cloud/storage');
    const storageOpts = {};
    if (env.GCS_PROJECT_ID || env.GCP_PROJECT_ID) {
      storageOpts.projectId = env.GCS_PROJECT_ID || env.GCP_PROJECT_ID;
    }
    if (env.GCS_CREDENTIALS) {
      // Cloud Run convenience: full service-account JSON in an env var.
      storageOpts.credentials = JSON.parse(env.GCS_CREDENTIALS);
    } else if (env.GCS_KEY_FILE && fs.existsSync(env.GCS_KEY_FILE)) {
      storageOpts.keyFilename = env.GCS_KEY_FILE;
    }
    // Otherwise rely on Application Default Credentials (Cloud Run / gcloud).
    const storage = new Storage(storageOpts);
    bucket = storage.bucket(GCS_BUCKET_NAME);
    console.log(`[gcs] using bucket "${GCS_BUCKET_NAME}"`);
  } catch (err) {
    console.warn(`[gcs] failed to initialise Storage client: ${err.message}`);
  }
} else {
  console.warn('[gcs] GCS_BUCKET_NAME not set — save/list will be unavailable');
}

const BANK_PREFIX = 'banks/';

// ---------------------------------------------------------------------------
// xAPI / LRS (optional) — basic auth via username/password (or legacy key/secret)
// ---------------------------------------------------------------------------
const LRS_ENDPOINT = env.LRS_ENDPOINT;
const LRS_USERNAME = env.LRS_USERNAME || env.LRS_KEY;
const LRS_PASSWORD = env.LRS_PASSWORD || env.LRS_SECRET;
const lrsEnabled = Boolean(LRS_ENDPOINT && LRS_USERNAME && LRS_PASSWORD);

/**
 * Best-effort send of an xAPI statement. Never throws — telemetry must not
 * break the primary request flow.
 */
async function sendXapiStatement(verb, objectName, extra = {}) {
  if (!lrsEnabled) return;
  try {
    const auth =
      'Basic ' + Buffer.from(`${LRS_USERNAME}:${LRS_PASSWORD}`).toString('base64');
    const statement = {
      actor: {
        objectType: 'Agent',
        name: 'AssessBank Instructor',
        account: { homePage: 'https://assessbank.app', name: 'instructor' },
      },
      verb: {
        id: `http://adlnet.gov/expapi/verbs/${verb}`,
        display: { 'en-US': verb },
      },
      object: {
        objectType: 'Activity',
        id: `https://assessbank.app/xapi/${encodeURIComponent(objectName)}`,
        definition: {
          name: { 'en-US': objectName },
          extensions: extra,
        },
      },
      timestamp: new Date().toISOString(),
    };
    const url = LRS_ENDPOINT.replace(/\/+$/, '') + '/statements';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Experience-API-Version': '1.0.3',
        Authorization: auth,
      },
      body: JSON.stringify(statement),
    });
    if (!res.ok) {
      console.warn(`[xapi] LRS responded ${res.status}`);
    }
  } catch (err) {
    console.warn(`[xapi] failed to send statement: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// LLM item generation
// ---------------------------------------------------------------------------
function buildPrompt({ topic, standard, itemType, count }) {
  return `You are an expert assessment designer who writes standards-aligned test items for instructors.

Generate exactly ${count} ${itemType} assessment item(s) on the topic: "${topic}".
Align every item to this target standard: "${standard || 'general subject mastery'}".

Return ONLY valid JSON (no markdown, no commentary) with this exact shape:
{
  "items": [
    {
      "stem": "the question or prompt text",
      "type": "${itemType}",
      "options": ["A ...", "B ...", "C ...", "D ..."],
      "answer": "the correct answer (for multiple choice, the full text of the correct option)",
      "rationale": "1-2 sentences explaining why the answer is correct",
      "difficulty": "easy | medium | hard",
      "standard": "${standard || ''}"
    }
  ]
}

Rules:
- For "multiple choice", provide 4 plausible options and set "answer" to the correct option's text.
- For "true/false", set "options" to ["True","False"].
- For "short answer" or "essay", set "options" to an empty array and put a model answer in "answer".
- Make difficulty varied and realistic. Keep stems clear and unambiguous.`;
}

async function generateItems(params, providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider || !provider.configured) {
    const err = new Error('No LLM provider is configured. Set LLM_PROVIDER and the matching API key.');
    err.status = 503;
    throw err;
  }

  const messages = [
    {
      role: 'system',
      content:
        'You generate high-quality, standards-aligned assessment items and reply with strict JSON only.',
    },
    { role: 'user', content: buildPrompt(params) },
  ];

  const content = await provider.chat(messages);
  return parseItems(content);
}

/** Tolerantly parse the model's JSON (strips code fences / surrounding prose). */
function parseItems(content) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    text = text.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const e = new Error('Could not parse LLM response as JSON');
    e.status = 502;
    throw e;
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return items.map((it) => ({
    stem: String(it.stem || '').trim(),
    type: String(it.type || '').trim(),
    options: Array.isArray(it.options) ? it.options.map(String) : [],
    answer: String(it.answer ?? '').trim(),
    rationale: String(it.rationale || '').trim(),
    difficulty: String(it.difficulty || 'medium').toLowerCase().trim(),
    standard: String(it.standard || '').trim(),
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Public, non-secret runtime config for the frontend.
app.get('/api/config', (req, res) => {
  const providers = configuredProviders();
  const active = resolveProvider(null);
  res.json({
    providers,
    defaultProvider: active,
    storage: Boolean(bucket),
    lrs: lrsEnabled,
  });
});

// Generate assessment items.
app.post('/api/assessbank', async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim();
    const standard = String(req.body?.standard || '').trim();
    const itemType = String(req.body?.itemType || 'multiple choice').trim();
    let count = parseInt(req.body?.count, 10);
    if (!Number.isFinite(count) || count < 1) count = 5;
    if (count > 20) count = 20;

    if (!topic) {
      return res.status(400).json({ error: 'A topic is required.' });
    }

    const providerId = resolveProvider(req.body?.provider);
    if (!providerId) {
      return res
        .status(503)
        .json({ error: 'No LLM provider is configured. Set LLM_PROVIDER and the matching API key.' });
    }

    const items = await generateItems({ topic, standard, itemType, count }, providerId);

    sendXapiStatement('generated', `${itemType} items: ${topic}`, {
      'https://assessbank.app/ext/topic': topic,
      'https://assessbank.app/ext/standard': standard,
      'https://assessbank.app/ext/count': items.length,
      'https://assessbank.app/ext/provider': providerId,
    });

    res.json({ topic, standard, itemType, provider: providerId, model: PROVIDERS[providerId].model, items });
  } catch (err) {
    console.error('[generate] error:', err.message);
    res
      .status(err.status || 500)
      .json({ error: err.message || 'Generation failed.' });
  }
});

// Save an item bank to GCS.
app.post('/api/assessbank/save', async (req, res) => {
  try {
    if (!bucket) {
      return res
        .status(503)
        .json({ error: 'Saving is not configured (GCS_BUCKET_NAME missing).' });
    }
    const { name, topic, standard, itemType, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items to save.' });
    }

    const id = crypto.randomUUID();
    const record = {
      id,
      name: String(name || topic || 'Untitled bank').trim(),
      topic: String(topic || '').trim(),
      standard: String(standard || '').trim(),
      itemType: String(itemType || '').trim(),
      itemCount: items.length,
      items,
      savedAt: new Date().toISOString(),
    };

    const file = bucket.file(`${BANK_PREFIX}${id}.json`);
    await file.save(JSON.stringify(record, null, 2), {
      contentType: 'application/json',
      resumable: false,
      metadata: {
        metadata: {
          name: record.name,
          topic: record.topic,
          itemCount: String(record.itemCount),
          savedAt: record.savedAt,
        },
      },
    });

    sendXapiStatement('saved', `bank: ${record.name}`, {
      'https://assessbank.app/ext/bankId': id,
      'https://assessbank.app/ext/itemCount': record.itemCount,
    });

    res.json({ ok: true, id, savedAt: record.savedAt });
  } catch (err) {
    console.error('[save] error:', err.message);
    res.status(500).json({ error: 'Failed to save bank.' });
  }
});

// List saved item banks.
app.get('/api/assessbank/banks', async (req, res) => {
  try {
    if (!bucket) {
      return res.json({ banks: [] });
    }
    const [files] = await bucket.getFiles({ prefix: BANK_PREFIX });
    const banks = files
      .filter((f) => f.name.endsWith('.json'))
      .map((f) => {
        const m = f.metadata?.metadata || {};
        return {
          id: f.name.slice(BANK_PREFIX.length, -'.json'.length),
          name: m.name || f.name,
          topic: m.topic || '',
          itemCount: Number(m.itemCount || 0),
          savedAt: m.savedAt || f.metadata?.updated || '',
        };
      })
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    res.json({ banks });
  } catch (err) {
    console.error('[list] error:', err.message);
    res.status(500).json({ error: 'Failed to list banks.' });
  }
});

// Fetch a single saved bank.
app.get('/api/assessbank/banks/:id', async (req, res) => {
  try {
    if (!bucket) {
      return res.status(503).json({ error: 'Storage is not configured.' });
    }
    const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
    const file = bucket.file(`${BANK_PREFIX}${id}.json`);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'Bank not found.' });
    const [buf] = await file.download();
    res.type('application/json').send(buf.toString('utf8'));
  } catch (err) {
    console.error('[get] error:', err.message);
    res.status(500).json({ error: 'Failed to load bank.' });
  }
});

// Health check for Cloud Run.
app.get('/healthz', (req, res) => {
  const active = resolveProvider(null);
  res.json({
    ok: true,
    llm: Boolean(active),
    provider: active,
    providers: configuredProviders().map((p) => p.id),
    storage: Boolean(bucket),
    lrs: lrsEnabled,
  });
});

app.listen(PORT, () => {
  const active = resolveProvider(null);
  console.log(`AssessBank listening on port ${PORT}`);
  console.log(
    `[llm] default provider: ${active || 'NONE'} ` +
      `(configured: ${configuredProviders().map((p) => p.id).join(', ') || 'none'})`
  );
});
