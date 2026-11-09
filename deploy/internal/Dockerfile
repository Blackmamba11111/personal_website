FROM node:24-bookworm-slim

# 不使用任何 npm 依赖：SQLite 走 Node 内置 node:sqlite，
# 因此镜像构建全程离线，不受内网出口对 npm / Cloudflare 网段的限制。
ENV NODE_ENV=production \
    PORT=18080 \
    APP_DIR=/app \
    DATA_DIR=/data \
    TZ=Asia/Shanghai \
    SOFFICE_BIN=/usr/bin/soffice \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app

# ---- 附件在线预览：Office 文档转 PDF ----
# 浏览器没有 Office 渲染引擎，唯一能让「格式完全不变」的方案是服务端转 PDF，
# 再用浏览器自带的 PDF 阅读器展示。这一步因此需要 LibreOffice + 中文字体。
#
# 字体选择（缺一种就会让换行/分页跑偏，或中文变方块）：
#   fonts-noto-cjk      中文主力，宋/黑两族齐全
#   fonts-wqy-microhei  兜底黑体，体积小
#   fonts-liberation    Arial / Times New Roman / Courier New 度量兼容替身
#   fonts-crosextra-*   Calibri / Cambria 度量兼容替身（Word 默认字体）
#
# 本层位于 COPY . . 之前：日常改代码不会触发 apt 重装，
# 只有本文件或 office-cjk.conf 变动时才重建。
COPY office-cjk.conf /etc/fonts/conf.d/99-office-cjk.conf

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libreoffice-writer \
        libreoffice-calc \
        libreoffice-impress \
        fonts-noto-cjk \
        fonts-wqy-microhei \
        fonts-liberation \
        fonts-crosextra-carlito \
        fonts-crosextra-caladea \
        fontconfig; \
    fc-cache -f >/dev/null 2>&1 || true; \
    rm -rf /var/lib/apt/lists/*; \
    soffice --version

COPY . .

RUN mkdir -p /data /data/preview

EXPOSE 18080

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
