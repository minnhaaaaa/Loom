import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "@loom/domain";

const cost = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummyHash = `scrypt-v1$32768$8$1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`;
function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, cost, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16),
    key = await derive(password, salt);
  return `scrypt-v1$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<boolean> {
  const value = encoded ?? dummyHash;
  const match =
    /^scrypt-v1\$32768\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(
      value,
    );
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1], "base64url")),
    expected = Buffer.from(match[2], "base64url");
  return timingSafeEqual(key, expected) && encoded !== null;
}
export function newSessionToken() {
  return randomBytes(32).toString("base64url");
}
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function isSessionToken(token: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
export function invitationToken(id: string) {
  const secret = process.env.LOOM_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new DomainError(
      "SESSION_CONFIGURATION",
      "Set LOOM_SESSION_SECRET to at least 32 random characters before creating invitations.",
      503,
    );
  return `${id}.${createHmac("sha256", secret).update(`invite:${id}`).digest("base64url")}`;
}
export function validInvitationToken(token: string) {
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(
      token,
    );
  if (!match) return false;
  const expected = invitationToken(match[1]);
  return (
    token.length === expected.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  );
}
