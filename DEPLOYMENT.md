# Deployment instructions

Loom's supported demonstration is **local-only**: one Next.js server on `127.0.0.1`, with Exasol as a separate database process. There is no hosted URL or cloud deployment configured. The browser never receives database or provider credentials.

## 1. Install prerequisites

Use Node.js 24 (minimum 22.13) and pnpm 10.31.0. On Linux x86_64, install rootless Podman and its prerequisites using your operating system's instructions, then verify `podman info` works.

Clone the public repository and run `pnpm install --frozen-lockfile`.

## 2. Install or connect Exasol

For the repository's tested Linux helper:

```sh
pnpm db:setup
pnpm db:status
```

`db:setup` downloads a checksum-pinned official Exasol Personal launcher and runs its local installer with `--auto-approve`. Review `scripts/setup-exasol.sh`, Exasol's terms, and any host preparation requirements before running it. It creates `.local/exasol`; it does not configure Loom's `.env` or AI providers. On other platforms, use the [official Exasol Personal guide](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm).

Use the credentials and trusted PEM CA for your deployment. For this local installation, `.local/exasol/secrets.json` holds private deployment credentials; never commit or screen-share it. Follow the deployment's certificate export instructions. Loom does not support disabling TLS certificate/hostname validation.

## 3. Configure Loom

For a **fresh clone only**, copy `.env.example` to `.env`. Never overwrite an existing private configuration.

| Variable                         | Required value / purpose                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| `APP_ORIGIN`                     | `http://127.0.0.1:3000`                                              |
| `LOOM_AUTH_MODE`                 | `workspace`                                                          |
| `LOOM_ALLOW_WORKSPACE_SIGNUP`    | `true` for owner registration; can be disabled afterward             |
| `LOOM_SESSION_SECRET`            | Stable random secret, generated with `openssl rand -hex 32`          |
| `EXASOL_HOST`, `EXASOL_PORT`     | Reachable database host and port, normally `127.0.0.1:8563` locally  |
| `EXASOL_SCHEMA`                  | Dedicated schema, e.g. `LOOM`                                        |
| `EXASOL_USER`, `EXASOL_PASSWORD` | Your deployment's credentials                                        |
| `EXASOL_CA_FILE`                 | Absolute readable path to the trusted CA for a private-CA deployment |

Keep fixture/demo flags false. Use synthetic business data for the presentation, through normal accounts and intake.

## 4. Migrate and verify

Stop application writers before migrating. Do not run migrations concurrently.

```sh
pnpm db:migrate
pnpm check:local
```

The migration command preserves existing records and checks applied file checksums. Readiness checks configuration, a real SQL query, and migrations without modifying data. If it fails, fix the stated issue; do not seed, reset, or delete records to bypass readiness.

## 5. Start the app

Development:

```sh
pnpm dev
```

Built local demo (stop development first):

```sh
pnpm build
pnpm check:local
pnpm start:local
```

Open `http://127.0.0.1:3000/register`, create an owner account, then finish company setup. Only one application server should write to this schema. Do not build while development is running: both use `.next`.

`pnpm dev` uses `scripts/dev-local.mjs` to load the root `.env` without forwarding incompatible Node command-line flags to Next's worker. `start:local` validates local configuration and requires an existing production build. It does not migrate or seed data.

## Optional AI and source connections

Generate a separate stable encryption key with `openssl rand -hex 32` and put it in `LOOM_PROVIDER_ENCRYPTION_KEY`. Keep it private and backed up separately. Replacing it makes saved provider/source credentials unreadable.

- **Manual workflow:** no AI key or subscription required.
- **ChatGPT plan:** set `LOOM_OPENAI_LOCAL_ENABLED=true`, keep the exact `127.0.0.1` origin, restart, and choose **Continue with ChatGPT** in Settings. Complete consent, select an available model, and save setup. The connection is per owner; eligibility and usage limits apply. No API key is needed for this route.
- **Company API provider:** select a supported provider in Settings and use Test and save. This sends a real provider request and may incur provider charges.
- **Discord:** create/install a bot with Message Content Intent, View Channels, and Read Message History. Verify its token in Connected sources, choose a channel, and start import. No webhook tunnel or separate bot worker is needed.
- **Other sources:** see [CONNECTED_SOURCES.md](CONNECTED_SOURCES.md), including Microsoft tenant permissions and GitHub token scope.

The server checks due sources every 15 seconds. Completed scans normally wait five minutes; pagination and rate limits can take longer. Use Sync now for a rehearsed demo.

## Operating scope

Keep `.env`, `.local`, tokens, database snapshots, and private logs out of Git. Exasol Personal has separate individual/single-user terms; synthetic role personas under one operator do not establish production multi-user licensing. A hosted service would additionally need an appropriate database edition, HTTPS/session decisions, suitable OAuth setup, backup/restore rehearsal, and an operational security review. None is claimed as deployed here.

For daily use, restart and troubleshooting, see [RUN_GUIDE.md](RUN_GUIDE.md). Older detailed configuration notes remain in [DEPLOYMENT_NOTES.md](DEPLOYMENT_NOTES.md).
