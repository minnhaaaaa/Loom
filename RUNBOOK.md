# Run Loom locally

## Single-prompt workspace — 2026-10-28

The normal entry point (`/` or `/?view=assistant`) has one conversation composer. `/?view=records` opens saved work; `/?view=settings` holds company setup, teammates, the optional manual tool builder, and advanced source/run administration. A new company owner sees onboarding first until setup is complete. End users do not need to select requests, create triage runs, or fill a knowledge form to ask a question.

Apply migration `008_conversations` with `pnpm db:migrate` before using the conversation API. `GET /api/conversation` returns the signed-in person's authorized recent messages and agent configuration; `POST` accepts `{commandId,prompt}`. Prompts and results persist in Exasol. Historical conversation visibility follows the exact role under which it was created; changing roles hides earlier differently scoped turns. Conversations are personal to their author within the shared workspace.

For **Loom's agent**, model output decides whether to answer, ask a follow-up, propose supported changes, or ask the existing tool designer for an unpublished draft. There are no business-keyword shortcuts or canned success replies. Provider failure is shown explicitly. Built-in generation retains free-only configuration and does not silently switch providers. Model calls run outside database write transactions; completion rechecks permissions, record versions, tool revision, membership context, and approved sources.

For **Codex, Claude Code, or another MCP client**, the prompt is queued durably for the selected client type. The connected client must call `loom_list_tasks`, perform its work, and call `loom_reply_task` with the current task version and context hash. `loom_propose_changes` can attach a `taskId`; owners' tool requests can use `loom_propose_tool` to prepare an unpublished draft. Loom displays the response and linked reviews in the conversation. Loom does not start a remote CLI or run an automatic external-client polling loop. Until the client picks up a prompt, the UI says it is waiting. External task delivery currently supports owners/operators; requester/viewer conversations require the built-in agent.

Record proposals still require explicit authorized approval; tool publication still requires owner review. The supported component/action catalog remains bounded to one request-family tool per workspace. Conversation actions currently edit existing sampled records; creating a new request uses **Saved work → New request**. Prompting does not add arbitrary generated code, external integrations, or autonomous actions.

Implementation checkpoint: 2026-10-27. Versioned tool design/publication and the shared request-family renderer are now implemented; detailed verification is recorded below. The manual desk, approved knowledge, and OpenRouter-backed proposal pipeline are implemented. The heuristic recommendation engine has been removed. Seventeen real Exasol tests cover persistence and orchestration (the external provider is explicitly mocked only in tests), and adapter tests cover OpenRouter HTTP/JSON behavior. The private key is configured and free-only routing is enabled. Triage uses `openrouter/free`; the designer has the separate verified model documented below. Successful schema parsing alone is not treated as evidence of correct actions. Production-browser and restart verification are tracked separately below. The earlier deterministic-engine restart result does not verify the new provider path.

## Requirements and preview

Use Node 24 LTS and pnpm 10.31.0 (see `.nvmrc` and `packageManager`). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. With no database credentials, Loom shows a **read-only sample preview** with a disabled assistant composer. Saved work and settings expose synthetic records and the manual tool preview. Preview saves are disabled. It does not use localStorage, SQLite, or an in-memory database to simulate persistence.

The frontend is basic semantic React and plain CSS. Edit `apps/web/components/desk.tsx` and `apps/web/app/globals.css` for the later redesign. The working desk and builder preview use the validated definitions in `packages/contracts/src/tools.ts` through `apps/web/components/tool-renderer.tsx`. Apply migration `005_tool_definitions` before opening a configured database-backed build.

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

## Describe, refine, and publish a tool

Run `pnpm db:migrate` to apply the additive `005_tool_definitions` migration. It creates workspace-scoped tool drafts, immutable revisions, publication events, generation reservations, and a JSON-text column for custom request values. Existing request records are preserved.

1. Choose the owner persona and open **Customize this desk**. Preview visitors can use **Explore the tool builder** to try templates and direct controls without saving.
2. Start from **Data requests** or **IT requests**, or describe changes and choose **Generate a draft** with the configured OpenRouter model. Model calls are real, bounded, and free-only under the default policy; there is no generated-response fallback. A generation error leaves the published desk unchanged. Manual design works without a model.
3. Edit the title, description, field labels/visibility/requirements, optional text/textarea fields, queue columns, search/status filters, summary cards, and status labels. The preview uses the same components as the working desk. Changes remain local until saved and published.
4. Inspect changes and compatibility warnings, then **Save draft for review**. Check **I reviewed this saved draft and its exact changes** and **Publish reviewed tool**. Editing a saved draft clears its approval and requires a new immutable draft. Publication checks current owner access, the exact draft hash, and the expected published revision in one transaction.
5. Colleagues receive the published definition with the next authorized queue refresh (3 seconds by default, focus, reconnect, or explicit refresh). **Copy workspace link** copies the current workspace URL; it does not invite anyone or grant permissions. Password accounts can join through owner-issued invitations; local demo personas remain available only in explicitly enabled loopback demo mode.
6. Open **Saved drafts and publication history** to continue a draft or copy an earlier compatible definition into a new draft. Restoration publishes a new revision and never rolls back business records. If an older definition omits a custom field added since then, preserve that field in the new draft; destructive restoration is blocked.

