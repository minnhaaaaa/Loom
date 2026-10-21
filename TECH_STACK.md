# Loom technical stack

Status: proposed implementation baseline. Reviewed: 2026-10-21. No dependencies are installed by this document.

The stack serves one web application, one API, and a background worker built from a shared TypeScript codebase. PostgreSQL is the authoritative store. The first delivery should prove one request workflow before adding distributed infrastructure.

See [README.md](README.md) for product scope, [PLAN.md](PLAN.md) for build order, and [ARCHITECTURE.md](ARCHITECTURE.md) for data and authorization contracts.

## Selected baseline

| Area | Selection | Purpose and reason |
| --- | --- | --- |
| Language and runtime | TypeScript, a supported Node.js LTS release, pnpm workspaces | Share types and validation across web, API, and worker. Pin exact compatible versions during setup. |
| Frontend | React and Vite; React Router in library mode | An authenticated workspace application with a separately deployable API; server-side rendering is not required for the MVP. |
| UI primitives | Tailwind CSS and accessible Radix-based shadcn/ui components | Consistent forms, dialogs, menus, and review controls. Accessibility still needs application-level verification. |
| Tables and server state | TanStack Table and TanStack Query | Filtering, row selection, pagination, cached queries, and refetch after authorized change notifications. |
| Forms | React Hook Form and shared Zod schemas | Required fields and consistent validation messages. Server validation remains authoritative. |
| Generated tool specification | Loom-owned, versioned `ToolSpec` validated with Zod | A small allowlisted component and action catalog, with no executable expressions. |
| API | Fastify on Node.js | Typed HTTP endpoints, validation hooks, structured logging, and shared domain modules. |
| Database | PostgreSQL hosted through Supabase | Transactions, constraints, JSONB extension fields, full-text search, and row-level security in one store. |
| Database access | Drizzle ORM with `pg`; reviewed SQL migrations | Typed queries, explicit transactions, and custom SQL for RLS, compare-and-swap updates, and search. |
| Authentication | Supabase Auth; server-side JWT verification using `jose` and the project's signing-key configuration | Avoid building an identity service. Database membership is checked independently of token validity. |
| Authorization | Workspace membership and operation policies, plus PostgreSQL RLS | Enforce requester-owned records and internal team access. Agents use the initiating user's scope. |
| Live collaboration | Supabase Realtime private workspace channels; authorized invalidation events and presence | Notify clients to refetch records through the API. Presence is ephemeral and never grants authority. |
| File storage | Supabase Storage, private buckets | Store bounded CSV and plain-text/Markdown source uploads. Download URLs are short lived and permission checked. |
| Model integration | Vercel AI SDK behind a Loom provider adapter | Provider-neutral model calls, validated structured output, and bounded tool use. No provider SDK in the browser. |
| Agent control flow | Explicit persisted TypeScript state machine | Short, inspectable runs that generate proposals; no framework is necessary for the initial sequence. |
| Background jobs | pg-boss in a separate PostgreSQL schema | Durable import, indexing, and agent jobs with retries without adding Redis. Domain writes still require idempotency. |
| Retrieval | SQL filters and PostgreSQL full-text search first; pgvector when the retrieval gate justifies it | Exact record and policy lookup comes first. Semantic retrieval is an evaluated extension, not a prerequisite. |
| Application tests | Vitest; API integration tests against real local PostgreSQL | Verify parsing, policy, state transitions, isolation, and concurrency rather than only mocks. |
| Browser tests | Playwright | Verify the intake, review, conflict, and two-user collaboration flows. |
| Agent evaluation | Versioned JSON fixtures and Promptfoo | Compare models/prompts on grounded recommendations and adversarial cases. Database assertions decide action correctness. |
| Observability | Pino logs, persisted run metrics; OpenTelemetry instrumentation as deployment grows | Correlate requests, jobs, proposals, and commits without logging full private source contents by default. |
| Delivery | Static web assets, Node API/worker containers, managed Supabase; GitHub Actions | Few runtime roles from one codebase. Hosting provider remains an implementation choice. |

These are engineering selections for Loom, not conclusions proven by the cited papers. Compatibility and deployment credentials must be verified at implementation time.

## Why these choices

### One language and a modular backend

The initial workflow does not require a Python service, graph database, orchestration cluster, or multi-agent framework. Keep tool definitions, requests, knowledge, proposals, and audit modules separate inside one backend. The worker imports the same application services; it does not implement another version of permissions or actions.

