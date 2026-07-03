#!/usr/bin/env bash
# Hot backup of the SQLite database inside the running app container.
#   - Uses SQLite's .backup() command (online, doesn't block writers)
#   - Copies out of the container to the host backups dir
#   - Records SHA256 + row counts in a sidecar
#   - Prunes backups older than ${BACKUP_RETENTION_DAYS:-30} days
#
# Usage:
#   tools/backup.sh                # full backup, prune old
#   tools/backup.sh --no-prune     # skip pruning
#   tools/backup.sh --label=name   # extra tag in filename

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LABEL=""
NO_PRUNE=0
for a in "$@"; do
  case "$a" in
    --no-prune) NO_PRUNE=1 ;;
    --label=*) LABEL="-$(echo "${a#--label=}" | tr -c 'A-Za-z0-9._-' '_')" ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="bookingagent-${TS}${LABEL}.sqlite"
BACKUPS_DIR="${BACKUPS_DIR:-$ROOT/backups}"
mkdir -p "$BACKUPS_DIR"
# Use a log file we know is writable regardless of who's running the script.
LOG="${BACKUP_LOG:-$BACKUPS_DIR/.backup.log}"
touch "$LOG"

OUT_TMP="$BACKUPS_DIR/$NAME.tmp"
OUT="$BACKUPS_DIR/$NAME"

# 1. Try hot backup via the app container (uses SQLite .backup()). This is
#    the only reliable way to get a consistent snapshot in WAL mode while
#    the app is running — `cp` on the main file would miss the WAL.
HOT_OK=0
if command -v docker >/dev/null 2>&1 && [ "$(docker compose ps -q app 2>/dev/null)" != "" ]; then
  echo "[backup] hot backup via app container..."
  if docker compose exec -T app node -e "
    const Database = require('better-sqlite3');
    const db = new Database('/app/data/bookingagent.sqlite');
    (async () => {
      try {
        await db.backup('/tmp/backup.sqlite');
        db.close();
        console.log('OK');
      } catch (e) { console.error('BACKUP_ERR:' + e.message); process.exit(2); }
    })();
  " >"$LOG" 2>&1; then
    if docker compose cp app:/tmp/backup.sqlite "$OUT_TMP" 2>>"$LOG"; then
      HOT_OK=1
    fi
  fi
fi

# 2. Fallback: container is down, do a checkpoint inside the container's
#    data dir via a one-shot container, then `cp` the file out.
if [ "$HOT_OK" = "0" ]; then
  echo "[backup] hot backup unavailable, using one-shot container + cp"
  if [ -f "$ROOT/data/bookingagent.sqlite" ]; then
    # Use a one-shot container to run the checkpoint as the same user that
    # owns the DB file. This avoids the "readonly database" error you get
    # when the host tries to checkpoint WAL mode without write access.
    docker run --rm \
      -v "$ROOT/data:/data" \
      -v "$BACKUPS_DIR:/backups" \
      --user 100:101 \
      --entrypoint sh \
      node:20-alpine \
      -c "cd /tmp && node -e \"
        const Database = require('better-sqlite3');
        const db = new Database('/data/bookingagent.sqlite');
        db.backup('/tmp/backup.sqlite');
        db.close();
        console.log('OK');
      \"" 2>>"$LOG"
    docker run --rm -v "$BACKUPS_DIR:/backups" -v /tmp/backup.sqlite:/tmp/backup.sqlite \
      --user 100:101 alpine:3.19 sh -c "cp /tmp/backup.sqlite /backups/$(basename $OUT_TMP)" 2>>"$LOG"
    [ -f "$OUT_TMP" ] && HOT_OK=1 || HOT_OK=0
  elif command -v docker >/dev/null 2>&1; then
    # Last resort: extract from the named volume
    docker compose run --rm -T --entrypoint sh app -c "cat /app/data/bookingagent.sqlite" > "$OUT_TMP" 2>/dev/null || {
      echo "[backup] FAILED: no data file accessible"
      exit 3
    }
  else
    echo "[backup] FAILED: no data file accessible"
    exit 3
  fi
fi

mv "$OUT_TMP" "$OUT"
echo "[backup] wrote $OUT ($(stat -c %s "$OUT" 2>/dev/null || stat -f %z "$OUT") bytes)"

# 3. Sidecar: SHA256
( cd "$BACKUPS_DIR" && sha256sum "$NAME" > "${NAME}.sha256" )

# 4. Sidecar: row counts (so you can verify what's inside)
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$OUT" "SELECT 'accounts', COUNT(*) FROM accounts UNION ALL SELECT 'sessions', COUNT(*) FROM sessions UNION ALL SELECT 'recurring_bookings', COUNT(*) FROM recurring_bookings UNION ALL SELECT 'watches', COUNT(*) FROM watches UNION ALL SELECT 'bookings', COUNT(*) FROM bookings UNION ALL SELECT 'fire_events', COUNT(*) FROM fire_events UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log;" > "$BACKUPS_DIR/${NAME}.counts" || true
  echo "[backup] row counts:"
  cat "$BACKUPS_DIR/${NAME}.counts" | sed 's/^/    /'
fi

# 5. Prune old backups
if [ "$NO_PRUNE" = "0" ]; then
  RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
  PRUNED=$(find "$BACKUPS_DIR" -maxdepth 1 -name 'bookingagent-*.sqlite' -mtime +$RETENTION_DAYS -print -delete | wc -l)
  if [ "$PRUNED" -gt 0 ]; then
    # Also remove the sidecars
    find "$BACKUPS_DIR" -maxdepth 1 -name 'bookingagent-*.sha256' -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
    find "$BACKUPS_DIR" -maxdepth 1 -name 'bookingagent-*.counts' -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
    echo "[backup] pruned $PRUNED backup(s) older than $RETENTION_DAYS days"
  fi
fi

echo "[backup] done. Latest: $OUT"
