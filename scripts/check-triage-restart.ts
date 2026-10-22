import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  personas,
  workspaceId,
  type RunDetails,
  type TriageRun,
} from "@loom/contracts";
import { isConfigured, writeDatabase } from "@loom/db-exasol";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const origin = "http://127.0.0.1:3400",
  next = require.resolve("next/dist/bin/next");
const requestIds: string[] = [],
  commandIds: string[] = [];
let child: ChildProcess | null = null,
  cookie = "",
  runId: string | null = null;
if (!isConfigured())
  throw new Error(
    "Configure real Exasol and build the app before test:restart.",
  );
async function stop() {
  const processToStop = child;
  child = null;
  if (!processToStop || processToStop.exitCode !== null) return;
  const exited = once(processToStop, "exit");
  processToStop.kill("SIGTERM");
  const timeout = setTimeout(() => processToStop.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
async function boot() {
  try {
    await fetch(`${origin}/api/desk`, { signal: AbortSignal.timeout(1000) });
    throw new Error(
      "Port 3400 is already in use. Stop that process before running test:restart.",
    );
  } catch (error) {
    if ((error as Error).message.startsWith("Port 3400")) throw error;
  }
  child = spawn(
    process.execPath,
    [next, "start", "--hostname", "127.0.0.1", "--port", "3400"],
    {
      cwd: new URL("../apps/web", import.meta.url),
      stdio: "ignore",
      env: {
        ...process.env,
        APP_ORIGIN: origin,
        LOOM_AUTH_MODE: "local-demo",
        LOOM_ALLOW_DEMO_PRODUCTION: "true",
      },
    },
  );
  let spawnError = false;
  child.on("error", () => {
    spawnError = true;
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError || child.exitCode !== null)
      throw new Error(
        "The restart-check server failed to start. Run pnpm build first.",
      );
    try {
      const response = await fetch(`${origin}/api/desk`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 401) return;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The restart-check server did not become ready.");
}
async function call<T>(path: string, body?: object): Promise<T> {
  const commandId = body ? randomUUID() : null;
  if (commandId) commandIds.push(commandId);
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: body ? JSON.stringify({ ...body, commandId }) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `Restart check ${path} returned ${response.status} (${result.error?.code || "unknown"}).`,
    );
  return result as T;
}
try {
  await boot();
  const session = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ userId: personas[0].id }),
  });
  assert.equal(session.status, 200);
  cookie = session.headers.getSetCookie()[0]?.split(";")[0] || "";
  assert.ok(cookie, "Demo sign-in did not return a session.");
  for (let index = 0; index < 2; index++) {
    const record = await call<{ id: string }>("/api/requests", {
      values: {
        title: `Restart fixture ${randomUUID()}`,
        businessQuestion:
          "Can a fresh server resume an exact saved triage checkpoint?",
      },
    });
    requestIds.push(record.id);
  }
  const run = await call<TriageRun>("/api/runs", { requestIds });
  runId = run.id;
  const first = await call<RunDetails>(`/api/runs/${runId}`, {
    expectedVersion: 1,
    action: "advance",
  });
  assert.equal(first.run.checkpoint, 1);
  assert.equal(first.run.status, "running");
  const originalHash = first.proposals[0].hash;
  const firstPid = child!.pid;
  await stop();
  await boot();
  assert.notEqual(child!.pid, firstPid);
  const resumed = await call<RunDetails>(`/api/runs/${runId}`);
  assert.equal(resumed.run.checkpoint, 1);
  assert.equal(resumed.proposals[0].hash, originalHash);
  const completed = await call<RunDetails>(`/api/runs/${runId}`, {
    expectedVersion: resumed.run.version,
    action: "advance",
  });
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.steps.length, 2);
  assert.equal(completed.proposals.length, 2);
  for (const id of requestIds) {
    const result = await call<{ request: { version: number } }>(
      `/api/requests/${id}`,
    );
    assert.equal(
      result.request.version,
      1,
      "Triage must not apply request changes.",
    );
  }
  console.log(
    "Passed: a fresh production server resumed one saved checkpoint, preserved the proposal hash, and completed without changing requests.",
  );
} finally {
  await stop();
  // Remove only records and command IDs created by this verification invocation.
  await writeDatabase(async (sql) => {
    const proposalIds = runId
      ? (
          await sql.query(
            "SELECT ID FROM TRIAGE_PROPOSALS WHERE WORKSPACE_ID = ? AND RUN_ID = ?",
            [workspaceId, runId],
          )
        ).map((row) => String(row.ID))
      : [];
    if (runId) {
      for (const table of ["AGENT_STEPS", "TRIAGE_PROPOSALS"])
        await sql.execute(
          `DELETE FROM ${table} WHERE WORKSPACE_ID = ? AND RUN_ID = ?`,
          [workspaceId, runId],
        );
      await sql.execute(
        "DELETE FROM AGENT_RUNS WHERE WORKSPACE_ID = ? AND ID = ?",
        [workspaceId, runId],
      );
      for (const id of [runId, ...proposalIds])
        await sql.execute(
          "DELETE FROM AGENT_EVENTS WHERE WORKSPACE_ID = ? AND RESOURCE_ID = ?",
          [workspaceId, id],
        );
    }
    for (const id of requestIds)
      for (const table of [
        "COMMENTS",
        "REQUEST_EVENTS",
        "AUDIT_EVENTS",
        "OUTBOX_EVENTS",
        "REQUESTS",
      ])
        await sql.execute(
          `DELETE FROM ${table} WHERE WORKSPACE_ID = ? AND ${table === "REQUESTS" ? "ID" : "REQUEST_ID"} = ?`,
          [workspaceId, id],
        );
    for (const id of commandIds)
      await sql.execute(
        "DELETE FROM COMMAND_RECEIPTS WHERE WORKSPACE_ID = ? AND COMMAND_ID = ?",
        [workspaceId, id],
      );
  });
}
