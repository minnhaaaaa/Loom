# Connected sources

Loom can automatically import requests from selected Slack and Microsoft Teams channels, and searchable document passages from selected SharePoint document libraries. Staff keep posting and maintaining documents in their existing tools. A company owner connects each service and selects the sources once, in **Settings → Connected sources**.

The connectors are read-only. They do not send Slack/Teams messages, modify SharePoint files, or make AI calls. General channels use a local English-language detector. Clear analytics asks become requests, uncertain matches appear in a compact owner review list, and ordinary chatter is ignored. No model key or subscription is needed. Dedicated intake channels can still import every post.

## Local server

Use Node 22.13+ (Node 24 recommended). Apply migrations through `012_source_detection_documents` with `pnpm db:migrate`, build with `pnpm build`, and run `pnpm start:local`. The application starts the background sync loop automatically. There is no public webhook or separate worker to deploy. Sync continues while the local server is running, even when the browser is closed. Set `LOOM_SOURCE_SYNC=false` to disable the loop.

Configure `LOOM_PROVIDER_ENCRYPTION_KEY` with a stable 64-character hexadecimal secret. This existing key now also encrypts source credentials in Exasol. Do not replace an existing key or commit credentials. Credentials are bound to the company, connection owner, provider, and connection version. Source APIs return connection metadata only.

## Slack

