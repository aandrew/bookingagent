# v3.1: use the official Playwright base image so Chromium + all system deps
# are baked in. Required because production now runs Playwright (re-login
# after session expiry) — the previous node:20-alpine image had no browser.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS base
RUN apt-get update && apt-get install -y --no-install-recommends tini wget ca-certificates sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=optional

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV BACKUP_DIR=/app/backups
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Chromium is provided by the base image at /ms-playwright; Playwright
# already knows how to find it via PLAYWRIGHT_BROWSERS_PATH (default).
# Use a fixed uid/gid (999) for the app user so it matches the host
# chown performed by tools/deploy.sh. This avoids the
# "attempt to write a readonly database" error when the bind-mounted
# DB is owned by a different host uid (e.g. the previous syslog-owned
# state from older containers that had no USER directive).
RUN groupadd -g 999 app && useradd -u 999 -g 999 -m app
# Wrapper entrypoint: chowns the bind-mounted data dir as root (so the
# app user can write it), then drops to app for the node process.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY data ./data
RUN mkdir -p /app/data /app/backups && chown -R app:app /app
USER root
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node","src/server.js"]
