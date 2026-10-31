# Loom

Loom helps **small analytics teams** turn vague business requests into clear, assigned work and see where those requests spend time.

A business requester should not have to chase an analyst for every update. An analyst should not have to repeatedly reconstruct the reporting period, dataset, metric definition, or owner. Loom brings the request, approved team guidance, proposed next steps, and workflow measurements into one company workspace.

**Problem statement:** Small analytics teams struggle to turn business requests into actionable work because requirements, ownership, and business definitions are scattered across conversations. Requesters wait while analysts repeatedly chase context.

**Hackathon track:** Track 04 — The Work Behind the Work.

This is a working prototype. Customer demand, reduced coordination time, and willingness to pay remain unmeasured. Loom does not execute arbitrary business analyses, create analyst capacity, or establish the cause of every delay.

## Company journey

| Route                | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `/`                  | Public landing page                                                        |
| `/register`          | Create an owner account and company workspace when registration is enabled |
| `/login`             | Individual staff sign-in                                                   |
| `/app`               | Authenticated workspace and assistant                                      |
| `/app?view=records`  | Request intake and saved work                                              |
| `/app?view=insights` | Exasol flow insights for owners and analysts                               |
| `/app?view=settings` | Company setup, access, AI provider, and advanced desk configuration        |
| `/app?demo=1`        | Unsaved sample exploration                                                 |
| `/join`              | Accept an owner-issued invitation                                          |

1. An administrator registers the company, sets its name and appearance, and invites colleagues.
2. Each colleague uses an individual account. Membership determines access: owners administer, operators/analysts manage the queue, requesters submit and track their own work, and viewers have read-only access.
3. The team imports a synthetic backlog or submits requests, then adds approved metric definitions and routing procedures.
4. The assistant can explain visible work and propose supported changes. A teammate reviews exact changes before they are applied.
5. Flow insights show waiting time, weekly movement, and current owner workload. A useful decision can become reusable guidance after separate owner approval.

A company currently maps to one workspace and one shared request-family tool. Company-name selection alone grants no access. Domain discovery, verified-domain joining, and an organization hierarchy are not implemented.

## Completed and pending features

“Implemented” describes code and exercised system behavior; live provider quality and production readiness are separate gates. See [RUNBOOK.md](RUNBOOK.md) for dated verification results.

| Area               | Implemented                                                                                                         | Pending or limited                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Request desk       | Forms, assignment, statuses, comments, due dates, CSV import/export, activity, and version conflicts                | Slack/Teams/email ingestion and notifications                                                                       |
| Company access     | Owner registration, individual password accounts, invitation links, roles, revocation, branding                     | Email verification/delivery, password recovery, SSO, and company-domain joining                                     |
| Exasol insights    | Stage median/p90, weekly arrivals and closure/reopening transitions, backlog, owner aging, bounded request evidence | Outcome evaluation, richer filters, capacity estimates, and predictive SLA models                                   |
| Assistant          | Saved conversation, scoped context, validated proposals, explicit human approval                                    | Reliable live provider coverage and broad quality/cost evaluation                                                   |
| Company AI         | Owner-managed OpenAI, Claude, Kimi, and DeepSeek API adapters; test-and-save, encrypted credentials, disconnect     | Subscription-account OAuth; verification with each real company credential/model                                    |
| External agents    | MCP context, queued tasks, replies, proposals, tool drafts, expiring/revocable Loom tokens                          | Hosted agent runner and interactive vendor-client verification                                                      |
| Team guidance      | Approved definitions/procedures, lexical retrieval, citations, reviewed decision reuse                              | External ingestion, semantic retrieval, automatic policy creation                                                   |
| Desk configuration | Templates, manual editing, validated AI drafts, reviewed publication, compatible revisions                          | Arbitrary application/code generation and multiple independent tools per company                                    |
| Deployment         | Next.js Node application, Exasol migrations, local setup and deployment instructions                                | Production edition/hosting decision, operational hardening, backup/restore rehearsal, and multi-instance deployment |

Legacy IT, onboarding, and project-review templates remain available in advanced configuration, but the product and demonstration now focus on analytics requests.

## Exasol does the analytical work

Exasol is the canonical store for requests, events, accounts, conversations, proposals, guidance, and company settings. Flow insights also run real, workspace-filtered SQL rather than asking an LLM to estimate metrics:

