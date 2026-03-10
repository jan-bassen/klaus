.PHONY: dev nas-up nas-build nas-logs nas-restart nas-backup nas-down dev-up dev-down setup-nas

COMPOSE     = docker compose -f docker-compose.yml -f docker-compose.nas.yml
COMPOSE_DEV = docker compose

# ── One-time NAS setup ───────────────────────────────────────────────────────
# Usage: make setup-nas NAS=admin@192.168.1.100
setup-nas:
	@test -n "$(NAS)" || (echo "Usage: make setup-nas NAS=user@host"; exit 1)
	bash scripts/setup-nas.sh $(NAS)

# ── Local dev ────────────────────────────────────────────────────────────────

dev:
	bun --env-file .env.secrets dev

dev-up:
	$(COMPOSE_DEV) up -d

dev-down:
	$(COMPOSE_DEV) down

# ── NAS (production) ─────────────────────────────────────────────────────────

nas-up:
	$(COMPOSE) up -d

nas-build:
	$(COMPOSE) build app

nas-logs:
	$(COMPOSE) logs -f app

nas-restart:
	$(COMPOSE) restart app

nas-backup:
	$(COMPOSE) --profile backup run --rm backup

nas-down:
	$(COMPOSE) down
