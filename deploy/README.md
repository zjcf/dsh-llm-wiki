# DSH 管理与只读双实例

`compose.yaml` 使用同一份 DSH 0.2.2-rc.1 源码及已安装依赖，以官方 Node 24.13.0 为基础，在 `Dockerfile` 中预装 pnpm 11.28.5 后运行两个服务。DSH 插件管理器直接执行 `pnpm view/add/remove`；只有 Node/npm 的基础镜像会报 `spawn pnpm ENOENT`，不能仅在临时容器内安装。插件本身支持 Node 22.13.0 起，DSH 0.2.2 的源码运行要求 Node 24.9.0 起，部署镜像按宿主要求选择。源码目录只读挂载，更新源码前应先检查版本并重启验证；本配置不自动拉取 Git，也不把用户数据打入镜像。

| 服务 | 默认访问地址 | 宿主数据目录 | 知识库权限 |
| --- | --- | --- | --- |
| admin | http://127.0.0.1:3080 | `DSH_ADMIN_HOME` | 完整增删改查、整理、commit/push、管理页 revert |
| reader | http://127.0.0.1:3081 | `DSH_READER_HOME` | 同一知识库只读查询与预览 |

DSH 拒绝绑定 `0.0.0.0`。Compose 使用宿主网络模式，默认绑定 `127.0.0.1`，两个服务端口分别为 `3080`、`3081`。需要其他设备访问时，将 `DSH_BIND_IP` 设置为部署主机的具体 IP；保持宿主原有登录鉴权，健康检查接受正常页面或要求鉴权的 HTTP 401，不关闭认证。

两个实例容器内都使用 `DSH_HOME=/root/.dsh`，但绑定的是两个不同的宿主目录。各自的 `sessions/`、`attachments/`、`storages/`、profile、凭据、登录状态和派生索引独立持久化；不共享会话数据。需要保留已有管理会话时，将 `DSH_ADMIN_HOME` 指向现有 DSH 数据目录。只读实例使用独立的数据目录。

只读实例的知识库使用第二层只读 bind mount，映射管理实例的 `/root/.dsh/llm-wiki`，因此管理端提交后的新内容无需手动复制。它的插件配置必须为 `readOnly: true`，缓存放在自己的 `/root/.dsh/llm-wiki-cache`；`autoReview` 即使为 true 也不会启动。只读实例不应配置 Git 写入 Token，也不复制其他管理插件配置。模型连接与凭据使用该实例自己的 DSH 配置入口设置；经用户授权，可仅迁移所选默认模型及其单个凭据引用对应的值，不复制整个管理端凭据库。

`readOnly` 只限制知识库业务。只读实例自己的 profile、插件包和配置仍可写，可正常安装其他 DSH 插件；新增插件的会话和附件仍保存在它自己的 DSH 数据目录。

现有 profile 从宿主迁入容器后，`node_modules/.modules.yaml` 可能仍记录宿主的 pnpm store 路径，安装新插件会报 `ERR_PNPM_UNEXPECTED_STORE`。应在容器里重建依赖，让 store 位于该实例持久化的 `/root/.dsh/.pnpm-store/`，不要手改登记文件或共用两个实例的依赖缓存。以只读实例为例：

```bash
# 在本目录执行
docker compose stop reader
docker compose run --rm --no-deps -T --workdir /root/.dsh/profiles/web reader pnpm install --force
docker compose up -d reader
```

后续插件安装与升级通过实例自身的插件管理页或容器内 CLI 执行，使用同一份 profile 和缓存。插件包名为 `dsh-llm-wiki`，不需要组织 scope 路由；选择实际发布该包的 npm 源，或使用本地构建的 tarball。公共依赖使用可访问的公共源，不绕过供应链检查。源码中不固定发布 registry。

启动前准备好两个 profile 并安装相同版本的插件。在只读 profile 的插件运行配置中设置：

```yaml
root: /root/.dsh/llm-wiki
readOnly: true
cacheDir: /root/.dsh/llm-wiki-cache
autoReview: false
```

在本目录创建 `.env`，明确指定部署主机的目录。以下为示例路径，须按实际环境调整；`DSH_WIKI_ROOT` 应为管理实例实际使用的知识库目录。所有目录必须预先存在，Compose 不自动创建缺失目录；两个实例的数据目录必须不同。

```dotenv
DSH_BIND_IP=127.0.0.1
DSH_SOURCE=/srv/deepseek-harness
DSH_ADMIN_HOME=/srv/dsh/admin
DSH_READER_HOME=/srv/dsh/reader
DSH_WIKI_ROOT=/srv/dsh/admin/llm-wiki
```

`DSH_SOURCE`、`DSH_ADMIN_HOME`、`DSH_READER_HOME` 和 `DSH_WIKI_ROOT` 为必填项，缺失时 Compose 会报错。镜像在本地构建，名称为 `dsh-llm-wiki-runtime:node24.13.0-pnpm11.28.5`。在本目录执行：

```bash
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose restart admin reader
```

验收需覆盖两个实例的知识查询、管理端写入及只读端拒绝写入、Docker 只读卷拒绝直接文件写入，以及重建容器后两端各自的会话仍可打开且互不出现。`down` 不会删除 bind mount 中的数据。不要使用清空宿主数据目录的命令；版本回滚仍通过管理页新增 revert 提交，不执行 force push。
