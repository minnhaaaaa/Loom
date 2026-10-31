# Loom implementation plan

Updated: **2026-10-31**. The product is now focused on **small analytics teams**: clarify business requests, establish ownership, reuse approved guidance, and measure where work waits. The current checkpoint below supersedes the earlier broad tool-builder positioning. Dated test counts and live-provider outcomes belong in [RUNBOOK.md](RUNBOOK.md).

## Objective

A business requester can submit and follow their own request. An analyst can clarify, assign, and progress authorized work with reviewed AI suggestions. A team lead can inspect Exasol-computed waiting time and backlog movement instead of estimating workflow performance from the recent record list.

This direction is an adoption hypothesis, not evidence of customer demand or measured savings. Validate it with small analytics teams and matched synthetic scenarios. The competition excludes employer/proprietary data.

## Current checkpoint

| Implemented                                                                                                        | Remaining gate                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Public landing, `/register`, `/login`, `/app`, and `/app?demo=1` entry points                                      | Continue accessibility/responsive checks; preserve a usable non-3D fallback        |
| Company workspace registration, individual accounts, invitation links, roles, branding                             | Email verification/delivery, password reset, SSO, verified company-domain joining  |
| Request forms, owner/status/due-date controls, comments, CSV transfer, version conflicts, activity                 | External request ingestion and notifications                                       |
| Exasol stage medians/p90, weekly flow/backlog, owner aging, scoped evidence                                        | Wider workload fixtures, production-scale measurements, and outcome evaluation     |
| Compact Exasol analytics context for owner/operator conversations                                                  | Measure whether agent explanations faithfully describe the computed values         |
| Saved conversations, reviewed proposals, approved guidance, decision reuse                                         | Reliable live-provider runs, broader quality evaluation, and live restart recovery |
| Company OpenAI/Claude/Kimi/DeepSeek API configuration, explicit connection test, encrypted credentials, revocation | Real credential/model verification and subscription-account OAuth                  |
| External-agent MCP connection and task/reply/proposal protocol                                                     | Hosted runner and interactive vendor-client verification                           |
| Declarative desk configuration and reviewed publication                                                            | Additional tool families remain outside the focused product scope                  |

A company is currently one workspace; it is not a separate organization hierarchy. Joining requires an invitation/membership. Setting up an external agent does not start it. Company API billing and chat subscriptions are distinct connection modes.

## Next priorities

1. Finish the analytics-team journey from company registration through requester submission, analyst review, and Exasol flow insights. Keep human approval and workspace isolation intact.
2. Verify a live, explicitly chosen company provider/model with synthetic data; preserve honest provider errors and never silently switch billing accounts.
3. Rehearse the Exasol demo with known timestamps, reopened/closed work, and calculated expected results. Explain calendar time, sample sizes, and partial weeks.
4. Run matched manual-versus-assisted usability exercises before claiming time savings or changing the problem direction.
5. Complete the public repository, pitch deck, three-minute demo, and run instructions for **31 October 2026, 23:59 IST**. A public production service remains a separate edition/hosting decision.

The milestones below retain detailed acceptance criteria. An unchecked broad gate may include implemented components whose full failure/evaluation coverage is still incomplete. Consult the current checkpoint and RUNBOOK rather than interpreting old milestone wording as a release guarantee.

## Delivery rules

- Finish the manual request workflow before adding the operating agent.
- Build one reusable request-and-review engine; demonstrate a data desk first.
- Persist state and permissions before adding live notifications.
- Treat generated specifications and model suggestions as untrusted inputs.
- Publish tool structure and team knowledge through explicit reviewed revisions.
- Make a proposal approval authorize only the immutable changes displayed.
- A milestone is complete only when its acceptance criteria have been demonstrated.

## M0 — Exasol compatibility and Next.js foundation

Dependencies: documentation revision complete; user resumed implementation on 2026-10-21.