The initial built-in definition is revision 1. Each workspace currently has one published request-family tool; the IT template changes its vocabulary through the same engine, rather than creating a separate dataset. Core field keys/types and six workflow states remain fixed. Up to eight custom fields use stable `custom_` keys, at most 2,000 characters per field and 8,000 encoded characters across submitted custom values. Custom fields start optional and may become required before Ready, with warnings that existing requests need review. Intake requirement tightening, removing fields, renaming keys, reducing limits, changing types, arbitrary components/actions, executable expressions, and generated SQL/code are rejected. Layout visibility is a presentation setting, not a new field-level authorization system.

Forms retain the definition they opened with and submit its revision. A newer publication rejects the old form's save and retains its input for review; closing/reopening loads current fields. Existing records retain custom values when unrelated descriptions change. Starting a triage run pins the published revision; republishing blocks later advance/approval of that older run. Owners review a fresh run instead. Summary completeness currently measures the two core readiness fields; custom readiness is enforced when editing/advancing requests. CSV imports still map the four core intake fields; exports include custom values as stable-key columns.

Generation reserves a command, model, prompt version, two-minute lease, and attempt count in Exasol, releases the transaction before calling the provider, and rechecks owner access and the current revision before retaining output. Identical completed commands return the saved draft; overlapping calls are blocked. At most two explicit attempts are allowed per generation command. Provider rate-limit delays are persisted and returned through `Retry-After`; the builder displays a countdown without automatic calls. Retrying unchanged input reuses its command ID. Once its attempts are exhausted, **Start new generation** explicitly creates a new command while preserving the editor. Upstream errors are sanitized, including errors inside HTTP 200 responses. A crash after provider completion but before persistence can require another call and is not exactly-once billing. History/draft lists show the latest 20 entries; pagination and retention remain future work.

## Use the manual desk

With Exasol configured and seeded, choose a synthetic persona:

| Persona          | Capabilities                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Ananya, owner    | Read the queue; create requests; edit descriptions, owners, priority, due dates, and status; comment.                                |
| Rohan, operator  | Same manual request controls in this checkpoint. Only workspace owners manage membership and publish tools.                          |
| Meera, requester | Submit, read, and edit own requests; add requester-visible comments. Internal priority, comments, and queue aggregates are excluded. |
| Dev, viewer      | Read-only internal queue and comments.                                                                                               |

Create a request with a title and business question. Add reporting period and dataset before advancing to Ready. The default transition sequence is New → Ready → In progress → Done; Needs information and Cancelled are explicit alternatives. Reopening completed/cancelled work follows the domain transition rules.

Saved queues and open details refresh every three seconds by default, on focus/reconnect, and after successful changes. `LOOM_POLL_INTERVAL_MS` can be 1000–30000 milliseconds. Expected versions reject stale edits; the form retains unsaved input on failure. The client reuses its pending command ID when retrying the identical action in the same session. Command receipts, request revisions, audit events, and outbox entries commit with the change. Outbox delivery, presence, and cross-process scheduling are not implemented.

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
2. Open **Run triage and review proposals**. Select 1–20 requests and enter your own instructions. The chosen OpenRouter model is displayed. Starting the run stores the task, exact model ID, prompt version, current published tool revision, selected records, and 30-minute expiry in Exasol. Without model configuration, starting a run fails rather than pretending to work.
3. **Process next request** makes one model call for the current checkpoint. It receives the task, authorized request and comments, active approved knowledge prose, current members, and supported tool/action constraints. There is no dataset matcher, canned clarification response, predefined assignment, or deterministic recommendation. The model selects proposed commands, explanation, uncertainty, and evidence IDs. No request changes during generation.
4. Review the model's explanation, sources, full exact command JSON, before/after owner/status, model identity, and token metadata. Supported commands can also change priority, due date, descriptions, or comment visibility; their exact parameters are shown in the command JSON. The model cannot generate executable SQL/code or bypass permissions. Schema validity does not prove factual correctness or evidence support.
5. Finish the run, confirm the displayed review hash, and approve or reject an individual proposal. Approval never calls the model again or substitutes recomputed recommendations. It applies only the stored, reviewed commands through the same transactional command service as manual edits. Current role, initiator eligibility, target version, source revisions/validity, knowledge context, and command preconditions are rechecked. Any conflict blocks the entire proposal without partial writes.

