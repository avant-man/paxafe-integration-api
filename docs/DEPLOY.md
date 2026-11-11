# Deploy runbook: PAXAFE Integration API

Target: one Render Starter web service (Docker, region `oregon`, 1 instance) and one Neon
Postgres 18 project (free plan, AWS `us-west-2`). Time: about 15 minutes.

| Part | Where | Live URL |
|---|---|---|
| Integration API | Render Starter web service, Docker, `oregon` | `https://paxafe-integration-api-0sed.onrender.com` |
| Postgres 18 | Neon, free plan, AWS `us-west-2` | direct host `ep-xxxx.us-west-2.aws.neon.tech` |

Source: https://github.com/avant-man/paxafe-integration-api. A push to `main` deploys again.

Render may add a suffix to a service name that is taken. Use the URL that the dashboard shows.

The Mock Tive sender is a separate repo with its own runbook: see `docs/DEPLOY.md` in
`paxafe-mock-tive-sender`. Deploy the API first, because the sender needs the API URL and key.

## 0. Things to know about the platform

- Render Starter services stay running when idle, so the first request is not slow.
- Starter has a shell, a pre-deploy command and one-off jobs. The API still runs its migrations at boot (`src/index.ts`), so a deploy needs no extra step. Each migration file runs in a transaction that holds a Postgres advisory lock.
- The service runs 1 instance.
- The Neon project is on the free plan. Neon free compute suspends after about 5 minutes idle and resumes on the next connection, normally in under 1 second. The API `/health` check waits up to 2 seconds for `SELECT 1`. Render's health checks call `/health` often, so they keep the Neon compute active and spend Neon compute hours.
- Render health checks: each request must answer 2xx or 3xx in 5 seconds. A new deploy has 15 minutes to pass. A running instance that fails for 60 seconds in a row gets a restart.

## 1. Create the Neon database

1. Go to https://console.neon.tech and sign in.
2. Click **New Project**.
   - Name: `paxafe`
   - Postgres version: 18
   - Region: **AWS US West 2 (Oregon)**. This matches Render region `oregon`.
3. Open the project, click **Connect**.
4. Turn **Connection pooling OFF** and copy the direct (unpooled) string. The host must NOT contain `-pooler`.
5. Change `sslmode=require` to `sslmode=verify-full`. Remove `&channel_binding=require` if it is there (node-postgres does not read it). The result looks like this:

   ```
   postgresql://neondb_owner:<password>@ep-xxxx.us-west-2.aws.neon.tech/neondb?sslmode=verify-full
   ```

Why direct and not pooled: the Neon pooler is PgBouncer in transaction mode. The API sets `statement_timeout` (10 s) and `idle_in_transaction_session_timeout` (15 s) with `SET` on each new connection (`src/db/pool.ts`). In transaction mode, a session `SET` does not stick to your transactions. The pooled URL boots, but the timeouts would not hold. The test suite's `SET search_path` is lost the same way. The API opens at most 10 connections, so a direct connection is fine for 1 instance.

If you must use the pooled URL for `DATABASE_URL`, also set `DATABASE_URL_DIRECT` to the direct URL. Migrations (at boot, `migrate` and `create-key`) then use the direct URL. The live deploy does not do this. It uses the direct string in `DATABASE_URL`.

Keep this string private. You paste it into Render in step 2.

## 2. Deploy the Integration API on Render

1. `render.yaml` and `.github/workflows/ci.yml` are in the repo root. With `autoDeployTrigger: checksPass`, Render deploys only after CI is green. Without CI on the repo, change it to `commit`.
2. Go to https://dashboard.render.com and click **New > Blueprint**.
3. Connect GitHub and pick the `avant-man/paxafe-integration-api` repo, branch `main`.
4. Render reads `render.yaml` and shows 1 web service on the Starter plan. It asks for the `sync: false` values:
   - `DATABASE_URL`: paste the Neon direct URL from step 1.
   - `DATABASE_URL_DIRECT`: leave it empty when `DATABASE_URL` is the direct URL.
5. Click **Apply**. Render builds the Dockerfile and starts the container.
6. Watch **Logs**. A good boot shows these lines in this order:
   ```
   "msg":"migration applied","migration":"001_init"                          (first deploy only)
   "msg":"migration applied","migration":"002_bigint_accounts_indexes_checks" (first deploy after 002)
   "msg":"seed API key upserted"
   "msg":"server listening","port":10000
   ```
   Render sets `PORT=10000`. The app reads `PORT` and listens on all interfaces.
7. The deploy is live when the `/health` check passes.

### Migrations

There is nothing to run by hand. Each boot applies new files in `migrations/` in order and records them in `schema_migrations`. Each file runs in its own transaction with `pg_advisory_xact_lock`, no statement timeout and a 5 s lock timeout. To check from your laptop:

```bash
psql "$NEON_DIRECT_URL" -c "select * from schema_migrations"
```

To run them without a deploy, from a local checkout or from the image:

```bash
DATABASE_URL="$NEON_DIRECT_URL" npm run migrate                       # local checkout, after npm ci
docker run --rm -e DATABASE_URL="$NEON_DIRECT_URL" paxafe-integration-api node dist/scripts/migrate.js
```