- [x] Verify the current local Personal starter kit on Linux/Podman, edition terms, hardware needs, and actual database/launcher versions. Do not provision cloud resources by default.
- [x] Test the official TypeScript driver with supported Node LTS, TLS trust/hostname checks, prepared value bindings, explicit transactions, rollback, affected-row reporting, and connection cleanup.
- [ ] Test exact numeric/UTC/JSON-text mappings and empty-string/null behavior against the real database.
- [ ] Prove enabled primary/composite keys reject invalid inserts; do not assume UNIQUE/CHECK, JSONB, RLS, row locks, or PostgreSQL queue syntax.
- [ ] Verify command receipt replay, rollback after a partial command, collision retry, and reconciliation after an ambiguous commit response.
- [x] Set up pnpm, TypeScript, Next.js App Router, and Node Route Handlers with server-only Exasol access. Keep the UI basic and easy to redesign.
- [ ] Prove distinct mutation routes share one process-wide coordinator in the production Node build. No replicas or serverless deployment in this baseline.
- [ ] Define ToolSpec, action/proposal/event/error contracts and the owner/operator/requester/viewer matrix.
- [x] Seed two workspaces and synthetic role identities. Verify API and repository isolation, including direct forged requests.
- [x] Render a fixed request template without an LLM; use the Loom-owned catalog renderer without an additional json-render adapter.
- [ ] Persist one bounded run/checkpoint and resume it after a server restart through an authenticated advance request. The previous engine passed; the new live-model restart path still needs verification.

Acceptance: a real Exasol connection passes transaction, key, identity-isolation, and concurrent-route checks; a static tool renders in Next.js; persisted state survives restart. Record tested versions and limitations. Mock-only success does not satisfy this milestone. If the TypeScript driver blocks progress, record the failing contract before evaluating PyExasol as a narrow fallback.

Remaining M0 gates include complete proposal/event contracts, deliberately invalid composite references, forced database collision/ambiguous-commit cases, and a resumable agent checkpoint. The working manual workflow does not imply those later capabilities are complete.

## M1 — Usable request desk without AI

Dependencies: M0.

- [x] Implement workspace membership and current-permission checks.
- [x] Create request, comment, revision, activity, and audit tables with enabled composite workspace keys verified on Exasol.
- [x] Implement request creation, own-request listing, team queue listing, details, comments, and controlled updates.
- [x] Render intake form, table, details, filters, and summary cards from `ToolSpec`.
- [x] Support statuses `new`, `needs_info`, `ready`, `in_progress`, `done`, and `cancelled`.
- [x] Separate hard intake requirements from readiness requirements; imported historical records may be incomplete and must be marked accordingly.
- [x] Implement owner and due-date controls, pagination, and requester-visible status.
- [x] Implement CSV column mapping, bounded upload parsing, validation preview, explicit import commit, and authorized export.
- [x] Add compare-and-swap record versions and Exasol-backed command receipts with enabled primary keys for mutations.
- [x] Write audit and outbox events in the same transaction as successful changes.

Acceptance: a requester submits a record; an operator clarifies, assigns, and completes it; the requester sees their own progress. A requester cannot change owner, priority, or status through a forged API call. A viewer cannot mutate. Invalid transitions and stale versions fail without partial writes. Duplicate import submission does not create duplicate rows.

## M1b — Exasol insights and evidence

Dependencies: M1.

- [x] Import bounded synthetic CSV batches through mapping, validation, reviewed commit, and replay-safe receipts.
- [x] Calculate workspace queue counts and current owner workload/aging in named SQL queries.
- [x] Derive status intervals using Exasol `LEAD`, clip to 30/90-day UTC windows, sum repeated visits, and compute per-request stage medians/p90 with `PERCENTILE_CONT`.
- [x] Use `LAG` and cumulative SQL sums for weekly arrivals, completion/cancellation/reopening transitions, carryover, and ending backlog.
- [x] Compare SQL outputs with hand-calculated isolated fixtures covering open tails, closure/reopening, equal timestamps, UTC boundaries, role denial, and cross-company isolation.
- [x] Show measurement definitions, sample counts, query IDs/hashes, timing, cutoff, and bounded contributing-request evidence.
- [x] Supply a compact 30-day analytical snapshot to owner/operator conversations; omit it from requester/viewer context and retain existing action authorization.
- [ ] Add richer filters or duplicate candidates only when pilot evidence identifies a need.
- [ ] Measure performance on larger event histories; query timing shown in the UI is not a benchmark.
- [ ] Evaluate real improvements in clarification, assignment, and fulfillment separately.

The SQL aggregates cover every qualifying record. Evidence is capped at 50 requests; owner tables at 100 rows, and assistant owner context at 20. Stage metrics measure window-clipped elapsed calendar time, not effort or completed turnaround. Weekly completions count transitions, not unique requests. Owner metrics describe current open work across all creation dates, not available capacity. The server executes no model-authored SQL.

