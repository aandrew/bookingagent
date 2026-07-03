#!/usr/bin/env bash
# Deploy a new build to production. Snapshots the DB first, then rebuilds.
#
# Usage:
#   tools/deploy.sh                # backup → build → restart
#   tools/deploy.sh --no-backup    # skip the snapshot (NOT recommended)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_BACKUP=1
for a in "$@"; do
  case "$a" in
    --no-backup) DO_BACKUP=0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [ "$DO_BACKUP" = "1" ]; then
  echo "[deploy] snapshotting DB..."
  tools/backup.sh --label=pre-deploy || {
    echo "[deploy] WARNING: backup failed, continuing anyway (Ctrl-C in 5s to abort)"
    sleep 5
  }
fi

echo "[deploy] building image..."
sudo docker compose build app

echo "[deploy] restarting app..."
sudo docker compose up -d app

echo "[deploy] waiting for health check..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "[deploy] app is healthy"
    break
  fi
  sleep 1
done

sudo docker compose ps | grep -E "Up|STATUS" | head -5
echo "[deploy] done. To check backups: ls -1t backups/ | head -5"
echo "[deploy] To roll back: tools/restore.sh"
