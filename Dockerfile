FROM node:20-alpine AS base
RUN apk add --no-cache tini wget ca-certificates
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --omit=optional

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV BACKUP_DIR=/app/backups
RUN apk add --no-cache sqlite  # for tools/backup.sh hot path verification
RUN addgroup -S app && adduser -S app -G app
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
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/server.js"]
