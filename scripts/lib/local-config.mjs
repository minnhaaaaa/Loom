// Shared by the local account-mode preflight and read-only readiness probe.
// Errors name configuration fields only: never include supplied values.
export function localConfigurationErrors(env = process.env) {
  const errors = [];
  try {
    const origin = new URL(env.APP_ORIGIN || "");
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      errors.push(
        "APP_ORIGIN must be a loopback HTTP(S) origin without a path or credentials.",
      );
  } catch {
    errors.push("APP_ORIGIN must be an explicit loopback HTTP(S) origin.");
  }
  if (env.LOOM_AUTH_MODE !== "workspace")
    errors.push("LOOM_AUTH_MODE must be workspace.");
  for (const flag of [
    "LOOM_ALLOW_DEMO_PRODUCTION",
    "LOOM_ALLOW_SEED_FIXTURES",
    "LOOM_TEST_LIVE_MODEL",
    "LOOM_TEST_LIVE_TOOL_GENERATION",
  ])
    if (env[flag] && env[flag] !== "false")
      errors.push(`${flag} must be false or unset.`);
  if (!["true", "false"].includes(env.LOOM_ALLOW_WORKSPACE_SIGNUP || ""))
    errors.push(
      "LOOM_ALLOW_WORKSPACE_SIGNUP must explicitly be true or false.",
    );

  const secret = env.LOOM_SESSION_SECRET || "";
  if (
    secret.length < 32 ||
    secret.trim() !== secret ||
    new Set(secret).size < 2 ||
    /public[-_ ]?(?:test|session)|test[-_ ]?(?:only|secret|session)|change[-_ ]?me|replace[-_ ]?me|your[-_ ]?(?:secret|key)|example|placeholder/i.test(
      secret,
    )
  )
    errors.push(
      "LOOM_SESSION_SECRET must be a newly generated private secret of at least 32 characters.",
    );
  if (!env.EXASOL_HOST || !/^[a-zA-Z0-9.:-]+$/.test(env.EXASOL_HOST))
    errors.push("EXASOL_HOST must be a hostname or IP address, not a URL.");
  for (const name of ["EXASOL_USER", "EXASOL_PASSWORD"])
    if (!env[name]?.trim()) errors.push(`${name} is required.`);
  const port = Number(env.EXASOL_PORT || 8563);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    errors.push("EXASOL_PORT must be a valid port.");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(env.EXASOL_SCHEMA || "LOOM"))
    errors.push("EXASOL_SCHEMA must be an uppercase SQL identifier.");
  const encryptionKey = env.LOOM_PROVIDER_ENCRYPTION_KEY;
  const localOpenAi = env.LOOM_OPENAI_LOCAL_ENABLED === "true";
  if (
    env.LOOM_OPENAI_LOCAL_ENABLED &&
    !["true", "false"].includes(env.LOOM_OPENAI_LOCAL_ENABLED)
  )
    errors.push("LOOM_OPENAI_LOCAL_ENABLED must be true, false, or unset.");
  if (localOpenAi) {
    try {
      const origin = new URL(env.APP_ORIGIN || "");
      if (
        origin.protocol !== "http:" ||
        origin.hostname !== "127.0.0.1" ||
        origin.pathname !== "/" ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash
      )
        errors.push(
          "APP_ORIGIN must be an http://127.0.0.1 origin without a path or credentials when local ChatGPT connection is enabled.",
        );
    } catch {
      // The general origin check above already reports a missing or invalid URL.
    }
    if (!encryptionKey)
      errors.push(
        "LOOM_PROVIDER_ENCRYPTION_KEY is required when local ChatGPT connection is enabled.",
      );
    if (
      env.LOOM_OPENAI_HOST_ID &&
      !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        env.LOOM_OPENAI_HOST_ID,
      )
    )
      errors.push(
        "LOOM_OPENAI_HOST_ID must be a stable UUID v4 in urn:uuid format when supplied.",
      );
  }
  if (
    encryptionKey &&
    (!/^[a-fA-F0-9]{64}$/.test(encryptionKey) ||
      new Set(encryptionKey).size < 2)
  )
    errors.push(
      "LOOM_PROVIDER_ENCRYPTION_KEY must be a generated 64-character hexadecimal key when credential storage is enabled.",
    );
  if (env.OPENROUTER_API_KEY?.trim() && !env.OPENROUTER_MODEL?.trim())
    errors.push(
      "OPENROUTER_MODEL is required when a global OpenRouter API key is configured.",
    );
  if (
    env.PORT &&
    (!/^\d+$/.test(env.PORT) ||
      Number(env.PORT) < 1 ||
      Number(env.PORT) > 65535)
  )
    errors.push("PORT must be a valid port.");
  return errors;
}
