# HTTP API

Base URL (local): `http://localhost:3001`. `/v1` is the documented surface. Legacy routes share the same handlers so the console keeps working.

Optional header: `x-trace-id`.

## Writes

### `POST /v1/writes` (= `POST /write`)

Body:

```json
{
  "table": "users",
  "record": { "id": "u_1", "name": "Ada", "email": "ada@example.com", "signupAt": "2026-10-23T00:00:00.000Z" },
  "idempotencyKey": "write-1",
  "pipelineId": "default"
}
```

`table` and `record` are required. `pipelineId` defaults to `default`. Supported tables: `users`, `orders`.

| Status | Body |
|--------|------|
| 201 | `{ status: "committed", operationId, sequenceNo, traceId }` |
| 202 | `{ status: "queued", position, operationId, sequenceNo, traceId }` |
| 422 | `{ status: "kicked", incident, operationId, sequenceNo, traceId }` |
| 409 | idempotency key reused with a different payload |
| 200 | `{ status: "duplicate", ... }` idempotent replay of a commit |
| 400 | unknown table or missing envelope |

## Operations

`GET /v1/operations/:id` — durable operation row.

## Incidents

`GET /v1/incidents?state=open&pipeline=&limit=50`  
`GET /v1/incidents/:id` — includes `version`, `operation_id`, `similar`

Decision body: `{ actor?, version?, fix?, record?, editedFields? }`

| Method | Path | Effect |
|--------|------|--------|
| POST | `/v1/incidents/:id/approve` | Apply proposed or supplied fix; full revalidation |
| POST | `/v1/incidents/:id/edit-approve` | Edited record then approve; no new fields |
| POST | `/v1/incidents/:id/reject` | Reject; pipeline does not auto-resume unless idle |
| POST | `/incidents/:id/abort` | Legacy: drop held queue for that pipeline |

Stale `version` → 409, no state change.

## Pipelines

| Method | Path |
|--------|------|
| GET | `/v1/pipelines` |
| GET | `/v1/pipelines/:id/status` |
| POST | `/v1/pipelines/:id/pause` |
| POST | `/v1/pipelines/:id/resume` |
| POST | `/v1/pipelines/:id/abort` |

Abort reports committed / rejected / dropped counts. Committed rows stay committed.

## Rules and observability

| Method | Path |
|--------|------|
| GET | `/rules/:table` |
| POST | `/rules/reload` |
| GET | `/v1/metrics` |
| GET | `/health` |
| GET | `/v1/stream` | SSE; reconnect by reading the API, not by replaying missed events |

`/health` is `ok` when Postgres answers. Redis is reported separately and is not required.

## n8n webhook (outbound)

The gate POSTs to `N8N_WEBHOOK_URL` after a durable kick or queued write:

```json
{
  "status": "kicked",
  "table": "orders",
  "pipelineId": "default",
  "operationId": "op_…",
  "sequenceNo": 12,
  "traceId": "…",
  "incident": {
    "id": "inc_…",
    "severity": "high",
    "check": "B4_TOTAL_RANGE",
    "explanation": "…"
  }
}
```

The published workflow **ErrorKicker Incident Router** classifies this as 422 / 201 / 202 / 400. That HTTP code is the router’s reply, not a failure of the gate write.
