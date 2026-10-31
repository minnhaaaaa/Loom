import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { DomainError } from "@loom/domain";
const valid =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = Symbol.for("loom.openai-host-id.v1");
const shared = globalThis as typeof globalThis & { [key]?: Promise<string> };
export async function openAiHostId(): Promise<string> {
  if (process.env.LOOM_OPENAI_HOST_ID) {
    if (!valid.test(process.env.LOOM_OPENAI_HOST_ID))
      throw new DomainError(
        "OPENAI_HOST_CONFIGURATION",
        "LOOM_OPENAI_HOST_ID must be a stable urn:uuid value generated for this computer.",
        503,
      );
    return process.env.LOOM_OPENAI_HOST_ID;
  }
  return (shared[key] ??= (async () => {
    const directory = resolve(process.cwd(), ".local"),
      file = resolve(directory, "openai-host-id");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(file, `urn:uuid:${randomUUID()}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await chmod(file, 0o600);
    const value = (await readFile(file, "utf8")).trim();
    if (!valid.test(value))
      throw new DomainError(
        "OPENAI_HOST_CONFIGURATION",
        "The local OpenAI host ID could not be read. Restore its saved value before reconnecting.",
        503,
      );
    return value;
  })().catch((error) => {
    delete shared[key];
    throw error;
  }));
}
