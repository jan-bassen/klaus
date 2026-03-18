#!/bin/sh
# Backup script — runs inside the `backup` service container.
# NOTE: .env is NOT backed up here — store API keys in a password manager.
# Archives data, vault, config, and files volumes to /backups/<date>/.
# Keeps the last 7 daily backups; older ones are pruned.
set -e

DATE=$(date +%Y-%m-%d)
DEST=/backups/$DATE
mkdir -p "$DEST"

echo "==> Archiving data volume to $DEST/data.tar.gz"
tar czf "$DEST/data.tar.gz" -C /data .

echo "==> Archiving vault volume to $DEST/vault.tar.gz"
tar czf "$DEST/vault.tar.gz" -C /vault .

echo "==> Archiving config volume to $DEST/config.tar.gz"
tar czf "$DEST/config.tar.gz" -C /config .

echo "==> Archiving files volume to $DEST/files.tar.gz"
tar czf "$DEST/files.tar.gz" -C /files .

echo "==> Pruning backups older than 7 days"
find /backups -maxdepth 1 -type d -name "????-??-??" -mtime +7 -exec rm -rf {} +

echo "==> Backup complete: $DEST"
ls -lh "$DEST"
