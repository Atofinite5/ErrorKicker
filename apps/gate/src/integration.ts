// Live HTTP checks against a running gate. Skip unless GATE_INTEGRATION=1.
// npm run integration  (needs docker compose + gate)
const GATE = process.env.GATE_URL ?? "http://localhost:3001";
const KEY = process.env.WRITE_API_KEY ?? "";

if (process.env.GATE_INTEGRATION !== "1") {
  console.log("skip integration (set GATE_INTEGRATION=1)");
  process.exit(0);
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (KEY) h.authorization = `Bearer ${KEY}`;
  return h;
}

async function main() {
  const health = await fetch(`${GATE}/health`);
  if (!health.ok) throw new Error("health failed");
  const body = (await health.json()) as { ok?: boolean };
  if (!body.ok) throw new Error("postgres not ok");

  const id = `u_it_${Date.now()}`;
  const res = await fetch(`${GATE}/v1/writes`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      table: "users",
      record: { id, name: "Ada Lovelace", email: "ada@example.com", signupAt: "2026-10-23T00:00:00.000Z" },
      idempotencyKey: `it-${id}`,
    }),
  });
  if (res.status !== 201 && res.status !== 401) {
    throw new Error(`unexpected write status ${res.status} ${await res.text()}`);
  }
  if (res.status === 401) {
    console.log("integration: auth is on and WRITE_API_KEY is missing — health passed");
    return;
  }
  console.log("integration: committed a user write");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
