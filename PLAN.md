# Loom implementation plan

Status: revised for Exasol Personal and Next.js; implementation remains paused. Updated: 2026-10-21.

## Objective

Deliver a working data-request desk that a team lead can describe, refine, and share. Requesters submit and track their own requests. Operators and an agent triage the same queue using approved procedures. Authorized people review exact proposed changes before execution.

The user has accepted coordination pain as a promising problem. This is product direction, not evidence of willingness to pay or measured time savings. Validate those through user exercises with synthetic data; the event submission excludes employer/proprietary data.

Read [README.md](README.md), [TECH_STACK.md](TECH_STACK.md), and [ARCHITECTURE.md](ARCHITECTURE.md) together. Milestones are ordered by dependencies, not calendar promises. Every checkbox below represents future work.

## Delivery rules

- Finish the manual request workflow before adding the operating agent.
- Build one reusable request-and-review engine; demonstrate a data desk first.
- Persist state and permissions before adding live notifications.
- Treat generated specifications and model suggestions as untrusted inputs.
- Publish tool structure and team knowledge through explicit reviewed revisions.
- Make a proposal approval authorize only the immutable changes displayed.
- A milestone is complete only when its acceptance criteria have been demonstrated.

## M0 — Exasol compatibility and Next.js foundation

Dependencies: documentation revision complete; application implementation resumes only after the requested pause ends.

- [ ] Verify the current local Personal starter kit on Linux/Podman, edition terms, hardware needs, and actual database/launcher versions. Do not provision cloud resources by default.
- [ ] Test the official TypeScript driver with supported Node LTS, TLS trust/hostname checks, prepared value bindings, explicit transactions, rollback, affected-row reporting, and connection cleanup.
- [ ] Test exact numeric/UTC/JSON-text mappings and empty-string/null behavior against the real database.
- [ ] Prove enabled primary/composite keys reject invalid inserts; do not assume UNIQUE/CHECK, JSONB, RLS, row locks, or PostgreSQL queue syntax.
- [ ] Verify command receipt replay, rollback after a partial command, collision retry, and reconciliation after an ambiguous commit response.
- [ ] Set up pnpm, TypeScript, Next.js App Router, and Node Route Handlers with server-only Exasol access. Keep the UI basic and easy to redesign.
- [ ] Prove distinct mutation routes share one process-wide coordinator in the production Node build. No replicas or serverless deployment in this baseline.
- [ ] Define ToolSpec, action/proposal/event/error contracts and the owner/operator/requester/viewer matrix.
- [ ] Seed two workspaces and synthetic role identities. Verify API and repository isolation, including direct forged requests.
- [ ] Render a fixed request template without an LLM; evaluate json-render only as a thin optional adapter.
- [ ] Persist one bounded run/checkpoint and resume it after a server restart through an authenticated advance request.

Acceptance: a real Exasol connection passes transaction, key, identity-isolation, and concurrent-route checks; a static tool renders in Next.js; persisted state survives restart. Record tested versions and limitations. Mock-only success does not satisfy this milestone. If the TypeScript driver blocks progress, record the failing contract before evaluating PyExasol as a narrow fallback.

## M1 — Usable request desk without AI

Dependencies: M0.

- [ ] Implement workspace membership and current-permission checks.
- [ ] Create request, comment, revision, activity, and audit tables with enabled composite workspace keys verified on Exasol.
- [ ] Implement request creation, own-request listing, team queue listing, details, comments, and controlled updates.
- [ ] Render intake form, table, details, filters, and summary cards from `ToolSpec`.
- [ ] Support statuses `new`, `needs_info`, `ready`, `in_progress`, `done`, and `cancelled`.
- [ ] Separate hard intake requirements from readiness requirements; imported historical records may be incomplete and must be marked accordingly.
- [ ] Implement owner and due-date controls, pagination, and requester-visible status.
- [ ] Implement CSV column mapping, bounded upload parsing, validation preview, explicit import commit, and authorized export.
- [ ] Add compare-and-swap record versions and Exasol-backed command receipts with enabled primary keys for mutations.
- [ ] Write audit and outbox events in the same transaction as successful changes.

Acceptance: a requester submits a record; an operator clarifies, assigns, and completes it; the requester sees their own progress. A requester cannot change owner, priority, or status through a forged API call. A viewer cannot mutate. Invalid transitions and stale versions fail without partial writes. Duplicate import submission does not create duplicate rows.

## M1b — Exasol insights and evidence

Dependencies: M1; required before the agent demo.

- [ ] Import synthetic backlog rows into bounded staging, validate mappings, deduplicate source identities, and commit reviewed rows.
- [ ] Implement reviewed named SQL queries for queue age, SLA risk, owner workload, missing requirements, and normalized duplicate candidates.
- [ ] Derive status durations from request events using Exasol window functions; define reopened requests, null owners, cancelled work, and UTC boundaries.
- [ ] Compare real SQL results with hand-calculated fixture outputs. Record query ID, input digest, scope, data revisions, row count, timing, and source record references.
- [ ] Render simple summary cards/table results and expose the same authorized query evidence to the agent. Never execute model-authored SQL.

