// Local, conservative English-language rules. These are explainable signals,
// not model confidence scores. Ambiguous asks require an owner's review.
export type ChatMessage = { id: string; text: string; author: string };
export type RequestDetection = {
  decision: "request" | "review" | "ignored";
  reason: string;
  evidence?: ChatMessage;
};
export const detectionVersion = "local-1";
const analytics =
  /\b(data|analytics|analysis|analy[sz]e|dashboard|report|metric|kpi|revenue|sales|conversion|retention|churn|cohort|funnel|forecast|sql|dataset|breakdown|break down|segment|trend|numbers|definition)\b/i;
const ask =
  /\b(can|could|would|will)\s+(you|someone|anyone|we)\b|\b(please|i need|we need|need help|help me|help us|looking for|requesting)\b|\b(why|how many|how much|what is|what's|which)\b[^\n]*\?/i;
const action =
  /\b(explain|investigate|analy[sz]e|build|create|pull|extract|query|calculate|compare|check|find|show|share|send|define|review|break down|update|fix|understand)\b/i;
const completed =
  /\b(already|completed|resolved|done|shipped|published)\b|\b(no longer need|don't need|do not need|never mind|nevermind)\b/i;

export function detectRequest(messages: ChatMessage[]): RequestDetection {
  let uncertain: ChatMessage | undefined;
  let explicit: ChatMessage | undefined;
  let closedAfterRequest = false;
  let contextHasAnalytics = false;
  for (const message of messages) {
    // Quotes, code and pasted instructions are not independent requests.
    const text = message.text
      .replace(/```[\s\S]*?```/g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith(">"))
      .join("\n")
      .trim();
    const subject = analytics.test(text);
    const asking = ask.test(text);
    const cancel =
      /\b(no longer need|don't need|do not need|never mind|nevermind)\b/i.test(
        text,
      );
    if ((explicit || uncertain) && completed.test(text))
      closedAfterRequest = true;
    if (asking && !cancel && (subject || contextHasAnalytics)) {
      if (subject && action.test(text) && !completed.test(text))
        explicit ??= message;
      uncertain ??= message;
    } else if (subject && text.includes("?") && !cancel) uncertain ??= message;
    contextHasAnalytics ||= subject;
  }
  if (explicit && !closedAfterRequest)
    return {
      decision: "request",
      reason: "Explicit analytics request",
      evidence: explicit,
    };
  uncertain ??= explicit;
  return uncertain
    ? {
        decision: "review",
        reason: "Possible request — check the context",
        evidence: uncertain,
      }
    : { decision: "ignored", reason: "No explicit analytics request found" };
}
