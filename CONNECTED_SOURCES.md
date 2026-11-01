# Connected sources

Loom can automatically import requests from selected Slack, Microsoft Teams and Discord channels, plus searchable code and document passages from GitHub repositories and SharePoint document libraries. Staff keep posting and maintaining documents in their existing tools. A company owner connects each service and selects the sources once, in **Settings → Connected sources**.

The connectors are read-only. They never post messages, write repository changes, modify documents, or make AI calls. General channels use a local English-language detector. Clear analytics asks become requests, uncertain matches appear in a compact owner review list, and ordinary chatter is ignored. No model key or subscription is needed. Dedicated intake channels can still import every post.

## Guided connection flow

Open **Settings → Connected sources** and choose a service. A dark modal guides you through **Connect → Choose → Import**, with one setup step at a time, provider links, and an interactive example of a message becoming a request or a file becoming a cited passage. Illustrations are labeled and never inserted into your workspace. Existing token holders can skip the setup guide.

The **Connect** step verifies the account. **Choose source** loads the available repositories/channels/libraries. **Review import** shows the actual selected source, limits, and workspace-sharing checkbox before **Start automatic import** queues it. Microsoft opens a sign-in popup with a code; a fallback link works if popups are blocked. Closing the popup alone never marks the account connected. Each provider card also opens account management, including disconnecting and adding another source. Teams and SharePoint share one Microsoft connection.

## Local server

Use Node 22.13+ (Node 24 recommended). Apply migrations through `012_source_detection_documents` with `pnpm db:migrate`, build with `pnpm build`, and run `pnpm start:local`. The application starts the background sync loop automatically. There is no public webhook or separate worker to deploy. Sync continues while the local server is running, even when the browser is closed. Set `LOOM_SOURCE_SYNC=false` to disable the loop.

Configure `LOOM_PROVIDER_ENCRYPTION_KEY` with a stable 64-character hexadecimal secret. This existing key now also encrypts source credentials in Exasol. Do not replace an existing key or commit credentials. Credentials are bound to the company, connection owner, provider, and connection version. Source APIs return connection metadata only.

## Slack

