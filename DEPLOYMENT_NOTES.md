> Supplementary historical configuration notes. Start with [DEPLOYMENT.md](DEPLOYMENT.md) and [RUN_GUIDE.md](RUN_GUIDE.md) for current setup and operation.

# Running Loom locally

Loom is currently intended to run on this computer. No online deployment, cloud resources, or paid hosting are configured. The application and Exasol remain separate processes; the browser only connects to Loom.

Exasol Personal is documented for [single-user use](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm). One operator can exercise the account and company workflows locally. Inviting additional real users requires the appropriate Exasol permission or edition; multiple application accounts do not change the database license.

## Local configuration

Use the existing private `.env` at the repository root. Do not overwrite it with a template. A fresh clone can copy `.env.example` and fill its private values locally.

For real local account access:

- Set `APP_ORIGIN=http://127.0.0.1:3000` (or `http://localhost:3000`) to match the address you open.
- Set `LOOM_AUTH_MODE=workspace`. Leave `LOOM_ALLOW_DEMO_PRODUCTION` and `LOOM_ALLOW_SEED_FIXTURES` false or unset.
- Explicitly set `LOOM_ALLOW_WORKSPACE_SIGNUP=true` when you want to register a company. Set it to `false` to retain only existing accounts and owner invitations.
- Keep `LOOM_SESSION_SECRET` private, stable, and at least 32 random characters. Generate a new secret for a fresh setup with `openssl rand -hex 32`; do not rotate an existing secret casually.
- Configure `EXASOL_HOST`, `EXASOL_USER`, `EXASOL_PASSWORD`, `EXASOL_PORT`, and the intended `EXASOL_SCHEMA`. A private database CA belongs in a readable `EXASOL_CA_FILE`. Certificate and hostname verification remain enabled.

Use one persistent application server. The database write coordinator and authentication limiter are process-local; do not run multiple application writers or migrate while another instance writes. Local account mode uses the real Exasol store. Missing configuration produces an explicit unavailable state, never a sample replacement for your records.

## Check and run

The ordinary development commands remain available:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For a built local application with explicit checks:

```sh
pnpm build
pnpm check:local
pnpm start:local
```

`check:local` loads the existing `.env`, validates account-mode configuration, checks Exasol with a read-only query, and verifies every migration version/checksum against the files in this checkout. It prints field names and generic failures, never secret values. It does not mutate the database or call any AI provider.

`start:local` validates configuration and a completed build, then binds one Next server to **127.0.0.1**, using `PORT` or 3000. It forwards shutdown signals. It does not migrate, seed, create accounts, or test providers. Use the normal `pnpm start` when that additional account-mode preflight is not intended.

Apply migrations separately, only after checking the intended database/schema and stopping application writers:

```sh
pnpm db:migrate
```

A missing or changed migration makes readiness fail. The exact checksum check also rejects a newer schema than this checkout; it is not a rolling-upgrade protocol. Do not change applied migration files or run two migration processes concurrently. Back up important data and rehearse restoration before relying on it. Do not seed or delete existing records just to make a check pass.

## Accounts and AI

Open `/register` to create a company when signup is enabled. Staff access uses existing membership or an owner-issued invitation; choosing a company name alone grants no access. `/login` signs in, `/app` opens the workspace, `/join` accepts an invitation, and `/w/<id>` is a stable workspace link.

Manual work does not need an AI provider. Company API connections require `LOOM_PROVIDER_ENCRYPTION_KEY`, containing 32 random bytes encoded as 64 hexadecimal characters. Keep it stable and back it up separately from Exasol. Without it, saving company credentials is unavailable. Changing or losing it makes saved credentials unreadable.

Owners can select OpenAI API, Claude API, Kimi API, or DeepSeek API in Settings and use **Test and save**. That action sends a real provider request and can incur a charge. API billing is separate from a ChatGPT/Claude subscription. Configure provider spending limits separately; per-reply token limits are not an organization spending cap. A disconnected company provider does not silently switch billing accounts.

