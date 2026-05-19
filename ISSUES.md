P2: Invalid synced settings.yml logs a warning and continues with bundled defaults.

src/index.ts (line 234) falls back silently-ish. For a test deploy this is risky: wrong provider, timezone, sync tuning, vault permissions, or allowlist could be used while logs say only a warning. Given the docs say runtime settings are strict/user-owned, I’d fail startup here unless there’s an explicit recovery mode.


P2: If the model answers with normal assistant content instead of calling reply, Klaus drops it.

The loop stops when there are no tool calls at src/pipeline/core.ts (line 481), and replyContent is derived only from reply tool calls at src/pipeline/core.ts (line 326). The prompt tells models not to use direct output, but deploy reality says one eventually will. I’d either force toolChoice: required for reply-capable turns, or treat plain assistant content as a fallback reply/reportable error.


P2: npm audit reports a moderate ws vulnerability via Baileys.

baileys@7.0.0-rc.9 pulls ws@8.19.0 in package-lock.json (line 3484). Audit says ws has GHSA-58qx-3vcg-4xpx and npm audit fix is available. Worth doing before a public-ish test deploy.


P3: .env.example links to a stale docs path.

.env.example (line 18) says docs/setup-guide.md, but the actual file is docs/setup.md.
