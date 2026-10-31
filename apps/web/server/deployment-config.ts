import "server-only";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readDatabase, type Row } from "@loom/db-exasol";
import { localConfigurationErrors } from "../../../scripts/lib/local-config.mjs";

const cacheMs = 30_000;
const responseTimeoutMs = 5_000;
let cached: { ready: boolean; until: number } | undefined;
let pending: Promise<boolean> | undefined;

async function expectedMigrations() {
  // Both supported starts run with either the repository or apps/web as cwd.
  const directory = path.resolve(
    process.cwd(),
    process.cwd().endsWith(`${path.sep}apps${path.sep}web`) ? "../.." : ".",
    "exasol/migrations",
  );
  const files = (await readdir(directory))
    .filter((file) => /^\d{3}_[a-z_]+\.sql$/.test(file))
    .sort();
  if (!files.length) throw new Error("Migration manifest unavailable");
  return Promise.all(
    files.map(async (file) => ({
      VERSION: file.slice(0, -4),
      CONTENT_HASH: createHash("sha256")
        .update(await readFile(path.join(directory, file), "utf8"))
        .digest("hex"),
    })),
  );
}

export function migrationStateMatches(expected: Row[], actual: Row[]) {
  const hashes = new Map(actual.map((row) => [row.VERSION, row.CONTENT_HASH]));
  return (
    actual.length === expected.length &&
    hashes.size === expected.length &&
    expected.every((row) => hashes.get(row.VERSION) === row.CONTENT_HASH)
  );
}

async function probe(): Promise<boolean> {
  try {
    const expected = await expectedMigrations();
    return await readDatabase(async (sql) => {
      const [ping] = await sql.query("SELECT 1 AS READY");
      if (Number(ping?.READY) !== 1) return false;
      const actual = await sql.query(
        "SELECT VERSION,CONTENT_HASH FROM SCHEMA_MIGRATIONS ORDER BY VERSION",
      );
      return migrationStateMatches(expected, actual);
    });
  } catch {
    return false;
  }
}

export async function deploymentReady(): Promise<boolean> {
  if (localConfigurationErrors().length) return false;
  if (cached && cached.until > Date.now()) return cached.ready;
  if (!pending) {
    // Retain single-flight even if a caller's response times out. The existing
    // driver terminates the connection at its 20-second operation deadline.
    pending = probe()
      .then((ready) => {
        cached = { ready, until: Date.now() + cacheMs };
        return ready;
      })
      .finally(() => {
        pending = undefined;
      });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), responseTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
