# File Portal — 生产镜像
FROM node:22-slim

WORKDIR /app

# 只拷贝依赖清单, 利于缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝源码
COPY server.js ./
COPY public/ ./public/

# 本地存储目录 (local 模式; s3 模式无需但保留兼容)
RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENV NODE_ENV=production
EXPOSE 3000

# 生产建议: STORAGE_BACKEND=s3 + S3_* 环境变量 (存到 Cloudflare R2 / B2)
CMD ["node", "server.js"]
