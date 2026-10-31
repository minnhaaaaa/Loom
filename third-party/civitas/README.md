# Civitas presentation primitives

Adapted from [minnhaaaaa/civitas](https://github.com/minnhaaaaa/civitas) at commit
`0c914bff3e29a544ea5e9fe53714ad44e55e9743`, distributed under Apache-2.0.
The upstream license is copied verbatim in [LICENSE](LICENSE).

The adapted code is in `apps/web/components/ui/civitas.tsx`:

- `Arrow` comes from `apps/web/src/LandingPage.tsx`.
- `LoomMark` uses the wordmark/seal markup from `apps/web/src/AuditView.tsx`.
- `MetricCard` uses that file's `audit-overview` label/value/detail hierarchy.
- `ConsoleChrome` uses the terminal chrome and three decorative lights from
  `apps/web/src/InstallTerminal.tsx`.

Modifications: extracted reusable stateless React primitives, changed Civitas/C
branding to Loom/L, prefixed CSS hooks with `civitas-`, parameterized content, and
made metric details and console status optional. Source application state,
network access, installation commands, and animation behavior are omitted.
Loom supplies its own styles and application behavior.

`apps/web/app/civitas.css` adapts the same source's forest/leaf/lime palette,
wordmark, terminal chrome, orbital motif, and overview strip for a working
application. `globals.css` maps the existing controls to that palette. Loom
self-hosts Archivo Black, Manrope, and IBM Plex Mono, the fonts used by Civitas;
their upstream Google Fonts OFL notices are retained in `third-party/fonts/`.
