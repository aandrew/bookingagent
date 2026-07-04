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
RUN groupadd -r app && useradd -r -g app app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY data ./data
RUN mkdir -p /app/data /app/backups && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/server.js"]
