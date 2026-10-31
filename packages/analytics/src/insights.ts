import { createHash } from "node:crypto";
import type {
  Actor,
  ActiveStatus,
  AnalyticsInsights,
  InsightQueryEvidence,
} from "@loom/contracts";
import { sqlTimestamp, type SqlSession, type Row } from "@loom/db-exasol";

const activeStatuses: ActiveStatus[] = [
  "new",
  "needs_info",
  "ready",
  "in_progress",
];
const terminal = "('done','cancelled')";

// All SQL is code-owned. The caller must authorize owner/operator access first.
// Read every event before the cutoff before applying the reporting window: an
// event predating the window can own an interval extending into the window.
const eventCte = `WITH bounds AS (
  SELECT CAST(? AS TIMESTAMP) AS window_start, CAST(? AS TIMESTAMP) AS as_of FROM DUAL
), ordered_events AS (
  SELECT E.REQUEST_ID,E.STATUS,E.VERSION,E.CREATED_AT,
    LEAD(E.CREATED_AT) OVER (PARTITION BY E.REQUEST_ID ORDER BY E.CREATED_AT,E.VERSION,E.ID) AS next_at,
    LAG(E.STATUS) OVER (PARTITION BY E.REQUEST_ID ORDER BY E.CREATED_AT,E.VERSION,E.ID) AS previous_status
  FROM REQUEST_EVENTS E CROSS JOIN bounds B
  WHERE E.WORKSPACE_ID=? AND E.CREATED_AT < B.as_of
)`;
const intervalCte = `${eventCte}, intervals AS (
  SELECT E.REQUEST_ID,E.STATUS,E.VERSION,
    CAST(SECONDS_BETWEEN(LEAST(COALESCE(E.next_at,B.as_of),B.as_of),GREATEST(E.CREATED_AT,B.window_start)) AS DOUBLE)/3600.0 AS hours
  FROM ordered_events E CROSS JOIN bounds B
  WHERE E.STATUS NOT IN ${terminal} AND E.CREATED_AT < B.as_of
    AND COALESCE(E.next_at,B.as_of) > B.window_start
), request_phase AS (
  SELECT REQUEST_ID,STATUS,SUM(hours) AS hours,MIN(VERSION) AS first_version,MAX(VERSION) AS last_version
  FROM intervals WHERE hours > 0 GROUP BY REQUEST_ID,STATUS
)`;

export const phaseInsightsSql = `${intervalCte}
SELECT DISTINCT STATUS,
 COUNT(*) OVER (PARTITION BY STATUS) AS REQUEST_COUNT,
 SUM(hours) OVER (PARTITION BY STATUS) AS TOTAL_HOURS,
 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hours) OVER (PARTITION BY STATUS) AS MEDIAN_HOURS,
 PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY hours) OVER (PARTITION BY STATUS) AS P90_HOURS
FROM request_phase ORDER BY STATUS`;

export const recordInsightsSql = `${intervalCte}
SELECT P.REQUEST_ID,R.TITLE,
 SUM(CASE WHEN P.STATUS='new' THEN P.hours ELSE 0 END) AS NEW_HOURS,
 SUM(CASE WHEN P.STATUS='needs_info' THEN P.hours ELSE 0 END) AS NEEDS_INFO_HOURS,
 SUM(CASE WHEN P.STATUS='ready' THEN P.hours ELSE 0 END) AS READY_HOURS,
 SUM(CASE WHEN P.STATUS='in_progress' THEN P.hours ELSE 0 END) AS IN_PROGRESS_HOURS,
 MIN(P.first_version) AS FIRST_VERSION,MAX(P.last_version) AS LAST_VERSION
FROM request_phase P JOIN REQUESTS R ON R.ID=P.REQUEST_ID AND R.WORKSPACE_ID=?
GROUP BY P.REQUEST_ID,R.TITLE ORDER BY SUM(P.hours) DESC,P.REQUEST_ID LIMIT 51`;