Acceptance: changing imported or persisted requests changes verified SQL metrics; another workspace and requester-only identity cannot access internal aggregates. Demonstrate Exasol doing the actual data work, without claiming causal explanations or unmeasured performance gains.

## M2 — Describe, refine, and publish the tool

Dependencies: M1.

- [ ] Generate a draft `ToolSpec` using the supported catalog and current template context.
- [ ] Validate schema shape, field keys, view bindings, action references, limits, and transition references.
- [ ] Show assumptions, unsupported requests, and an actionable validation error when generation fails.
- [ ] Provide direct controls for labels, requiredness, visible fields, filters, and status labels.
- [ ] Preview a draft and show changes relative to the published revision.
- [ ] Publish using the expected current revision; keep existing clients on a valid published revision until refresh.
- [ ] Limit MVP structural edits to compatible changes; require backfill or defer destructive/type-changing edits.
- [ ] Restore an older compatible definition by publishing a new revision, without reverting business records.
- [ ] Render an IT-request template through the same contracts and renderer.

Acceptance: an owner describes a desk and gets a working draft; a follow-up adds an optional field without losing records. A required-field change shows its impact on existing requests. Unknown components or generated expressions never execute. Concurrent publication produces a clear conflict. The second template does not require a separate app implementation.

## M3 — Shared saved records and activity

Dependencies: M1; can proceed before M2 is complete.

- [ ] Use authenticated polling/refetch after mutations, tab focus, reconnect, and a modest configurable interval.
- [ ] Apply current role/own-request scope to every read, including activity, counts, exports, and query results.
- [ ] Retain unsaved input on version conflict and show the authorized current state.
- [ ] Clear inaccessible local data when a refresh is denied; isolate caches by identity and workspace.
- [ ] Keep transactional outbox events for durable change history; SSE/presence are optional extensions after core correctness.

Acceptance: two synthetic browser personas see acknowledged saved updates, simultaneous edits do not silently overwrite, and revocation denies subsequent fetches. Requesters never receive internal activity or other requesters' identifiers.

## M4 — Approved team knowledge

Dependencies: M1.

- [ ] Support bounded plain-text/Markdown uploads and editable glossary/routing entries.
- [ ] Store canonical source revisions, content hashes, visibility, owners, and provenance.
- [ ] Implement knowledge states: draft, approved, superseded, retired; preserve case-specific exceptions separately.
- [ ] Require an owner to publish reusable procedures or rules.
- [ ] Add searchable active approved knowledge with explicit applicability and effective dates.
- [ ] Implement bounded normalized-term retrieval and exact-key lookup in Exasol with access filtering before retrieval results reach the model.
- [ ] Support source inspection and permission-checked evidence links.
- [ ] Mark conflicting approved rules as requiring clarification rather than silently choosing one.
- [ ] Defer semantic retrieval; if the lexical baseline fails, evaluate an Exasol-compatible approach against frozen authorized fixtures before choosing additional infrastructure.

Acceptance: an active approved routing rule is retrieved; a draft or retired rule is not treated as authority. A requester cannot retrieve internal procedures. Updating or revoking a source invalidates dependent reusable knowledge and pending proposals. Search failure is distinguishable from a legitimate no-match result.

## M5 — Bounded agent and proposal review

Dependencies: M1 and M4; tool-aware interface depends on M2.

- [ ] Start a run with an authenticated initiator, selected record IDs, published spec revision, budgets, and idempotency key.
- [ ] Recheck access in each bounded execution request before each retrieval, persisted result, and proposed action.
- [ ] Support summarization, missing-field identification, owner suggestions, duplicate candidates, and clarification drafts.
- [ ] Restrict the agent to known read/propose tools; keep business mutation and approval tools unavailable to it.
- [ ] Persist run steps and validated outputs; checkpoint after each completed expensive call.
- [ ] Store immutable proposals containing exact action parameters, expected versions, evidence dependencies, and a server-computed hash.
- [ ] Display record-level before/after values, sources, and uncertainty. Explain abstention when rules are absent or conflicting.
- [ ] Allow review, rejection, or editing by creating a new proposal revision that requires fresh approval.
- [ ] Execute approved local actions atomically through the shared command service.
- [ ] Implement cancel, timeout, budget exhaustion, retry exhaustion, and stale-proposal behavior.
- [ ] Revalidate inside the write transaction and append audit/outbox records on commit.

Acceptance: agent-assisted triage completes on a selected batch. No request is modified before an authorized approval. Editing a proposal invalidates the previous approval. Changed records, rules, tool revisions, or permissions block stale execution. A duplicate approval or retried job produces one domain effect. Server restart, request interruption, and cancellation do not cause an unapproved write.

## M6 — Reviewed decision reuse