Inference is outside the database transaction and write coordinator. A short reservation transaction records the input snapshot/hash, command/attempt identity, and a two-minute lease. Finalization opens a fresh transaction and rechecks permissions, run state/version, and the whole context. Changes to records, comments, members, or approved knowledge discard the response. Cancellation can run while inference is pending; aborting the provider is best effort and cancelled results cannot be saved/applied.

There are at most two provider-call attempts per request checkpoint, including failed/interrupted attempts. Retries are explicit; there are no automatic paid retries or model fallbacks. An in-flight lease blocks duplicate calls. After a process crash, wait for its two-minute lease to expire before an explicit retry. Completed checkpoints/command receipts reconcile without another call. A crash between provider success and durable persistence can still cause a second charge; this is not exactly-once provider billing. Token counts, generation/model IDs, duration, and cost when returned are stored with successful outputs; failed/unknown calls may still be billable. The configured free-only mode caps provider prices at zero. Free models still have rate/capacity limits; an individual free endpoint may return 429. `openrouter/free` is the configured router. Endpoint availability and model output quality can vary between calls; no account privacy setting was changed. Both requested and actual model identities are recorded.

The current context limit is 120 KB UTF-8, at most 50 approved knowledge entries in the authorized candidate corpus and 20 comments per selected request. The agent receives the top 12 matching approved entries using bounded normalized keywords and metadata; retrieval scores indicate relevance, not confidence. Its query includes the task, record, and custom values, and the context includes the published tool's field labels. A digest of the full approved corpus still invalidates stale proposals when unselected guidance changes. Candidate-corpus or comment overflow is an explicit error. Semantic retrieval remains deferred. The output-token limit must be 256–8192; provider timeout 1–90 seconds. Optional `OPENROUTER_REASONING_ENABLED` can be true, false, or unset. Reasoning can consume the completion budget before visible JSON appears. Each run processes at most 20 records and expires after 30 minutes. All snapshots/attempt metadata remain private in Exasol; automated retention is pending. Historical runs using older prompt versions are readable but cannot advance; start a new run with `triage-llm-v3`.

Only owners/operators can read model context, runs, or knowledge. The initiator or a workspace owner can advance/cancel; eligible operators can review workspace proposals. Source files, proposal editing, whole-run atomic approval, SSO/email verification/password reset, and quality/productivity evaluation remain unfinished. Tool-definition generation is implemented separately from operating-agent triage, with live designer creation/refinement and publication now verified independently of the still-unverified live triage/restart paths.

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

Browser tests use `/usr/bin/google-chrome` by default; set `CHROME_PATH` if needed. The preview suite starts the production build on loopback port 3100 with public synthetic test configuration and no database credentials. The connected suite uses port 3200. The preview suite verifies the UI/API boundary without database credentials. The connected suite loads private `.env`, uses local Exasol and seeded synthetic personas, and exercises actual saves and denied API operations. Run `pnpm build` before browser and restart tests. The connected live-triage journey is skipped unless `LOOM_TEST_LIVE_MODEL=true` and both OpenRouter settings are present; skipped tests do not establish live-model correctness. `test:restart` requires configured OpenRouter credentials/model and seeded local personas, makes two live provider calls, and starts a temporary loopback production server on port 3400, records a checkpoint, stops it, starts a fresh process, resumes the run, and checks that no request changed. It cleans only the synthetic records/command IDs it created. Run it separately from other database-backed application servers or writers. Screenshots and reports are ignored by Git.

Do not run a build and a development server in the same app directory concurrently; they share `.next`. Formatting is available through `pnpm format`. The lockfile pins resolved dependencies.

## Verified checkpoint

| Component/check               | Result                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime/package manager       | Node 24.15.0; pnpm 10.31.0                                                                                                                                                  |
| Application                   | Next.js 16.4.2, one Node process                                                                                                                                            |
| Local database                | Launcher 2.3.0; Personal 2026.2.0-nano.3; rootless Podman                                                                                                                   |
| Adapter                       | Official TypeScript driver 0.8.1; verified private CA and hostname                                                                                                          |
| Static checks                 | TypeScript, ESLint, formatting, production build passed                                                                                                                     |
| Unit/service tests            | 63 passed on 2026-10-27; mocked SQL/provider boundaries remain explicit                                                                                                     |
| Real SQL integration          | 17 passed on 2026-10-27 across four suites; real Exasol with isolated UUID fixture cleanup and explicitly test-only provider fixtures                                       |
| Preview browser suite         | 6 passed on 2026-10-27, including template/custom-field exploration, desktop/mobile layout, and denied API calls                                                            |
| Connected production journeys | Manual desk, CSV transfer, reviewed publication, and live AI generation/reload/review/publication/requester rendering pass. Live triage remains a separate unresolved check |
| Restart recovery              | Live-model restart check available; not yet verified against the current provider transport. The earlier heuristic check is superseded                                      |

The adapter uses the official driver's public prepared-statement command API because its 0.8.1 `prepare()` error path can retain a connection. Values follow returned parameter metadata. Next config selects `ws`'s supported JavaScript masking fallback for its production bundle. No TLS bypass is used.

