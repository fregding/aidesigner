# Docker 部署说明

## 本地运行

需要已安装 Docker 和 Docker Compose 插件，或旧版 `docker-compose` 命令。

```bash
./start.sh
```

脚本会在首次运行时生成 `.env.docker`，其中包含随机 `JWT_SECRET`、`CONFIG_ENCRYPTION_KEY` 和管理员密码。运行数据保存在：

- `runtime/data/aimaster.db`
- `runtime/uploads/`
- `runtime/backups/`

## 服务器首次部署

本地先打一份干净包：

```bash
./scripts/package-release.sh
```

把 `dist/aidesigner_*.tar.gz` 上传到服务器，建议解压到固定目录，这样后续更新时 `runtime/` 数据会一直保留在同一个位置：

```bash
mkdir -p /srv/aidesigner
tar -xzf aidesigner_*.tar.gz --strip-components=1 -C /srv/aidesigner
cd /srv/aidesigner
```

然后首次部署：

```bash
./scripts/deploy-docker.sh https://your-domain.example admin@your-domain.example
```

脚本会生成 `.env.docker` 并打印首次管理员账号。请把该文件权限保持为 `600`，不要提交到 Git。

脚本会保证服务真正启动后才结束：

- 自动生成或修正关键运行配置：`APP_BIND=127.0.0.1`、`TRUST_PROXY=true`、邮件发送队列限速参数。
- 自动备份 `runtime/data/aimaster.db`。
- 重新构建镜像并强制重建 `app` 容器，避免旧环境变量继续留在容器里。
- 轮询 `http://127.0.0.1:3000/api/health`，只有返回健康结果才显示部署完成。
- 如果启动失败，脚本会提示查看 `docker compose --env-file .env.docker logs -f app`，不要在健康检查失败时继续对外放量。

没有域名、也不想先配 Nginx 时，可以让 Docker 直接暴露公网端口：

```bash
./scripts/deploy-docker.sh --direct http://your-server-ip:3000 admin@local
```

然后访问 `http://your-server-ip:3000`。正式上线有域名后，建议改回反代模式，只把容器绑定到 `127.0.0.1`。

如果你已经把旧版本解压到带时间戳的新目录里，更新前请先把旧目录里的 `runtime/` 复制过去，否则数据库和上传文件不会跟着代码一起迁移。

## 上传后确保 AI 服务已启动

每次把新包上传到服务器后，只按这套顺序执行：

```bash
mkdir -p /srv/aidesigner
tar -xzf aidesigner_*.tar.gz --strip-components=1 -C /srv/aidesigner
cd /srv/aidesigner
./scripts/deploy-docker.sh
```

首次部署才需要带域名和管理员邮箱：

```bash
./scripts/deploy-docker.sh https://your-domain.example admin@your-domain.example
```

看到下面两类结果，才说明服务器上的 AI 服务已经开起来：

```bash
curl -fsS http://127.0.0.1:3000/api/health
docker compose --env-file .env.docker ps
```

`curl` 应返回 `{"status":"ok",...}`，`docker compose ps` 里 `app` 应为 `running` 或 `healthy`。如果不是，先看日志：

```bash
docker compose --env-file .env.docker logs -f app
```

正式域名反代模式下，`.env.docker` 里必须保持：

```env
APP_BIND=127.0.0.1
TRUST_PROXY=true
ALLOWED_ORIGINS=https://your-domain.example
```

Nginx 必须透传真实 IP，否则注册/验证码限流会把所有人当成同一个 IP：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

如果后台能打开但 AI 生成不可用，优先检查 `.env.docker` 或后台配置里的模型 Key：`TIME_BACKWARD_API_KEY`、`IMAGE_API_KEY`、`IMAGE_ASSISTANT_API_KEY`、`TAVILY_API_KEY`。服务启动只代表后端可用，具体模型调用还需要对应 Key 有效。

## 更新

```bash
cd /srv/aidesigner
tar -xzf aidesigner_*.tar.gz --strip-components=1 -C /srv/aidesigner
./scripts/deploy-docker.sh
```

脚本会先备份 SQLite，再重建镜像并滚动重启容器。代码在镜像内，数据和上传文件在 `runtime/`，只要持续使用同一个部署目录，更新就不会覆盖业务数据。

## HTTPS

Docker 容器默认只绑定 `127.0.0.1:3000`。公网建议使用宿主机 Nginx 或 Caddy 做 HTTPS，然后反代到该地址。Nginx 示例在 `deploy/nginx/aidesigner.conf`。

## 备份

```bash
./scripts/backup.sh
```

备份文件会写入 `runtime/backups/`。如果安装了 `sqlite3`，脚本会使用 SQLite 在线备份；否则退化为文件复制。
