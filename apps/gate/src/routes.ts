import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  approveIncident,
  abortIncident,
  abortPipeline,
  commitWrite,
  editApproveIncident,
  evaluateWrite,
  kickWrite,
  pausePipeline,
  pipelineStatus,
  rejectIncident,
  resumePipeline,
} from "./gate.ts";
import {
  checkIdempotency,
  decideIdempotency,
  requestHash,
  storeIdempotency,
} from "./dedup.ts";
import { loadRules, reloadRules } from "./rules.ts";
import {
  countOpenIncidents,
  getIncident,
  listIncidents,
  similarIncidents,
} from "./incidents.ts";
import {
  bus,
  emitEvent,
  metricsSnapshot,
  recordWrite,
  type GateEvent,
} from "./metrics.ts";
import { buildNotifyEvent } from "./notify.ts";
import {
  createOperation,
  getOperation,
  insertOutboxEvent,
  publishPendingOutbox,
  updateOperationStatus,
} from "./operations.ts";
import {
  enqueueWhilePaused,
  getPipeline,
  listPipelines,
} from "./pause.ts";
import { isRedisUp } from "./redis.ts";
import { pool } from "./db.ts";

// ---------------------------------------------------------------------------
// PRD Arch §10 API surface. Every /v1 route has a legacy twin (registered
// with the same handler) so the existing console keeps working unchanged:
//   POST /v1/writes            = POST /write
//   GET  /v1/incidents[/:id]   = GET  /incidents[/:id]
//   POST /v1/incidents/:id/{approve,edit-approve,reject}
//                              = POST /incidents/:id/{approve,reject}
//   POST /v1/pipelines/:id/{pause,resume,abort}, GET /v1/pipelines/:id/status
//   GET  /v1/metrics           = GET  /metrics
//   GET  /v1/stream            = GET  /stream
// Incident decisions accept `version` in the body: a stale version is a 409
// with no state change (FR-06). Version is enforced whenever the client
// sends it; legacy console calls send none and fall back to the state check
// (documented compromise in README).
// ---------------------------------------------------------------------------

function errStatus(e: unknown): number {
  return (e as { statusCode?: number }).statusCode ?? 500;
}

interface DecisionBody {
  fix?: Record<string, unknown>;
  record?: Record<string, unknown>;
  editedFields?: Record<string, unknown>;
  actor?: string;
  version?: number;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- the write path -------------------------------------------------------
  const writeHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const traceId =
      (req.headers["x-trace-id"] as string | undefined) ?? randomUUID();
    const body = req.body as {
      table?: string;
      record?: Record<string, unknown>;
      idempotencyKey?: string;
      pipelineId?: string;
    };
    if (!body?.table || !body?.record)
      return reply.code(400).send({ error: "body needs { table, record, idempotencyKey?, pipelineId? }" });
    const pipelineId = body.pipelineId ?? "default";
    const key = body.idempotencyKey;

