# PAXAFE Integration API

Receives Tive webhook payloads, validates and transforms them into the PAXAFE sensor and
location formats, and stores them in PostgreSQL with a full audit log.

- Design: [`docs/DESIGN-SPEC.md`](docs/DESIGN-SPEC.md)
- Decisions and assumptions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Schemas and samples: [`schemas/`](schemas)

## Requirements

- Node.js 22 or later
- Docker (for the local Postgres 16)

## Run locally

```bash
npm install
cp .env.example .env              # set DB_PORT and DATABASE_URL if host port 5433 is taken
docker compose up -d db           # postgres:16 on host port ${DB_PORT:-5433}
npm run migrate                   # also runs automatically at boot
SEED_API_KEY=test-key-local npm run dev    # http://localhost:3000
```

Send a sample:

```bash
curl -s -X POST http://localhost:3000/api/webhook/tive \
  -H 'Content-Type: application/json' -H 'X-API-Key: test-key-local' \
  -d "$(node -e "console.log(JSON.stringify(require('./schemas/sample-tive-payloads.json').payloads[0].payload))")"
```

Create more keys (the key is printed once and only its hash is stored):

```bash
npm run create-key -- my-client          # unscoped
npm run create-key -- tenant-478 478     # scoped to AccountId 478
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run migrate` | Apply `migrations/*.sql` |
| `npm run create-key -- <name> [accountId]` | Create an API key |
| `npm test` | Unit, contract and golden tests. DB integration tests also run when `DATABASE_URL` is set |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |

The integration tests create and drop their own Postgres schema, so they do not touch your data:

```bash
DATABASE_URL=postgres://paxafe:paxafe@localhost:5433/paxafe npm test
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | none (required) | Postgres connection string. Add `sslmode=require` for Neon |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | pino level |
| `SEED_API_KEY` | none | Upserted at boot as the unscoped key `seed` |
| `RATE_LIMIT_PER_MIN` | `600` | Per key, per instance |
| `DB_PORT` | `5433` | Host port for `docker compose` only |

## API

All `/api/*` routes need `X-API-Key: <key>` or `Authorization: Bearer <key>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/webhook/tive` | Ingest one payload (object) or a batch (array of 1 to 100) |
| GET | `/api/events?limit=50&status=` | Recent ingest events |
| GET | `/api/events/:id` | One event with raw body, errors, warnings and output ids |
| GET | `/api/devices/:imei/readings?limit=50` | Latest sensor and location rows for a device |
| GET | `/health` | Liveness plus a database check (503 when the database is down) |

Single-item status codes: `201` processed or partial, `200` duplicate or duplicate_conflict,
`422` rejected, `500` failed. A batch returns `207` with `results` (same order) and `summary`.
Other codes: `400` invalid JSON or bad batch size, `401` bad key, `413` body over 1 MB,
`415` not JSON, `429` rate limited (with `Retry-After`).

```json
{
  "event_id": "uuid",
  "request_id": "string",
  "status": "processed",
  "sensor": { "id": 1, "payload": { "device_id": "A571992", "temperature": 10.08 } },
  "location": { "id": 1, "payload": { "latitude": 40.810562, "location_source": "WiFi" } },
  "warnings": [{ "code": "SENSOR_SENTINEL", "path": "ProbeTemperature.Celsius", "message": "..." }],
  "errors": []
}
```

## Deploy (Render)

`render.yaml` defines a Docker web service and a managed Postgres. Create a Blueprint from
the repo and set `SEED_API_KEY` in the dashboard. Migrations run at boot. The Docker image
works on any container host:

```bash
docker build -t paxafe-integration-api .
docker run -p 3000:3000 -e DATABASE_URL=... -e SEED_API_KEY=... paxafe-integration-api
```

Or run the whole stack locally with `docker compose --profile app up -d --build`.

## Layout

```
src/transform/   pure functions: normalize, validate, clean, map, address, round, hash, PX schema check
src/db/          pg pool, migration runner, repositories (keys, events, readings)
src/http/        Hono app, auth, rate limit, request id and logging, routes
src/ingest.ts    one item: audit row -> transform -> transactional store
src/scripts/     migrate, create-key
migrations/      plain SQL
tests/unit       rules, contract test over every sample, golden test
tests/integration HTTP + Postgres (runs when DATABASE_URL is set)
```
