import type { AnalyticsResult, Actor } from "@loom/contracts";
import type { SqlSession } from "@loom/db-exasol";
export * from "./insights";
// This query is code-owned. Callers must authorize internal queue access first.
export const queueSummarySql = `SELECT
  COUNT(*) AS OPEN_COUNT,
  COALESCE(SUM(CASE WHEN DUE_AT < CURRENT_DATE THEN 1 ELSE 0 END),0) AS OVERDUE_COUNT,
  COALESCE(SUM(CASE WHEN OWNER_ID IS NULL THEN 1 ELSE 0 END),0) AS UNASSIGNED_COUNT,
  COALESCE(SUM(CASE WHEN REPORTING_PERIOD IS NULL OR DATASET IS NULL THEN 1 ELSE 0 END),0) AS INCOMPLETE_COUNT,
  COALESCE(MAX(DAYS_BETWEEN(CURRENT_TIMESTAMP, CREATED_AT)),0) AS OLDEST_AGE_DAYS
FROM REQUESTS WHERE WORKSPACE_ID = ? AND STATUS NOT IN ('done','cancelled')`;
export async function queueSummary(
  session: SqlSession,
  actor: Actor,
): Promise<AnalyticsResult> {
  const [row] = await session.query(queueSummarySql, [actor.workspaceId]);
  return {
    queryId: "queue-summary-v1",
    queriedAt: new Date().toISOString(),
    open: Number(row.OPEN_COUNT),
    overdue: Number(row.OVERDUE_COUNT),
    unassigned: Number(row.UNASSIGNED_COUNT),
    incomplete: Number(row.INCOMPLETE_COUNT),
    oldestAgeDays: Number(row.OLDEST_AGE_DAYS),
    rowCount: Number(row.OPEN_COUNT),
  };
}
