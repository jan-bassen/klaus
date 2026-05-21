## Todo (no state to migrate)

### Review fixes

- Resolve quoted media before command dispatch.
  - `handleTurn()` currently executes `/commands` before `resolveQuotedMedia()`.
  - This makes `/image <prompt>` ignore quoted image media, so edits/restyles generate from prompt only.

- Avoid duplicate simulation actions for `image_generate`.
  - The framework records custom `simulate` handler results.
  - `image_generate.simulate` also pushes its own overlay action, so reports can show one call twice.

- Bring README command examples back in sync with the codebase.
  - Actual commands include `/schedules` and `/image`.

### Cleanup notes

- Make report emitted logs cleaner, probably just log the report filename/name by default.
  - Current shape is noisy:
    `INF [reports] emitted runId=... agent=assistant jsonPath=/app/data/logs/... vaultPath=/app/vault/Klaus/reports/...`

- Rename or clarify watcher template log wording.
  - `template invalidated: report` sounds like a problem even when it just means the cache was refreshed.
