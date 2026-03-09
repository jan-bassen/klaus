.PHONY: nas-up nas-build nas-logs nas-restart nas-backup nas-down dev-up dev-down

COMPOSE     = docker compose -f docker-compose.yml -f docker-compose.nas.yml
COMPOSE_DEV = docker compose

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

# ── Local dev ────────────────────────────────────────────────────────────────

dev-up:
	$(COMPOSE_DEV) up -d

dev-down:
	$(COMPOSE_DEV) down
