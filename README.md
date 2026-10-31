# Loom

Loom lets a team describe a small internal tool, assemble it from supported components, share it with colleagues, and work alongside an agent in one live workspace.

The everyday screen is **one prompt box**. People ask questions or describe what they need in their own words. The configured agent reads the workspace context they can access and replies in that conversation. When appropriate, it returns a proposed record change or an unpublished tool draft for explicit review. There is no hardcoded business-query routing or required record-selection step.

Company owners can now use **Company setup** to preview and save their name, logo, brand colors, typography, and corner style. Branding follows the workspace for all colleagues. The same onboarding flow creates scoped MCP connections for Codex, Claude Code, or another compatible agent, with proposals entering Loom's existing human review. See the [company setup guide](RUNBOOK.md#company-branding-and-bring-your-own-agent--2026-10-28).

Supported starting points include **data requests, IT support, employee onboarding, and project reviews**. They share a bounded request-and-review engine: collect information, assign owners, record progress, and work alongside an agent. Its suggestions draw on approved team knowledge and remain proposals until someone reviews and applies them. Onboarding buddies, dates, and checklists are editable text; integrations and automatic task execution are not included.

**Hackathon track:** Track 04 — The Work Behind the Work.

**Project status:** The describe → shared tool → agent journey includes a conversation entry point, four optional templates, direct editing, a shared renderer, immutable drafts, reviewed publication, password accounts, expiring invitations, and role-aware records. The team brain adds approved-source search, evidence-backed connections, and an activity timeline. The agent retrieves relevant approved guidance; an applied decision can become a provenance-linked knowledge draft, with separate owner approval before reuse. Definitions, conversations, records, proposals, and knowledge persist in Exasol. Live designer generation was verified previously; current automated workflow checks distinguish real database execution from test-only model responses. SSO, email verification/reset, multiple independent tools per workspace, external ingestion, semantic retrieval, and broader evaluation remain planned. See [RUNBOOK.md](RUNBOOK.md) for supported behavior and verification limits.

## Describe a process, then work inside it

1. **Describe:** Type a question or describe the tool you need in the main prompt. Owners can review a generated draft of supported fields, table, filters, summary, and status labels. A manual builder and templates remain in workspace settings.
2. **Share:** Save the draft, review its exact changes, and publish. Invite colleagues with a requester, operator, or viewer role. Each workspace has one tool; create a separate workspace for an independent process.
3. **Work with the agent:** Ask for help in the same conversation. Relevant approved procedures and authorized saved work supply context. Inspect source references and before/after changes, then approve or reject them.
4. **Keep useful knowledge:** Write guidance from an applied proposal and explain when it should be reused. An owner approves it separately. A later run can retrieve that guidance, with its original decision preserved as evidence.

The Company Brain architecture reference informs the separation of stored facts, retrieved context, and AI suggestions. Loom's relationship view comes from saved ownership and explicit source references. It does not infer engineering infrastructure, ingest Slack/GitHub, provide vector search, or reconstruct a historical service topology.

