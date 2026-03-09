#!/bin/sh
# Backup script — runs inside the `backup` service container (postgres:17-alpine image).
# Dumps Postgres + exports baileys_auth volume to /backups/<date>/.
# Keeps the last 7 daily backups; older ones are pruned.
set -e

DATE=$(date +%Y-%m-%d)
DEST=/backups/$DATE
mkdir -p "$DEST"

echo "==> Dumping Postgres to $DEST/postgres.dump"
pg_dump -h postgres -U postgres -d klaus -Fc -f "$DEST/postgres.dump"

echo "==> Archiving baileys_auth volume to $DEST/baileys_auth.tar.gz"
tar czf "$DEST/baileys_auth.tar.gz" -C /baileys_auth .

echo "==> Pruning backups older than 7 days"
find /backups -maxdepth 1 -type d -name "????-??-??" -mtime +7 -exec rm -rf {} +

echo "==> Backup complete: $DEST"
ls -lh "$DEST"
