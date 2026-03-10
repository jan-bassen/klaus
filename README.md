# Klaus

A lean, self-hosted personal AI agent: **WhatsApp → TypeScript → Postgres**. *Klaus* is a reference to [Klaus Störtebeker](https://en.wikipedia.org/wiki/Klaus_St%C3%B6rtebeker), the legendary pirate who allegedly walked past his crew after being beheaded — because this stack is *headless*. Personal hobby project.

---

## Stack

| Layer | Tech |
| --- | --- |
| Runtime | Bun + TypeScript (strict) |
| LLM / Vision | Anthropic Claude via Vercel AI SDK |
| Embeddings | Voyage AI (`voyage-3`, 1024-dim) |
| STT / TTS | ElevenLabs (Scribe v1 / Multilingual v2) |
| WhatsApp | Baileys (unofficial WA Web API, multi-device) |
| Database | Postgres + Drizzle ORM + pgvector + tsvector |
| Job queue | pg-boss (Postgres-native, `SKIP LOCKED`) |
| Hosting | Synology NAS via Docker Compose |
| CI/CD | GitHub Actions + self-hosted runner on NAS |

---

## Secrets (1Password)

Secrets are stored in 1Password and injected at runtime via the `op` CLI — no plain-text secrets in `.env`.

Copy `.env.example` to `.env` and fill in your vault paths:

```
ANTHROPIC_API_KEY=op://Personal/Klaus/ANTHROPIC_API_KEY
```

All `make` targets and `bun` commands are wrapped with `op run --env-file .env --`, which resolves `op://` URIs before the process starts. On your Mac this uses the desktop app (biometric unlock). On the NAS it uses a **service account token** instead.

**NAS / CI setup (one-time):**
1. Create a 1Password Service Account scoped to the Klaus item at [1password.com](https://1password.com/developer/service-accounts/)
2. Add the token as a GitHub Actions secret named `OP_SERVICE_ACCOUNT_TOKEN` (repo Settings → Secrets)
3. The deploy workflow installs the `op` CLI on the runner and uses the token automatically

---

## Running in dev

**Prerequisites:** Bun, Docker

```bash
cp .env.example .env        # fill in API keys + ALLOWED_CHAT_ID
docker compose up -d postgres   # start Postgres
                                # docker-compose.override.yml auto-loads and
                                # exposes :5432 to the host for bun/drizzle-kit
bun run db:migrate          # apply migrations
bun dev                     # start the agent
                            # scan the QR code in the terminal on first run to pair WhatsApp
```

To test the full Docker build locally instead:

```bash
make dev-up    # builds image + starts postgres, app, caddy
make dev-down
```

---

## Deploying to NAS (production)

**Prerequisites:** Docker + make on the NAS, repo cloned, `.env` filled in (see NAS-only vars below).

```bash
# First deploy
make nas-build   # build app image on the NAS
make nas-up      # start postgres + app + caddy + GitHub Actions runner

# First-run WhatsApp pairing
make nas-logs    # watch logs, scan the QR code

# Ongoing
make nas-restart  # restart app container only (e.g. after env changes)
make nas-backup   # dump postgres + baileys_auth to /volume1/backups/klaus
make nas-down     # stop everything
```

The `nas-*` targets load `docker-compose.yml` + `docker-compose.nas.yml` automatically. Pushes to `main` trigger the self-hosted runner on the NAS, which runs typecheck + tests, rebuilds the image, and restarts the app. Agent-only changes (edits to `src/agents/`) take a fast path that skips the Docker rebuild (~5s).

---

## Environment variables

| Variable | Description | Context |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | always |
| `ANTHROPIC_API_KEY` | Claude API key | always |
| `VOYAGE_API_KEY` | Voyage AI embedding key | always |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS/STT key | always |
| `ALLOWED_CHAT_ID` | WhatsApp chat ID to allow (fail-closed) | always |
| `BAILEYS_AUTH_FOLDER` | Auth state directory (default: `./.auth`) | always |
| `PORT` | Internal app port — Caddy proxies this | always |
| `DOMAIN` | Public domain for Caddy TLS (Let's Encrypt) | NAS only |
| `GITHUB_REPO_URL` | Repo URL for self-hosted Actions runner | NAS only |
| `GITHUB_RUNNER_TOKEN` | Runner registration token | NAS only |

---

## Folder structure

```
src/
├── agents/        # Agent prompt files (.md with YAML frontmatter)
├── commands/      # /command handlers
├── context/       # Context query modules (one file per query)
├── core/          # Pipeline, agent runner, dispatch, queue, model router
├── db/            # Schema, migrations, search, write path
├── tools/         # Tool definitions and toolsets
│   └── sets/      # Toolset definitions (memory, task, ops, files)
└── whatsapp/      # Transport layer (connection, receive, send, TTS, STT)
```

New agent = new `.md` file in `agents/`. New tool = new file in `tools/`. New context = new file in `context/`. See `AGENT.md` for coding guidelines.

---

## Usage

Send a WhatsApp message to the paired number. Prefix with `@agent` to route to a specific agent (e.g. `@think`). Use `/command` for direct control. Use `!flag` for inline behavior hints (`!verbose`, `!concise`).