Acceptance: changing persisted history changes verified SQL metrics; unauthorized roles cannot retrieve internal aggregates or receive them through model context. Every displayed metric has a declared period, scope, and definition. A snapshot used in an explanation does not bypass current record/version checks for a proposed change.

## M1c — Company entry and company AI

- [x] Provide a public landing page, company registration, staff login, workspace, and explicit sample route.
- [x] Retain individual accounts, invitation-only membership, role controls, and owner-managed company appearance.
- [x] Add company-owned OpenAI, Claude, Kimi, and DeepSeek API configuration with explicit test-and-save and revocation.
- [x] Encrypt saved provider credentials using a deployment key and workspace/provider/model/revision binding; return metadata only to settings clients.
- [x] Route the existing bounded AI workflows through the configured company API and recheck provider configuration before retaining results.
- [ ] Verify each intended live provider/model using supplied credentials; fixture tests do not prove real provider availability or answer quality.
- [ ] Add email verification/recovery and domain-based discovery only with explicit membership approval semantics.
- [ ] Design supported account OAuth separately if needed. Do not treat a chat-subscription login as a generic backend API credential.
- [ ] Choose an appropriate Exasol edition/deployment before a real multi-company rollout; Personal remains the single-operator challenge prototype.

## M2 — Describe, refine, and publish the tool

Dependencies: M1.

- [x] Generate a draft `ToolSpec` using the supported catalog and current template context.
- [x] Validate schema shape, field keys, view bindings, action references, limits, and transition references.
- [x] Show assumptions, unsupported requests, and an actionable validation error when generation fails.
- [x] Provide direct controls for labels, requiredness, visible fields, filters, and status labels.
- [x] Preview a draft and show changes relative to the published revision.
- [x] Publish using the expected current revision; keep existing clients on a valid published revision until refresh.
- [x] Limit MVP structural edits to compatible changes; require backfill or defer destructive/type-changing edits.
- [x] Restore an older compatible definition by publishing a new revision, without reverting business records.
- [x] Render an IT-request template through the same contracts and renderer.

Current M2 implementation: the supported request-family tool-building slice is implemented and verified. Strict catalog validation, shared rendering, direct editing, optional custom fields, immutable drafts/revisions, exact-hash owner publication, compatible restoration, and actual model generation use the same contracts. A live synthetic check created a facilities desk with a Location field, published it, created a request, refined the tool with an Asset tag field, and published again without changing the existing request's data/version. A separate production browser journey used the real model, reloaded its saved draft, inspected inference metadata and assumptions, reviewed/published it, opened the result as a requester, and restored the original definition. All four successful live calls used the pinned free designer and reported cost zero. This is small-sample correctness evidence, not the proposed 95% generation-quality measurement. Scope remains one request-family tool per workspace; custom intake tightening, destructive edits, multiple independent tools, SSO/email verification/password recovery, and broad quality/productivity evaluation remain deferred.

Acceptance: an owner describes a desk and gets a working draft; a follow-up adds an optional field without losing records. A required-field change shows its impact on existing requests. Unknown components or generated expressions never execute. Concurrent publication produces a clear conflict. The second template does not require a separate app implementation.

## M3 — Shared saved records and activity

Dependencies: M1; can proceed before M2 is complete.

- [x] Use authenticated polling/refetch after mutations, tab focus, reconnect, and a modest configurable interval.
- [x] Apply current role/own-request scope to every read, including activity, counts, exports, and query results.
- [x] Retain unsaved input on version conflict and show the authorized current state.
- [x] Clear inaccessible local data when a refresh is denied; isolate caches by identity and workspace.
- [x] Keep transactional outbox events for durable change history; SSE/presence are optional extensions after core correctness.

Acceptance: two synthetic browser personas see acknowledged saved updates, simultaneous edits do not silently overwrite, and revocation denies subsequent fetches. Requesters never receive internal activity or other requesters' identifiers.

Current M3 implementation: password accounts, expiring single-use invitations, authorized workspace switching/deep links, owner membership administration, polling of queue/details/access, and explicit version-conflict review are implemented. Database and two-browser journeys verify scope, last-owner protection, role changes, revocation, and preserved drafts. Public-host configuration is documented separately; SSO, email verification/reset, realtime presence/SSE and distributed replicas remain outside this slice. The account-only two-browser journey and all20 real SQL tests passed; public hosting remains a separate deployment choice.

