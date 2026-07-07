# ffmpeg cutter for domovina-cutter.
# alpine + ffmpeg (libx264 + native aac) + a tiny Node HTTP server that cuts a
# chapter and uploads it straight to R2 via the S3 API.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
