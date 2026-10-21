# Loom technical stack

Status: revised for ExaThon India 2026; implementation remains paused. Reviewed: 2026-10-21.

**Exasol Personal is the required and selected primary data platform. Next.js App Router is the recommended application framework.** This replaces the earlier React/Vite + Fastify + PostgreSQL/Supabase design. The frontend stays basic for a later redesign.

See [README.md](README.md) for the problem and contest requirements, [PLAN.md](PLAN.md) for implementation gates, and [ARCHITECTURE.md](ARCHITECTURE.md) for the system and research register.

## Verified platform findings

| Finding from primary sources | Consequence for Loom |
| --- | --- |
| The matching [ExaThon rules](https://www.exasol.com/events/exathon-india-2026/) require Exasol Personal as the data platform. | Core records and analytics must actually run on Exasol, with reproducible query evidence. |
| [Personal documentation](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm) describes a free, fully functional edition for individual use with a single-user restriction. | Demo with synthetic personas; resolve applicable event/edition permissions before real shared use. A shared backend credential does not establish licensing permission. |
| The current [developer hub](https://www.exasol.com/developers/) supports local Linux/WSL using Podman, alongside native macOS and Windows instructions. | Use the current local starter kit on this Linux workspace; do not assume Docker alone is the supported launcher path. |
| [Transaction management](https://docs.exasol.com/db/latest/database_concepts/transaction_management.htm) documents serializable transactions, object-level locking, collision rollbacks, and default autocommit. | Batch small writes, explicitly control transaction scope, and test full-transaction retries. PostgreSQL row-lock/queue recipes cannot be copied. |
| The official [TypeScript driver](https://github.com/exasol/exasol-driver-ts) supports encrypted Node connections, prepared statements, and local file import. | Keep the TypeScript backend; isolate the driver behind a repository adapter. |
| [Constraint guidance](https://docs.exasol.com/db/latest/migration_guides/oracle/execution/constraints.htm) distinguishes supported keys from unsupported UNIQUE/CHECK constraints. | Use enabled primary keys for command receipts and membership identities; validate business rules in the application. |

The general getting-started index contains older platform wording. Use the dedicated Personal page, current developer hub, and selected release documentation; record the tested release during M0. Free database software does not imply free cloud infrastructure. No installer, database deployment, account creation, or cloud provisioning was performed for this revision.

## Selected baseline

| Area | Selection | Purpose |
| --- | --- | --- |
| Language/runtime | TypeScript, supported Node.js LTS, pnpm workspaces | Shared contracts and domain code. Pin compatible versions during implementation. |
| Application framework | Next.js App Router with React and TypeScript | Basic queue, form, details, analytics, and review screens in one application. |
| UI | Semantic HTML and a small plain-CSS token sheet initially | Accessible labels, keyboard focus, responsive layout; easy future redesign. Add primitives only as needed. |
| Tables/forms/server state | TanStack Table/Query, React Hook Form, Zod | Reusable controls, validation, and authorized refetch. Server checks remain authoritative. |
| HTTP/server boundary | Next.js Route Handlers in the Node.js runtime | Same-origin API, validated commands, identity checks, and structured errors. No separate Fastify server initially. |
| Primary database | Exasol Personal | Requests, history, memberships, tool definitions, approved knowledge, proposals, execution receipts, audit, imports, and query evidence. |
| Database driver | `@exasol/exasol-driver-ts` with Node `ws` | Server-only TLS connections and bound SQL values. Compatibility is an M0 gate. |
| SQL/data access | Loom-owned Exasol repositories and reviewed versioned SQL | No assumed Drizzle/Prisma Exasol dialect. Separate data access from domain services. |
| Analytics | Exasol SQL views and parameterized query registry | Backlog age, status duration, SLA risk, missing requirements, duplicate candidates, and owner workload. |
| Authentication | Backend-verified identity contract using `jose` | Local-only synthetic demo identities; configured OIDC/JWT for an appropriately licensed shared deployment. No production bypass. |
| Authorization | Explicit workspace/role predicates in the API and repository layer | Owner, operator, requester, viewer. No PostgreSQL RLS assumption and no browser DB credentials. |
| Saved-record updates | Authorized polling/refetch initially | Basic working collaboration prototype without Supabase Realtime. SSE is optional after persistence works. |
| Source files | Bounded upload staging on a private local volume; canonical text/metadata in Exasol | Keep raw files outside SQL where appropriate. Download access is checked by the API. No mandatory cloud storage. |
| Model integration | Vercel AI SDK behind a provider adapter | Generate a bounded tool definition or reviewable suggestions; never unrestricted SQL or direct writes. |
| Agent state | Explicit persisted steps and work items in Exasol | Bounded request-driven execution with resumable checkpoints; no pg-boss dependency or assumed durable background execution. |
| Mutation concurrency | One write coordinator in one backend instance | Serialize local commands, membership changes, and run persistence; use database transactions and expected versions. Not a distributed lock. |
| Retrieval | Typed rules, glossary keys, normalized term lookup over authorized Exasol rows | Small-corpus baseline; no PostgreSQL full-text indexes or pgvector. |
| Tests/evaluation | Vitest, real Exasol integration fixtures, Playwright, Promptfoo | Verify real SQL, commit/rollback, isolation boundaries, retries, UI flow, and grounded suggestions. |
| Observability | Pino, Exasol-backed run/query/execution metadata | Query ID, parameters digest, data revision, row count, latency, run ID, review outcome. |
| Delivery | Local Exasol Personal plus one self-hosted Next.js Node process | Reproducible synthetic-data demo. Horizontal replicas and serverless deployment are outside the first concurrency contract. |

These are engineering selections, not verified implementation results. Exasol is optimized for analytics; the initial write workload is deliberately small and serialized. Do not claim production OLTP throughput from a successful demo.

## What changes from the previous stack

| Earlier assumption | Revised decision |
| --- | --- |
| Separate Vite frontend and Fastify API | Next.js pages/layouts and Node Route Handlers; shared domain modules remain independent of the framework. |
| PostgreSQL as authoritative store | Exasol Personal stores canonical application records and performs analytical queries. No duplicate authoritative PostgreSQL store. |
| Supabase database/Auth/Storage/Realtime bundle | Remove the bundle requirement. Identity, private upload staging, and saved-record refresh have explicit application contracts. |
| Drizzle with `pg` and PostgreSQL migrations | Exasol driver adapter and `exasol/migrations` SQL history. |
| JSONB/UUID/partial indexes/RLS policies | Portable scalar columns, canonical validated JSON text, explicit workspace checks, and Exasol-tested constraints. |
| PostgreSQL full-text search and pgvector | Rule/key matching and bounded normalized text lookup; semantic retrieval deferred. |
| pg-boss and `SKIP LOCKED` | Persisted work items plus one runner/coordinator; prove recovery before adding parallel workers. |
| Transaction-local actor settings and per-row locks | Verified actor passed to every repository call; single write path and Exasol transaction/version checks. |

Keep the earlier papers and repository comparisons as research history, but mark PostgreSQL-specific implementations as superseded or deferred.

## Why Next.js for this build

This is an authenticated internal web application, so one framework for routing, pages, forms, and server endpoints reduces setup and deployment work. Use Server Components for authorized initial reads and Client Components for tables, filters, dialogs, and request forms. Keep the Exasol adapter in server-only modules. Every Route Handler and Server Action must authorize its operation independently; a protected page is not API authorization.

Select the Node.js runtime for Exasol access. The initial deployment is a self-hosted Node server, with private/user-specific responses uncached and no browser-side database connection. Validate that all mutation handlers share the same process-wide write coordinator; do not deploy multiple serverless instances and assume an in-memory mutex provides distributed serialization. M0 must test concurrent requests across distinct routes.

Persist agent run/checkpoint state in Exasol and advance work within bounded authenticated requests. A crash or disconnect leaves a retryable step, not an assumed completed job. Do not treat `after()` or a detached promise as a durable queue. Add a separately managed runner only when longer or unattended jobs are required, with a new coordination design. See [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers), [Node deployment](https://nextjs.org/docs/app/getting-started/deploying), and [`after()` constraints](https://nextjs.org/docs/app/api-reference/functions/after).

Use server-only environment variables for Exasol and model credentials. Cookie sessions require CSRF/origin checks on mutations, secure production cookies, and a deliberate session lifecycle. Never share cached data between identities or embed secrets in client bundles.

## Driver and transaction contract

Use the official [driver user guide](https://github.com/exasol/exasol-driver-ts/blob/main/doc/user_guide/user_guide.md). SQL values use prepared bindings. Schema/table/view names come only from code-owned identifiers. Never put Exasol credentials or the driver in the browser, even though the driver supports browser connections.

A multi-statement command exclusively owns one connection with autocommit disabled, commits only on complete success, and rolls back on failure. Do not assume independent pool queries share a transaction. M0 must verify explicit commit/rollback, affected-row reporting, SQL error classification, numeric precision, cancellation, and connection cleanup against the installed release.

All mutation paths, including run persistence and membership changes, enter one bounded coordinator in the first single-instance deployment. Network/model calls happen outside it. Database collisions retry the complete idempotent transaction with a fresh snapshot and bounded backoff. An ambiguous commit outcome is reconciled by command ID before retrying. Extra backend instances or direct database writers are outside this baseline and require a new concurrency design.

Trust the configured CA and verify TLS/host identity. Do not copy documentation examples that disable certificate or hostname verification into the default runtime. Verify the certificate procedure supplied by the chosen local deployment in M0.

## Data representation and analytical value

Use relational columns for request status, requester, owner, timestamps, and versions. Use canonical bounded JSON text for tool definitions and optional values, validated by Zod. Map IDs initially to `VARCHAR(36)`, revisions/counts to exact numeric types, and timestamps with an explicit tested UTC conversion. Validate all mappings against [Exasol data types](https://docs.exasol.com/db/latest/sql_references/data_types/datatypedetails.htm); account for empty-string/null behavior and serialization precision.

Use enabled primary keys and supported composite foreign keys where verified. Do not migrate disabled constraints and assume they enforce uniqueness. Status enums, readiness checks, role permissions, and field rules are code-owned validations. Enabled key behavior must be verified with deliberately invalid inserts.

Exasol is central to both stored work and insight: ingest the synthetic backlog into staging, validate and normalize it, derive queue/owner metrics in SQL, and attach query evidence to the agent's explanation. Removing Exasol should break the real workflow rather than merely remove an optional chart.

## Proposed layout

```text
apps/
  web/
    app/               Next.js pages/layouts and Node Route Handlers
    components/        Basic React UI, ready for later redesign
    server/            Identity, command coordinator, bounded run execution
packages/
  contracts/           ToolSpec and API/action/event schemas
  domain/              Permissions, transitions, knowledge applicability
  db-exasol/           Driver adapter, scoped repositories, transactions
  analytics/           Named query registry and metric/result contracts
  agent/               Context assembly, bounded steps, provider adapter
  evaluation/          Synthetic fixtures and deterministic assertions
exasol/
  migrations/          Reviewed Exasol DDL; one migration history
  queries/             Reviewed analytical views/queries
  fixtures/            Synthetic-only import data and expected outputs
scripts/               Future setup/check/seed entry points
```

This layout is proposed; it is not present yet. Store no real credentials or employer data in it.

## Configuration contract

| Configuration | Visibility/purpose |
| --- | --- |
| `EXASOL_HOST`, `EXASOL_PORT`, `EXASOL_SCHEMA` | Backend connection target and code-validated schema. |
| `EXASOL_USER`, `EXASOL_PASSWORD` | Backend only; authorized Personal deployment credentials. |
| `EXASOL_CA_FILE` | Backend path to trusted deployment CA material. |
| `EXASOL_READ_POOL_SIZE`, `EXASOL_WRITE_CONCURRENCY` | Small evaluated read pool; write concurrency fixed to one initially. |
| `LOOM_AUTH_MODE` | Explicit local-demo or configured identity-provider mode. Demo mode disabled for production. |
| `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE` | Required when configured JWT identity is used. |
| `APP_ORIGIN` | Same-origin Next.js application and permitted mutation origin; no Vite-specific variables. |
| `UPLOAD_DIRECTORY` | Private local upload staging; outside public web assets. |
| `LLM_PROVIDER`, `LLM_MODEL`, provider credential | Backend only, selected through fixture evaluation. |
| Run/upload/query limits | Bounded result rows, deadlines, retries, and model spend. |

Create a redacted `.env.example` only when implementation resumes. Do not copy local credentials into documentation. Retire the earlier `DATABASE_URL_*`, `SUPABASE_*`, and embedding-specific variables from the selected baseline.

## Deployment and edition gates

- Prefer local Personal on the current Linux host using the documented Podman route. Record launcher, database, and driver versions and hardware actually tested.
- No cloud account is needed for the local path. AWS/Azure are alternatives, not pre-authorized infrastructure creation or free compute.
- Personal's individual/single-user terms must be distinguished from the future multi-user product. Use public/synthetic data and role personas for the event demonstration. Obtain applicable organizer/vendor clarification before an actual shared service; do not infer an exception from a shared SQL login.
- Text AI, UDFs, MCP, and advanced deployment features are optional future spikes. Local/cloud availability differs; the core workflow must work with ordinary SQL and the supported driver.
- If Node driver compatibility blocks M0, evaluate [PyExasol](https://github.com/exasol/pyexasol) behind a narrow adapter. Add Python only with a recorded reason; it is not the default.

## Primary references

- [Exact challenge rules](https://www.exasol.com/events/exathon-india-2026/), [Exasol Personal](https://docs.exasol.com/db/latest/get_started/exasol_personal.htm), [developer hub](https://www.exasol.com/developers/).
- [Launcher repository](https://github.com/exasol/exasol-personal), [TypeScript driver](https://github.com/exasol/exasol-driver-ts), [driver guide](https://github.com/exasol/exasol-driver-ts/blob/main/doc/user_guide/user_guide.md), [PyExasol](https://github.com/exasol/pyexasol).
- [Transactions](https://docs.exasol.com/db/latest/database_concepts/transaction_management.htm), [IMPORT](https://docs.exasol.com/db/latest/sql/import.htm), [MERGE](https://docs.exasol.com/db/latest/sql/merge.htm), [analytic functions](https://docs.exasol.com/db/latest/sql_references/functions/analyticfunctions.htm), [constraint differences](https://docs.exasol.com/db/latest/migration_guides/oracle/execution/constraints.htm).