    try {
      // FR-02 (PostgreSQL): replay same-key/same-payload, 409 on
      // same-key/different-payload — BEFORE any evaluation or operation.
      if (key) {
        const hit = await checkIdempotency(key);
        if (hit) {
          const decision = decideIdempotency(hit.recordHash, requestHash(body.table, body.record));
          if (decision === "conflict")
            return reply.code(409).send({
              error: "idempotency conflict: this key was already used with a different payload",
              operationId: hit.operationId,
              traceId,
            });
          // replay: return the previous durable result, never re-run.
          if (hit.result === "committed") {
            recordWrite("pass");
            return reply.code(200).send({
              status: "duplicate",
              detail: "idempotent replay of a committed write",
              operationId: hit.operationId,
              traceId,
            });
          }
          if (hit.result === "kicked")
            return reply.code(422).send({
              status: "kicked",
              incidentId: hit.incidentId,
              replay: true,
              operationId: hit.operationId,
              traceId,
            });
          return reply.code(202).send({
            status: "queued",
            replay: true,
            operationId: hit.operationId,
            traceId,
          });
        }
      }

      // Durable operation row first (sequence = per-pipeline order, FR-09).
      const { operationId, sequenceNo } = await createOperation({
        pipelineId,
        table: body.table,
        record: body.record,
        requestHash: requestHash(body.table, body.record),
        idempotencyKey: key,
      });

      const verdict = await evaluateWrite({
        table: body.table,
        record: body.record,
        idempotencyKey: key,
        traceId,
      });

      if (verdict.kind === "noop") {
        await updateOperationStatus(operationId, "REPLAYED", { detail: verdict.detail });
        recordWrite("pass");
        return { status: "duplicate", detail: verdict.detail, operationId, sequenceNo, traceId };
      }

      if (verdict.kind === "kick") {
        const incident = await kickWrite(pipelineId, traceId, body.table, body.record, verdict, {
          operationId,
          sequenceNo,
          pipelineId,
          idempotencyKey: key,
        });
        void publishPendingOutbox().catch(() => undefined);
        return reply.code(422).send({ status: "kicked", incident, operationId, sequenceNo, traceId });
      }

      // pass — re-check the pipeline state at commit time (Arch §5: a
      // read-only check long before the commit is not enough).
      const pipe = await getPipeline(pipelineId);
      if (pipe.state === "PAUSED_AWAITING_REVIEW" || pipe.state === "ABORTED") {
        const position = await enqueueWhilePaused(pipelineId, {
          table: body.table,
          record: verdict.record,
          idempotencyKey: key,
          traceId,
          operationId,
          sequenceNo,
        });
        await updateOperationStatus(operationId, "QUEUED", { position });
        if (key)
          await storeIdempotency(key, requestHash(body.table, body.record), "queued", undefined, {
            operationId,
            resultJson: { status: "queued", position },
          });
        await insertOutboxEvent(
          operationId,
          "write.queued",
          buildNotifyEvent({
            status: "queued",
            table: body.table,
            pipelineId,
            operationId,
            sequenceNo,
            traceId,
          }),
        );
        void publishPendingOutbox().catch(() => undefined);
        recordWrite("queued");
        emitEvent({ type: "metrics", metrics: metricsSnapshot() });
        return reply.code(202).send({ status: "queued", position, operationId, sequenceNo, traceId });
      }
      await commitWrite(body.table, verdict.record, key, { operationId, sequenceNo, pipelineId });
      void publishPendingOutbox().catch(() => undefined);
      recordWrite("pass");
      emitEvent({ type: "metrics", metrics: metricsSnapshot() });
      return reply.code(201).send({ status: "committed", operationId, sequenceNo, traceId });
    } catch (e) {
      req.log.error(e);
      return reply.code(errStatus(e)).send({ error: (e as Error).message, traceId });
    }
  };
  app.post("/write", writeHandler);
  app.post("/v1/writes", writeHandler);

  // --- operations ------------------------------------------------------------
  app.get("/v1/operations/:id", async (req, reply) => {
    const op = await getOperation((req.params as { id: string }).id);
    if (!op) return reply.code(404).send({ error: "operation not found" });
    return op;
  });

  // --- incidents --------------------------------------------------------------
  const listIncidentsHandler = async (req: FastifyRequest) => {
    const q = req.query as { state?: string; pipeline?: string; limit?: string };
    return listIncidents({
      state: q.state,
      pipelineId: q.pipeline,
      limit: q.limit ? Number(q.limit) : 50,
    });
  };
  app.get("/incidents", listIncidentsHandler);
  app.get("/v1/incidents", listIncidentsHandler);

  const getIncidentHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const inc = await getIncident((req.params as { id: string }).id);
    if (!inc) return reply.code(404).send({ error: "incident not found" });
    return { ...inc, similar: await similarIncidents(inc) };
  };
  app.get("/incidents/:id", getIncidentHandler);
  app.get("/v1/incidents/:id", getIncidentHandler);

  const approveHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as DecisionBody;
    try {
      return await approveIncident(id, body.fix, body.actor ?? "reviewer", body.version);
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  };
  app.post("/incidents/:id/approve", approveHandler);
  app.post("/v1/incidents/:id/approve", approveHandler);

  app.post("/v1/incidents/:id/edit-approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as DecisionBody;
    try {
      return await editApproveIncident(
        id,
        { fix: body.fix, record: body.record, editedFields: body.editedFields },
        body.actor ?? "reviewer",
        body.version,
      );
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  });

  const rejectHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as DecisionBody;
    try {
      return await rejectIncident(id, body.actor ?? "reviewer", body.version);
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  };
  app.post("/incidents/:id/reject", rejectHandler);
  app.post("/v1/incidents/:id/reject", rejectHandler);

  app.post("/incidents/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { actor?: string };
    try {
      return await abortIncident(id, body.actor ?? "reviewer");
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  });

  // --- pipelines ---------------------------------------------------------------
  const listPipelinesHandler = async () => {
    const pipes = await listPipelines();
    const out = [];
    for (const p of pipes) {
      out.push({
        ...p,
        queued_count: Number(p.queued_count),
        next_sequence: Number(p.next_sequence),
        last_completed_sequence: Number(p.last_completed_sequence),
        openIncidents: await countOpenIncidents(p.pipeline_id),
      });
    }
    return out;
  };
  app.get("/pipelines", listPipelinesHandler);
  app.get("/v1/pipelines", listPipelinesHandler);

  app.get("/v1/pipelines/:id/status", async (req, reply) => {
    try {
      return await pipelineStatus((req.params as { id: string }).id);
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  });

  app.post("/v1/pipelines/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { actor?: string };
    try {
      return await pausePipeline(id, body.actor ?? "reviewer");
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  });

  const resumeHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { actor?: string };
    try {
      return await resumePipeline(id, body.actor ?? "reviewer");
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  };
  app.post("/pipelines/:id/resume", resumeHandler);
  app.post("/v1/pipelines/:id/resume", resumeHandler);

  app.post("/v1/pipelines/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { actor?: string };
    try {
      return await abortPipeline(id, body.actor ?? "reviewer");
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  });

  // --- rules (versioned, reloadable without redeploy) -------------------------
  app.get("/rules/:table", async (req, reply) => {
    try {
      return await loadRules((req.params as { table: string }).table);
    } catch (e) {
      return reply.code(errStatus(e)).send({ error: (e as Error).message });
    }
  });

  app.post("/rules/reload", async () => {
    reloadRules();
    return { status: "reloaded — rules re-read from the database on next write" };
  });

  // --- observability ------------------------------------------------------------
  const metricsHandler = async () => metricsSnapshot();
  app.get("/metrics", metricsHandler);
  app.get("/v1/metrics", metricsHandler);

  app.get("/health", async () => {
    let pg = false;
    try {
      await pool.query("SELECT 1");
      pg = true;
    } catch {
      pg = false;
    }
    // PRD: health = Postgres (authoritative store). Redis is reported for
    // visibility only — when it is down, alert dedup + the anomaly baseline
    // degrade and writes continue via Postgres.
    return {
      ok: pg,
      postgres: pg,
      redis: isRedisUp(),
      redisRole: "best-effort cache/async only — not authoritative",
      at: new Date().toISOString(),
    };
  });

  const streamHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (e: GateEvent) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    send({ type: "metrics", metrics: metricsSnapshot() });
    bus.on("event", send);
    req.raw.on("close", () => bus.off("event", send));
  };
  app.get("/stream", streamHandler);
  app.get("/v1/stream", streamHandler);
}
