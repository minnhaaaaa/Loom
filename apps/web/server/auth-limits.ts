import "server-only";
import { createHash } from "node:crypto";
import { DomainError } from "@loom/domain";

// One Node process is the deployment contract. Bound expensive password work before hashing.
const key = Symbol.for("loom.auth-attempt-limits.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: Map<string, { count: number; until: number }>;
};
const attempts = (shared[key] ??= new Map());
export function limitCredentialAttempt(identity: string) {
  const now = Date.now();
  for (const [id, state] of attempts)
    if (state.until <= now) attempts.delete(id);
  const identityKey = createHash("sha256")
    .update(identity.trim().toLowerCase())
    .digest("hex");
  for (const [id, maximum] of [
    ["global", 60],
    [identityKey, 8],
  ] as const) {
    const state = attempts.get(id) || { count: 0, until: now + 60_000 };
    if (state.count >= maximum || attempts.size > 1000)
      throw new DomainError(
        "AUTH_RATE_LIMIT",
        "Too many account attempts. Wait before trying again.",
        429,
        {
          retryAfterSeconds: Math.max(1, Math.ceil((state.until - now) / 1000)),
          retryable: true,
        },
      );
    state.count++;
    attempts.set(id, state);
  }
}
