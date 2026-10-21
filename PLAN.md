# Loom implementation plan

Status: proposed; implementation has not started. Updated: 2026-10-21.

## Objective

Deliver a working data-request desk that a team lead can describe, refine, and share. Requesters submit and track their own requests. Operators and an agent triage the same queue using approved procedures. Authorized people review exact proposed changes before execution.

The user has accepted coordination pain as a promising problem. This is product direction, not evidence of willingness to pay or measured time savings. Validate those with real users while implementing.

Read [README.md](README.md), [TECH_STACK.md](TECH_STACK.md), and [ARCHITECTURE.md](ARCHITECTURE.md) together. Milestones are ordered by dependencies, not calendar promises. Every checkbox below represents future work.

## Delivery rules

- Finish the manual request workflow before adding the operating agent.
- Build one reusable request-and-review engine; demonstrate a data desk first.
- Persist state and permissions before adding live notifications.
- Treat generated specifications and model suggestions as untrusted inputs.
- Publish tool structure and team knowledge through explicit reviewed revisions.
- Make a proposal approval authorize only the immutable changes displayed.
- A milestone is complete only when its acceptance criteria have been demonstrated.

## M0 — Contracts, fixtures, and thin technical spike

Dependencies: none.

- [ ] Set up pnpm workspaces, TypeScript, formatting, linting, and a supported Node runtime.
- [ ] Create React/Vite web, Fastify API, and a minimal worker entry point.
- [ ] Confirm supported package versions, licenses, database connection roles, and migration ownership.
- [ ] Define shared `ToolSpec`, action, proposal, event, and API error schemas.
- [ ] Define the role matrix: owner, operator, requester, viewer.
- [ ] Seed two organizations/workspaces and separate role identities with synthetic data.
- [ ] Create a fixed data-request template and validate/render it without an LLM.
- [ ] Evaluate json-render against the small catalog; record adapter adoption or rejection.
- [ ] Verify pg-boss queue/schema privileges and outbox delivery with one harmless job.
- [ ] Verify private Realtime channel authorization and the restricted database role in the intended Supabase environment.

Acceptance: a static specification renders; a valid identity can call one scoped API endpoint; another workspace's identity cannot read it; a job survives worker restart. Resolve auth/database role compatibility before building additional features.

## M1 — Usable request desk without AI

Dependencies: M0.

- [ ] Implement workspace membership and current-permission checks.
- [ ] Create request, comment, revision, activity, and audit tables with composite workspace constraints.
- [ ] Implement request creation, own-request listing, team queue listing, details, comments, and controlled updates.
- [ ] Render intake form, table, details, filters, and summary cards from `ToolSpec`.
- [ ] Support statuses `new`, `needs_info`, `ready`, `in_progress`, `done`, and `cancelled`.
- [ ] Separate hard intake requirements from readiness requirements; imported historical records may be incomplete and must be marked accordingly.
- [ ] Implement owner and due-date controls, pagination, and requester-visible status.
- [ ] Implement CSV column mapping, bounded upload parsing, validation preview, explicit import commit, and authorized export.
- [ ] Add compare-and-swap record versions and database idempotency keys for mutations.
- [ ] Write audit and outbox events in the same transaction as successful changes.

Acceptance: a requester submits a record; an operator clarifies, assigns, and completes it; the requester sees their own progress. A requester cannot change owner, priority, or status through a forged API call. A viewer cannot mutate. Invalid transitions and stale versions fail without partial writes. Duplicate import submission does not create duplicate rows.

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

## M3 — Shared workspace and activity

Dependencies: M1; can proceed before M2 is complete.

- [ ] Publish idempotent invalidations after outbox events commit.
- [ ] Authorize internal-team channels separately from requester-owned channels.
- [ ] Refetch through the API after notifications, reconnect, and tab focus.
- [ ] Detect event gaps/out-of-order delivery using versions; perform a full authorized refresh when needed.
- [ ] Add minimal presence, authorized activity, and record comments.
- [ ] Show conflict resolution controls that retain the user's unsaved input.
- [ ] Handle permission revocation: deny subsequent API access and clear local data on denied refresh; bound subscription lifetime and reauthorize channels.

