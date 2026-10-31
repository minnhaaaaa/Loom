import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { localConfigurationCheck } from "./local-config-check.mjs";

process.env.NODE_ENV = "production";
const errors = await localConfigurationCheck();
if (errors.length) {
  console.error("Local account start refused:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const web = fileURLToPath(new URL("../apps/web/", import.meta.url));
  try {
    await access(new URL("../apps/web/.next/BUILD_ID", import.meta.url));
  } catch {
    console.error(
      "Local account start refused: build Loom before starting it.",
    );
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    // Exactly one application server. No migrations, fixtures, or provider calls.
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../apps/web/node_modules/next/dist/bin/next",
            import.meta.url,
          ),
        ),
        "start",
        web,
        "--hostname",
        "127.0.0.1",
        "--port",
        process.env.PORT || "3000",
      ],
      { cwd: root, env: process.env, stdio: "inherit" },
    );
    const forward = (signal) => child.kill(signal);
    const onTerm = () => forward("SIGTERM");
    const onInt = () => forward("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    child.on("error", () => {
      console.error("The application server could not start.");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      process.exitCode = code ?? (signal === "SIGTERM" ? 143 : 130);
    });
  }
}
