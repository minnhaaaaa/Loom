# Deploying Loom for colleagues

Loom runs as one persistent Node process with Exasol as the canonical store. Workspace accounts and invitation links work on the same shared application URL. The browser never connects to Exasol directly.

## Prototype and company routes

The challenge build uses Exasol Personal with synthetic companies and role personas under one operator. [Personal documentation](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm) describes individual/single-user use. Multi-workspace code does not establish permission to offer a multi-company production service on Personal. Resolve the edition/permission and database-hosting choice before a real organizational rollout; the shared-host instructions below describe application mechanics.

The public page is `/`; administrators register at `/register`, staff sign in at `/login`, and authenticated work is under `/app`. `/app?demo=1` opens unsaved samples. `/app?view=insights` shows internal Exasol analytics; requesters/viewers cannot fetch those aggregates. Invitation links use `/join`, and stable workspace links use `/w/<id>`.

Set `LOOM_ALLOW_WORKSPACE_SIGNUP=true` when company self-registration is intended. With it disabled, existing companies and owner-issued invitations continue to work. Each company is currently a workspace with individual memberships; there is no verified-domain auto-join or organization hierarchy. Staff require an invitation or existing membership, not merely knowledge of a company name.

## Company AI credential setup

1. Apply all migrations with `pnpm db:migrate`, including `009_provider_connections.sql`.
2. Generate a separate deployment key with `openssl rand -hex 32` and save its 64 hex characters as `LOOM_PROVIDER_ENCRYPTION_KEY` in the server's secret environment. Keep it stable and back it up separately from Exasol. Never put it in client configuration or commit it.
3. As a company owner, open `/app?view=settings` and **Bring your AI provider**. Choose OpenAI API, Claude API, Kimi API, or DeepSeek API; enter an API key and model ID permitted by that account and set the output-token limit.
4. Review the charge acknowledgement and use **Test and save**. This deliberately sends a small provider request; a failed structured test leaves the existing connection unchanged. A successful test establishes that connection check, not broad answer quality.
5. Choose **Loom’s agent** in Company setup to use the saved API configuration inside Loom. Staff use their own Loom accounts and receive only their authorized context.

Provider credentials are encrypted with AES-256-GCM and associated with the company, version, provider, and model. Settings responses contain metadata, never the saved key. Changing the deployment key without a credential migration makes existing credentials unreadable; owners must reconnect them. Disconnect removes the active saved credential. The application has a per-reply token limit; organization spend limits must also be configured with the provider.

This is bring-your-own **API billing**, not ChatGPT/Claude/Kimi/DeepSeek subscription OAuth. Account OAuth is not implemented. Real provider credentials were not assumed during development; see RUNBOOK for the exact live checks actually performed. Fixed provider endpoints and JSON validation constrain the transport, but model availability and structured-output behavior still require a live check for the selected model.

The existing server `OPENROUTER_*` configuration can serve workspaces that have no company provider configured. A configured but disconnected/failed company provider does not silently fall back to a different billing account. The separate Codex/Claude Code MCP mode continues to run in the customer's external client; setup grants Loom access and does not start a background runner or authenticate the client with its vendor.

## Free online testing: Cloudflare Quick Tunnel

A [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives the local web app a temporary HTTPS address. Your machine must keep Loom, Exasol, and `cloudflared` running. This is a free testing path, not permanent cloud hosting: the address can change, there is no uptime guarantee, and Quick Tunnels have a 200 in-flight request limit and no SSE. Loom currently uses authorized polling.

1. Apply migrations and build with `pnpm db:migrate` and `pnpm build`.
2. Create a real password account locally. Start an account-enabled bootstrap server:

   ```sh
   APP_ORIGIN=http://127.0.0.1:3000 \
   LOOM_AUTH_MODE=workspace \
   LOOM_ALLOW_WORKSPACE_SIGNUP=true \
   pnpm start
   ```

   Open `http://127.0.0.1:3000/register` and register the synthetic company, then stop this server before starting the shared server below. If port 3000 is occupied, choose another port with `pnpm start --port 3001` and use that port consistently in `APP_ORIGIN`, your browser, and the tunnel command. Each workspace has its own generated tool and records. To keep an existing demo workspace, invite the password account from the local demo owner, promote it to owner, and then remove demo owner access from that workspace. Do not use synthetic test credentials for a public workspace.

3. Use `LOOM_AUTH_MODE=workspace` for the shared server. It disables synthetic persona sign-in. Set `LOOM_ALLOW_WORKSPACE_SIGNUP=false` after creating the intended owner; colleagues can still register through owner-issued invitations. Keep `LOOM_SESSION_SECRET` private and at least 32 random characters.
4. Install `cloudflared` using Cloudflare's platform instructions, then start the tunnel:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:3000
   ```

5. Copy the HTTPS address it reports. Start or restart the application with that exact origin:

   ```sh
   APP_ORIGIN=https://your-temporary-address.trycloudflare.com \
   LOOM_AUTH_MODE=workspace \
   LOOM_ALLOW_WORKSPACE_SIGNUP=false \
   LOOM_ALLOW_DEMO_PRODUCTION=false \
   pnpm start
   ```

6. Sign in at `/login` on the HTTPS address. Open **Share workspace**, create the intended role's invitation, and send that link yourself. A colleague creates their own account or signs in and accepts. Invitation tokens are carried in URL fragments and sent only in POST bodies, not query strings.

Changing the tunnel address requires updating `APP_ORIGIN`, restarting Loom, and issuing links for the new address. A named Cloudflare Tunnel can provide a stable hostname when you already control an appropriate domain. Neither path requires exposing the database port.

## Free web hosting: Render

[Render free web services](https://render.com/docs/free) can host the Node app, with managed HTTPS and a generated application hostname. Free services sleep after 15 minutes without inbound traffic, and local files are ephemeral. Sessions, accounts, tools, and records are in Exasol, so application restarts do not erase them.

This hosts only the web application. Exasol must be reachable from the Render service over verified TLS; a database bound to your laptop's loopback interface is not reachable from a cloud web service. Hosting the whole current stack for free is therefore a separate database/edition decision.

A Node web service can use:

```sh
# Build command
corepack enable && pnpm install --frozen-lockfile && pnpm build

# Start command; Render supplies PORT
pnpm --filter @loom/web exec next start --hostname 0.0.0.0 --port "$PORT"
```

Use one service instance. Configure `APP_ORIGIN` to its HTTPS hostname, `LOOM_AUTH_MODE=workspace`, `LOOM_ALLOW_DEMO_PRODUCTION=false`, `LOOM_ALLOW_WORKSPACE_SIGNUP=false` after owner bootstrap, and the required private Exasol/model/session settings from `.env.example`. Provide a trusted database CA through the host's private file facility when required; do not disable certificate validation. Keep credentials and private certificates out of the repository.

## Current operating scope

Workspace passwords use salted scrypt; opaque sessions expire after eight hours and are stored only as hashes. Invitations expire after 24 hours, are single-use, and can be revoked. Permission changes apply on subsequent authorized reads/mutations and polling clears inaccessible local state. Email addresses identify accounts but are not verified. Email delivery, password reset, SSO, automated retention, distributed coordination, and multiple application replicas are not implemented.

The connected browser suite creates isolated synthetic accounts/workspaces with random passwords and leaves their records for inspection. Database integration fixtures create and clean their own UUID-scoped state. Use deliberate owner accounts and workspace membership when moving from testing to shared hosting.
