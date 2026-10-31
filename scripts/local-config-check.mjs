import { access, constants } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { localConfigurationErrors } from "./lib/local-config.mjs";

export async function localConfigurationCheck(env = process.env) {
  const errors = localConfigurationErrors(env);
  if (env.EXASOL_CA_FILE) {
    try {
      await access(env.EXASOL_CA_FILE, constants.R_OK);
    } catch {
      errors.push("EXASOL_CA_FILE must reference a readable trusted CA file.");
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const errors = await localConfigurationCheck();
  if (errors.length) {
    console.error("Local account configuration check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      "Local configuration checks passed. Run check:local to verify Exasol and migrations.",
    );
  }
}