Acceptance: two authenticated browser contexts see saved updates. Simultaneous edits cannot silently overwrite each other. Missing notifications do not leave the queue permanently stale. Requesters never subscribe to internal queue channels or receive other requesters' record identifiers.

## M4 — Approved team knowledge

Dependencies: M1.

- [ ] Support bounded plain-text/Markdown uploads and editable glossary/routing entries.
- [ ] Store canonical source revisions, content hashes, visibility, owners, and provenance.
- [ ] Implement knowledge states: draft, approved, superseded, retired; preserve case-specific exceptions separately.
- [ ] Require an owner to publish reusable procedures or rules.
- [ ] Add searchable active approved knowledge with explicit applicability and effective dates.
- [ ] Implement SQL full-text retrieval and exact-key lookup with access filtering before retrieval results reach the model.
- [ ] Support source inspection and permission-checked evidence links.
- [ ] Mark conflicting approved rules as requiring clarification rather than silently choosing one.
- [ ] Evaluate pgvector only if the baseline fails paraphrase retrieval; compare against the frozen lexical baseline before adoption.

Acceptance: an active approved routing rule is retrieved; a draft or retired rule is not treated as authority. A requester cannot retrieve internal procedures. Updating or revoking a source invalidates dependent reusable knowledge and pending proposals. Search failure is distinguishable from a legitimate no-match result.

## M5 — Bounded agent and proposal review

Dependencies: M1 and M4; tool-aware interface depends on M2.

- [ ] Start a run with an authenticated initiator, selected record IDs, published spec revision, budgets, and idempotency key.
- [ ] Recheck access in the worker before each retrieval, persisted result, and proposed action.
- [ ] Support summarization, missing-field identification, owner suggestions, duplicate candidates, and clarification drafts.
- [ ] Restrict the agent to known read/propose tools; keep business mutation and approval tools unavailable to it.
- [ ] Persist run steps and validated outputs; checkpoint after each completed expensive call.
- [ ] Store immutable proposals containing exact action parameters, expected versions, evidence dependencies, and a server-computed hash.
- [ ] Display record-level before/after values, sources, and uncertainty. Explain abstention when rules are absent or conflicting.
- [ ] Allow review, rejection, or editing by creating a new proposal revision that requires fresh approval.
- [ ] Execute approved local actions atomically through the shared command service.
- [ ] Implement cancel, timeout, budget exhaustion, retry exhaustion, and stale-proposal behavior.
- [ ] Revalidate inside the write transaction and append audit/outbox records on commit.

Acceptance: agent-assisted triage completes on a selected batch. No request is modified before an authorized approval. Editing a proposal invalidates the previous approval. Changed records, rules, tool revisions, or permissions block stale execution. A duplicate approval or retried job produces one domain effect. Worker restart and cancellation do not cause an unapproved write.

## M6 — Reviewed decision reuse

Dependencies: M4 and M5.

- [ ] Let an operator record why a recommendation was corrected.
- [ ] Let the agent or operator propose a scoped reusable rule with evidence.
- [ ] Require owner review of applicability, precedence, effective date, and source visibility.
- [ ] Preserve the original decision as a case-specific record regardless of rule publication.
- [ ] Retrieve approved guidance on a subsequent request and expose its source/version.
- [ ] Support supersession, retirement, and correction without rewriting history.

Acceptance: a correction remains an exception until reviewed. Once approved as guidance, it influences an applicable later request. It does not influence unrelated requests or a user who lacks access. Retiring it removes it from future authoritative context and prevents pending dependent changes from being applied.

## M7 — Evaluation, pilot readiness, and demo

Dependencies: M1–M6.

- [ ] Freeze evaluation fixtures, prompts, models, specification versions, and knowledge revisions.
- [ ] Complete permission, concurrency, idempotency, source-injection, and worker recovery integration checks.
- [ ] Run the complete two-user journey in Playwright.
- [ ] Compare the manual desk with the agent-assisted desk on equivalent tasks.
- [ ] Run a small pilot with consenting team members using their chosen workflow and permitted data.
- [ ] Record actual setup effort, completion quality, review time, latency, token usage, and repeat usage.
- [ ] Verify backups/restoration, migration rehearsal, private storage/channel settings, error monitoring, and deployment secrets.
- [ ] Publish a demo environment with synthetic data and a reset procedure.

