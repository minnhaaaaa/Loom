# Run Loom locally

Implementation checkpoint: 2026-10-21. The Next.js request desk and Exasol server adapter exist. Live database verification is pending. Agent runs, proposal review, generated tool definitions, CSV import/export, approved knowledge, and production identity are not implemented yet.

## Requirements and preview

Use Node 24 LTS and pnpm 10.31.0 (see `.nvmrc` and `packageManager`). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. With no database credentials, Loom shows a **read-only sample preview**: synthetic requests, search/status filters, request details, and the intake form. Preview saves are disabled. It does not use localStorage, SQLite, or an in-memory database to simulate persistence.

The frontend is basic semantic React and plain CSS. Edit `apps/web/components/desk.tsx` and `apps/web/app/globals.css` for the later redesign. Fields come from the fixed specification in `packages/contracts/src/index.ts`; generation/publication is future work.

## Connect Exasol Personal

Use the current [official starter kit](https://www.exasol.com/developers/) and its [Linux setup](https://github.com/exasol-labs/exasol-personal-local-starterkit/blob/main/setup/setup-linux.sh). Linux requires usable rootless Podman. Follow its prerequisite and certificate instructions; Docker alone does not satisfy that path. No cloud resources are needed.

On this workspace, the installed `exasol` launcher is version 2.2.0. Its `install local` command failed with `local deployments are only supported on macOS Apple Silicon (current platform: linux/amd64)`. The current starter kit has a Linux path, but its preflight reports that Podman is missing. Network, disk, memory, architecture, and port checks passed outside the network-restricted sandbox. Installing Podman was attempted, but `sudo` requires interactive authentication. The database was not installed and no cloud infrastructure was created.

On a Debian/Ubuntu host, install the prerequisite in your own terminal, then follow the current kit's setup instructions:

```sh
sudo apt-get install -y podman uidmap
podman info
```

The kit may require updating the old launcher. Do not repeatedly use the unsupported 2.2.0 local preset on Linux. Inspect installer options; Loom needs the database, not automatic configuration of unrelated AI clients. Resolve any rootless namespace prerequisites reported by the kit.

Copy the configuration template and edit it locally:

```sh
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `LOOM_SESSION_SECRET`; fill `EXASOL_HOST`, `EXASOL_PORT`, `EXASOL_USER`, and `EXASOL_PASSWORD` from your deployment. Set `EXASOL_CA_FILE` to its trusted PEM CA if it uses a private CA. The host must match the certificate. Certificate/hostname verification remains enabled; there is no insecure TLS option. Use an empty, dedicated `EXASOL_SCHEMA=LOOM` for first setup. Never commit `.env`, certificates containing private keys, deployment state, or credentials.

Run from the root after the database is available:

```sh
pnpm db:migrate
pnpm db:check
pnpm db:seed
pnpm test:db
pnpm dev
```

`db:migrate` creates the schema and records a migration checksum. It does not reset an existing database or accept changed applied migrations. `db:seed` inserts public synthetic fixtures and two isolation workspaces; if the primary fixture workspace already exists, it leaves it untouched. Do not run migrations concurrently or against an unrelated populated schema. Rehearse against the installed Exasol release before trusting the SQL.

`db:check` exercises TLS, prepared bindings, primary-key rejection, rollback, and scalar mappings. `test:db` uses the actual configured Exasol connection and creates fresh UUID-scoped fixtures; cleanup deletes only those fixture workspaces. It checks request isolation, internal-comment filtering, command replay/conflicts, concurrent versions, history counts, and rollback. It deliberately fails when no database is configured. These checks have **not passed on a live database yet**.

## Use the manual desk

With Exasol configured and seeded, choose a synthetic persona:

| Persona | Capabilities |
| --- | --- |
| Ananya, owner | Read the queue; create requests; edit descriptions, owners, priority, due dates, and status; comment. |
| Rohan, operator | Same manual request controls in this checkpoint. Membership/publication controls are not implemented. |
| Meera, requester | Submit, read, and edit own requests; add requester-visible comments. Internal priority, comments, and queue aggregates are excluded. |
| Dev, viewer | Read-only internal queue and comments. |

Create a request with a title and business question. Add reporting period and dataset before advancing to Ready. The transition sequence is New → Ready → In progress → Done; Needs information and Cancelled are explicit alternatives. Reopening completed/cancelled work follows the domain transition rules.

Saved lists refresh every 15 seconds and on window focus. Details refresh on open, explicit refresh, and successful changes. Expected versions reject stale edits; the form retains unsaved input on failure. The client reuses its pending command ID when retrying the identical action in the same session. Command receipts, request revisions, audit events, and outbox entries commit with the change. Outbox delivery, presence, and cross-process scheduling are not implemented.

Queue summary SQL runs on Exasol for internal personas. Cards show a named query ID and query time when available; list-derived counts are labeled separately. The current list loads at most 100 recent requests; full pagination is pending.

## Production build for a local demonstration

```sh
pnpm build
pnpm start
```

The process binds to loopback. Production builds disable demo sign-in by default. For an operator-owned synthetic demonstration only, explicitly set `LOOM_ALLOW_DEMO_PRODUCTION=true`, `LOOM_AUTH_MODE=local-demo`, a loopback `APP_ORIGIN` matching the browser address, and a strong session secret. Restart after environment changes. This is not production authentication or a licensed shared service.

Run exactly one Node process: the process-wide write coordinator is not a distributed lock. Do not use replicas, serverless instances, or independent direct SQL writers. Verify cross-route coordination against live Exasol before expanding deployment. Personal's individual-use terms still apply; synthetic personas do not establish multi-user licensing permission.

## Verification commands

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
pnpm test:e2e
```

Browser tests use `/usr/bin/google-chrome` by default; set `CHROME_PATH` if needed. They start the production build on loopback port 3100 with public synthetic test configuration and no database credentials. They verify the actual preview UI/API boundary; they do not establish live SQL correctness. Run `pnpm build` before browser tests. Screenshots and reports are ignored by Git.

Do not run a build and a development server in the same app directory concurrently; they share `.next`. Formatting is available through `pnpm format`. The lockfile pins resolved dependencies.

## Next implementation gates

1. Finish current Linux Personal setup and pass `db:check` and `test:db`.
2. Verify production cross-route mutation coordination, real SQL collision codes, timestamp/large-number behavior, and ambiguous-commit recovery.
3. Complete pagination, CSV mapping/import/export, owner eligibility updates, and remaining M1 checks.
4. Add evidence-backed agent proposals only after the manual persistence checks pass. No model credentials are needed for this checkpoint.
