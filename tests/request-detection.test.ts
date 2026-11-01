import { expect, it } from "vitest";
import { detectRequest } from "../apps/web/server/request-detection";
const detect = (...texts: string[]) =>
  detectRequest(
    texts.map((text, i) => ({ id: String(i), text, author: `user${i}` })),
  );
it.each([
  "Can you explain the revenue drop?",
  "Please build a retention dashboard for October.",
  "We need to compare conversion by region.",
])("recognizes an explicit analytics ask: %s", (text) =>
  expect(detect(text).decision).toBe("request"),
);
it.each([
  "Good morning everyone",
  "The revenue dashboard is published.",
  "We don't need a sales report.",
  "> Can you build a revenue dashboard?",
  "```Please analyze revenue```",
  "Can someone book a meeting room?",
])("ignores chatter, completed work, cancellations and quotes: %s", (text) =>
  expect(detect(text).decision).toBe("ignored"),
);
it("finds asks in replies and uses thread context for an uncertain ask", () => {
  expect(
    detect("Hello team", "Can you analyze revenue by region?").evidence,
  ).toMatchObject({ id: "1", author: "user1" });
  expect(
    detect("The revenue chart looks strange", "Can you investigate this?")
      .decision,
  ).toBe("review");
  expect(detect("Why did revenue drop?").decision).toBe("review");
});
it("sends threads with later completion/cancellation to review", () => {
  expect(
    detect("Please build a revenue report", "Already done, thanks").decision,
  ).toBe("review");
});
