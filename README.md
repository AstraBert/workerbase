# workerbase

A Cloudflare Worker that exposes a small file-storage + retrieval API backed by a Durable Object (for raw file content) and a Qdrant collection (for BM25 sparse-vector search). PDFs are parsed in-worker with [`@llamaindex/liteparse-wasm`](https://github.com/run-llama/liteparse), and text is chunked with [`@chonkiejs/chunk`](https://www.npmjs.com/package/@chonkiejs/chunk) before indexing.

## Architecture

```
                   ┌──────────────────────────┐
                   │  Cloudflare Worker       │
 multipart POST →  │  src/index.ts            │
                   │   ├─ liteparse (PDF→txt) │
                   │   ├─ chonkie  (chunking) │
                   │   ├─ Qdrant   (BM25)     │ ──→ Qdrant Cloud
                   │   └─ DurableFsObject     │ ──→ raw file storage
                   └──────────────────────────┘
```

- **`DurableFsObject`** — a SQLite-backed Durable Object that keeps the full extracted text for each ingested file, keyed by a generated `file_key`. Used by `read` and `grep`.
- **Qdrant collection** — stores per-chunk BM25 sparse vectors plus metadata (`file_key`, plus any caller-provided fields). Used by `retrieve`.
- **`src/qdrant.ts`** — a minimal Workers-compatible Qdrant client built on `@qdrant/openapi-typescript-fetch`

## Endpoint

A single `POST /` endpoint. The request body must be `multipart/form-data` with:

- `job` (string, required) — JSON-encoded job descriptor (see below).
- `file` (File, required for `store` only) — the file to ingest.

All requests must include `Authorization: Bearer <INTERNAL_API_KEY>`.

### Job types

All jobs are wrapped as `{ "payload": { "type": "...", ... } }` and validated with Zod (see `src/index.ts`).

#### `store`

Ingest a file. Returns `{ file_key }`.

```json
{
  "payload": {
    "type": "store",
    "file_name": "invoice.pdf",
    "file_type": "application/pdf",
    "metadata": { "type": "invoice", "department": "finance" }
  }
}
```

Supported `file_type`s:
- `application/pdf` — parsed to text via liteparse.
- Anything starting with `text/`, plus a whitelist of text-ish `application/*` mimetypes (`json`, `xml`, `yaml`, `csv`, `sql`, `graphql`, `x-ndjson`, `x-sh`, …). See `TEXT_BASED_MIMETYPES` in `src/index.ts`.

The extracted text is chunked (size 1024) and upserted into Qdrant under the `sparse` vector with model `qdrant/bm25`. The full text is also stored in the Durable Object under the returned `file_key`.

#### `retrieve`

BM25 search across stored chunks.

```json
{
  "payload": {
    "type": "retrieve",
    "query": "heavy cream",
    "top_k": 3,
    "file_key": "optional — restrict to one file",
    "filters": [
      { "field": "type", "operator": "eq", "value": "invoice" }
    ]
  }
}
```

Supported filter operators: `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `true`, `false` (the last two are unary boolean matches). Translated to a Qdrant `Filter` by `buildQdrantFilter`.

Returns `{ retrieved: [{ id, version, score, payload }] }`.

> _Filtering needs the payload fields to be indexed, use [create-payload-indices.ts](./scripts/create-payload-indices.ts)_

#### `read`

Return the raw extracted text from the Durable Object, optionally sliced.

```json
{
  "payload": {
    "type": "read",
    "file_key": "invoice.pdf:<uuid>",
    "offset": 0,
    "max_chars": 1000
  }
}
```

#### `grep`

Run a JS regex against the raw stored text.

```json
{
  "payload": {
    "type": "grep",
    "file_key": "invoice.pdf:<uuid>",
    "pattern": "total\\s+\\$[0-9.]+",
    "max_matches": 10,
    "context": 40
  }
}
```

Returns `{ matches: [{ match, start, end, context?: { text, start, end } }] }`.

## Configuration

Bindings and config live in `wrangler.jsonc`:

- Durable Object: `DURABLE_FS_OBJECT` → `DurableFsObject` (SQLite class, migration tag `v1`).
- `nodejs_compat` is enabled (needed for `crypto.randomUUID` and friends).
- WASM modules (`liteparse_wasm_bg.wasm`, `chonkiejs_chunk_bg.wasm`) are imported as `CompiledWasm` rules.

Environment variables (set as secrets in production, `.dev.vars` locally):

| Variable | Purpose |
|---|---|
| `QDRANT_BASE_URL` | Qdrant Cloud URL |
| `QDRANT_API_KEY` | Qdrant API key |
| `QDRANT_COLLECTION_NAME` | Target collection (must already exist) |
| `INTERNAL_API_KEY` | Bearer token clients must present |
| `DURABLE_OBJECT_SERVICE` | Name used to address the singleton Durable Object instance |

## Setup

```bash
yarn install
```

Create the Qdrant collection and any payload indices you want to filter on:

```bash
# Loads QDRANT_* from your env / .dev.vars
yarn tsx scripts/create-collection.ts
yarn tsx scripts/create-payload-indices.ts type department
```

`create-collection.ts` provisions a `sparse` named vector. `create-payload-indices.ts` creates `keyword` indices for each field name you pass on the command line — required for `eq`/`ne` filters on those fields.

## Development

```bash
yarn dev          # wrangler dev --local
yarn start        # wrangler dev
yarn deploy       # wrangler deploy
yarn cf-typegen   # regenerate worker-configuration.d.ts after binding changes
```

Re-run `yarn cf-typegen` whenever you edit bindings in `wrangler.jsonc`.

## Smoke tests

The `scripts/` directory has small `tsx` entry points that hit the deployed worker. They expect `INTERNAL_API_KEY` (and for the Qdrant scripts, `QDRANT_*`) in the environment, and they currently point at `https://workerbase.astraberte9.workers.dev/` — edit the URL if you've deployed elsewhere.

```bash
yarn tsx scripts/test-store.ts                  # uploads scripts/data/invoice.pdf
yarn tsx scripts/test-retrieve.ts <file_key>    # BM25 query
yarn tsx scripts/test-read.ts <file_key>        # raw text slice
yarn tsx scripts/test-grep.ts <file_key>        # regex over raw text
```

## Project layout

```
src/
  index.ts          Worker entry: auth, job dispatch, DO + Qdrant orchestration
  qdrant.ts         Workers-safe Qdrant client (openapi-typescript-fetch)
  types/            Ambient .d.ts for chonkie
scripts/            One-off admin + smoke-test scripts
wrangler.jsonc      Worker + DO config
*.wasm              liteparse + chonkie WASM bundles, imported by src/index.ts
```