Synthetic browser runs create demonstration records; failed runs may leave their test requests in the desk. They do not reset other records. `test:db` creates and removes separate temporary workspaces. A full reset/export/restore workflow is still planned.

Use `pnpm db:status`, `pnpm db:stop`, and `pnpm db:start` to manage the project-local database. Keep `.local` and `.env` private and ignored by Git. The helper pins Linux x86_64; use official platform setup for other hosts.

`pnpm model:check` makes a live request using only synthetic fixtures and prints model/usage and the generated proposal. It never modifies requests. The current configuration uses `openrouter/free` and leaves reasoning overrides unset for compatibility. The current transport passed a live synthetic `openrouter/free` check: the router selected `dots-studio/dots-3-note-preview:free`, returned a valid comment action, and reported cost zero. Other router checks encountered unsupported/unavailable endpoints and malformed action output. Earlier output also contained ineffective actions despite a plausible explanation; the server now rejects duplicate and no-op state changes. A successful synthetic call does not establish browser approval or restart correctness. No account privacy settings or paid fallback were enabled, and no key or private `.env` content is committed.

## Next implementation gates

1. Finish remaining M0 contracts and deliberately invalid composite-reference checks; verify the new model-backed restart path with live credentials.
2. Extend precision limits, forced database collision, lost-acknowledgement, restart, and backup/restore checks. The current cross-route command-conflict journey already passes.
3. Finish owner eligibility updates and the reusable ToolSpec renderer; measure larger CSV batches before adding chunking/source-ID merge.
4. Improve structured-action reliability and verify the live browser/restart paths with an available configured free model; evaluate the bounded keyword/metadata retrieval baseline and richer query evidence.

## Tool-building verification delta — 2026-10-27

Initial tool-building verification, before designer hardening: TypeScript, ESLint, formatting, production build, 51 unit/service tests, 16 real Exasol tests, six preview browser tests, and three connected production journeys passed. Two connected checks were skipped: the live triage journey was explicitly disabled, and the missing-model test requires absent credentials. Those skips do not establish live-model correctness. The connected tool test restored the original definition through a fresh publication; historical synthetic drafts/revisions and desk fixtures remain as documented. The current designer transport (`tool-designer-v4`) asks the model for bounded catalog choices rather than a full polymorphic specification; code assembles those exact choices into the five known views and fixed core field descriptors, then validates the complete ToolSpec. This is deterministic decoding, without semantic repair or a generated-response fallback.

Earlier full-spec/router checks rejected invalid custom-field requirements or encountered HTTP 404/429. They were superseded by the current flat transport and a separate tested designer model. Four live synthetic calls now pass: exact title-only refinement; facilities-tool creation with `custom_location`; refinement adding `custom_asset_tag` while preserving records; and production-browser generation/reload/review/publication/requester rendering. Each reported cost zero. No paid route or privacy-setting change was introduced. These checks do not establish general instruction fidelity, uptime, or the proposed 95% quality target.

## Reproduce live AI tool generation

Keep `OPENROUTER_MODEL` for operating-agent triage. Optionally set `OPENROUTER_TOOL_MODEL` to configure the designer separately; an empty value uses `OPENROUTER_MODEL`. The current local designer is `dots-studio/dots-3-note-preview:free`, tested with `OPENROUTER_FREE_ONLY=true`, `data_collection=deny`, and zero-price provider caps. The generic triage model remains `openrouter/free`. Model availability can change; choose a compatible endpoint rather than weakening privacy or allowing a paid fallback. Restart the app after private environment changes.

```sh
pnpm tool:check
LOOM_TEST_LIVE_TOOL_GENERATION=true LOOM_TEST_LIVE_MODEL=false pnpm test:e2e:connected tests/connected/tool-generation.spec.ts
```

`tool:check` makes two real model calls and exercises generated creation/refinement, explicit publication, command replay, requester reads, custom values, and record preservation in an isolated synthetic Exasol workspace. It deletes only its generated workspace and records, including on failure. Run it separately from application servers/database writers. The browser journey makes one real call, inspects and reloads the exact saved draft before approval, publishes through the UI, verifies requester access, and restores the original compatible definition through ordinary publication. Synthetic draft/revision history remains. The other test in that browser file uses explicitly intercepted error responses to verify browser retry recovery; it never calls the provider or publishes. Live designer and live triage have separate opt-in flags; skipped tests do not prove provider correctness.

Saved generated drafts now expose requested/actual model, generation ID, prompt version, token counts, duration, and reported cost. Metadata survives response replay and reloading; its absence is never represented as a measured zero. Generator validation rejects incompatible changes against both the published definition and the owner's edited base before saving, preserves existing field order/fixed metadata, and never repairs or substitutes model decisions.

