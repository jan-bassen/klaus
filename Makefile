.PHONY: up down logs restart pull backup reset status

COMPOSE = docker compose

## Start all services
up:
	$(COMPOSE) up -d --remove-orphans

## Stop all services
down:
	$(COMPOSE) down

## Follow app logs
logs:
	$(COMPOSE) logs -f app

## Restart app container only (e.g. after .env change)
restart:
	$(COMPOSE) restart app

## Deploy: pull latest code, rebuild image, restart app
pull:
	git pull
	$(COMPOSE) build app
	$(COMPOSE) up -d app

## Run a one-shot backup (postgres dump + baileys auth)
backup:
	$(COMPOSE) --profile backup run --rm backup

## Nuke everything and start fresh (WARNING: deletes all data volumes)
reset:
	$(COMPOSE) down -v
	$(COMPOSE) up -d --remove-orphans

## Show container status
status:
	$(COMPOSE) ps
