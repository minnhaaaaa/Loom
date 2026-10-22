import {
  inferProposal,
  modelConfiguration,
} from "../apps/web/server/openrouter";
import { sampleRequests } from "../packages/contracts/src/fixtures.ts";
import { personas, toolSpec } from "@loom/contracts";
import { transitions } from "@loom/domain";
try {
  const config = modelConfiguration();
  const result = await inferProposal(
    {
      task: "Review this synthetic request. Summarize it and propose a useful small next step for human review, or explain why no change is needed. Use only the available action schema and supplied facts.",
      request: sampleRequests[0],
      comments: [],
      knowledge: [],
      members: personas.map((p) => ({
        userId: p.id,
        name: p.name,
        role: p.role,
      })),
      tool: toolSpec,
      allowedTransitions: transitions,
      today: new Date().toISOString().slice(0, 10),
    },
    config.model,
  );
  console.log(
    JSON.stringify(
      {
        model: result.inference.actualModel,
        cost: result.inference.cost,
        tokens: result.inference.completionTokens,
        summary: result.suggestion.summary,
        commands: result.suggestion.commands,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    code && /^MODEL_[A-Z0-9_]+$/.test(code)
      ? `${code}: ${(error as Error).message}`
      : "Model check failed. No credentials or raw provider errors are printed.",
  );
  process.exitCode = 1;
}