Acceptance: all correctness gates pass, material limitations are documented, and the demonstration runs from fresh state. Pilot metrics are reported separately from synthetic evaluations.

## Evaluation fixtures and proposed gates

Create 60 labeled request scenarios: 40 for development and 20 held out. Include complete and incomplete requests, ambiguous owners, duplicate candidates, absent/contradictory guidance, stale revisions, restricted data, and injected instructions. Split by scenario family to avoid near-duplicate leakage. Add deterministic system tests beyond these 60 agent examples.

Create a small versioned knowledge corpus containing approved, draft, superseded, retired, restricted, and case-specific material. Label expected evidence, allowed actions, and abstentions. Repeat selected agent scenarios at least five times to expose inconsistent behavior; retain every trial rather than selecting the best run.

All thresholds below are proposed release targets, not achieved results. Revise them with pilot evidence and report counts alongside percentages.

| Dimension | Initial gate | How to assess |
| --- | --- | --- |
| Authorization | Zero unauthorized reads/writes in the defined isolation suite | Assert API responses, context inputs, channel routing, storage access, and database state. |
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

Initial tunable limits: CSV up to 5 MiB and 5,000 rows; text/Markdown source up to 1 MiB; agent triage up to 20 selected records; at most eight model/tool steps, two transient retries per step, and a 120-second total run deadline. Define provider token/spend budgets in configuration before live runs. These are engineering starting points requiring measurement.

Stream or process files with bounded memory. Export untrusted spreadsheet cells with formula-injection protection. Treat linked URLs as text; remote fetching and PDF/Office parsing are deferred to a separately designed ingestion step.

## Demo script

1. An owner describes a data-request desk and publishes the validated draft.
2. Import a synthetic CSV with known missing fields and repeated requests.
3. A requester submits a request and sees only their own records.
4. An operator opens the shared queue in a second browser and changes an owner.
5. Ask the agent to triage selected requests using an approved procedure.
6. Inspect evidence and exact proposed changes; approve a subset.
7. Change a record in the second browser before approving its older proposal; show the conflict and refreshed proposal.
8. Correct a recommendation, propose a routing rule, and approve it as the owner.
9. Submit a new applicable request; show grounded reuse and the audit trail.

The demo should include a visible rejected/stale proposal. It should use genuine persisted state and a synthetic dataset, not simulated success messages.

## After the MVP

Prioritize from observed pilot friction: one connector, notifications, saved templates, broader reporting, and finer resource permissions. External actions require explicit product-level authorization, connector-specific scopes, idempotency/reconciliation, and truthful reporting of ambiguous outcomes.

Do not add a graph database, autonomous agent team, offline editing, arbitrary code execution, or a connector marketplace simply because a reference project includes it.

## Open decisions and risks

| Decision/risk | Default | Evidence that changes it |
| --- | --- | --- |
| Which team to pilot with | Internal analytics/data operations | Interviews and access to a consenting pilot team. |
| Agent provider/model | One provider selected with fixtures | Grounded task quality, latency, price, and permitted data handling. |
| Renderer adapter | Loom-owned schema, thin catalog renderer | M0 spike proves json-render fits without obscuring domain contracts. |
| Semantic retrieval | Lexical/structured retrieval first | Measured retrieval failures and a passing hybrid-search comparison. |
| Workflow too broad | Data-request desk first | Repeated demand for another workflow using the same primitives. |
| Existing ticket tool already sufficient | Validate coordination benefit before integration breadth | Pilot users cannot demonstrate a meaningful reason to adopt Loom. |
| Capacity remains the bottleneck | Report triage and fulfillment separately | Actual throughput and queue-age evidence. |

## Definition of done

The MVP is done when a lead can create a reusable desk, requesters can submit and track authorized work, operators can collaborate on persisted records, and an agent can make evidence-backed proposals that are safely reviewed and committed. One reviewed correction must be reusable on a later request with correct scope and provenance. Required correctness checks and the fresh-state demonstration must pass.
