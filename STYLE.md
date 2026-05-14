# Klaus codebase style reference

Working doc for the code-consistency pass on `src/`. Distills the de-facto
conventions used today so this review can normalise the outliers. Anything
worth keeping long-term gets folded into `CLAUDE.md`; the rest stays here.

Reference is descriptive, not aspirational — it captures patterns that
*already dominate* the codebase, not what we wish were there.

---

## 1. Tooling & formatting

- **Formatter:** Biome, tabs, double quotes (`biome.json`). Run `npx biome check --write .` to normalise.
- **Imports:** organised by Biome (`organizeImports: on`). Use explicit `.ts` extensions, relative paths. No barrels.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`.
- **`exactOptionalPropertyTypes` consequence:** never assign `undefined` to an optional field. The codebase universally uses conditional spreads:
  ```ts
  // ✅ standard pattern
  ...(value ? { key: value } : {})
  ...(arr.length > 0 ? { arr } : {})
  ```

## 2. File layout

Sections are separated by box-drawing rules; the `─` form is the canonical one:

```ts
// ── Public types ───────────────────────────────────────────────────────────
// ── Public API ─────────────────────────────────────────────────────────────
// ── <subsystem> (private) ──────────────────────────────────────────────────
```

A file's top is usually:

1. Imports (Biome-sorted).
2. A `/** … */` file-level doc comment when the module isn't self-explanatory from one read.
3. Public types/interfaces.
4. Public functions.
5. Private helpers.

Module-level singletons follow a *lazy init + delegate* pattern:

```ts
let _store: FooStore | null = null;
export function initFooStore(env: Env): void { _store = create(env); }
function store(): FooStore {
  if (!_store) throw new Error("[foo] store not initialized");
  return _store;
}
export function fooOp(): Promise<X> { return store().fooOp(); }
```

## 3. Naming

| Element | Convention |
|---|---|
| Functions / vars | `camelCase` |
| Types / interfaces / classes | `PascalCase` |
| Files | `kebab-or-lower.ts` (one concept per file) |
| Constants (true constants) | `UPPER_SNAKE` (e.g. `REPLY_TOOL_NAME`, `MODULE_DIR`) |
| Tuneable values | Live in `settings.*` — **never** inline magic numbers |
| Log prefixes | `[module-name]` (lowercase, dashes ok). E.g. `[startup]`, `[agent]`, `[conversation]`, `[reply]` |
| Dedup keys | `<runId>:<kind>[:suffix]` (see `outbound.ts`'s `makeDedupKey`) |

## 4. Error handling

Two coexisting conventions for "expected failure" — **needs normalisation**:

1. **Discriminated result:** `Promise<{ ok: true; ... } | { ok: false; error: ... }>` — used in `infra/config.ts` and `infra/vault/sync.ts`. Preferred for richer errors.
2. **`T | Error`:** used in `pipeline/media.ts`, `primitives/tools/image.ts`, `infra/whatsapp/send.ts`. Lighter weight; callers check `instanceof Error`.

Rule of thumb in this pass: leave each call-site as-is unless a file mixes both, in which case prefer **result** for richer kinds and **`T | Error`** for "did it work, yes/no + a message."

`throw` only at true boundaries:
- bootstrap / init failures (`infra/config.ts`, `infra/store/*` `store()` accessors)
- unrecoverable internal contract violations (`@${name}: persist tool was not called`)
- model-loop reraise of `AbortError`

## 5. Type-system cheats

- **No `any`.** Verified — zero occurrences.
- **`as` reserved for:**
  - SDK type re-aliases (`ChatMessages as ChatMessage`) — keep for now, it's load-bearing across files.
  - Zod ↔ JSON-Schema bridge (`toJSONSchema(schema as never) as Record<string, unknown>`) — required by the v3/v4 boundary; comment in place.
  - Narrowing parsed JSON of *unknown* shape into `Record<string, unknown>`.
- Any other `as` is suspect → flag in the review.

## 6. Comments

CLAUDE.md says: *comments explain why, never what.* This is mostly honoured but
not uniformly. Concrete rules:

- ✅ JSDoc on **exported** types/functions explaining *purpose & contract*.
- ✅ Inline `// reason` for a non-obvious choice or workaround.
- ❌ Inline comments that restate the code (`// Iterate messages`, `// Set the externalId`).
- ❌ Multi-line decorative blocks just for visual padding.

Section separators (`// ── … ──`) are fine and used widely.

## 7. Logging

`log.info / log.warn / log.error / log.debug` from `infra/logger.ts`. Pattern:

```ts
log.info("[module] short imperative sentence", { contextField: value });
log.warn("[module] non-fatal warning", { error: err.message });
log.error("[module] something broke", { error: ... });
```

Never `console.*` (verified — one legitimate use inside the logger itself).

## 8. Tools / variables / commands (primitives)

Auto-discovered via `scanFiles` glob from the bootstrap. Files export a
plain object literal (`Command`, `Variable`, `ToolDefinition`) — registration
is reflective on shape via `safeParse`.

Constraint: filename ≠ `index.ts` is loaded; `index.ts` holds the registry + loader.

Tools declare `sideEffect: "external" | "stateful" | "pure"` + `kind: "builtin"` + `capability: "tool"`. Stateful/external tools should also declare a `simulate` handler when their default faker isn't appropriate.

## 9. Settings access

Always read live: `import { settings } from "../infra/config.ts"`.

The `settings` object is **mutated in place** on hot-reload — never destructure
once and cache. Live getters (`settings.locale`, `settings.timezone`,
`settings.defaultAgent`, `settings.allowedChat`) exist as shortcuts; treat them
as ordinary fields.

## 10. Patterns to *avoid* introducing

- `index.ts` re-exporting from siblings ("barrel imports"). Only `index.ts` files that act as registry/loader/utility hub are allowed.
- Optional fields set to `undefined` (kills `exactOptionalPropertyTypes`).
- Inline magic numbers. Route through `settings.*` or a named `const`.
- Comments that restate code. Comment the *why*, not the *what*.
- Mutating shared `settings` object outside `infra/config.ts` write functions.
- `try/catch` that swallows + ignores. Either re-throw, return a typed error, or log + recover deliberately.

---

## 11. Known pre-existing test failures (not fixed in this pass)

- `test/primitives/commands/default.test.ts` (2 cases) — `getDefaultAgent` no longer pulls from disk on cache miss.
- `test/templates/golden.test.ts` (3 cases) — template-snapshot drift.

These already fail on `main`/`dev` before this review started.
