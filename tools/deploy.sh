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

# Fix bind-mount permissions: the DB on the host may be owned by a different
# uid (e.g. syslog from an older container that had no USER directive). The
# current container runs as uid 999 (USER app in the Dockerfile), so chown
# the data dir to match — otherwise the app fails writes with
# "attempt to write a readonly database" (SQLITE_READONLY).
APP_UID=999
APP_GID=999
if [ -d data ]; then
  CURRENT_UID=$(stat -c '%u' data/bookingagent.sqlite 2>/dev/null || echo unknown)
  if [ "$CURRENT_UID" != "$APP_UID" ]; then
    echo "[deploy] data/ is owned by uid $CURRENT_UID, chowning to $APP_UID:$APP_GID to match the container's USER app..."
    sudo chown -R "$APP_UID:$APP_GID" data/
  fi
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