export const ownerInsightsSql = `WITH bounds AS (SELECT CAST(? AS TIMESTAMP) AS as_of FROM DUAL)
SELECT R.OWNER_ID,COALESCE(M.NAME,'Unassigned') AS OWNER_NAME,
 COUNT(*) AS OPEN_COUNT,
 SUM(CASE WHEN R.DUE_AT < CAST(B.as_of AS DATE) THEN 1 ELSE 0 END) AS OVERDUE_COUNT,
 SUM(CASE WHEN SECONDS_BETWEEN(B.as_of,R.CREATED_AT) < 604800 THEN 1 ELSE 0 END) AS UNDER_7,
 SUM(CASE WHEN SECONDS_BETWEEN(B.as_of,R.CREATED_AT) >= 604800 AND SECONDS_BETWEEN(B.as_of,R.CREATED_AT) < 1209600 THEN 1 ELSE 0 END) AS DAYS_7_14,
 SUM(CASE WHEN SECONDS_BETWEEN(B.as_of,R.CREATED_AT) >= 1209600 THEN 1 ELSE 0 END) AS DAYS_14_PLUS,
 MAX(CAST(SECONDS_BETWEEN(B.as_of,R.CREATED_AT) AS DOUBLE)/3600.0) AS OLDEST_HOURS
FROM REQUESTS R CROSS JOIN bounds B
LEFT JOIN MEMBERSHIPS M ON M.WORKSPACE_ID=R.WORKSPACE_ID AND M.USER_ID=R.OWNER_ID
WHERE R.WORKSPACE_ID=? AND R.STATUS NOT IN ${terminal} AND R.CREATED_AT < B.as_of
GROUP BY R.OWNER_ID,M.NAME ORDER BY OPEN_COUNT DESC,OWNER_NAME,R.OWNER_ID LIMIT 101`;

export function insightWindow(days: 30 | 90, at = new Date()) {
  if (![30, 90].includes(days) || !Number.isFinite(at.getTime()))
    throw new Error("Choose a valid 30-day or 90-day reporting window.");
  const asOf = at.toISOString();
  const from = new Date(at.getTime() - days * 86400000).toISOString();
  const monday = new Date(from);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weeks: string[] = [];
  for (let time = monday.getTime(); time < at.getTime(); time += 7 * 86400000)
    weeks.push(new Date(time).toISOString().slice(0, 10));
  return { asOf, from, weeks };
}

export function flowInsightsSql(weekCount: number) {
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 14)
    throw new Error("The reporting window must contain 1–14 weeks.");
  // Only bounded SQL structure is generated; dates and workspace remain bound.
  const weeks = Array.from(
    { length: weekCount },
    () => "SELECT CAST(? AS DATE) AS week_start FROM DUAL",
  ).join(" UNION ALL ");
  return `${eventCte}, weeks AS (${weeks}), before_window AS (
    SELECT STATUS,ROW_NUMBER() OVER (PARTITION BY REQUEST_ID ORDER BY CREATED_AT DESC,VERSION DESC) AS latest
    FROM ordered_events CROSS JOIN bounds WHERE CREATED_AT < window_start
  ), baseline AS (
    SELECT COUNT(*) AS backlog FROM before_window WHERE latest=1 AND STATUS NOT IN ${terminal}
  ), flow_events AS (
    SELECT R.CREATED_AT AS happened_at,1 AS incoming,0 AS completions,0 AS cancellations,0 AS reopens,0 AS delta
    FROM REQUESTS R CROSS JOIN bounds B WHERE R.WORKSPACE_ID=? AND R.CREATED_AT>=B.window_start AND R.CREATED_AT<B.as_of
    UNION ALL
    SELECT E.CREATED_AT,0,
      CASE WHEN E.STATUS='done' AND (E.previous_status IS NULL OR E.previous_status<>'done') THEN 1 ELSE 0 END,
      CASE WHEN E.STATUS='cancelled' AND (E.previous_status IS NULL OR E.previous_status<>'cancelled') THEN 1 ELSE 0 END,
      CASE WHEN E.previous_status IN ${terminal} AND E.STATUS NOT IN ${terminal} THEN 1 ELSE 0 END,
      CASE WHEN (E.previous_status IS NULL OR E.previous_status IN ${terminal}) AND E.STATUS NOT IN ${terminal} THEN 1
           WHEN E.previous_status NOT IN ${terminal} AND E.STATUS IN ${terminal} THEN -1 ELSE 0 END
    FROM ordered_events E CROSS JOIN bounds B WHERE E.CREATED_AT>=B.window_start AND E.CREATED_AT<B.as_of
  ), weekly AS (
    SELECT W.week_start,COALESCE(SUM(F.incoming),0) AS incoming,COALESCE(SUM(F.completions),0) AS completions,
      COALESCE(SUM(F.cancellations),0) AS cancellations,COALESCE(SUM(F.reopens),0) AS reopens,COALESCE(SUM(F.delta),0) AS delta
    FROM weeks W LEFT JOIN flow_events F ON TRUNC(F.happened_at,'IW')=W.week_start GROUP BY W.week_start
  )
  SELECT W.week_start,W.incoming,W.completions,W.cancellations,W.reopens,
    B.backlog+SUM(W.delta) OVER (ORDER BY W.week_start ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ending_backlog
  FROM weekly W CROSS JOIN baseline B ORDER BY W.week_start`;
}

