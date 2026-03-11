#!/bin/sh
set -e

if [ -n "$OBSIDIAN_EMAIL" ] && [ -n "$OBSIDIAN_PASSWORD" ]; then
  if [ -z "$OBSIDIAN_VAULT_NAME" ]; then
    echo "ERROR: OBSIDIAN_VAULT_NAME is required when OBSIDIAN_EMAIL/OBSIDIAN_PASSWORD are set." >&2
    exit 1
  fi

  echo "==> Authenticating with Obsidian Sync..."
  ob login --email "$OBSIDIAN_EMAIL" --password "$OBSIDIAN_PASSWORD"

  echo "==> Configuring vault..."
  if [ -n "$OBSIDIAN_E2EE_PASSWORD" ]; then
    ob sync-setup --vault "$OBSIDIAN_VAULT_NAME" --path /vault --password "$OBSIDIAN_E2EE_PASSWORD"
  else
    ob sync-setup --vault "$OBSIDIAN_VAULT_NAME" --path /vault
  fi
else
  echo "WARN: OBSIDIAN_EMAIL/OBSIDIAN_PASSWORD not set — relying on persisted auth token."
fi

echo "==> Starting continuous sync..."
exec ob sync --path /vault --continuous
