# Klaus — Agent Guidelines

## Stack

Bun, TypeScript (strict), Postgres (Drizzle ORM, pgvector, pgboss), Baileys, Vercel AI SDK. All containerized via Docker Compose.

## Principles

- **Typesafe end-to-end.** No `any`. Shared types in `types.ts`. Drizzle schema is the source of truth for DB types.
- **Write tests while developing** Relevant tests should be written alongside the code, so we can test while developing.
- **Lean and minimal.** Small surface area, few dependencies, no abstractions until the second use case demands one.
- **Configuration is code.** Settings, flags, tool definitions, agent prompts — all in the repo, all version-controlled.
- **No unnecessary comments.** Code should be self-explanatory. Comments exist only to explain *why*, never *what*.
- **Extend by adding, not modifying.** New agent = new `.md` file. New tool = new file implementing `ToolDefinition`. New context query = new file implementing `ContextQuery`.
- **Don't overcomplicate deps** Just use `bun add` or `bun update`, you don't have to check the versions manually.

## Code Style

- Prefer `const` and pure functions. Minimize mutable state.
- No 'any' or unresolved 'unknown' types.
- Explicit return types on exported functions.
- No barrel files. Import from the specific module.
- Errors are values — return them, don't throw, except at true boundaries (unrecoverable).

## Dependencies

- Keep the dependency list short. Justify every addition.
- Prefer Postgres-native solutions (pgvector, pgboss, tsvector) over adding new infrastructure.

## Testing (`bun:test`)

- Tests mirror source tree under `src/__tests__/`.
- DB tests run against real Postgres (Docker) — no mocking the database.
- LLM calls are mocked at the `model-router` boundary in integration tests.
- Agent evals (`*.eval.ts`) test non-deterministic behavior — not CI-blocking, tracked over time.
- No coverage targets. Optimize for confidence in the critical paths: pipeline, middleware, DB read/write, tool execution.

## Project Structure

See `README.md` for project overview and folder structure. Key boundaries:

- `/whatsapp` — pure transport, no business logic
- `/core` — pipeline, agent engine, queue, middleware
- `/db` — schema, search, write path, migrations
- `/tools` — each tool/tool-set in its own file or folder
- `/context` — one file per context query
- `/agents` — markdown prompt files with YAML frontmatter
- `/skills` — static `.md` reference documents loaded on demand via `skill_get`
