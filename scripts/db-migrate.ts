import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseError, openConnection, schemaName } from "@loom/db-exasol";
const connection = await openConnection(false);
try {
  const schema = schemaName();
  await connection.session.execute(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await connection.session.execute(`OPEN SCHEMA ${schema}`);
  await connection.session.execute(
    "CREATE TABLE IF NOT EXISTS SCHEMA_MIGRATIONS (VERSION VARCHAR(40) NOT NULL, CONTENT_HASH VARCHAR(64) NOT NULL, CONSTRAINT PK_SCHEMA_MIGRATIONS PRIMARY KEY (VERSION) ENABLE)",
  );
  const files = (await readdir("exasol/migrations"))
    .filter((file) => /^\d{3}_[a-z_]+\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const version = file.slice(0, -4);
    const sql = await readFile(`exasol/migrations/${file}`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const rows = await connection.session.query(
      "SELECT CONTENT_HASH FROM SCHEMA_MIGRATIONS WHERE VERSION = ?",
      [version],
    );
    if (rows[0]) {
      if (rows[0].CONTENT_HASH !== hash)
        throw new Error(
          "Applied migration checksum changed. Add a new migration instead.",
        );
      console.log(`${version} already applied.`);
    } else {
      for (const statement of sql
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await connection.session.execute(statement);
      await connection.session.execute(
        "INSERT INTO SCHEMA_MIGRATIONS (VERSION,CONTENT_HASH) VALUES (?,?)",
        [version, hash],
      );
      await connection.commit();
      console.log(`Applied ${version}.`);
    }
  }
} catch (error) {
  await connection.rollback().catch(() => undefined);
  console.error(
    error instanceof DatabaseError
      ? `Migration SQL ${error.sqlCode}: ${error.sqlDetail || error.message}`
      : error instanceof Error
        ? error.message
        : "Migration failed.",
  );
  process.exitCode = 1;
} finally {
  await connection.close();
}