## M4 — Approved team knowledge

Dependencies: M1.

- [ ] Support bounded plain-text/Markdown uploads and editable glossary/routing entries.
- [ ] Store canonical source revisions, content hashes, visibility, owners, and provenance.
- [ ] Implement knowledge states: draft, approved, superseded, retired; preserve case-specific exceptions separately.
- [x] Require an owner to publish reusable procedures or rules.
- [x] Add searchable active approved knowledge with explicit applicability and effective dates.
- [x] Implement bounded normalized-term retrieval and exact-key lookup in Exasol with access filtering before retrieval results reach the model.
- [x] Support source inspection and permission-checked evidence links.
- [ ] Evaluate whether the model reliably identifies conflicting approved guidance and asks for clarification. This is no longer a hardcoded branch.
- [ ] Defer semantic retrieval; if the lexical baseline fails, evaluate an Exasol-compatible approach against frozen authorized fixtures before choosing additional infrastructure.

Current M4 scope: internal plain-text entries (up to 4,000 characters), immutable replacement drafts, owner-controlled lifecycle, validity dates, normalized keyword/ID/metadata search, bounded relevant model context, a source-linked relationship projection, and a combined activity timeline. Source uploads, semantic search, requester-visible knowledge, and historical graph reconstruction remain unfinished.

Acceptance: an active approved routing rule is retrieved; a draft or retired rule is not treated as authority. A requester cannot retrieve internal procedures. Updating or revoking a source invalidates dependent reusable knowledge and pending proposals. Search failure is distinguishable from a legitimate no-match result.

## M5 — Bounded agent and proposal review

Dependencies: M1 and M4; tool-aware interface depends on M2.

- [ ] Start a run with an authenticated initiator, selected record IDs, published spec revision, budgets, and idempotency key.
- [x] Recheck access in each bounded execution request before each retrieval, persisted result, and proposed action.
- [ ] Support summarization, missing-field identification, owner suggestions, duplicate candidates, and clarification drafts.
- [ ] Restrict the agent to known read/propose tools; keep business mutation and approval tools unavailable to it.
- [ ] Persist run steps and validated outputs; checkpoint after each completed expensive call.
- [x] Store immutable proposals containing exact action parameters, expected versions, evidence dependencies, and a server-computed hash.
- [x] Display record-level before/after values, sources, and uncertainty. Explain abstention when rules are absent or conflicting.
- [ ] Allow review, rejection, or editing by creating a new proposal revision that requires fresh approval.
- [x] Execute approved local actions atomically through the shared command service.
- [ ] Implement cancel, timeout, budget exhaustion, retry exhaustion, and stale-proposal behavior.
- [x] Revalidate inside the write transaction and append audit/outbox records on commit.

Current M5 scope: the bounded operating agent and conversation interface generate validated structured proposals using a configured company API or, where configured, the server OpenRouter fallback. No heuristics choose model outputs. Short database reservations/finalization surround provider calls; models cannot apply their own proposals. Company provider changes are checked before generated results are retained. Runs, knowledge, record versions, explicit human review, and audit history remain the authority for action execution. Internal conversation context now includes the Exasol insight snapshot with its cutoff and measurement definitions. Live provider/model quality, restart recovery, proposal editing, broader retrieval, and cost/productivity evaluation remain separate gates. A failed or revoked company provider is not silently replaced by another billing account.

Acceptance: agent-assisted triage completes on a selected batch. No request is modified before an authorized approval. Editing a proposal invalidates the previous approval. Changed records, rules, tool revisions, or permissions block stale execution. A duplicate approval or retried job produces one domain effect. Server restart, request interruption, and cancellation do not cause an unapproved write.

## M6 — Reviewed decision reuse

Dependencies: M4 and M5.

- [ ] Let an operator record why a recommendation was corrected.
- [x] Let an operator propose a scoped reusable rule from an applied proposal with evidence.
- [ ] Require owner review of applicability, precedence, effective date, and source visibility.
- [x] Preserve the original decision as a case-specific record regardless of rule publication.
- [x] Retrieve approved guidance on a subsequent request and expose its source/version.
- [x] Support supersession, retirement, and correction without rewriting history.

