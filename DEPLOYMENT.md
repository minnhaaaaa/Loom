# Deploying Loom for colleagues

Loom runs as one persistent Node process with Exasol as the canonical store. Workspace accounts and invitation links work on the same shared application URL. The browser never connects to Exasol directly.

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

   Open `http://127.0.0.1:3000` and use **Create a workspace**, then stop this server before starting the shared server below. If port 3000 is occupied, choose another port with `pnpm start --port 3001` and use that port consistently in `APP_ORIGIN`, your browser, and the tunnel command. Each workspace has its own generated tool and records. To keep an existing demo workspace, invite the password account from the local demo owner, promote it to owner, and then remove demo owner access from that workspace. Do not use synthetic test credentials for a public workspace.
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

6. Sign in at the HTTPS address. Open **Share workspace**, create the intended role's invitation, and send that link yourself. A colleague creates their own account or signs in and accepts. Invitation tokens are carried in URL fragments and sent only in POST bodies, not query strings.

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

Exasol documents [Personal](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm) as individual/single-user software. A technically working collaboration demo does not establish edition permission for organizational shared use; select an appropriate permitted database deployment before a real organization rollout.

## Current operating scope

Workspace passwords use salted scrypt; opaque sessions expire after eight hours and are stored only as hashes. Invitations expire after 24 hours, are single-use, and can be revoked. Permission changes apply on subsequent authorized reads/mutations and polling clears inaccessible local state. Email addresses identify accounts but are not verified. Email delivery, password reset, SSO, automated retention, distributed coordination, and multiple application replicas are not implemented.

The connected browser suite creates isolated synthetic accounts/workspaces with random passwords and leaves their records for inspection. Database integration fixtures create and clean their own UUID-scoped state. Use deliberate owner accounts and workspace membership when moving from testing to shared hosting.