Current designer verification: 63 unit/service tests, 17 real Exasol tests, six preview browser tests, the live custom-field creation/refinement check, and the real-provider browser publication journey pass. Browser-only recovery fixtures separately verify rate-limit waits, same-ID retries, explicit new commands, and model-settings recovery without making provider calls. The earlier live triage/restart limitations remain.

Final connected regression run: four journeys passed with both live flags disabled; three skips were the separately verified live designer journey, the still-unverified live triage journey, and the missing-model check (credentials were configured). The dedicated live designer journey passed separately with actual model `dots-studio/dots-3-note-preview:free`, prompt `tool-designer-v4`, saved usage/cost metadata, and reported cost zero. The original published definition was restored; request records were preserved.

## Workspace sharing and collaboration — 2026-10-27

Apply `006_workspace_access`. It adds password identities, hashed sessions, invitations, membership versions, workspace audit events, and account-scoped workspace-creation receipts. Existing generated tools and records are preserved.

Use **Create a workspace** with `LOOM_ALLOW_WORKSPACE_SIGNUP=true` for owner bootstrap, or choose the local demo owner for synthetic testing. Open **Share workspace**, select Operator/Requester/Viewer, and **Create invitation link**. Copy/send it yourself. A colleague opens `/join#token=...`, creates a separate account or signs in, and accepts. Acceptance checks the invitation's state, expiry, workspace and current inviter authority in one transaction. A link cannot claim an existing email identity without signing in.

Owners can change roles, remove/restore access, and revoke unused invitations. Changes use membership versions; the last active owner cannot be removed or demoted. A revoked account can still authenticate and accept a new invitation or create its own workspace, without regaining access to old records. Workspace creation has account-scoped idempotency, independent of inaccessible prior workspaces. **Copy workspace link** targets `/w/<id>`; opening it checks access and selects the intended workspace rather than granting membership.

The workspace selector keeps tools/records scoped to the selected workspace. Independent colleague sessions see shared saved updates and comments. A remote edit updates current metadata while preserving a dirty description/comment draft. The conflict view shows current saved fields alongside the draft; **Keep my draft with current version** explicitly rebases reviewed input, and **Use latest saved values** explicitly adopts the server copy. No implicit rebase or silent overwrite occurs. New record/tool versions can still reject a later write.

Role changes, session changes, workspace changes, and denied refreshes clear or replace inaccessible local state. Requesters receive only own records, requester-visible comments, and no internal activity history. Queue/detail/access polling is authorized each time. This is saved-record collaboration, not character-level editing or presence.

For shared hosting use `LOOM_AUTH_MODE=workspace` with an HTTPS `APP_ORIGIN`. It rejects persona sign-in without revoking an existing password session. Workspace signup can be disabled after owner setup while invitations continue to work. Passwords require at least 12 characters and use salted scrypt; session cookies are HTTP-only and secure on HTTPS. Account endpoints enforce same-origin JSON and bounded authentication attempts. Invitations and session secrets are not logged or stored as plaintext tokens.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the free tunnel option, Render's web-hosting option, and the remaining Exasol hosting/edition constraints. The collaboration browser test uses two independent password accounts and no live model calls; it publishes a supported template through the same reviewed tool service.

Reproduce account-only collaboration with `pnpm test:e2e:sharing`. It runs the two-account browser journey with `LOOM_AUTH_MODE=workspace` in the test server: signup/invite acceptance, shared template publication, polling of records/comments, explicit stale-edit recovery, stable links, isolation, role downgrade, removal, and revoked-invitation denial. It makes no provider calls and leaves only uniquely named synthetic accounts/workspaces with independently random passwords. The ordinary connected suite retains local-demo mode for older synthetic-persona journeys.

Workspace-access verification: migration 006 applied; 71 unit/service tests and all 20 real Exasol tests pass. Six preview browser tests pass. The full two-account collaboration journey passed in both local-demo compatibility mode and account-only workspace mode. It verifies invitation acceptance, shared publication, saved-record/comment refresh, conflict review/rebase, workspace creation and stable links, denied guessed links, requester scoping, removal/cache clearing, and revoked invitations. These tests make no provider calls; the earlier real AI designer generation proof remains separate.

The final connected regression suite passed all five enabled journeys: manual desk, CSV transfer, reviewed tool publication, browser retry fixtures, and two-account collaboration. Three checks were skipped with live calls disabled or credentials present: live triage, live designer, and the missing-model configuration case. The live designer was verified separately as described above; live triage/restart remains unverified.

## Civitas UI adaptation — 2026-10-28

The working workspace now reuses presentation primitives adapted from `minnhaaaaa/civitas` commit `0c914bff3e29a544ea5e9fe53714ad44e55e9743`: wordmark/seal, overview metrics, decorative arrow, and terminal chrome. The latter appears in both the tool designer and agent workspace. Styling uses the source's forest, leaf, lime, and paper palette; Archivo Black, Manrope, and IBM Plex Mono are served locally. Upstream licenses and source paths are retained under `third-party/`.