Fastify and Vite keep the client and long-lived worker independent. Use ordinary same-origin routing in production (`/api` to the API) and a development proxy locally. The browser uses an Auth-issued bearer token for API calls; never put tokens in URLs or logs. JWT refresh is handled by the auth client. Validate issuer, audience, expiry, algorithm, and signing key on the API. Use a strict origin policy and CSP; sanitize rendered user content.

### A Loom specification before a general UI protocol

Use stable component IDs and field keys. Labels can change without changing record identity. `ToolSpec` includes field definitions, fixed view descriptions, allowed workflow transitions, and references to server-owned action IDs.

[json-render](https://github.com/vercel-labs/json-render) and [A2UI](https://github.com/a2ui-project/a2ui) demonstrate catalog-based declarative UI patterns. Evaluate json-render as a renderer adapter in a short spike. Keep the stored Loom specification independent of either project's wire format. If an adapter cannot enforce bindings, authorization, and revision compatibility cleanly, implement the small fixed renderer directly. A2UI interoperability is deferred.

Provider-enforced structured output does not establish that fields, actions, or access decisions are semantically valid. Validate references and capabilities on the server before rendering or saving a draft.

### PostgreSQL as the business authority

Supabase supplies managed PostgreSQL, Auth, Storage, and Realtime; it does not replace application action authorization. RLS is a second boundary, not a substitute for validating allowed fields or workflow transitions.

The product roles are **owner**, **operator**, **requester**, and **viewer**. Owners manage the desk and publish knowledge; operators triage and review record changes; requesters submit and read their own work; viewers have authorized internal read-only access. The full operation matrix is in `ARCHITECTURE.md`.

The API and worker use a non-owner, non-`BYPASSRLS` `loom_app` database role. A transaction-local verified actor context is set by trusted backend code. Tables use policies based on that actor and current database membership. Migrations run under a separate administrative identity. The queue uses its own `loom_queue` connection and schema; browser identities have no queue access. A separate `loom_delivery` role can execute narrow outbox claim/acknowledgment and recipient-resolution functions, without generic domain-table reads. No tenant-provided SQL is accepted.

Browser domain writes go through the API. Do not expose generic insert/update grants on domain tables to Supabase's browser roles. Private Realtime authorization is backed by membership policies on `realtime.messages`; it sends identifiers and revisions, not sensitive record payloads. The API refetch applies current permissions again.

See the [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization), and [PostgreSQL row security documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

### Durable jobs without an orchestration service

[pg-boss](https://github.com/timgit/pg-boss) supports PostgreSQL-backed work and transactional enqueue patterns. Use an application outbox written in the same transaction as a domain change, then idempotently enqueue delivery work. This avoids assuming that separately committed API writes and queue writes are atomic.

Model calls and file parsing happen outside database transactions. Persist their inputs and outcomes; hold row locks only during short state changes. Retries can repeat model calls and incur costs, so checkpoint completed steps and use bounded retries. A queue's delivery semantics do not guarantee exactly-once external effects.

### Retrieval before graph infrastructure

Start with active approved rules, glossary entries, exact record references, and full-text search restricted by workspace and visibility. Add pgvector only after a frozen retrieval set shows a meaningful gain. Keep embeddings rebuildable from canonical sources, with provider, dimensions, model version, and source revision recorded.

[Graphiti](https://github.com/getzep/graphiti), [Mem0](https://github.com/mem0ai/mem0), and [Letta](https://github.com/letta-ai/letta-code) are references for memory design. Do not adopt all three or assume their benchmark results apply to Loom. A graph backend is reconsidered only when relational links and hybrid search fail a real relationship or historical-query evaluation.

## Alternatives and decision triggers

| Alternative | MVP decision | Reconsider when |
| --- | --- | --- |
| Next.js full-stack application | Not selected; the API and worker already require explicit backend lifecycles. | Server rendering or a team preference materially simplifies delivery. |
| FastAPI/Python agent service | Deferred to avoid a second runtime and duplicated contracts. | A validated capability depends on a Python-only library. |
| LangGraph.js | Reference for checkpoints and interrupts; no runtime dependency initially. | The agent requires branching, durable subflows, or repeated human pauses beyond the bounded sequence. |
| Temporal | Reference for durable execution; deferred. | Long-running cross-system processes need stronger orchestration and compensation. |
| Yjs / Automerge | Deferred. | Character-level simultaneous editing or offline document collaboration becomes a validated need. |
| OpenFGA | Reference for relationship authorization; deferred. | Cross-workspace sharing and nested resource relationships outgrow membership policies. |
| Neo4j / Graphiti service | Deferred. | Multi-hop and temporal retrieval failures justify the operational cost. |
| Redis / BullMQ | Deferred; pg-boss uses the existing database. | Queue load and isolation requirements exceed the measured PostgreSQL budget. |
| Forking an internal-tool platform | Not selected. Study Appsmith, ToolJet, and Budibase patterns. | A deliberate product and licensing evaluation favors extending an existing platform. |

## Proposed repository layout

This is a future structure, not a description of files already present.

```text
apps/
  web/                 React workspace and fixed component registry
  api/                 Fastify routes, authentication, application services
  worker/              pg-boss handlers using shared services
packages/
  contracts/           ToolSpec, API inputs, proposal and event schemas
  domain/              permissions, request transitions, knowledge rules
  db/                  Drizzle schema, repositories, transaction context
  agent/               context assembly, provider adapter, bounded run steps
  ui/                  accessible application components
  evaluation/          fixtures, deterministic assertions, model comparisons
supabase/
  migrations/          reviewed SQL, RLS, indexes, and storage/channel policies
  seed.sql             synthetic fixtures only
tests/
  integration/         database, permissions, retries, concurrency
  e2e/                 two-user browser journeys
```

Drizzle schema definitions and SQL migrations must describe the same state. Generate candidate migrations with Drizzle tooling, review/add RLS and custom SQL, and use one committed migration history under `supabase/migrations`. Do not run two competing migration systems against a deployed database.

## Configuration contract

| Configuration | Visibility | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Public | API origin or same-origin base path. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | Public | Auth and private-channel connection; policies enforce access. |
| `DATABASE_URL_APP` | API/worker only | Non-owner application database role. |
| `DATABASE_URL_QUEUE` | Backend only | Queue-schema connection; no browser access. |
| `DATABASE_URL_DELIVERY` | Dispatcher only | Narrow outbox claim/acknowledgment and authorized recipient-resolution functions. |
| `DATABASE_URL_MIGRATIONS` | Migration job only | Administrative schema changes; never used by the app. |
| `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUDIENCE` | Backend | Explicit token verification configuration. |
| `SUPABASE_SERVICE_ROLE_KEY` | Restricted backend publisher only, if required | Storage/broadcast service operations; never general domain reads or model context. Prefer narrower server capabilities where available. |
| `LLM_PROVIDER`, `LLM_MODEL`, provider API credential | Backend | One configured provider for the first pilot. Model choice follows fixture evaluation. |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | Indexing/retrieval only | Required only if the semantic-retrieval gate is passed. |
| `APP_ORIGIN`, run budgets, upload limits | Backend | Explicit origin and resource boundaries. |

Names are proposed. Create a redacted `.env.example` during implementation. Never inspect, copy, or commit local credentials to populate it.

## Dependency and release discipline

1. Pick supported stable releases and verify their Node compatibility; repository default branches can contain future or preview APIs.
2. Commit a lockfile, runtime version file, and container digest policy. Do not write unverified version numbers into this document.
3. Confirm the license of the exact package or code copied. A public repository, its hosted product, and enterprise extensions can have different licenses and capabilities.
4. Run the thin vertical slice before expanding dependencies. Document an adopted adapter or changed stack decision here and in architecture decisions.
5. Use separate development and pilot environments. Confirm migrations, RLS, queue reconnects, Auth signing configuration, and private channel behavior in the pilot environment.

## Primary implementation references

- [React](https://react.dev/), [Vite](https://vite.dev/guide/), [Fastify](https://fastify.dev/docs/latest/), [Zod](https://zod.dev/), [Drizzle](https://orm.drizzle.team/docs/overview).
- [Supabase Auth JWTs](https://supabase.com/docs/guides/auth/jwts), [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization), [private Storage](https://supabase.com/docs/guides/storage/security/access-control).
- [AI SDK](https://ai-sdk.dev/docs/introduction), [pg-boss](https://github.com/timgit/pg-boss), [pgvector](https://github.com/pgvector/pgvector).
- [TanStack Table](https://tanstack.com/table/latest), [TanStack Query](https://tanstack.com/query/latest), [Playwright](https://playwright.dev/docs/intro), [Vitest](https://vitest.dev/guide/), [Promptfoo](https://github.com/promptfoo/promptfoo).

The architecture source register records the research and repository comparisons behind these selections.
