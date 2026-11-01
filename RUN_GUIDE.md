# Run guide

For first-time installation and `.env` configuration, follow [DEPLOYMENT.md](DEPLOYMENT.md).

## Start an existing installation

```sh
pnpm db:status
# If stopped:
pnpm db:start
pnpm check:local
pnpm dev
```

Open `http://127.0.0.1:3000/login`. Keep the terminal running. If using a production build, use `pnpm start:local` instead of `pnpm dev`; rebuild after code changes, with the app stopped.

## First workspace

1. Enable signup in `.env` and restart if necessary; open `/register`.
2. Create your owner account and company. Company setup should prefill the registered name.
3. Finish setup; AI and source connections are optional for manual request work.
4. Invite role personas if needed. A workspace link alone does not grant membership.
5. Create a request, or import `exasol/fixtures/request-backlog.csv` through Requests → CSV import/export. Review the preview before committing.

## Demonstrate the complete workflow

Follow the [demo script](docs/demo/README.md). Connect a dedicated Discord channel, import a synthetic ask, identify missing fields with the assistant, clarify them, review and approve a proposal, and show owner, deadline, source link, activity, Knowledge, and Insights.

Use an existing workspace member for assignment. New companies have no historical backlog; a recent request cannot establish a trend or a measured productivity gain.

## Stop and restart

- Stop Loom with **Ctrl+C** in its terminal.
- Restart it with `pnpm dev` or `pnpm start:local`.
- To stop the database after stopping Loom: `pnpm db:stop`.
- To resume: `pnpm db:start`, `pnpm check:local`, then start Loom.
- Changing `.env` requires restarting the application. Preserve the existing session/encryption secrets.

## Troubleshooting

| Symptom                              | Action                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration disabled                | Set `LOOM_ALLOW_WORKSPACE_SIGNUP=true`; restart. The server still enforces this setting when submitting.                                                                                    |
| Account already exists               | Sign in; do not repeatedly create the same account.                                                                                                                                         |
| Workspace unavailable or save stalls | Run `pnpm check:local` and `pnpm db:status`. If the service is running but queries stall, stop Loom, cleanly restart Exasol with `db:stop`/`db:start`, verify readiness, then restart Loom. |
| Disabled Finish setup                | Check company name and color fields in the wizard; stale settings must be refreshed.                                                                                                        |
| Port already in use                  | Stop the previous Loom process. Keep port 3000 and `APP_ORIGIN` consistent, especially for ChatGPT callbacks.                                                                               |
| Old assets after a restart           | Hard-refresh the browser. Never run build and development concurrently.                                                                                                                     |
| Discord channel absent               | Confirm bot membership, Message Content Intent, View Channels, and Read Message History for the selected channel. Use text channels, not forums/threads/DMs.                                |
| Discord connected but no requests    | Select a source and start import; connection alone is insufficient. Use human posts, Sync now, and inspect source errors/review items.                                                      |
| AI unavailable                       | Confirm provider/model selection and account eligibility. Inspect the displayed error; do not assume an API key is required for ChatGPT plan usage.                                         |
| Proposal expired or stale            | Ask for a fresh proposal against current request versions. Never bypass the review/version checks.                                                                                          |

A database timeout can leave the outcome of a commit uncertain. Check the current record or try signing in before repeating an account creation. Do not reset the schema as a troubleshooting shortcut.

## Verification commands

```sh
pnpm typecheck
pnpm lint
pnpm test
```

The following are optional integration checks, not normal startup steps:

```sh
# Real Exasol; synthetic test workspaces. Stop normal application writers first.
pnpm test:db
# Build first, with development stopped; browser prerequisites are in RUNBOOK.md.
pnpm build
pnpm test:e2e
pnpm test:e2e:connected
```

Tests involving external providers require explicit opt-ins and can consume usage. Browser suites can leave synthetic accounts/records. Use a dedicated test schema for evaluation, and read the relevant test configuration before running it. Historical dated test results are recorded in [RUNBOOK.md](RUNBOOK.md); they are not a claim that every suite was rerun for this submission.
