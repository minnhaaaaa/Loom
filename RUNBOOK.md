# Run Loom locally

Implementation checkpoint: 2026-10-22. The Next.js request desk and Exasol server adapter exist. Exasol Personal is running locally; compatibility checks and four live database tests passed. Two connected production-browser journeys also passed. Agent runs, proposal review, generated tool definitions, approved knowledge, and production identity are not implemented yet.

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

The original global launcher was 2.2.0 and rejected Linux local deployment. After installing Podman, a verified launcher **2.3.0** was placed in the ignored `.local/bin` directory. Its SHA-256 matches the official starter kit's version manifest. The existing global launcher was left unchanged. The local database is ready, migrations and synthetic seeding succeeded, and live SQL checks passed. No cloud infrastructure was created.

For a fresh Linux x86_64 host:

```sh
sudo apt-get install -y podman uidmap
podman info
pnpm db:setup
```

`db:setup` downloads the pinned official launcher, verifies its checksum, and installs Personal under `.local/exasol`. It brings up only the local database; it does not configure AI clients. Other platforms should follow the current official starter kit. Inspect the Personal terms and host preparation steps reported by the launcher.

This workspace already has a private `.env` created from the local deployment. Do not overwrite it. For a fresh clone, copy the template and edit it locally:

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

`db:check` exercises TLS, prepared bindings, prepare-error recovery, primary-key rejection, rollback, scalar mappings, and UTC timestamp round trips. It reports the actual database version. `test:db` uses the actual configured Exasol connection and creates fresh UUID-scoped fixtures; cleanup deletes only those fixture workspaces. It checks request isolation, internal-comment filtering, command replay/conflicts, concurrent versions, history counts, and rollback. It deliberately fails when no database is configured. These checks passed against the current local deployment. The separate production-browser suite verifies the application/server boundary.

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

Queue summary SQL runs on Exasol for internal personas. Cards show a named query ID and query time when available; list-derived counts are labeled separately. Search and status filters execute in authorized SQL across the queue. Lists show 25 rows per page, newest creation first with ID as a deterministic tie-breaker. Pagination uses bounded offsets (up to page index 4,000); concurrent inserts can shift page boundaries. It is a live list, not a frozen export snapshot. Returning to page one shows new requests.

## Transfer a synthetic CSV backlog

Apply migration `002_csv_imports` with `pnpm db:migrate`. Open **CSV import / export** below the queue. Owners/operators can choose `exasol/fixtures/request-backlog.csv`, map its four intake columns, generate a preview, inspect every row and warning, tick the review checkbox, and commit. Title and business question are required. Missing dataset/reporting period is allowed and starts that request as Needs information. Other rows start as New. Each imported request belongs to the importing persona, with normal priority, no owner, and no due date. Other CSV columns are deliberately ignored; existing requester identities/status/history are not migrated.

Uploads are UTF-8 CSV, at most 5 MiB, 100 data records, 20 uniquely named columns, and 20,000 characters per record. The JSON transport has an additional 6 MiB limit. Parsing handles BOMs, quoted commas, escaped quotes, and multiline cells. Invalid intake, inconsistent columns, repeated mapped rows, or ambiguous mapping prevents the whole batch from committing. Fix the file and regenerate the preview; no rows are silently dropped. CSV record numbers count parsed records, not physical lines in multiline files.

Preview mappings, normalized rows, source/preview hashes, actor, workspace, and a 30-minute expiry are stored in Exasol. Commit checks current membership and exact preview hash. Requests, history, audit/outbox events, batch result, and command receipt save in one transaction. Retry the unchanged action after an uncertain response; its command ID or committed batch returns the original IDs. Reopening the exact same file with the same mapping as the same actor also returns an existing committed batch. This is batch deduplication, not detection of the same business request across edited files or different people. Stable source-ID merge/update is future work.

All signed-in roles can export authorized rows with the current search/status filters, across all pages. Requesters export only their own requests, without internal priority/comments/metrics. Exports contain request fields, not comment/activity history. More than 500 matches returns an error asking for narrower filters; there is no silent truncation. Formula-like cell prefixes are neutralized and cells are quoted. CSV is a viewing/transfer format, not a full backup or lossless formula-text round trip.

Expired previews are rejected but retained in Exasol; automated retention/cleanup remains future work. Use synthetic data only. Browser tests likewise retain synthetic demo records; database integration fixtures are isolated and removed.

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
pnpm test:e2e:connected
```

Browser tests use `/usr/bin/google-chrome` by default; set `CHROME_PATH` if needed. The preview suite starts the production build on loopback port 3100 with public synthetic test configuration and no database credentials. The connected suite uses port 3200. The preview suite verifies the UI/API boundary without database credentials. The connected suite loads private `.env`, uses local Exasol and seeded synthetic personas, and exercises actual saves and denied API operations. Run `pnpm build` before browser tests. Screenshots and reports are ignored by Git.

Do not run a build and a development server in the same app directory concurrently; they share `.next`. Formatting is available through `pnpm format`. The lockfile pins resolved dependencies.

## Verified checkpoint

| Component/check | Result |
| --- | --- |
| Runtime/package manager | Node 24.15.0; pnpm 10.31.0 |
| Application | Next.js 16.4.2, one Node process |
| Local database | Launcher 2.3.0; Personal 2026.2.0-nano.3; rootless Podman |
| Adapter | Official TypeScript driver 0.8.1; verified private CA and hostname |
| Static checks | TypeScript, ESLint, formatting, production build passed |
| Unit/service tests | 24 passed; mocked SQL/driver boundaries clearly separated |
| Real SQL integration | 4 passed; temporary UUID-scoped workspaces cleaned up |
| Preview browser suite | 4 passed, including mobile and denied API calls |
| Connected production journeys | 2 passed: manual coordination and protected API; CSV mapping/review/commit/scoped download |

The adapter uses the official driver's public prepared-statement command API because its 0.8.1 `prepare()` error path can retain a connection. Values follow returned parameter metadata. Next config selects `ws`'s supported JavaScript masking fallback for its production bundle. No TLS bypass is used.

Synthetic browser runs create demonstration records; failed runs may leave their test requests in the desk. They do not reset other records. `test:db` creates and removes separate temporary workspaces. A full reset/export/restore workflow is still planned.

Use `pnpm db:status`, `pnpm db:stop`, and `pnpm db:start` to manage the project-local database. Keep `.local` and `.env` private and ignored by Git. The helper pins Linux x86_64; use official platform setup for other hosts.

## Next implementation gates

1. Finish the remaining M0 contracts, invalid composite-reference checks, and durable agent checkpoint.
2. Extend precision limits, forced database collision, lost-acknowledgement, restart, and backup/restore checks. The current cross-route command-conflict journey already passes.
3. Finish owner eligibility updates and the reusable ToolSpec renderer; measure larger CSV batches before adding chunking/source-ID merge.
4. Add evidence-backed agent proposals only after the manual persistence checks pass. No model credentials are needed for this checkpoint.
