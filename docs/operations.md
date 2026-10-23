# Operations

## Run

```bash
cp .env.example .env
docker compose up -d
npm install
npm run gate      # :3001
npm run console   # :3000
```

The database starts empty. There is no seed script.

```bash
curl -sS -X POST http://localhost:3001/v1/writes \
  -H 'content-type: application/json' \
  -d '{"table":"users","record":{"id":"u_1","name":"Ada","email":"ada@example.com","signupAt":"2026-10-23T00:00:00.000Z"},"idempotencyKey":"write-1"}'
```

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `GATE_PORT` | `3001` | Gate listen port |
| `DATABASE_URL` | local `kicker/kicker` | Postgres |
| `REDIS_URL` | `redis://localhost:6379` | Cache |
| `LLM_ENABLED` | `false` | Stage D12 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `LLM_MODEL` | OpenAI | Only if LLM is on |
| `SLACK_WEBHOOK_URL` | empty | High/critical alerts |
| `ALERT_EMAIL_TO` | empty | Logged, not mailed in v1 |
| `N8N_WEBHOOK_URL` | empty | Outbound incident router |
| `N8N_NOTIFY_STATUSES` | `kicked,queued` | Which outcomes to POST |
| `NEXT_PUBLIC_GATE_URL` | `http://localhost:3001` | Console → gate |

Do not commit `.env`. `.env.example` is the template.

## Health

`GET /health` → `{ ok, postgres, redis, redisRole }`. `ok` follows Postgres.

## Checks

```bash
npm run smoke      # pure-logic, no infra
npm run typecheck
```

## Recovery

- **Restart during pause:** pipeline state, incident, sequence, and pending writes are in Postgres. Start the gate again; resume from the console if needed.
- **Lost HTTP response:** retry with the same `idempotencyKey`.
- **n8n unreachable:** write still commits/kicks; outbox retries then gives up after 8 attempts.
- **Reset local data:** `docker compose down -v` then `docker compose up -d`. Rules reload from YAML on empty `rules_config`.

## v1 limits (do not claim otherwise)

- `actor` is a name in the audit log, not authentication.
- LLM payload redaction is ids-only, not full PII stripping.
- Outbox delivery is HTTP at-least-once, not BullMQ exactly-once.
- Only writes that pass through this gate are protected.
