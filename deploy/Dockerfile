# FQRH v4 · 容器镜像（可选部署方式；生产也可直接 systemd，见 docs/11-linux-deploy.md）
FROM node:24-alpine

LABEL org.opencontainers.image.title="fqrh-v4" \
      org.opencontainers.image.description="FQRH v4 局域网 AI 中转网关" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY src ./src
COPY scripts ./scripts
COPY config.example.json config.demo.json README.md ./

# 运行数据目录（挂载卷覆盖）：账本 data/fqrh.db、密钥 data/keys/
RUN mkdir -p /data/data/keys && chown -R node:node /data

USER node
WORKDIR /data
EXPOSE 8790

# 配置从挂载的 /etc/fqrh/config.json 读；不带 config 时用示例（记得改）
CMD ["node", "/app/src/server.mjs", "--config", "/etc/fqrh/config.json"]
