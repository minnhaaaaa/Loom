import "server-only";
import { insightQuerySchema, type Actor } from "@loom/contracts";
import { readDatabase } from "@loom/db-exasol";
import { analyticsInsights } from "@loom/analytics";
import { requireOperator } from "./knowledge";

export async function readInsights(
  actor: Actor,
  input: unknown = {},
  at = new Date(),
) {
  const query = insightQuerySchema.parse(input);
  return readDatabase(async (sql) => {
    // Authorization runs before every analytical or evidence query.
    await requireOperator(sql, actor);
    return analyticsInsights(sql, actor, query.days, at);
  });
}