TypeScript, ESLint, formatting, production build, all 71 unit/service tests, and all six preview browser tests pass. The account-only two-colleague journey also passes against the new UI. Additional browser inspection verifies the sidebar opens the builder, the 390px dialog sits at the viewport top without page overflow, background skip navigation is inert while the dialog is open, and no browser runtime errors occur. This UI pass makes no model calls and does not repeat the previously documented live designer or SQL integration checks.

## Process and team-memory journey — 2026-10-28

The workspace guide connects **describe → shared tool → agent**. The builder offers Data requests, IT requests, Employee onboarding, and Project reviews; selecting a template also supplies an editable description. Save, review, and publish through the same immutable draft protocol. Template switches retain existing custom fields and queue references; exceeding the catalog cap leaves the prior draft intact. A workspace still has one shared request-family tool. Create another workspace for an independent process. Joining dates, buddies, and checklist progress are text, with no calendar/HR integration or automatic subtask execution. Required custom fields participate in local completeness; when SQL analytics are available, the custom-aware missing-requirements card explicitly covers the current page while other cards retain their workspace SQL scope.

**Team brain** is available only to owners/operators. Sources supports keyword/exact-ID, type, dataset/context, and validity-date filters. Sources must be approved now and valid on the selected day; selecting a date does not reconstruct historical approval state. Connections derives ownership, authorship, approval, proposal citations, and reviewed-decision provenance from persisted records. Citing a source is a stored fact about a proposal, not proof that the recommendation is correct. Timeline combines request, tool-publication, sharing, and agent events. Search filters scope knowledge; record/proposal samples and timeline remain recent workspace activity.

`GET /api/memory` accepts `q`, `kind`, `dataset`, `ownerId`, and `asOf`. Authorization precedes every source/record/event query. Lexical SQL filtering runs before the 200-candidate source cap; exact IDs can retrieve older matching sources. Responses return at most 20 sources, 50 recent requests, 50 proposals, and 100 combined events, with explicit truncation flags. Connections include only available endpoints in this bounded projection. The panel refreshes while open and clears on workspace/identity change or denied access. There are no embeddings, inferred infrastructure edges, external ingestion workers, secret-redaction pipeline, or blast-radius claims.

After applying an agent proposal, choose **Draft guidance from this decision**. Write a title, reusable guidance, and why it applies. `POST /api/proposals/:id/knowledge` binds the exact proposal hash and persists a draft with server-verified provenance. An applied proposal and unchanged record/tool/cited sources are required at creation and owner approval. Lost acknowledgements replay the original draft; conflicting payloads cannot reuse its command identity. The source proposal remains immutable. The draft stays out of retrieval until separate owner approval in Team knowledge. Linked replacements inherit verified provenance. After approval, later record changes do not erase historical guidance; owners retire or replace it explicitly.

Designer prompt is now `tool-designer-v5`; operating-agent prompt is `triage-llm-v3`. Older pending runs remain readable but require a fresh run to continue. No migration is needed for optional provenance stored in the existing content JSON. Tests with mocked provider responses establish orchestration and persistence, not live model quality.

Verification for this checkpoint: TypeScript, ESLint, formatting, production build, 91 unit/service/HTTP tests, and 23 real Exasol integration tests pass. Seven preview browser checks and five connected production-browser checks pass, including onboarding publication, colleague invitation/submission, knowledge approval/search, connections, timeline, mobile layout, and requester memory denial. Three connected checks were skipped: opt-in live designer and triage journeys, plus the missing-model case because credentials were configured. Database suites clean their isolated fixtures; browser journeys retain explicitly synthetic accounts/workspaces/records.

Live provider checks during this checkpoint did not pass: the configured free router returned an unavailable endpoint, and an explicit test of the already configured designer as an operating agent returned an incomplete response. No paid fallback, credential change, or automatic retry was introduced. The triage adapter now classifies HTTP-success envelopes containing provider errors and preserves HTTP failure status for non-JSON bodies. These checks do not establish current live generation, proposal approval, or restart recovery against the provider.

## Company branding and bring-your-own agent — 2026-10-28

Migration `007_workspace_settings` adds workspace settings and hashed agent connections. Apply with `pnpm db:migrate` before running the updated application. No existing tool definitions or request records are migrated. New owner accounts see the company setup wizard open; owners can reopen **Company setup** from the sidebar. Other roles receive the saved branding without its administrative controls.

The four steps are company identity, appearance, agent, and completion. Company name and optional raster logo appear in the workspace header/sidebar. Primary and accent colors generate a complete palette with contrast-aware foregrounds, surfaces, buttons and focus treatments. Typography uses bundled Manrope/Archivo, system Georgia, or bundled IBM Plex Mono; no remote font is loaded. Corner style is rounded or square. Edits preview locally across the workspace; saving or finishing publishes versioned settings to this workspace's members. Conflicting owner edits preserve the draft and require loading current settings. Workspace/role changes clear the editing preview. A separate workspace has independent branding.

