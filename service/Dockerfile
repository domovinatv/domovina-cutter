# domovina-cutter ffmpeg microservice (deploy on Coolify, like mcp.domovina.ai).
# alpine + ffmpeg (libx264 + native aac) + a tiny Node HTTP server that cuts a
# chapter (HTTP-range seek, no full download) and uploads it straight to R2 via
# the S3 API. I/O-bound, not CPU-bound — a single small instance is plenty.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --spider -q http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