1. Choose **Slack** in Connected sources. The popup links to [Slack app management](https://api.slack.com/apps).
2. Create an internal app, then add `channels:read` and `channels:history` under **User Token Scopes** in OAuth & Permissions.
3. Install the app into your workspace. Copy the **User OAuth Token** (`xoxp-`) into Loom and choose **Verify connection**. User tokens support public-channel thread replies; bot tokens remain accepted for existing installations but may lack thread access. Join the public channels you want to share. Do not paste tokens into chat or source files.
4. Choose **Choose source**, select a channel, then **Review import**. Choose **Detect analytics requests** or **Every post** for a dedicated intake channel, confirm sharing, and start the import.

Loom verifies the token and resolves channel names through Slack before accepting a selection. Private channels, DMs, Slack Connect/private-channel permission replication, bot posts, and system events are outside this version. Replies are attached to their root request rather than imported as duplicate requests. Slack user IDs are retained as the source author when a display name is unavailable.

Slack's OAuth redirects require HTTPS, so this loopback-only build uses an installed app token rather than an unusable HTTP OAuth button. A token with rotation enabled will need replacement when it expires. A hosted Slack OAuth installation and automatic Slack token rotation are pending.

Primary references: [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [channel history](https://docs.slack.dev/reference/methods/conversations.history/), [thread replies](https://docs.slack.dev/reference/methods/conversations.replies/).

## Microsoft Teams and SharePoint

1. In your company's Microsoft Entra tenant, register an application for this local Loom installation. This integration uses the organization's tenant, not a personal Microsoft account.
2. Enable **Allow public client flows** in the app's authentication settings. The device-code flow needs no callback URL or client secret.
3. Add these **delegated** Microsoft Graph permissions: `User.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, and `Sites.Read.All`. The flow also requests `offline_access` for renewal. Have the tenant administrator grant consent where required. Organizational conditional-access rules can restrict device sign-in.
4. Set the application's client ID and tenant ID in the local `.env` as `LOOM_MICROSOFT_CLIENT_ID` and `LOOM_MICROSOFT_TENANT_ID`. Restart Loom.
5. Choose **Microsoft Teams** or **SharePoint**, then **Sign in with Microsoft**. A popup opens; enter the code shown in Loom. Sign in using a company account with access to the intended sources. Loom shows the account as connected only after Microsoft issues and validates its token.
6. Choose **Choose source**. For Teams, select a team and a standard channel. For SharePoint, search for a site and select its document library. Confirm sharing and start the import.

Teams private/shared channels and direct chats are excluded. This version selects entire SharePoint document libraries; folder-level selection is pending. Use a library containing only material intended for this Loom workspace.

Primary references: [Microsoft device sign-in](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code), [Teams channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0), [SharePoint/drive changes](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0), [file downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0).

## GitHub

1. Choose **GitHub** in Connected sources. Follow the guide to [create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
2. Set the resource owner and **Only select repositories**. Grant repository **Contents**, **Issues**, and **Pull requests** permissions as **Read-only**; Metadata is included by GitHub. Your organization may require token approval or SSO authorization.
3. Paste the `github_pat_` token into Loom and choose **Verify connection**. Tokens are encrypted with the existing workspace/provider-bound credential storage. This local connector does not pretend to offer GitHub OAuth without a registered application.
4. Select a repository, review the scope and sharing, and start importing. Repeat to add another repository.

Loom imports the selected repository's **default-branch source code and documents**, plus **open/closed issues, pull requests, and their discussion comments** into Knowledge. They are reference context, not a new task backlog. Source paths, issue numbers, authors, and original GitHub links remain available. Code links pin a commit; code is never executed. The assistant can answer questions such as “Where is net revenue calculated?” or “What did the refunds issue decide?” using retrieved passages.

Each code scan pins one commit and processes 20 entries per page. After the complete tree scan, files no longer present retire their passages. Failed or incomplete trees never trigger removal. Up to 5,000 tree entries and 256 KB per file are supported. GitHub's truncated trees and oversized API responses produce explicit errors. Files are split into bounded passages using the existing document pipeline. UTF-8 source files, text, PDFs and DOCX are supported; binary assets, symlinks, submodules, generated/vendor directories and common credential filenames are excluded. A limited content check excludes recognizable private keys and some token patterns; it is not comprehensive secret detection. Select repositories appropriate to the Loom workspace audience. Per-file exclusions appear under **Import details**.

Issues/PRs are paginated, with up to the first 100 discussion comments per item; omitted comments are reported. Their body and discussion become reference passages. Git history, other branches, PR review comments/diffs, Discussions, wikis, releases and Actions artifacts are not imported. Code-file deletion is reconciled; deleted/transferred issues and external ACL changes are not. Token expiration/revocation requires replacement. Provider rate limits delay sync and use retry headers. A repository rename is resolved through its stable repository ID.

Primary references: [Git trees](https://docs.github.com/en/rest/git/trees#get-a-tree), [Git blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob), [repository issues and pull requests](https://docs.github.com/en/rest/issues/issues#list-repository-issues), [fine-grained token creation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## Discord

1. Choose **Discord** in Connected sources. Open the [Discord Developer Portal](https://discord.com/developers/applications) from the guide and create an application.
2. On its **Bot** page, enable **Message Content Intent**. If Discord requires approval for your app, obtain that before connecting.
3. Under **OAuth2 → URL Generator**, choose the `bot` scope and **View Channels** / **Read Message History** permissions (integer `66560`). Open the generated link and install the bot into your server. No posting permission or Administrator permission is required.
4. Copy the bot token into Loom and verify it. Personal-account tokens are rejected. Choose a server and a text/announcement channel, review sharing, and start importing.

The connector checks intent and the bot's computed permissions for the selected channel before reading history. It reads human messages in a rolling 30-day scan; bot/system/webhook messages are excluded. Each message retains its own source identity and permalink. Included reply context is accepted only from the same selected channel; a “thanks” reply does not duplicate the referenced request. Native separate threads, forums, DMs, voice, attachments and remote deletion reconciliation are not supported. The bot must retain access to every selected channel. Rate limits apply per bot and defer subsequent reads.

Primary references: [message history](https://docs.discord.com/developers/resources/message#get-channel-messages), [application intent flags](https://docs.discord.com/developers/resources/application), [computed channel permissions](https://docs.discord.com/developers/resources/channel#get-channel-member-permissions), [rate limits](https://docs.discord.com/developers/topics/rate-limits).

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

Tests use synthetic provider responses and an isolated Exasol schema. They exercise authorization, encrypted storage, pagination restrictions, deduplication, preserving manual edits, document deletion, paused-run rejection, device-code ownership, general-chat review/dismissal, real PDF extraction, late-page retrieval, passage updates and deletion. Browser checks exercise the setup UI. Live GitHub/Slack/Discord installation, Microsoft tenant consent, actual source retrieval, and provider rate-limit behavior require validation with the administrator's actual accounts. No real source account is connected by the implementation itself.