### API keys

The Blueprint generates `SEED_API_KEY` (a random 256-bit value). The API upserts it at boot as the unscoped key named `seed`.

- Read it: Render dashboard > `paxafe-integration-api` > **Environment** > `SEED_API_KEY` > reveal.
- The seed key is unscoped: it can read and write every account. For the public sender demo, give the sender a key scoped to one account (for example 478), not the seed key.
- To make an extra key, run `create-key` in the Render shell or from your laptop against Neon:

  ```bash
  # Render shell (dashboard > paxafe-integration-api > Shell). DATABASE_URL is already set:
  node dist/scripts/create-key.js reviewer-478 478
  # from a laptop, in a local checkout after npm ci:
  DATABASE_URL="$NEON_DIRECT_URL" npm run create-key -- reviewer             # unscoped
  DATABASE_URL="$NEON_DIRECT_URL" npm run create-key -- reviewer-478 478     # scoped to account 478
  # or with the image, no Node install needed:
  docker run --rm -e DATABASE_URL="$NEON_DIRECT_URL" paxafe-integration-api node dist/scripts/create-key.js reviewer-478 478
  ```

  It prints `api_key` once. Only its SHA-256 hash is stored, so copy it now.

A scoped key always writes its own account. A payload with a different or invalid `AccountId` is rejected with `ACCOUNT_MISMATCH`, and a device that belongs to another account is rejected with `DEVICE_ACCOUNT_CONFLICT`.

### Retention

`webhook_events` keeps every request. Run the retention job from time to time, by hand or from a scheduler. A Render cron job is a separate paid service, so the deploy has none.

```bash
node dist/scripts/retention.js                                        # Render shell
DATABASE_URL="$NEON_DIRECT_URL" npm run retention                     # laptop, local checkout
docker run --rm -e DATABASE_URL="$NEON_DIRECT_URL" paxafe-integration-api node dist/scripts/retention.js
```

It deletes `duplicate`, `duplicate_conflict` and `rejected` events older than `RETENTION_EVENT_DAYS` (default 30), and clears the raw body of `processed` and `partial` events older than `RETENTION_RAW_DAYS` (default 90), in batches of `RETENTION_BATCH_SIZE` (default 1000). It keeps `failed` events.

## 3. Smoke test the live URL

Use a test key from the submission email, or the `SEED_API_KEY` value. The first sample has `AccountId` 478, so both test keys accept it.

```bash
API=https://paxafe-integration-api-0sed.onrender.com
KEY='<TEST_API_KEY>'

# 1. The service and the database are up.
curl -sS "$API/health"       # {"status":"ok","db":"ok"}

# 2. Auth is enforced: no key gives 401.
curl -sS -o /dev/null -w '%{http_code}\n' "$API/api/events"            # 401

# 3. Send the first sample and read it back.
curl -sS -X POST "$API/api/webhook/tive" -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d "$(node -e "console.log(JSON.stringify(require('./schemas/sample-tive-payloads.json').payloads[0].payload))")"
curl -sS -H "X-API-Key: $KEY" "$API/api/events?limit=5"
curl -sS -H "X-API-Key: $KEY" "$API/api/devices/863257063350583/readings?limit=5"
```

For the end-to-end test through the sender UI, see the sender repo runbook.

## 4. Operate

- **Logs**: Render dashboard > service > **Logs**. The API writes JSON lines with `request_id` and `event_id`.
- **Redeploy**: push to `main`. Or dashboard > **Manual Deploy > Deploy latest commit**.
- **Rollback**: dashboard > service > **Events** > pick an earlier deploy > **Rollback**. Migrations do not roll back. Each migration only adds or widens, so the earlier code still runs on the newer schema.
- **Rotate the seed key**: dashboard > **Environment** > edit `SEED_API_KEY` > **Save and deploy**. The sender does not use the seed key, so it needs no change. The old seed key stops working because the row is upserted with the new hash.
- **Rotate the DB password**: Neon > **Roles** > reset password > put the new direct URL into `DATABASE_URL` on Render.
- **Shutdown**: Render sends SIGTERM and waits up to 30 seconds. The API closes the HTTP server and the pool, and forces exit after 10 seconds.
- **Backups**: the Neon free plan keeps a short point-in-time restore window. Use Neon > **Branches** > restore if a test run corrupts data. There is no tested restore drill.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Boot log: `SECURITY WARNING: The SSL modes 'prefer', 'require'...` | `sslmode=require` in the URL | Use `sslmode=verify-full` |
| Boot log: `DATABASE_URL is required` | Env var not set | Set it in **Environment** and deploy |
| Boot log: `Migration 00N_... failed: canceling statement due to lock timeout` | A long query held a table lock for more than 5 s | Deploy again when the database is quiet |
| Queries time out after 10 s only sometimes | Pooled URL: session `SET` does not stay with each transaction | Use the direct URL |
| `429 rate_limited` for many keys at once | Per-IP limit (`RATE_LIMIT_PER_IP_PER_MIN`, default 1200) | Raise it in **Environment** |
