#!/bin/sh
# Backup script — runs inside the `backup` service container.
# NOTE: .env is NOT backed up here — store API keys in a password manager.
# Archives data, vault, baileys_auth, and files volumes to /backups/<date>/.
# Keeps the last 7 daily backups; older ones are pruned.
set -e

DATE=$(date +%Y-%m-%d)
DEST=/backups/$DATE
mkdir -p "$DEST"

echo "==> Archiving data volume to $DEST/data.tar.gz"
tar czf "$DEST/data.tar.gz" -C /data .

echo "==> Archiving vault volume to $DEST/vault_data.tar.gz"
tar czf "$DEST/vault_data.tar.gz" -C /vault_data .

echo "==> Archiving baileys_auth volume to $DEST/baileys_auth.tar.gz"
tar czf "$DEST/baileys_auth.tar.gz" -C /baileys_auth .

echo "==> Archiving files_data volume to $DEST/files_data.tar.gz"
tar czf "$DEST/files_data.tar.gz" -C /files_data .

echo "==> Pruning backups older than 7 days"
find /backups -maxdepth 1 -type d -name "????-??-??" -mtime +7 -exec rm -rf {} +

echo "==> Backup complete: $DEST"
ls -lh "$DEST"
