import { randomUUID } from "node:crypto";
import { DatabaseError, fromTimestamp, openConnection } from "@loom/db-exasol";
const connection = await openConnection();
const id = randomUUID();
try {
  const [{ BOUND_VALUE }] = await connection.session.query(
    "SELECT CAST(? AS DECIMAL(18,0)) AS BOUND_VALUE FROM DUAL",
    [42],
  );
  if (Number(BOUND_VALUE) !== 42) throw new Error("Prepared binding failed.");
  let prepareRejected = false;
  try {
    await connection.session.query(
      `SELECT ID FROM MISSING_${id.replaceAll("-", "")} WHERE ID = ?`,
      [id],
    );
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    prepareRejected = true;
  }
  if (!prepareRejected)
    throw new Error("Expected a missing-table prepare error.");
  const [afterError] = await connection.session.query(
    "SELECT CAST(? AS DECIMAL(18,0)) AS BOUND_VALUE FROM DUAL",
    [42],
  );
  if (Number(afterError.BOUND_VALUE) !== 42)
    throw new Error("Prepared statement failure leaked the connection.");
  await connection.session.execute(
    "INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)",
    [id, "Rollback check"],
  );
  let duplicateRejected = false;
  try {
    await connection.session.execute(
      "INSERT INTO WORKSPACES (ID,NAME) VALUES (?,?)",
      [id, "Duplicate must fail"],
    );
  } catch {
    duplicateRejected = true;
  }
  await connection.rollback();
  if (!duplicateRejected)
    throw new Error("Enabled primary key did not reject a duplicate.");
  const rows = await connection.session.query(
    "SELECT ID FROM WORKSPACES WHERE ID = ?",
    [id],
  );
  if (rows.length) throw new Error("Rollback left a row behind.");
  const [mapping] = await connection.session.query(
    "SELECT CAST(? AS TIMESTAMP) AS UTC_VALUE, CAST(? AS DECIMAL(18,0)) AS EXACT_VALUE, CAST(? AS VARCHAR(10)) AS EMPTY_VALUE FROM DUAL",
    ["2026-10-21 12:00:00.123", "9007199254740991", ""],
  );
  if (
    Number(mapping.EXACT_VALUE) !== 9007199254740991 ||
    mapping.EMPTY_VALUE !== null
  )
    throw new Error("Unexpected scalar mapping.");
  if (fromTimestamp(mapping.UTC_VALUE) !== "2026-10-21T12:00:00.123Z")
    throw new Error("UTC timestamp round trip failed.");
  const [metadata] = await connection.session.query(
    "SELECT PARAM_VALUE FROM EXA_METADATA WHERE PARAM_NAME = 'databaseProductVersion'",
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        databaseVersion: metadata?.PARAM_VALUE,
        checks: [
          "TLS connection",
          "prepared bindings",
          "prepare failure recovery",
          "enabled primary key",
          "rollback",
          "exact numeric and empty-string mapping",
          "UTC timestamp round trip",
        ],
        timestamp: mapping.UTC_VALUE,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await connection.rollback().catch(() => undefined);
  console.error(
    error instanceof DatabaseError
      ? `Check SQL ${error.sqlCode}: ${error.sqlDetail || error.message}`
      : error instanceof Error
        ? error.message
        : "Exasol check failed.",
  );
  process.exitCode = 1;
} finally {
  await connection.close();
}
