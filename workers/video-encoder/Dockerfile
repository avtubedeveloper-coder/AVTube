# Server-side Reel encoder. Needs only Node 22 and FFmpeg/ffprobe; no npm dependencies.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production WORK_DIR=/tmp/avtube-encoder
EXPOSE 8080
USER node
CMD ["node", "src/server.mjs"]
