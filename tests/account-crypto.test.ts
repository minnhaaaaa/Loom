import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  isSessionToken,
  invitationToken,
  validInvitationToken,
} from "../apps/web/server/identity-crypto";

afterEach(() => vi.unstubAllEnvs());
it("uses independently salted scrypt hashes and verifies passwords without storing plaintext", async () => {
  const password = "A synthetic fixture password 2026!",
    first = await hashPassword(password),
    second = await hashPassword(password);
  expect(first).not.toBe(second);
  expect(first).toMatch(/^scrypt-v1\$32768\$8\$1\$/);
  expect(first).not.toContain(password);
  expect(await verifyPassword(password, first)).toBe(true);
  expect(await verifyPassword("A different fixture password", first)).toBe(
    false,
  );
  expect(await verifyPassword(password, null)).toBe(false);
  expect(await verifyPassword(password, "unsupported-format")).toBe(false);
});
it("creates opaque 256-bit session tokens with a separate SHA256 storage digest", () => {
  const first = newSessionToken(),
    second = newSessionToken();
  expect(isSessionToken(first)).toBe(true);
  expect(Buffer.from(first, "base64url")).toHaveLength(32);
  expect(first).not.toBe(second);
  expect(hashToken(first)).toMatch(/^[0-9a-f]{64}$/);
  expect(hashToken(first)).not.toBe(first);
  expect(isSessionToken("forged")).toBe(false);
});
it("reconstructs invitation tokens for replay and rejects forgery or secret changes", () => {
  vi.stubEnv(
    "LOOM_SESSION_SECRET",
    "public-crypto-fixture-secret-over-32-characters",
  );
  const id = randomUUID(),
    token = invitationToken(id);
  expect(invitationToken(id)).toBe(token);
  expect(validInvitationToken(token)).toBe(true);
  expect(
    validInvitationToken(
      token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"),
    ),
  ).toBe(false);
  expect(validInvitationToken(randomUUID() + "." + token.split(".")[1])).toBe(
    false,
  );
  vi.stubEnv(
    "LOOM_SESSION_SECRET",
    "different-public-fixture-secret-over-32-characters",
  );
  expect(validInvitationToken(token)).toBe(false);
});
