# AssessBank

AI-powered assessment item generator for instructors. Enter a **topic**, a
**target standard**, and an **item type** — AssessBank generates aligned
assessment items with **answer keys** and **difficulty tags**, lets you **save**
them as item banks to Google Cloud Storage, and (optionally) emits **xAPI**
statements to a Learning Record Store.

## Features

- **Generate** standards-aligned items (multiple choice, true/false, short
  answer, essay) with answer keys, rationales, and difficulty tags.
- **Save** generated item banks to Google Cloud Storage.
- **List & open** previously saved banks.
- **Optional xAPI** statements (`generated`, `saved`) sent to an LRS.
- Server-side LLM calls only — **no API keys are ever exposed to the browser**.

## Architecture

| Path | Purpose |
| --- | --- |
| `public/assessbank.html` | Frontend (generator form, results, save, saved-banks list) |
| `server.js` | Express backend + API |
| `POST /api/assessbank` | Generate items via the LLM |
| `POST /api/assessbank/save` | Save an item bank to GCS |
| `GET /api/assessbank/banks` | List saved banks |
| `GET /api/assessbank/banks/:id` | Fetch one saved bank |
| `GET /healthz` | Health/config probe |

## Configuration

All config is read from `process.env` (loaded from `.env` in development).
Copy `.env.example` to `.env` and fill in:

- `ZAI_API_KEY` — LLM key (required to generate). `ZAI_API_URL` / `ZAI_MODEL`
  are optional overrides.
- `GCS_BUCKET_NAME` — bucket for saving/listing banks.
- `LRS_ENDPOINT`, `LRS_KEY`, `LRS_SECRET` — optional LRS (xAPI).
- `PORT` — server port (Cloud Run sets this automatically).

## Run locally

```bash
npm install
cp .env.example .env   # then edit .env
npm start
# open http://localhost:8080
```

## Deploy to Google Cloud Run

```bash
# Build & push (or use --source . to build from source)
gcloud run deploy assessbank \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars ZAI_API_KEY=...,GCS_BUCKET_NAME=...,ZAI_MODEL=glm-4.6
```

The container reads `PORT` from the environment and the service account provides
GCS credentials automatically. For local GCS access, set
`GOOGLE_APPLICATION_CREDENTIALS` to a service-account key file.