- **Stage time:** `LEAD` constructs intervals from request history; repeated visits are summed per request/status. Exasol computes medians and 90th percentiles over these totals.
- **Weekly flow:** `LAG` identifies completions, cancellations, and reopening. A cumulative SQL ledger starts with carryover backlog and follows every transition.
- **Owner workload:** current open requests, overdue dates, age buckets, and oldest age are grouped by current owner.
- **Evidence:** query IDs, SQL hashes, cutoff, timing, sample counts, and up to 50 contributing request rows make results inspectable. Aggregates include all qualifying records even when evidence is truncated.

The reporting window is 30 or 90 rolling UTC days, start included and cutoff excluded. First/last calendar weeks can be partial. Stage time is elapsed calendar time within the window, including unfinished work; it is not analyst effort or completed-request turnaround. Done/cancelled intervals are excluded until work reopens. Transition counts may include a request more than once. Owner workload covers all current open work and does not measure available capacity.

The assistant receives a compact 30-day Exasol snapshot for owners/operators, including the cutoff and measurement definitions. Requesters/viewers receive no internal analytics snapshot. These measurements explain the workspace; action authorization still depends on exact permitted records and versions. There is no model-authored SQL execution.

## Bring a company AI provider

Owners can configure an **API account** for OpenAI, Claude, Kimi, or DeepSeek in company settings. The server sends authorized context using the selected model; staff continue using Loom. Test-and-save makes a small explicit provider request before saving a usable connection. API usage is billed by that provider.

Set `LOOM_PROVIDER_ENCRYPTION_KEY` on the server before enabling this feature. Credentials are encrypted with AES-256-GCM, bound to the workspace/provider/model/revision, and never returned by the settings API. See [DEPLOYMENT.md](DEPLOYMENT.md) for setup and key handling. Available models and structured-output compatibility depend on the provider; adapter tests do not establish that every model works.

A ChatGPT/Claude/Kimi/DeepSeek chat subscription is not a connected API account in this implementation. Subscription-account OAuth is not implemented. The separate Codex/Claude Code MCP option gives an externally running client a Loom token; company setup does not launch, host, or log that client into its vendor account. External connections currently serve owners/operators.

## Run the current build

```sh
pnpm install --frozen-lockfile
# On a fresh checkout only, copy .env.example to .env; preserve existing secrets.
# Configure Exasol, session settings, and optional company AI encryption in .env.
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:3000 for the landing page or http://localhost:3000/app?demo=1 for an unsaved sample. Company registration requires `LOOM_ALLOW_WORKSPACE_SIGNUP=true`; real saves and conversations require Exasol. Manual request work does not require a model. Follow [RUNBOOK.md](RUNBOOK.md) for installing/starting Exasol Personal, verifying the connection, and choosing the correct authentication mode. There is no substitute persistence backend.

## Competition and deployment scope

The [ExaThon India 2026 rules](https://www.exasol.com/events/exathon-india-2026/) require Exasol Personal, public or synthetic data, a public repository under an accepted open-source license, a clear problem statement, pitch deck, demo video of at most three minutes, and setup/deployment instructions. The official deadline is **31 October 2026, 23:59 IST**. Effective Exasol use accounts for 25% of judging. This repository uses Apache-2.0.

[Exasol Personal](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm) is documented for individual/single-user use. The challenge prototype uses synthetic companies and role personas under one operator. The implemented company and membership flows do not establish permission to run a multi-company production service on Personal. A production deployment requires an appropriate edition/permission and hosting decision.

## Documentation and evaluation

- [RUNBOOK.md](RUNBOOK.md): setup, operating behavior, dated checks, and verification limits.
- [PLAN.md](PLAN.md): narrowed priorities, acceptance gates, evaluation, and submission work.
- [DEPLOYMENT.md](DEPLOYMENT.md): company access, AI credential setup, shared-host configuration, and deployment limits.
- [ARCHITECTURE.md](ARCHITECTURE.md) and [TECH_STACK.md](TECH_STACK.md): system design and technology decisions; consult the current checkpoints for implemented scope.

Compare matched synthetic request batches using the existing workflow, Loom's manual desk, and Loom with an agent. Measure clarification rounds, time to readiness/assignment, review effort, errors, and repeat explanations; report actual fulfillment time separately. Numerical targets are evaluation goals, not achieved savings.

The workspace adapts styling/components from [Civitas](https://github.com/minnhaaaaa/civitas). Attribution and retained licenses are in [third-party/civitas](third-party/civitas/README.md).
