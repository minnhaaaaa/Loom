import { localConfigurationCheck } from "./local-config-check.mjs";
import { deploymentReady } from "../apps/web/server/deployment-config";

const errors = await localConfigurationCheck();
if (errors.length) {
  console.error("Local account configuration check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else if (!(await deploymentReady())) {
  console.error(
    "Local Exasol readiness failed. Check database availability, trusted TLS, and applied migration checksums. No data was changed.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "Local account configuration, Exasol connection, and migration checks passed. No data was changed and no AI provider was called.",
  );
}
