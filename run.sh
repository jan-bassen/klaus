#!/bin/sh
set -e
cd "$(dirname "$0")"

case "$1" in
  up)      docker compose up -d --remove-orphans ;;
  down)    docker compose down ;;
  logs)    docker compose logs -f app ;;
  restart) docker compose restart app ;;
  pull)    git pull && docker compose build app && docker compose up -d app ;;
  backup)  docker compose --profile backup run --rm backup ;;
  reset)   docker compose down -v && docker compose up -d --remove-orphans ;;
  status)  docker compose ps ;;
  *)       echo "Usage: $0 {up|down|logs|restart|pull|backup|reset|status}" && exit 1 ;;
esac