1. Create an internal Slack app at [Slack app management](https://api.slack.com/apps).
2. Give the app read permissions `channels:read` and `channels:history`, install it in the workspace, and invite it to a public channel intended to be shared with this Loom workspace.
3. Copy the installed app's OAuth token into **Settings → Connected sources → Slack app token**. Loom supports `xoxb-` and `xoxp-` tokens. The token must be allowed to read thread replies; if the app's bot token cannot do that in your Slack installation, use an explicitly authorized user OAuth token with the same read permissions. Do not paste tokens into chat or source files.
4. Choose **Load channels**, select a channel and **Detect analytics requests** (or **Every post** for a dedicated intake channel), authorize sharing with this Loom workspace, and choose **Start automatic import**.

Loom verifies the token and resolves channel names through Slack before accepting a selection. Private channels, DMs, Slack Connect/private-channel permission replication, bot posts, and system events are outside this version. Replies are attached to their root request rather than imported as duplicate requests. Slack user IDs are retained as the source author when a display name is unavailable.

Slack's OAuth redirects require HTTPS, so this loopback-only build uses an installed app token rather than an unusable HTTP OAuth button. A token with rotation enabled will need replacement when it expires. A hosted Slack OAuth installation and automatic Slack token rotation are pending.

Primary references: [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [channel history](https://docs.slack.dev/reference/methods/conversations.history/), [thread replies](https://docs.slack.dev/reference/methods/conversations.replies/).

## Microsoft Teams and SharePoint

1. In your company's Microsoft Entra tenant, register an application for this local Loom installation. This integration uses the organization's tenant, not a personal Microsoft account.
2. Enable **Allow public client flows** in the app's authentication settings. The device-code flow needs no callback URL or client secret.
3. Add these **delegated** Microsoft Graph permissions: `User.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, and `Sites.Read.All`. The flow also requests `offline_access` for renewal. Have the tenant administrator grant consent where required. Organizational conditional-access rules can restrict device sign-in.
4. Set the application's client ID and tenant ID in the local `.env` as `LOOM_MICROSOFT_CLIENT_ID` and `LOOM_MICROSOFT_TENANT_ID`. Restart Loom.
5. Choose **Connect Microsoft**, open Microsoft's sign-in page, and enter the code shown in Loom. Sign in using a company account with access to the intended sources. Loom shows the account as connected only after Microsoft issues and validates its token.
6. For Teams, choose **Load teams**, select a team and a standard channel. For SharePoint, search for a site and select its document library. Confirm sharing and start the import.

Teams private/shared channels and direct chats are excluded. This version selects entire SharePoint document libraries; folder-level selection is pending. Use a library containing only material intended for this Loom workspace.

Primary references: [Microsoft device sign-in](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code), [Teams channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0), [SharePoint/drive changes](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0), [file downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).

## What is imported

- **Slack:** human root posts and up to 100 replies per thread in a rolling 30-day history scan. A thread becomes one request with its original link. Older threads and edits outside the scanned window are not covered. Remote message deletion is not reconciled from an absence in history.
- **Teams:** human channel posts with the replies returned by Graph's expanded response. Additional replies are explicitly marked as omitted. History is paginated; copied source changes update existing requests. A deleted source post does not delete its Loom work history.
- **SharePoint:** PDF, text, Markdown, HTML, and Word `.docx` files up to 5 MB. Text is extracted without executing embedded code or following document links. Files become passages of at most 3,600 characters, retaining document identity and original links. PDF passages also retain page numbers and page links. Text-based PDF files are supported; spreadsheets, slides, images/OCR, and other formats remain unsupported. Individual file deletion/change-to-an-unsupported-format retires every corresponding passage. Folder moves/deletions and source ACL changes are not a complete permission-mirroring implementation.

Documents become `reference` knowledge when their source library is authorized; owners do not have to approve every file. This is approval to make the source available, not a claim that every sentence is verified company policy. The assistant is instructed to distinguish imported references from reviewed procedures. The knowledge graph records who imported a reference, rather than attributing its authorship to that Loom user.

Imported request titles and descriptions update only while they still match the previous imported values. Human edits, assigned owners, statuses, priorities, due dates, and custom fields remain under Loom's normal workflow. Original Slack/Teams users are not silently mapped to Loom accounts. Imported request workflow measurements begin at import time; no historical stage durations are fabricated.

## Detection and review

New chat sources default to **Detect analytics requests**. Existing sources keep their previous **Every post** setting until an owner changes the source's import dropdown. Changing mode restarts the scan without deleting existing requests. Pausing and resuming preserves the selected mode.

The detector examines human messages and fetched replies. Explicit analytics asks such as “Can you analyze conversion by region?” enter the queue automatically. Questions like “Why did revenue drop?” and asks relying on prior thread context wait under **Review possible requests**. An owner can **Import request** or **Dismiss**. Unchanged threads retain the decision; edited threads are reevaluated. Existing imported work is never silently deleted by a later detection result. Reviews are workspace/owner scoped, recheck the content hash and connection, and cannot import a stale candidate. One thread maps to at most one request, including requests made in replies.

This is a conservative rule-based English detector, not an LLM or a measured multilingual classifier. It can miss indirect requests and misread context. Quotes/code are excluded from detection, and completion/cancellation signals route an otherwise matching thread to review. Fetched-thread and history limits still apply. No cross-thread semantic deduplication is claimed.

## PDF processing

PDF text is extracted locally with Mozilla PDF.js in a disposable Node process with a 15-second timeout and 192 MB JavaScript heap limit. No provider credentials, URLs, or shell commands are passed to the parser. It does not execute PDF JavaScript or perform OCR. Maximum input is 5 MB; extraction stops at 100 pages or 300,000 characters, and document ingestion stops at 100 passages. Limit hits are recorded rather than presented as complete imports. A heap limit does not bound all native memory.

**Import details** reports unsupported, encrypted, corrupt, image-only and partially readable files. Empty pages can be blank or scanned; the UI says they may need OCR. An unreadable updated document retires the previously imported passages so stale text is not presented as current. Transient download failures retry the page; extraction failures are recorded for that file. After fixing a file, its next SharePoint change imports it again. To rescan an unchanged library after fixing the local parser, pause and resume that source.

Document identity is stable across retries. Each passage has a stable position-based identity and source page metadata. Reimports update matching positions, retire obsolete passages, and preserve human retirements. Edits that move content between positions create new versions rather than pretending the old citation is unchanged. Updating the application alone does not reset existing SharePoint delta cursors; pause/resume a previously connected library to backfill older PDFs and full document passages.

## Inspiration and attribution

This design takes inspiration from the public [Supermemory repository](https://github.com/supermemoryai/supermemory), inspected at commit `d53d124e4769e34c4be8bcc5d21eed1855b090ef`: [stable document IDs and processing states](https://github.com/supermemoryai/supermemory/blob/d53d124e4769e34c4be8bcc5d21eed1855b090ef/apps/docs/snippets/api-v5-document-ingestion.mdx), [batch ingestion with per-document results](https://github.com/supermemoryai/supermemory/blob/d53d124e4769e34c4be8bcc5d21eed1855b090ef/apps/docs/ingestion/batch-ingest-historical-data.mdx), and [deduplicated retrieval context](https://github.com/supermemoryai/supermemory/blob/d53d124e4769e34c4be8bcc5d21eed1855b090ef/packages/tools/src/shared/memory-client.ts). These are architectural ideas, not copied implementation code. Loom uses its own Exasol-backed pipeline; it does not call Supermemory, send it documents, or claim to reproduce its semantic memory engine.

PDF parser reference: [Mozilla PDF.js](https://mozilla.github.io/pdf.js/getting_started/). The pinned `pdfjs-dist` dependency retains its upstream license.

## Sync and access boundaries

Exasol stores connection metadata, encrypted credentials, selected sources, pagination/delta checkpoints, item identities, content hashes, and imported records. Updates are deduplicated by company, source, and external item ID. A checkpoint advances after its page is saved. If a page is retried, previously saved items are reused. Sync leases and source/connection versions prevent overlapping or revoked runs from committing stale output. The current deployment is a single local application server.

The scheduler checks due sources every 15 seconds. Completed scans normally wait five minutes; additional history pages wait at least 65 seconds. Large backfills take multiple cycles, and provider rate limits can delay them. Exasol source status records the actual last completed page and errors; a successful page does not imply that every historical message has already been imported. Reconnecting pauses existing selections so a new external account is not silently substituted.

Selection explicitly shares copied content with the Loom workspace: requests with owners/operators/viewers and knowledge with owners/operators. External ACLs are not mirrored per user. Requesters do not automatically gain access to someone else's imported requests. Choose only sources the intended workspace audience may read. Pause/disconnect stops future imports and removes active credentials on disconnect; previously authorized copies remain. Disconnecting locally does not uninstall the external app or revoke consent at the provider.

The assistant filters imported references by the query before ranking up to 500 matching passages; overly broad queries ask for narrower terms. Reviewed guidance remains eligible regardless of query. A separate metadata digest covers up to 10,000 approved entries, including passages not retrieved, so source changes still invalidate pending proposals. Citation content and versions are checked separately. Knowledge-tab search and the graph remain bounded projections. Retrieval is lexical, not semantic/vector search.

## Verification boundary

Tests use synthetic provider responses and an isolated Exasol schema. They exercise authorization, encrypted storage, pagination restrictions, deduplication, preserving manual edits, document deletion, paused-run rejection, device-code ownership, general-chat review/dismissal, real PDF extraction, late-page retrieval, passage updates and deletion. Browser checks exercise the setup UI. Live Slack installation, Microsoft tenant consent, real file retrieval, and provider rate-limit behavior require validation with the administrator's actual accounts. No real source account is connected by the implementation itself.