Logo uploads accept PNG/JPEG/WebP up to 2 MB, decode in the browser and are normalized to a maximum 256-pixel raster. The server independently validates the bounded data URI and raster signature, rejects SVG/arbitrary URLs, and stores it in settings JSON. Settings snapshots contain no agent credentials.

Choose Codex, Claude Code, or another MCP client to create a connection. The wizard displays a random 256-bit Loom access token once, supplies the endpoint `/api/mcp`, and generates a Codex `config.toml` or Claude Code `.mcp.json` entry using an environment variable. Set that variable in the environment where the agent runs, then reconnect the client. Loom never asks for the user's Codex/Claude login or their vendor API credential. The agent continues to run in its own environment; finishing company setup does not launch or host it. Selecting Loom's agent saves a preference and retains the separately configured built-in provider. Setup may also be completed with agent connection deferred.

Tokens expire after 30 days, are stored only as hashes, and may be revoked by an owner. A repeated creation command returns connection metadata with `token: null` rather than recovering the secret. Up to ten active connections are allowed. A connection acts within its workspace as the owner who issued it; current owner membership, expiry and revocation are rechecked on every read and inside proposal-write transactions. All internal context is available to that connection, so issue it only to a client permitted to read the workspace. Tokens appear neither in settings snapshots nor URLs, source records, receipts or application logs. The UI reports actual last use rather than claiming a continuously connected session.

The stateless Streamable HTTP endpoint uses the official MCP SDK. It accepts bearer credentials without browser cookies, checks the configured Host and any supplied Origin, requires HTTPS outside loopback, and limits request/result size. It exposes `loom_get_workspace`, `loom_list_requests`, `loom_get_request`, `loom_search_knowledge`, `loom_propose_changes`, `loom_list_tasks`, `loom_reply_task`, and `loom_propose_tool`. Workspace context includes the published field/action catalog, record versions, transitions, and the approved-knowledge digest. External proposals use these exact dependencies, reference the source connection, and enter the existing human-review interface as completed `external-mcp-v1` runs. No agent tool approves or directly mutates business records. Human approval rechecks record/tool/knowledge versions and connection eligibility; revoking the connection blocks pending proposals from it. Declared client type is a label, not vendor identity attestation. External inference cost/tokens/duration remain unknown.

Recent runs now show the workspace's latest ten for authorized operators/owners so teammates can discover and review external submissions. This does not make internal runs visible to requesters. Built-in model inference remains independently configured and subject to the provider limitations above. External connections do not call OpenRouter.

