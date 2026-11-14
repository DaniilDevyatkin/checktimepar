FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5177 \
    SCHEDULE_ROOT=/app/schedules \
    AUTH_REQUIRED=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./server.js
COPY public ./public

RUN mkdir -p /app/schedules && chown -R node:node /app

USER node
EXPOSE 5177

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5177/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