The workspace UI adapts components and styling from [Civitas](https://github.com/minnhaaaaa/civitas): its wordmark/seal, metric strip, terminal headers, forest/lime palette, and locally served typography. Component provenance and retained licenses are in [third-party/civitas](third-party/civitas/README.md).

## Run the current build

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. The default view is the assistant; **Saved work** opens the table, and **Workspace settings** holds the optional builder and administration. Sample exploration is unsaved; conversations require an authenticated workspace, Exasol, and a configured agent. To enable real saves, configure Exasol and follow the migration, seed, and database checks in [RUNBOOK.md](RUNBOOK.md). There is no substitute persistence backend.

## Build and challenge requirements

Selected stack: **Next.js App Router, TypeScript, and Exasol Personal**. Next.js supplies the basic frontend and Node server endpoints. Exasol is the canonical store and analytical engine: imported requests, status history, backlog/SLA metrics, and evidence for triage suggestions. This replaces the earlier PostgreSQL/Supabase design.

The matching [ExaThon India 2026 rules](https://www.exasol.com/events/exathon-india-2026/) allow any framework and teams of one to three. Use only public or synthetic data, not employer/proprietary data. Submit a public repository, problem statement, slide deck, demo of at most three minutes, setup/usage instructions, and a deployment/run guide. This repository already uses Apache-2.0, an accepted license. The published deadline is **25 October 2026, 23:59 IST**; confirm any organizer updates before submission. Effective Exasol use accounts for 25% of judging, so it must power the working workflow and measurable SQL insights.

Personal is documented for individual use with a single-user restriction. The event demo uses synthetic role personas under one operator; an actual shared service needs clarification of applicable permissions and edition terms. See the [Personal documentation](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm).

## Who it serves

| Person                         | Problem                                                                                  | Intended benefit                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Analytics or data-team lead    | Requests arrive through messages and spreadsheets, without clear requirements or owners. | Create a suitable intake and review tool, organize the queue, and inspect proposed assignments. |
| Analyst or operations teammate | Repeated clarification, context searches, and status updates interrupt delivery.         | Work from structured requests with relevant definitions, procedures, and decision history.      |
| Internal business requester    | It is unclear what to submit, who owns the request, or what happens next.                | Use a guided form, answer questions, and track their own requests.                              |

The initial adoption hypothesis is a team with recurring internal requests and repeated coordination work. Customer demand and time savings still need validation with pilot users.

## Intended MVP journey

> Build a data-request desk with requester, business question, reporting period, dataset, owner, priority, due date, and status. Show incomplete and overdue requests.

1. The lead describes the desk and reviews a generated draft.
2. Loom renders a supported table, intake form, record details, filters, and summary cards.
3. The team imports an existing CSV backlog and adds a routing procedure and glossary.
4. The agent checks selected requests, identifies missing details, retrieves relevant guidance, and proposes assignments or clarification drafts.
5. An authorized teammate reviews exact changes. The server checks permissions and record versions before committing them.
6. Everyone sees authorized updates in the shared workspace. The activity history records changes and decisions.
7. A useful correction can become a proposed team rule. An owner reviews it before future requests use it.

Loom aims to reduce coordination delays. It does not automatically create analyst capacity, execute arbitrary analyses, or resolve every cause of a long request backlog.

## MVP boundary

| Included                                                         | Deferred                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| One request-and-review tool family, led by the data-request desk | General-purpose application generation                    |
| Versioned tool specifications and a fixed component catalog      | Arbitrary generated JavaScript, SQL, or backend code      |
| CSV import/export and persisted requests                         | A connector marketplace or broad SaaS migration           |
| Shared saved records, comments, authorized refresh, and activity | Character-level collaborative editing and offline writes  |
| A bounded agent that reads context and creates proposals         | Unattended external actions or autonomous agent teams     |
| Approved procedures, definitions, and reviewed decision reuse    | Automatic promotion of chat messages into policy          |
| Exact-change review, version checks, and audit events            | Claims of guaranteed AI correctness or universal rollback |

The IT-request template uses the same specification, renderer, and action system as the data desk. In this slice each workspace has one published request-family tool; selecting a template starts a draft of that tool and preserves its records. Multiple independent tools are a later extension.

## How the company-brain idea fits

Loom starts with a small **team knowledge layer**: definitions, procedures, routing rules, and reviewed decisions. Every reusable item has a scope, owner, source, and version. Draft suggestions and historical exceptions are distinct from approved guidance.

The working tool supplies the interface and records; the knowledge layer supplies context; an explicit proposal and action system connects them. Shared knowledge is useful only when retrieval respects permissions and outdated guidance can be retired.

Related market references include [YC's Company Brain request](https://www.linkedin.com/posts/y-combinator_every-company-has-critical-know-how-scattered-activity-7455394239946862592-OW2d), [Hyperspell](https://www.ycombinator.com/companies/hyperspell), [Memory Store](https://www.ycombinator.com/companies/memory-store), and [Savant](https://www.ycombinator.com/companies/savant). YC's [A Cloud for Small Software request](https://www.ycombinator.com/rfs) also relates to creating and sharing small team tools. These references inform positioning; they do not establish an unoccupied market or validate Loom's demand.

## Documentation

| Document                           | Purpose                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| [DEPLOYMENT.md](DEPLOYMENT.md)     | Free online testing, shared-host configuration, and deployment limits.                         |
| [RUNBOOK.md](RUNBOOK.md)           | Actual setup commands, supported behavior, verification, and current blockers.                 |
| [TECH_STACK.md](TECH_STACK.md)     | Selected technologies, tradeoffs, proposed repository layout, and dependency evaluation rules. |
| [PLAN.md](PLAN.md)                 | Prioritized milestones, implementation tasks, acceptance criteria, evaluation, and demo.       |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System boundaries, data model, protocols, failure handling, and research/repository evidence.  |

Read the plan before implementation. Architecture decisions and the source register are maintained in `ARCHITECTURE.md`; stack choices are maintained in `TECH_STACK.md`.

## Success criteria

Compare the current workflow, Loom with manual controls, and Loom with its agent on comparable request batches. Measure setup effort, clarification and routing time, recommendation quality, repeat explanations, and lost or unowned work. Report request fulfillment time separately from triage time.

Numerical targets in the plan are proposed evaluation gates, not measured results.
