# Run Loom locally

Implementation checkpoint: 2026-10-22. The manual desk, approved knowledge, and OpenRouter-backed proposal pipeline are implemented. The heuristic recommendation engine has been removed. Ten real Exasol tests cover orchestration (the external provider is explicitly mocked only in tests), and adapter tests cover OpenRouter HTTP/JSON behavior. The private key is configured and free-only routing is enabled. The configured model is `openrouter/free`; successful schema parsing alone is not treated as evidence of correct actions. Production-browser and restart verification are tracked separately below. The earlier deterministic-engine restart result does not verify the new provider path.

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

## OpenRouter model setup and reviewed proposals

Apply migration `004_openrouter_runs` with `pnpm db:migrate`. Set these values in the repository's private `.env` (never in `NEXT_PUBLIC_*` variables or chat):

```dotenv
OPENROUTER_API_KEY=your-private-key
OPENROUTER_MODEL=openrouter/free
OPENROUTER_FREE_ONLY=true
OPENROUTER_MAX_OUTPUT_TOKENS=8192
OPENROUTER_TIMEOUT_MS=90000
# Leave OPENROUTER_REASONING_ENABLED unset for router compatibility.
```

Choose a model/provider endpoint with [structured-output support](https://openrouter.ai/docs/guides/features/structured-outputs). The example uses OpenRouter’s free router, which selects a compatible available free model per request; the app itself has no hardcoded model ID or heuristic fallback. The adapter uses OpenRouter's chat-completions API with strict JSON schema and `provider.require_parameters=true`. Free-only mode is enabled by default, rejects paid model IDs (including a paid model pinned in an older run), and sends a zero-price cap for input/output/per-request routing. Only explicit `:free` models or `openrouter/free` are accepted in this mode; there is no paid fallback. Unsupported parameters/models, missing credentials, insufficient credits, rate limits, refusals, truncated output, invalid JSON, or unsupported actions produce explicit errors. Provider error bodies, keys, and source text are not logged. `data_collection=deny` requests compatible provider data policies; it is not a claim that all retention is eliminated. Review your chosen provider/account settings. Restart the app after changing environment configuration.

1. Owners/operators open **Team knowledge** and draft procedures, glossary entries, or routing guidance in their own words. Dataset/owner metadata is optional. Only an owner can approve, retire, or approve a replacement. Source content is immutable; approving a linked replacement supersedes its predecessor. These are user-managed documents, not executable routing rules.
2. Open **Run triage and review proposals**. Select 1–20 requests and enter your own instructions. The chosen OpenRouter model is displayed. Starting the run stores the task, exact model ID, prompt version, fixed template revision, selected records, and 30-minute expiry in Exasol. Without model configuration, starting a run fails rather than pretending to work.
3. **Process next request** makes one model call for the current checkpoint. It receives the task, authorized request and comments, active approved knowledge prose, current members, and supported tool/action constraints. There is no dataset matcher, canned clarification response, predefined assignment, or deterministic recommendation. The model selects proposed commands, explanation, uncertainty, and evidence IDs. No request changes during generation.
4. Review the model's explanation, sources, full exact command JSON, before/after owner/status, model identity, and token metadata. Supported commands can also change priority, due date, descriptions, or comment visibility; their exact parameters are shown in the command JSON. The model cannot generate executable SQL/code or bypass permissions. Schema validity does not prove factual correctness or evidence support.
5. Finish the run, confirm the displayed review hash, and approve or reject an individual proposal. Approval never calls the model again or substitutes recomputed recommendations. It applies only the stored, reviewed commands through the same transactional command service as manual edits. Current role, initiator eligibility, target version, source revisions/validity, knowledge context, and command preconditions are rechecked. Any conflict blocks the entire proposal without partial writes.

Inference is outside the database transaction and write coordinator. A short reservation transaction records the input snapshot/hash, command/attempt identity, and a two-minute lease. Finalization opens a fresh transaction and rechecks permissions, run state/version, and the whole context. Changes to records, comments, members, or approved knowledge discard the response. Cancellation can run while inference is pending; aborting the provider is best effort and cancelled results cannot be saved/applied.

There are at most two provider-call attempts per request checkpoint, including failed/interrupted attempts. Retries are explicit; there are no automatic paid retries or model fallbacks. An in-flight lease blocks duplicate calls. After a process crash, wait for its two-minute lease to expire before an explicit retry. Completed checkpoints/command receipts reconcile without another call. A crash between provider success and durable persistence can still cause a second charge; this is not exactly-once provider billing. Token counts, generation/model IDs, duration, and cost when returned are stored with successful outputs; failed/unknown calls may still be billable. The configured free-only mode caps provider prices at zero. Free models still have rate/capacity limits; an individual free endpoint may return 429. `openrouter/free` is the configured router. Endpoint availability and model output quality can vary between calls; no account privacy setting was changed. Both requested and actual model identities are recorded.

The current context limit is 120 KB UTF-8, at most 50 approved knowledge entries and 20 comments per selected request. Overflow is an explicit error, not silent truncation. A general retrieval strategy is still pending. The output-token limit must be 256–8192; provider timeout 1–90 seconds. Optional `OPENROUTER_REASONING_ENABLED` can be true, false, or unset; the selected free model permits disabling reasoning. Reasoning can otherwise consume the completion budget before visible JSON appears. The selected model needed more than a 2,048-token total budget with default reasoning. Each run processes at most 20 records and expires after 30 minutes. All snapshots/attempt metadata remain private in Exasol; automated retention is pending. Historical heuristic runs remain readable but cannot be advanced or approved through the new engine.

Only owners/operators can read model context, runs, or knowledge. The initiator or a workspace owner can advance/cancel; eligible operators can review workspace proposals. Source files, model-authored tool generation, proposal editing, whole-run atomic approval, production identity, and quality/productivity evaluation remain unfinished.

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
pnpm test:restart
pnpm model:check
```

Browser tests use `/usr/bin/google-chrome` by default; set `CHROME_PATH` if needed. The preview suite starts the production build on loopback port 3100 with public synthetic test configuration and no database credentials. The connected suite uses port 3200. The preview suite verifies the UI/API boundary without database credentials. The connected suite loads private `.env`, uses local Exasol and seeded synthetic personas, and exercises actual saves and denied API operations. Run `pnpm build` before browser and restart tests. The connected live-model journey is skipped unless `LOOM_TEST_LIVE_MODEL=true` and both OpenRouter settings are present; skipped tests do not establish live-model correctness. `test:restart` requires configured OpenRouter credentials/model and seeded local personas, makes two live provider calls, and starts a temporary loopback production server on port 3400, records a checkpoint, stops it, starts a fresh process, resumes the run, and checks that no request changed. It cleans only the synthetic records/command IDs it created. Run it separately from other database-backed application servers or writers. Screenshots and reports are ignored by Git.

Do not run a build and a development server in the same app directory concurrently; they share `.next`. Formatting is available through `pnpm format`. The lockfile pins resolved dependencies.

## Verified checkpoint

| Component/check | Result |
| --- | --- |
| Runtime/package manager | Node 24.15.0; pnpm 10.31.0 |
| Application | Next.js 16.4.2, one Node process |
| Local database | Launcher 2.3.0; Personal 2026.2.0-nano.3; rootless Podman |
| Adapter | Official TypeScript driver 0.8.1; verified private CA and hostname |
| Static checks | TypeScript, ESLint, formatting, production build passed |
| Unit/service tests | 33 passed; mocked SQL/driver boundaries clearly separated |
| Real SQL integration | 10 passed; real Exasol, explicit test-only provider fixtures, temporary workspaces cleaned up |
| Preview browser suite | 4 passed, including mobile and denied API calls |
| Connected production journeys | Manual desk, CSV transfer, and missing-model rejection verified; current free-router browser journey failed: malformed action output was rejected and no proposal saved |
| Restart recovery | Live-model restart check available; not yet verified against the current provider transport. The earlier heuristic check is superseded |

The adapter uses the official driver's public prepared-statement command API because its 0.8.1 `prepare()` error path can retain a connection. Values follow returned parameter metadata. Next config selects `ws`'s supported JavaScript masking fallback for its production bundle. No TLS bypass is used.

Synthetic browser runs create demonstration records; failed runs may leave their test requests in the desk. They do not reset other records. `test:db` creates and removes separate temporary workspaces. A full reset/export/restore workflow is still planned.

Use `pnpm db:status`, `pnpm db:stop`, and `pnpm db:start` to manage the project-local database. Keep `.local` and `.env` private and ignored by Git. The helper pins Linux x86_64; use official platform setup for other hosts.

`pnpm model:check` makes a live request using only synthetic fixtures and prints model/usage and the generated proposal. It never modifies requests. The current configuration uses `openrouter/free` and leaves reasoning overrides unset for compatibility. The current transport passed a live synthetic `openrouter/free` check: the router selected `dots-studio/dots-3-note-preview:free`, returned a valid comment action, and reported cost zero. Other router checks encountered unsupported/unavailable endpoints and malformed action output. Earlier output also contained ineffective actions despite a plausible explanation; the server now rejects duplicate and no-op state changes. A successful synthetic call does not establish browser approval or restart correctness. No account privacy settings or paid fallback were enabled, and no key or private `.env` content is committed.

## Next implementation gates

1. Finish remaining M0 contracts and deliberately invalid composite-reference checks; verify the new model-backed restart path with live credentials.
2. Extend precision limits, forced database collision, lost-acknowledgement, restart, and backup/restore checks. The current cross-route command-conflict journey already passes.
3. Finish owner eligibility updates and the reusable ToolSpec renderer; measure larger CSV batches before adding chunking/source-ID merge.
4. Improve structured-action reliability and verify the live browser/restart paths with the configured free router; add bounded knowledge/query retrieval.
