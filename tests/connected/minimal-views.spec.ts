import { expect, test, type Page } from "@playwright/test";
import type {
  AnalyticsInsights,
  TeamMemorySnapshot,
} from "../../packages/contracts/src/index";
const origin = "http://127.0.0.1:3200";
async function register(page: Page) {
  const suffix = crypto.randomUUID();
  const response = await page.request.post("/api/account/register", {
    headers: { Origin: origin },
    data: {
      name: "Graph test",
      email: `${suffix}@example.com`,
      password: `Synthetic-${suffix}`,
      workspaceName: "Analytics team",
    },
  });
  expect(response.ok()).toBe(true);
}
const memory: TeamMemorySnapshot = {
  queriedAt: "2026-10-31T10:00:00Z",
  asOf: "2026-10-31",
  query: { q: "", kind: "all", dataset: "" },
  entries: [
    {
      score: 1,
      matchedBy: ["recent"],
      entry: {
        id: "source-1",
        workspaceId: "fixture",
        title: "Revenue definition",
        kind: "glossary",
        state: "approved",
        content: "Revenue excludes refunds and taxes.",
        dataset: "",
        ownerId: null,
        effectiveFrom: "2026-01-01",
        effectiveUntil: null,
        supersedesId: null,
        version: 1,
        createdBy: "person-0",
        approvedBy: "person-0",
        contentHash: "synthetic-test-content-hash",
        createdAt: "2026-10-01T00:00:00Z",
      },
    },
  ],
  graph: {
    nodes: [
      {
        id: "knowledge:source-1",
        kind: "knowledge",
        label: "Revenue definition",
        state: "approved",
        version: 1,
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `request:${i}`,
        kind: "request" as const,
        label: `Revenue request ${i + 1}`,
        state: "new",
      })),
    ],
    edges: Array.from({ length: 8 }, (_, i) => ({
      id: `edge-${i}`,
      from: `request:${i}`,
      to: "knowledge:source-1",
      relation: "cites" as const,
      evidence: {
        source: "proposal-record" as const,
        resourceId: `proposal-${i}`,
        version: 1,
        targetVersion: 1,
      },
    })),
  },
  timeline: [],
  limits: { knowledge: 100, requests: 100, proposals: 100, events: 100 },
  hasMore: {
    knowledge: false,
    requests: false,
    proposals: false,
    events: false,
  },
};
const insights: AnalyticsInsights = {
  workspaceId: "fixture",
  days: 30,
  from: "2026-10-01T00:00:00Z",
  asOf: "2026-10-31T00:00:00Z",
  phases: [
    {
      status: "new",
      requestCount: 8,
      medianHours: 12,
      p90Hours: 20,
      totalHours: 100,
    },
    {
      status: "needs_info",
      requestCount: 4,
      medianHours: 48,
      p90Hours: 60,
      totalHours: 200,
    },
    {
      status: "ready",
      requestCount: 4,
      medianHours: 8,
      p90Hours: 14,
      totalHours: 50,
    },
    {
      status: "in_progress",
      requestCount: 5,
      medianHours: 24,
      p90Hours: 38,
      totalHours: 130,
    },
  ],
  flow: [
    {
      weekStart: "2026-10-05",
      incoming: 10,
      completions: 4,
      cancellations: 0,
      reopens: 0,
      endingBacklog: 6,
    },
    {
      weekStart: "2026-10-12",
      incoming: 6,
      completions: 8,
      cancellations: 0,
      reopens: 0,
      endingBacklog: 4,
    },
    {
      weekStart: "2026-10-19",
      incoming: 8,
      completions: 5,
      cancellations: 0,
      reopens: 0,
      endingBacklog: 7,
    },
    {
      weekStart: "2026-10-26",
      incoming: 4,
      completions: 5,
      cancellations: 0,
      reopens: 0,
      endingBacklog: 6,
    },
  ],
  owners: [
    {
      ownerId: "owner-1",
      ownerName: "Alex",
      open: 6,
      overdue: 1,
      under7Days: 3,
      days7To14: 2,
      days14Plus: 1,
      oldestHours: 400,
    },
  ],
  records: [],
  hasMore: { owners: false, records: false },
  evidence: [],
  semantics: {
    period: "Selected period.",
    duration: "Elapsed stage time includes open work.",
    flow: "Counts reflect saved transitions.",
    workload: "Current requests, all dates.",
  },
};
test("knowledge graph follows saved edges, paginates neighbours and keeps sources and mobile readable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await register(page);
  await page.route("**/api/memory*", (route) =>
    route.fulfill({ json: memory }),
  );
  await page.goto("/app?view=knowledge");
  const graph = page.getByLabel("Saved relationship map");
  await expect(graph.locator(".knowledge-graph-focus")).toContainText(
    "Revenue definition",
  );
  await expect(graph.locator(".knowledge-graph-node")).toHaveCount(6);
  await expect(graph.locator("svg path")).toHaveCount(6);
  await page.screenshot({
    path: "test-results-connected/knowledge-graph-desktop.png",
    fullPage: true,
  });
  await graph.getByRole("button", { name: "Next", exact: true }).click();
  await expect(graph.locator(".knowledge-graph-node")).toHaveCount(2);
  await graph
    .getByRole("button", { name: /Explore Revenue request 8/ })
    .click();
  await expect(graph.locator(".knowledge-graph-focus")).toContainText(
    "Revenue request 8",
  );
  await expect(graph.locator(".knowledge-graph-node")).toHaveCount(1);
  await graph
    .getByRole("button", { name: /Explore Revenue definition/ })
    .click();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(
    page.getByText("Revenue excludes refunds and taxes.", { exact: true }),
  ).toBeHidden();
  await page.locator(".memory-source > summary").click();
  await expect(
    page.getByText("Revenue excludes refunds and taxes.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show in graph", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(graph.locator(".knowledge-graph-node")).toHaveCount(6);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results-connected/knowledge-graph-mobile.png",
    fullPage: true,
  });
  await page.route("**/api/memory*", (route) =>
    route.fulfill({
      json: { ...memory, entries: [], graph: { nodes: [], edges: [] } },
    }),
  );
  await page.reload();
  await expect(
    page.getByText(
      "Connections appear as your team saves requests and knowledge.",
    ),
  ).toBeVisible();
  await expect(page.locator(".knowledge-graph-node")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("insights show charts with exact values, keep evidence available, and handle an empty period", async ({
  page,
}) => {
  await register(page);
  await page.route("**/api/insights*", (route) =>
    route.fulfill({ json: insights }),
  );
  await page.goto("/app?view=insights");
  await expect(
    page.getByRole("heading", { name: "Weekly requests" }),
  ).toBeVisible();
  await expect(page.locator(".insights-week")).toHaveCount(4);
  await expect(page.locator(".insights-week").first()).toHaveAttribute(
    "aria-label",
    "Week 2026-10-05: 10 incoming, 4 completed, 6 backlog",
  );
  await expect(page.getByRole("table")).toBeHidden();
  await page.screenshot({
    path: "test-results-connected/insights-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stage time", exact: true }).click();
  await expect(page.locator(".insights-bar-row").nth(1)).toContainText("48 h");
  await page.getByRole("button", { name: "Workload", exact: true }).click();
  await expect(
    page.getByRole("img", {
      name: "3 under 7 days, 2 aged 7 to 14 days, 1 over 14 days",
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results-connected/insights-mobile.png",
    fullPage: true,
  });
  await page.route("**/api/insights*", (route) =>
    route.fulfill({ json: { ...insights, flow: [], owners: [] } }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("No open requests.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await expect(
    page.getByText("No request activity yet.", { exact: true }),
  ).toBeVisible();
});
