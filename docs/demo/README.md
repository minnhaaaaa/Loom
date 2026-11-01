# Demo video and rehearsal

[Watch the Loom demo on Google Drive](https://drive.google.com/file/d/1jJq3Rv_Yzt0LJa1ZIM08QaH1zUglkMgX/view?usp=sharing).

Submission limit: **3 minutes maximum**. The recording is hosted externally; this repository contains the rehearsal script below.

Use synthetic requests and keep provider tokens, `.env`, passwords, and deployment secrets off-screen. Complete connector consent and token setup before recording; show the connected source briefly during the presentation.

## Connect Discord

1. Create a demo Discord server and a normal text channel, `analytics-requests`.
2. Open [Discord Developer Portal](https://discord.com/developers/applications), choose New Application, and name it Loom Demo.
3. On Bot, enable Message Content Intent. Save changes. Copy the bot token using Reset Token if needed; keep it private.
4. Under OAuth2 → URL Generator, select the `bot` scope and View Channels / Read Message History permissions. No Administrator or posting permission is required.
5. Open the generated URL, choose your demo server, and authorize it. Complete any authentication/CAPTCHA yourself.
6. In Loom, open Settings → Connected sources → Discord. Paste the token, verify, and select the server/channel.
7. For this dedicated intake channel choose Every post, confirm sharing, and start automatic import.
8. Post as a human account, use Sync now, and inspect Requests. A bot can appear offline because Loom reads through HTTP; no separate bot process or webhook tunnel is needed.

## Three-minute script

| Time      | Screen/action                                   | What to say                                                                                                                                                                     |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:25 | Discord message                                 | "I built a system to catch work before it falls through the cracks. Small analytics teams get requests in chat, but the context and ownership are often missing. This is Loom." |
| 0:25–0:55 | Connected channel → Sync now → imported request | "Loom brings the request into a shared workspace and keeps its original source attached."                                                                                       |
| 0:55–1:25 | Assistant identifies missing context            | "Before an analyst starts, we need exact dates, a dataset, and an agreed definition of sales."                                                                                  |
| 1:25–2:10 | Supply details → review proposal → approve      | "The assistant proposes the update. I review exactly what will change and approve it before anything is applied."                                                               |
| 2:10–2:30 | Assign member, due date, activity               | "Now the request has context, an owner, a deadline, and a history."                                                                                                             |
| 2:30–2:45 | Insights                                        | "Exasol calculates where requests wait, how work moves, and how open requests are distributed across owners."                                                                   |
| 2:45–3:00 | Knowledge, closing                              | "Approved definitions can be reused and cited. Loom turns 'Can someone look into this?' into work someone can actually start."                                                  |

Allow for provider/sync latency. Rehearse once. For a recorded demo, trim waiting time without implying that asynchronous steps are instantaneous.

## Copy-ready messages

Discord:

> Can the analytics team investigate why sales dropped last week? We need a breakdown by region and product before Monday's leadership meeting.

Assistant, first prompt:

> Review the sales-drop request. What information is missing before an analyst can start? Don't invent answers.

Assistant, clarification:

> Clarify the sales-drop request. Reporting period: October 19–25 versus October 12–18, 2026. Metric: net sales after discounts and refunds, excluding tax. Dataset: synthetic orders and refunds. Deliverable: a regional and product breakdown with a short explanation for leadership. Propose updating the request and moving it to Ready. Include the metric and deliverable in the business question if they have no dedicated fields. Do not apply changes until I approve.

Review the actual proposal, check the review box, and approve. Assign an existing workspace member and set an explicit deadline with timezone. Show the saved activity and source link.

Optional Knowledge entry: **Net sales definition** — "Net sales means sales after discounts and refunds, excluding tax. For this demo, use the synthetic orders and refunds dataset." Approve it as the owner, then ask: "What is our approved definition of net sales? Cite the saved guidance."

Do not claim Loom found the cause of a sales decline. It manages the request and coordination; the analyst performs the business analysis. Use the limited-history caveat when showing a new workspace's Insights.
