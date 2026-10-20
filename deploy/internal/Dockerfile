FROM node:24-bookworm-slim

# 不使用任何 npm 依赖：SQLite 走 Node 内置 node:sqlite，
# 因此镜像构建全程离线，不受内网出口对 npm / Cloudflare 网段的限制。
ENV NODE_ENV=production \
    PORT=18080 \
    APP_DIR=/app \
    DATA_DIR=/data \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

COPY . .

RUN mkdir -p /data

EXPOSE 18080

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
