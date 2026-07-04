#!/bin/sh
# Container entrypoint.
#
# v3.1: chown the bind-mounted /app/data to the app user (uid 999) so the
# Node process can write the SQLite DB. The bind mount preserves host
# permissions, so if the host DB is owned by some other uid (e.g. syslog
# from a previous container that had no USER directive), the chown fixes
# the mismatch on every container start. Without this, the app fails any
# DB write with "attempt to write a readonly database" (SQLITE_READONLY).
#
# Then drops privileges to the app user and execs the given command (default
# `node src/server.js`). tini is prepended so PID 1 reaps zombies.

set -e

# Re-own the data dir to the app user. -R includes all subdirs and files
# (bookingagent.sqlite, spike-*, /app/backups is the named volume so it's
# already owned by Docker as root — we chown it too for consistency).
chown -R app:app /app/data /app/backups 2>/dev/null || true

# Re-exec as the app user, under tini.
exec /usr/bin/tini -- su -s /bin/sh app -c "$*"