Current M6 scope: an eligible teammate writes guidance and a rationale from an applied proposal. The immutable draft records its proposal/hash/run/record/version/reviewer provenance. Source freshness is rechecked at draft creation and owner approval; the owner must approve separately before later retrieval. Replacements inherit verified lineage. Real Exasol tests verify the draft → approval → later citation loop with a test-only model fixture. Direct manual-correction capture, agent-authored rule proposals, explicit precedence controls, and broad model-quality evaluation remain deferred.

Acceptance: a correction remains an exception until reviewed. Once approved as guidance, it influences an applicable later request. It does not influence unrelated requests or a user who lacks access. Retiring it removes it from future authoritative context and prevents pending dependent changes from being applied.

## M7 — Evaluation and reproducible event submission

Dependencies: M1–M6.

- [ ] Freeze evaluation fixtures, prompts, models, specification versions, and knowledge revisions.
- [ ] Complete permission, concurrency, idempotency, source-injection, and persisted-step recovery integration checks.
- [ ] Run the complete two-user journey in Playwright.
- [ ] Compare the manual desk with the agent-assisted desk on equivalent tasks.
- [ ] Run usability exercises with consenting participants using synthetic request scenarios. Keep future real-team pilots separate from this submission.
- [ ] Record actual setup effort, completion quality, review time, latency, token usage, and repeat usage.
- [ ] Verify backups/restoration, migration rehearsal, private storage and identity/cache settings, error monitoring, and deployment secrets.
- [ ] Prepare a local synthetic-data demo and reset procedure; public hosting is optional and requires an appropriate edition/deployment design.

Acceptance: all correctness gates pass, actual Exasol SQL outputs are reproducible, material limitations are documented, and the demonstration runs from fresh state. Pilot metrics are reported separately from synthetic evaluations.

## Evaluation fixtures and proposed gates

Create 60 labeled request scenarios: 40 for development and 20 held out. Include complete and incomplete requests, ambiguous owners, duplicate candidates, absent/contradictory guidance, stale revisions, restricted data, and injected instructions. Split by scenario family to avoid near-duplicate leakage. Add deterministic system tests beyond these 60 agent examples.

Create a small versioned knowledge corpus containing approved, draft, superseded, retired, restricted, and case-specific material. Label expected evidence, allowed actions, and abstentions. Repeat selected agent scenarios at least five times to expose inconsistent behavior; retain every trial rather than selecting the best run.

All thresholds below are proposed release targets, not achieved results. Revise them with pilot evidence and report counts alongside percentages.

| Dimension            | Initial gate                                                                                | How to assess                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Authorization        | Zero unauthorized reads/writes in the defined isolation suite                               | Assert API responses, context inputs, query scope, storage access, and database state.      |
| Change integrity     | Every stale or tampered approval rejected; every committed action audited                   | Concurrent transactions, proposal-edit tests, retry/replay tests.                           |
| Request intake       | Required intake checks deterministic and consistent                                         | Schema and end-to-end fixture assertions; no model judge needed.                            |
| Tool generation      | At least 95% of supported prompts produce valid drafts within the configured attempt budget | Fixed supported prompt set; separately report semantic suitability.                         |
| Owner suggestions    | At least 85% correct on cases with clear approved routing evidence                          | Human-labeled owner IDs; unknown cases scored separately for abstention.                    |
| Missing requirements | At least 90% precision and recall on labeled cases                                          | Compare field IDs and clarification needs with gold labels.                                 |
| Evidence             | At least 90% of actionable recommendations supported by the cited active guidance           | Human review of claim-to-source support; citation existence alone is insufficient.          |
| Memory updates       | All deterministic scope/retirement fixtures pass                                            | Verify current approved rule selection, historical preservation, and invalidation.          |
| Retrieval            | Record lexical baseline; target at least 90% recall@5 on applicable approved-rule cases     | Gold evidence IDs, scoped to authorized searchable content.                                 |
| Product usefulness   | Target at least 30% lower median coordination time versus current process                   | Time clarification, routing, and review on matched batches; report quality and sample size. |
| Collaboration        | No lost acknowledged updates in the concurrency suite                                       | Two-user writes, reconnects, version conflicts, event redelivery.                           |
| Cost and latency     | Choose a budget before the pilot; record median and p95 per operation                       | Include unsuccessful generations and retries in cost totals.                                |