Configuration references: [OpenAI's Codex MCP documentation](https://developers.openai.com/codex/mcp), [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp), and the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server). Real protocol/SQL tests use the official SDK and synthetic records; they do not claim that either vendor's interactive CLI or a paid subscription was exercised.

Company-setup verification: production build, TypeScript, lint, formatting, 110 unit/service/HTTP/protocol tests, and 27 real Exasol integration tests pass. Nine preview browser checks and six connected browser journeys pass, including logo normalization, live color/font/corner previews, saved branding after reload, colleague branding and denied admin access, actual HTTP MCP initialization/discovery, external proposal submission, exact human approval, and revocation. Three separate connected cases remain skipped: opt-in live designer/triage and the missing-model case when credentials are configured. Browser tests retain synthetic company workspaces but revoke their temporary agent credential on success or failure; isolated SQL tests delete their fixtures. No vendor login, CLI host configuration, or paid inference was exercised.

## Conversation verification — 2026-10-28

The resumed single-prompt implementation passes production build, TypeScript, lint, formatting, 114 unit/service/protocol tests, 36 real Exasol tests, 12 preview browser checks, and eight connected browser journeys. Three live-provider/configuration cases remain skipped. Database checks cover persisted generic replies, authorization and role downgrades, command replays, stale context, exact proposal approval, external task lineage, connection expiry/revocation, and unpublished tool drafts. The connected prompt journey exercises real HTTP MCP calls and Exasol: a queued question receives a reply, survives reload, displays an inert proposed record change for explicit approval, then displays a tool draft for separate owner publication. Browser fixtures provide the external agent response; this verifies the protocol and saved behavior, not vendor CLI reasoning. Temporary credentials are revoked after the journey.

A separate synthetic live check of the built-in conversation model returned `MODEL_HTTP_429` (free-provider rate limit). No paid fallback, provider change, or automatic retry was introduced. The built-in conversation is implemented but that live check did not establish current provider availability; failures are shown to the user with their prompt preserved.

## Analytics team launch — 2026-10-31

The public entry is now `/`: a dark landing page with a procedural Three.js loom and illuminated threads. `/register` creates a company and its owner account; `/login` signs in individual colleagues; `/app` opens their company workspace. Invitations remain `/join#token=...`. `/app?demo=1` deliberately opens unsaved synthetic examples even when Exasol is configured. Older `/?view=...` bookmarks redirect to `/app?view=...`.

The workspace defaults to the data request queue, with separate assistant, Flow insights, Team knowledge, and settings views. A new owner is directed to company setup. Registration requires `LOOM_ALLOW_WORKSPACE_SIGNUP=true`; use `LOOM_AUTH_MODE=workspace` for company accounts. Staff gain membership through an owner-issued invitation, not by choosing a company name. Email verification, email delivery, password recovery, and SSO remain pending.

Flow insights execute four versioned, parameterized SQL queries in Exasol: request stage durations/percentiles, weekly movement and carryover backlog, current owner aging, and bounded contributing-record evidence. Owners/operators can select 30 or 90 rolling UTC days. The UI includes calculation definitions, cutoff, query IDs/hashes and timings, sample counts, and truncation indicators. Calendar time in a stage includes unfinished work and is not labor effort or end-to-end turnaround. The assistant receives a smaller internal-only 30-day explanatory snapshot; proposed actions still require exact authorized records and review. Historical conversations without this optional context remain readable.

Apply migration `009_provider_connections`. Owners can test and save company API credentials for OpenAI, Claude, Kimi/Moonshot, or DeepSeek in settings. Configure a private `LOOM_PROVIDER_ENCRYPTION_KEY` containing 64 random hexadecimal characters before use; credentials are encrypted with AES-256-GCM and bound to company, provider, model, and configuration version. **Test and save** makes one explicitly acknowledged small provider call and may incur provider charges. No real company credential was supplied or paid vendor call made during this implementation. Tests use mock vendor responses with real Exasol persistence. Personal subscription-account OAuth and a hosted Claude Code/Codex runner are not implemented; external MCP clients continue running in their own environment.

Company provider configuration applies to conversation, triage, and tool design. An absent company connection permits the existing server OpenRouter configuration; a disconnected connection fails closed. Changing configuration invalidates in-flight output. Connection commands are replay-safe and rate-limited; credentials are excluded from saved replies, receipts, snapshots, and errors. Browser API calls carry the company rendered in that tab, and the server rejects a mismatch before authenticated work. Account polling and explicit company selection remain exempt so tabs can recover after a switch. This guard supplements existing role and tenant authorization.

Verification: production build, TypeScript, ESLint, formatting, and **134 unit/service/HTTP/protocol tests** pass. All **43 real Exasol integration cases** passed across the full run and isolated reruns. The first overlapping database test processes produced a transaction conflict; rerunning the affected cases serially passed. Run database suites and the connected app as separate writers, consistent with the current single-process write coordinator. **15 preview browser checks** passed, with the final landing and sample-desk subset rechecked after integration. The real WebGL loom was visually inspected at 1440px and 375px, including pause, reduced motion, no overflow, and recovery after simulated context loss; the illustration fallback remains available when WebGL cannot run.

All **eight connected browser journeys** passed across the regression run and focused reruns. The expanded collaboration check passed with account-only authentication: public company registration, invitation acceptance, staff logout/login, shared publication and conflict handling, 30/90-day Exasol insights, separate-company isolation, and access changes. The assistant/MCP review journey also passed in account-only mode. Three live-provider/configuration cases remain opt-in/skipped; the provider adapters and mocked replies do not establish live model availability or quality. Browser journeys retain clearly synthetic accounts/workspaces; isolated database suites clean their own fixtures. Exasol Personal remains the single-operator challenge prototype; production multi-company use requires an appropriate edition/permission and hosting decision.

## Minimal public theme — 2026-10-31

The landing now uses two sections, a near-black canvas, cream typography, and a graphite loom with violet threads. Promotional filler and the sculpture caption were removed. ORYZO's uppercase, medium-weight typography is implemented with its listed Inter substitute, self-hosted with its OFL license and provenance in `apps/web/app/fonts`; no licensed Halyard font was supplied. Registration and login use the same restrained theme and simpler forms. New/default workspace branding is graphite/lavender; stored company branding remains versioned and unchanged.

GSAP ScrollTrigger adds scroll-linked hero movement and product/row reveals. React-scoped cleanup runs on unmount, and reduced-motion preferences disable these animations. The Product anchor uses Next's Link so returning from the sample workspace restores the correct route and section. WebGL framing adapts to viewport shape, and a final output pass keeps the rendered background aligned with the page's `#090909` canvas.

Verification for this visual revision: production build, TypeScript, ESLint, formatting, all 134 unit/service tests, six targeted landing/theme browser checks, and the connected account-only collaboration journey pass. Desktop 1440px and mobile 375px screenshots were inspected with real WebGL, no horizontal overflow, and no console/page errors. Public signup, returning staff login, invitations, shared work, and Exasol insights remain operational in the connected journey. No new vendor inference or database migrations were needed.
