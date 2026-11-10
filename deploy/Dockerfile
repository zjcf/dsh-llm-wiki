FROM node:24.13.0-bookworm-slim

# DSH 插件管理器会直接执行 pnpm；在构建时安装，容器重建后仍然可用。
RUN npm install --global pnpm@11.28.5 --registry=https://registry.npmjs.org/ \
    && pnpm --version \
    && npm cache clean --force