Model judges can help assess phrasing and support, but cannot authorize actions or replace database assertions. Do not generalize small-sample pilot results into market-wide productivity claims.

## Resource limits to implement first

Initial tunable limits: CSV up to 5 MiB and 100 data rows per atomic reviewed batch (the earlier 5,000-row target is deferred until measured chunking/resume exists); exports up to 500 matching records; text/Markdown source up to 1 MiB; agent triage up to 20 selected records; at most eight model/tool steps, two transient retries per step, and a 120-second active execution budget across bounded requests. Define provider token/spend budgets in configuration before live runs. These are engineering starting points requiring measurement.

Stream or process files with bounded memory. Export untrusted spreadsheet cells with formula-injection protection. Treat linked URLs as text; remote fetching and PDF/Office parsing are deferred to a separately designed ingestion step.

## Demo script

1. Show the analytics-team problem on the landing page and register a synthetic company.
2. Invite a requester and analyst using individual accounts; submit a request with missing business context.
3. Import a synthetic backlog and approved metric definitions/routing guidance.
4. Open Flow insights. Show stage samples/medians, partial-week inflow/completions, reopened work, owner aging, and query evidence from Exasol.
5. Ask the assistant where requests wait. Inspect its interpretation against the exact SQL values and cutoff; disclose the configured provider or test fixture.
6. Ask for a clarification or assignment proposal using approved guidance, inspect the exact change, and approve it.
7. Change a record before approving an older proposal; demonstrate rejection of stale work.
8. Draft useful guidance from an applied decision, approve it separately, and demonstrate later authorized reuse.

Use genuine saved synthetic state. Do not imply that a mock provider response is live inference, that elapsed stage time equals analyst effort, or that a small synthetic exercise proves customer savings.

## Submission checklist

Follow the exact [event requirements](https://www.exasol.com/events/exathon-india-2026/) summarized in [README.md](README.md).

- [ ] Public repository with existing Apache-2.0 license and no credentials/proprietary data.
- [ ] Problem statement identifies the data-team coordination problem and Track 04.
- [ ] README setup/usage, tested Exasol/Node/driver versions, environment example, migrations, seed/reset, and deployment/run instructions.
- [ ] Slide deck and a demo video within the published limit; show real Exasol query results and a reviewed change.
- [ ] Fresh-clone rehearsal, limitations, actual evaluation results, and clear distinction between implemented and planned features.

Given the published deadline, prioritize M0, M1, M1b, and one evidence-backed proposal/review path before optional presence, semantic search, or broader template polish. Do not present unfinished milestones as shipped.

## After the MVP

Prioritize from observed pilot friction: one connector, notifications, saved templates, broader reporting, and finer resource permissions. External actions require explicit product-level authorization, connector-specific scopes, idempotency/reconciliation, and truthful reporting of ambiguous outcomes.

Do not add a graph database, autonomous agent team, offline editing, arbitrary code execution, or a connector marketplace simply because a reference project includes it.

## Open decisions and risks

| Decision/risk                           | Default                                                    | Evidence that changes it                                                        |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Event data and users                    | Synthetic analytics scenarios and consenting testers       | Real-team pilots require separate data permission and applicable edition terms. |
| Agent provider/model                    | Company API selected explicitly; fixtures for system tests | Live grounded quality, latency, price, and permitted data handling.             |
| Renderer adapter                        | Loom-owned schema, thin catalog renderer                   | M0 spike proves json-render fits without obscuring domain contracts.            |
| Semantic retrieval                      | Lexical/structured retrieval first                         | Measured retrieval failures and a passing hybrid-search comparison.             |
| Workflow too broad                      | Data-request desk first                                    | Repeated demand for another workflow using the same primitives.                 |
| Existing ticket tool already sufficient | Validate coordination benefit before integration breadth   | Pilot users cannot demonstrate a meaningful reason to adopt Loom.               |
| Capacity remains the bottleneck         | Report triage and fulfillment separately                   | Actual throughput and queue-age evidence.                                       |

## Definition of done

The MVP is done when a lead can create a reusable desk, requesters can submit and track authorized work, operators can collaborate on persisted records, and an agent can make evidence-backed proposals that are safely reviewed and committed. One reviewed correction must be reusable on a later request with correct scope and provenance. Required correctness checks and the fresh-state demonstration must pass.