const n = (row: Row, key: string) => Number(row[key] ?? 0);

export async function analyticsInsights(
  sql: SqlSession,
  actor: Actor,
  days: 30 | 90,
  at = new Date(),
  includeRecords = true,
): Promise<AnalyticsInsights> {
  const window = insightWindow(days, at);
  const bound = [
    sqlTimestamp(window.from),
    sqlTimestamp(window.asOf),
    actor.workspaceId,
  ];
  const evidence: InsightQueryEvidence[] = [];
  async function query(
    queryId: string,
    statement: string,
    parameters: unknown[],
  ) {
    const started = performance.now();
    const rows = await sql.query(statement, parameters);
    evidence.push({
      queryId,
      sqlHash: createHash("sha256").update(statement).digest("hex"),
      durationMs: Math.round(performance.now() - started),
      returnedRows: rows.length,
    });
    return rows;
  }
  // One connection/transaction, sequential statements, with one shared cutoff.
  const phaseRows = await query(
    "request-phase-hours-v1",
    phaseInsightsSql,
    bound,
  );
  const flowRows = await query(
    "weekly-request-flow-v1",
    flowInsightsSql(window.weeks.length),
    [...bound, ...window.weeks, actor.workspaceId],
  );
  const ownerRows = await query("current-owner-aging-v1", ownerInsightsSql, [
    sqlTimestamp(window.asOf),
    actor.workspaceId,
  ]);
  const recordRows = includeRecords
    ? await query("request-phase-evidence-v1", recordInsightsSql, [
        ...bound,
        actor.workspaceId,
      ])
    : [];
  return {
    workspaceId: actor.workspaceId,
    days,
    from: window.from,
    asOf: window.asOf,
    phases: activeStatuses.map((status) => {
      const row = phaseRows.find((row) => row.STATUS === status);
      return {
        status,
        requestCount: row ? n(row, "REQUEST_COUNT") : 0,
        totalHours: row ? n(row, "TOTAL_HOURS") : 0,
        medianHours: row ? n(row, "MEDIAN_HOURS") : null,
        p90Hours: row ? n(row, "P90_HOURS") : null,
      };
    }),
    flow: flowRows.map((row) => ({
      weekStart: String(row.WEEK_START).slice(0, 10),
      incoming: n(row, "INCOMING"),
      completions: n(row, "COMPLETIONS"),
      cancellations: n(row, "CANCELLATIONS"),
      reopens: n(row, "REOPENS"),
      endingBacklog: n(row, "ENDING_BACKLOG"),
    })),
    owners: ownerRows.slice(0, 100).map((row) => ({
      ownerId: row.OWNER_ID ? String(row.OWNER_ID) : null,
      ownerName: String(row.OWNER_NAME),
      open: n(row, "OPEN_COUNT"),
      overdue: n(row, "OVERDUE_COUNT"),
      under7Days: n(row, "UNDER_7"),
      days7To14: n(row, "DAYS_7_14"),
      days14Plus: n(row, "DAYS_14_PLUS"),
      oldestHours: n(row, "OLDEST_HOURS"),
    })),
    records: recordRows.slice(0, 50).map((row) => ({
      id: String(row.REQUEST_ID),
      title: String(row.TITLE),
      newHours: n(row, "NEW_HOURS"),
      needsInfoHours: n(row, "NEEDS_INFO_HOURS"),
      readyHours: n(row, "READY_HOURS"),
      inProgressHours: n(row, "IN_PROGRESS_HOURS"),
      firstEventVersion: n(row, "FIRST_VERSION"),
      lastEventVersion: n(row, "LAST_VERSION"),
    })),
    hasMore: {
      owners: ownerRows.length > 100,
      records: recordRows.length > 50,
    },
    evidence,
    semantics: {
      period:
        "Rolling UTC window: start included, cutoff excluded. First and last ISO weeks may be partial.",
      duration:
        "Elapsed calendar hours per request in each active status, clipped to the window; repeated visits are summed. Current intervals end at the cutoff. Done/cancelled intervals are excluded. Medians and p90 use only requests with positive time in that status; these are not completed-request turnaround times or analyst effort.",
      flow: "Incoming counts newly created requests. Completions, cancellations and reopens count status transitions, so one request can count more than once. Ending backlog includes work created before the window and removes closed intervals until reopened.",
      workload:
        "Current open requests grouped by current owner, across all creation dates. Age is calendar time since creation, including any earlier closed time. Overdue means due date before the cutoff's UTC date. Counts describe workload, not available capacity.",
    },
  };
}