The optional server-wide OpenRouter configuration requires both `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. Leave both blank if it is not intended. Company credentials and external MCP clients do not require a global OpenRouter key. Provider failure is shown explicitly, with no generated sample response.

A customer-run Codex, Claude Code, or other MCP client can connect to `/api/mcp` using a Loom token. These tokens grant access to Loom, expire after 30 days, are stored as hashes, and are revocable. Each connection acts as its issuing owner and can read internal workspace context. Loom does not launch the external client or host its polling loop. Account identity connection and permission to perform inference are separate capabilities.

## Continue with ChatGPT locally

Loom implements OpenAI's [local open-source registration flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). It uses dynamic registration and a callback on `127.0.0.1`; this local flow does not require a hosted partner client ID, client secret, or partner API key. The user signs in and grants permissions in OpenAI's browser flow. A verified identity alone does not authorize use of the ChatGPT plan.

1. Apply `010_openai_identity` with the other migrations after stopping application writers.
2. In the private `.env`, set `LOOM_OPENAI_LOCAL_ENABLED=true`, `APP_ORIGIN=http://127.0.0.1:3000` (or the actual local port), and a valid `LOOM_PROVIDER_ENCRYPTION_KEY`. Retain an existing encryption key; do not replace it when reconnecting an account.
3. Restart Loom and open the exact `127.0.0.1` address. Sign in to the owner account there; a session opened on `localhost` is a different browser origin.
4. In Company setup, choose ChatGPT and **Continue with ChatGPT**. Review and complete OpenAI's consent yourself. Loom returns to `/api/oauth/openai/callback` on the same local origin and verifies the callback before saving credentials.
5. Choose a model available to the connected account. `LOOM_CHATGPT_MODEL` may provide an initial model, but it does not prove the account can use it. Identity-only or model-less connections cannot run the assistant.

The server keeps a stable host identifier in its private `.local/openai-host-id` file, or uses a valid `LOOM_OPENAI_HOST_ID` override. Preserve that identifier for this computer. Issued client registrations and encrypted credentials are scoped to the Loom owner, company, host, and verified ChatGPT identity. The connected owner's assistant and direct tool designer use that personal plan; another owner or staff member does not inherit it. A changed model, disconnect, or lost permission invalidates pending inference before its answer, proposals, or draft can be saved. This path does not silently fall back to a company or server API key. Advanced triage requires explicitly selecting Company AI with an API account; it does not use the personal ChatGPT connection.

Local SQL integration checks cover one-use concurrent callbacks, cancelled attempts, owner/session rechecks, encrypted/scoped credentials, refresh leases, and disconnect during inference. Provider calls were mocked in those tests. **A real browser authorization, account consent, token renewal, and live ChatGPT model response have not yet been verified.**

The isolated integration suite refuses the default database schema. To repeat it deliberately:

```sh
EXASOL_SCHEMA=LOOM_TEST_LOCAL_OAUTH pnpm db:migrate
EXASOL_SCHEMA=LOOM_TEST_LOCAL_OAUTH node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run --config vitest.oauth-database.config.ts
```

This creates the dedicated test schema if needed and cleans only the suite's UUID-scoped fixtures. Run it with no other application writers. It never signs in to OpenAI or calls a live model.

## Local health checks

- `GET /api/health/live` returns `200 {"status":"ok"}` when the web process can handle the request, independently of Exasol.
- `GET /api/health/ready` returns `200 {"status":"ready"}` after valid local account configuration, a successful read-only `SELECT 1`, and exact migration matches. Otherwise it returns `503 {"status":"unavailable"}`. No hostnames, users, SQL errors, or secrets appear in the response.

Readiness shares one in-flight probe and caches the result for 30 seconds. Each response waits at most five seconds; the existing driver terminates a still-running connection at its twenty-second deadline. Probes do not write records, apply migrations, or call models. A green probe does not establish backup recovery, model quality, or multi-user licensing.

Passwords use salted scrypt; sessions are opaque, stored as hashes, and expire after eight hours. Cookies are HTTP-only and same-site, with exact-origin JSON mutation checks. Email verification/delivery, password recovery, SSO, automated retention, and distributed operation remain unfinished. Keep local secrets private and retain a recovery plan for data you care about.