Dependencies: M4 and M5.

- [ ] Let an operator record why a recommendation was corrected.
- [ ] Let the agent or operator propose a scoped reusable rule with evidence.
- [ ] Require owner review of applicability, precedence, effective date, and source visibility.
- [ ] Preserve the original decision as a case-specific record regardless of rule publication.
- [ ] Retrieve approved guidance on a subsequent request and expose its source/version.
- [ ] Support supersession, retirement, and correction without rewriting history.

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

| Dimension | Initial gate | How to assess |
| --- | --- | --- |
| Authorization | Zero unauthorized reads/writes in the defined isolation suite | Assert API responses, context inputs, query scope, storage access, and database state. |
| Change integrity | Every stale or tampered approval rejected; every committed action audited | Concurrent transactions, proposal-edit tests, retry/replay tests. |
| Request intake | Required intake checks deterministic and consistent | Schema and end-to-end fixture assertions; no model judge needed. |
| Tool generation | At least 95% of supported prompts produce valid drafts within the configured attempt budget | Fixed supported prompt set; separately report semantic suitability. |
| Owner suggestions | At least 85% correct on cases with clear approved routing evidence | Human-labeled owner IDs; unknown cases scored separately for abstention. |
| Missing requirements | At least 90% precision and recall on labeled cases | Compare field IDs and clarification needs with gold labels. |
| Evidence | At least 90% of actionable recommendations supported by the cited active guidance | Human review of claim-to-source support; citation existence alone is insufficient. |
| Memory updates | All deterministic scope/retirement fixtures pass | Verify current approved rule selection, historical preservation, and invalidation. |
| Retrieval | Record lexical baseline; target at least 90% recall@5 on applicable approved-rule cases | Gold evidence IDs, scoped to authorized searchable content. |
| Product usefulness | Target at least 30% lower median coordination time versus current process | Time clarification, routing, and review on matched batches; report quality and sample size. |
| Collaboration | No lost acknowledged updates in the concurrency suite | Two-user writes, reconnects, version conflicts, event redelivery. |
| Cost and latency | Choose a budget before the pilot; record median and p95 per operation | Include unsuccessful generations and retries in cost totals. |

Model judges can help assess phrasing and support, but cannot authorize actions or replace database assertions. Do not generalize small-sample pilot results into market-wide productivity claims.

## Resource limits to implement first

Initial tunable limits: CSV up to 5 MiB and 5,000 rows; text/Markdown source up to 1 MiB; agent triage up to 20 selected records; at most eight model/tool steps, two transient retries per step, and a 120-second active execution budget across bounded requests. Define provider token/spend budgets in configuration before live runs. These are engineering starting points requiring measurement.

Stream or process files with bounded memory. Export untrusted spreadsheet cells with formula-injection protection. Treat linked URLs as text; remote fetching and PDF/Office parsing are deferred to a separately designed ingestion step.

## Demo script

1. An owner describes a data-request desk and publishes the validated draft.
2. Import a synthetic CSV with known missing fields and repeated requests; inspect Exasol-derived queue age, owner workload, SLA risk, and query evidence.
3. A requester submits a request and sees only their own records.
4. An operator opens the shared queue in a second browser and changes an owner.
5. Ask the agent to triage selected requests using an approved procedure.
6. Inspect evidence and exact proposed changes; approve a subset.
7. Change a record in the second browser before approving its older proposal; show the conflict and refreshed proposal.
8. Correct a recommendation, propose a routing rule, and approve it as the owner.
9. Submit a new applicable request; show grounded reuse and the audit trail.

The demo should include a visible rejected/stale proposal. It should use genuine persisted state and a synthetic dataset, not simulated success messages.

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

| Decision/risk | Default | Evidence that changes it |
| --- | --- | --- |
| Event data and users | Synthetic analytics scenarios and consenting testers | Real-team pilots require separate data permission and applicable edition terms. |
| Agent provider/model | One provider selected with fixtures | Grounded task quality, latency, price, and permitted data handling. |
| Renderer adapter | Loom-owned schema, thin catalog renderer | M0 spike proves json-render fits without obscuring domain contracts. |
| Semantic retrieval | Lexical/structured retrieval first | Measured retrieval failures and a passing hybrid-search comparison. |
| Workflow too broad | Data-request desk first | Repeated demand for another workflow using the same primitives. |
| Existing ticket tool already sufficient | Validate coordination benefit before integration breadth | Pilot users cannot demonstrate a meaningful reason to adopt Loom. |
| Capacity remains the bottleneck | Report triage and fulfillment separately | Actual throughput and queue-age evidence. |

## Definition of done

The MVP is done when a lead can create a reusable desk, requesters can submit and track authorized work, operators can collaborate on persisted records, and an agent can make evidence-backed proposals that are safely reviewed and committed. One reviewed correction must be reusable on a later request with correct scope and provenance. Required correctness checks and the fresh-state demonstration must pass.
