import { readFile } from "node:fs/promises";
import {
  ExasolDriver,
  QueryResult,
  FetchCommand,
  CloseResultSetCommand,
  type ExaWebsocket,
  type FetchResponse,
  type SQLQueriesResponse,
  type SQLResponse,
} from "@exasol/exasol-driver-ts";
import WebSocket from "ws";

export type Row = Record<string, string | number | boolean | null>;
export interface SqlSession {
  query(sql: string, values?: unknown[]): Promise<Row[]>;
  execute(sql: string, values?: unknown[]): Promise<number>;
}
export class DatabaseUnavailable extends Error {
  constructor(
    message = "Exasol is not configured. Connect a database to save requests.",
  ) {
    super(message);
  }
}
export class DatabaseError extends Error {
  constructor(
    public sqlCode: string,
    message: string,
  ) {
    super(message);
  }
}
export function isConfigured(env = process.env): boolean {
  return Boolean(env.EXASOL_HOST && env.EXASOL_USER && env.EXASOL_PASSWORD);
}
export function schemaName(env = process.env): string {
  const schema = env.EXASOL_SCHEMA || "LOOM";
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(schema))
    throw new DatabaseUnavailable(
      "EXASOL_SCHEMA must be an uppercase SQL identifier.",
    );
  return schema;
}
function ensureOk<T>(result: SQLResponse<T>): T {
  if (result.status !== "ok")
    throw new DatabaseError(
      result.exception?.sqlCode ?? "UNKNOWN",
      "Exasol rejected the database operation.",
    );
  return result.responseData;
}
export async function openConnection(useSchema = true) {
  if (!isConfigured()) throw new DatabaseUnavailable();
  const host = process.env.EXASOL_HOST!;
  // A host only, never a URL or untrusted SQL/connection string.
  if (!/^[a-zA-Z0-9.:-]+$/.test(host))
    throw new DatabaseUnavailable(
      "EXASOL_HOST must be a hostname or IP address.",
    );
  const port = Number(process.env.EXASOL_PORT || 8563);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new DatabaseUnavailable("EXASOL_PORT must be a valid port.");
  const ca = process.env.EXASOL_CA_FILE
    ? await readFile(process.env.EXASOL_CA_FILE)
    : undefined;
  const socket: { current?: WebSocket } = {};
  const driver = new ExasolDriver(
    (url) => {
      socket.current = new WebSocket(url, {
        ca,
        rejectUnauthorized: true,
        handshakeTimeout: 10_000,
      });
      return socket.current as unknown as ExaWebsocket;
    },
    {
      host,
      port,
      user: process.env.EXASOL_USER,
      password: process.env.EXASOL_PASSWORD,
      autocommit: false,
      ...(useSchema ? { schema: schemaName() } : {}),
      clientName: "Loom",
      clientVersion: "0.1.0",
      resultSetMaxRows: 501,
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    socket.current?.terminate();
  }, 20_000);
  timer.unref();
  try {
    await driver.connect();
  } catch {
    clearTimeout(timer);
    socket.current?.terminate();
    await driver.close().catch(() => undefined);
    throw new DatabaseUnavailable(
      "Cannot connect to Exasol. Check the server, credentials, and trusted TLS certificate.",
    );
  }
  async function run(sql: string, values: unknown[] = []) {
    if (timedOut)
      throw new DatabaseUnavailable("The Exasol operation timed out.");
    if (!values.length)
      return ensureOk(await driver.query(sql, undefined, undefined, "raw"));
    const statement = await driver.prepare(sql);
    let response: SQLQueriesResponse;
    try {
      response = ensureOk(await statement.execute(...values));
    } finally {
      await statement.close();
    }
    // Prepared execution returns raw result sets in driver 0.8.1. Fetch every
    // page explicitly and close its cursor rather than silently dropping rows.
    for (const result of response.results) {
      const set = result.resultSet;
      if (!set) continue;
      try {
        if (set.numRows > 501)
          throw new DatabaseError(
            "RESULT_LIMIT",
            "Query exceeded the bounded result limit.",
          );
        while (set.numRowsInMessage < set.numRows) {
          if (set.resultSetHandle === undefined)
            throw new DatabaseError(
              "INCOMPLETE_RESULT",
              "Incomplete Exasol result.",
            );
          const page = ensureOk(
            await driver.sendCommand<FetchResponse>(
              new FetchCommand({
                resultSetHandle: set.resultSetHandle,
                startPosition: set.numRowsInMessage,
                numBytes: 1024 * 1024,
              }),
            ),
          );
          if (!page.numRows)
            throw new DatabaseError(
              "INCOMPLETE_RESULT",
              "Exasol returned an incomplete page.",
            );
          set.data ??= set.columns.map(() => []);
          page.data.forEach((column, i) => set.data![i].push(...column));
          set.numRowsInMessage += page.numRows;
        }
      } finally {
        if (set.resultSetHandle !== undefined)
          ensureOk(
            await driver.sendCommand(
              new CloseResultSetCommand([set.resultSetHandle]),
            ),
          );
      }
    }
    return response;
  }
  const session: SqlSession = {
    async query(sql, values) {
      const result = (await run(sql, values)).results[0];
      if (result?.resultType !== "resultSet")
        throw new DatabaseError("EXPECTED_ROWS", "Expected a query result.");
      return new QueryResult(result.resultSet).getRows();
    },
    async execute(sql, values) {
      const result = (await run(sql, values)).results[0];
      if (result?.resultType !== "rowCount" || result.rowCount === undefined)
        throw new DatabaseError(
          "EXPECTED_ROW_COUNT",
          "The database did not return an affected-row count.",
        );
      return result.rowCount;
    },
  };
  return {
    session,
    async commit() {
      ensureOk(await driver.query("COMMIT", undefined, undefined, "raw"));
    },
    async rollback() {
      ensureOk(await driver.query("ROLLBACK", undefined, undefined, "raw"));
    },
    async close() {
      clearTimeout(timer);
      await driver.close().catch(() => undefined);
    },
  };
}
export async function readDatabase<T>(
  work: (session: SqlSession) => Promise<T>,
): Promise<T> {
  const connection = await openConnection();
  try {
    return await work(connection.session);
  } finally {
    await connection.rollback().catch(() => undefined);
    await connection.close();
  }
}
// A process-wide symbol survives development reloads and separate route bundles.
const key = Symbol.for("loom.write-coordinator.v1");
const globalState = globalThis as typeof globalThis & {
  [key]?: { tail: Promise<void>; pending: number };
};
export const coordinatorState = (globalState[key] ??= {
  tail: Promise.resolve(),
  pending: 0,
});
export async function coordinateWrite<T>(work: () => Promise<T>): Promise<T> {
  if (coordinatorState.pending >= 100)
    throw new DatabaseUnavailable(
      "Too many pending writes. Try again shortly.",
    );
  coordinatorState.pending++;
  const previous = coordinatorState.tail;
  let release!: () => void;
  coordinatorState.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    coordinatorState.pending--;
    release();
  }
}
export async function writeDatabase<T>(
  work: (session: SqlSession) => Promise<T>,
): Promise<T> {
  return coordinateWrite(async () => {
    // Retry only an explicit serialization failure; never retry an unknown commit
    // outcome here. A client repeats the same command ID to reconcile its receipt.
    for (let attempt = 0; ; attempt++) {
      const connection = await openConnection();
      let committing = false;
      try {
        const result = await work(connection.session);
        committing = true;
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        if (
          !committing &&
          error instanceof DatabaseError &&
          error.sqlCode === "40001" &&
          attempt < 2
        )
          continue;
        throw error;
      } finally {
        await connection.close();
      }
    }
  });
}
export function sqlTimestamp(iso: string) {
  return iso.replace("T", " ").replace("Z", "");
}
export function fromTimestamp(value: unknown): string {
  if (typeof value !== "string")
    throw new DatabaseError(
      "INVALID_TIMESTAMP",
      "Unexpected database timestamp.",
    );
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Date(iso).toISOString();
}
