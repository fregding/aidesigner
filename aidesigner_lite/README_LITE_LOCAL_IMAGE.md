# AI Designer Lite：第一阶段本地图片生成版

这个版本用于先跑通“前端 -> Node 后端 -> 本地图片服务”的闭环。

## 已改动

- 新增 `local-image-server/`：OpenAI 兼容的本地 mock 图片服务。
- `POST /v1/images/generations` 返回 `b64_json`，后端会保存到 `/uploads` 并在页面显示。
- Docker Compose 同时启动：
  - `local-image-server`：端口 `18080`
  - `app`：端口 `3000`
- 后端图片配置默认指向：`http://local-image-server:18080/v1`
- 禁用 PPT、视频、支付、会员充值相关后端路由。
- 前端隐藏 PPT、视频、充值、支付、会员入口。
- `Dockerfile` 已从 `npm ci` 改为 `npm install --omit=dev`，不再依赖 `package-lock.json`。

## Docker 启动

```bat
cd C:\Embedded_Practice\Git_test\aidesigner_lite
docker compose down --remove-orphans
docker compose up --build
```

访问：

```text
http://localhost:3000/dashboard.html
http://localhost:3000/image.html
```

本地图片服务健康检查：

```bat
curl http://127.0.0.1:18080/health
```

后端健康检查：

```bat
curl http://127.0.0.1:3000/api/health
```

默认管理员账号：

```text
admin@localhost
AdminLocal@2026
```

## 非 Docker 启动本地图片服务

Windows：

```bat
cd local-image-server
start_windows.bat
```

Linux/macOS：

```bash
cd local-image-server
bash start_linux_mac.sh
```

如果 Node 后端跑在 Docker 容器里，而 Python 服务跑在 Windows 宿主机，把后端配置改成：

```env
IMAGE_BASE_URL=http://host.docker.internal:18080/v1
IMAGE_API_KEY=local-dev-key
IMAGE_MODEL=local-mock-image
```

## 下一阶段替换真模型

当前 `local-image-server` 是 mock 版，适合先验证工程链路。后续可以保持接口不变，把内部实现替换为：

- Diffusers CPU / OpenVINO
- `stabilityai/sd-turbo`
- LCM / tiny-sd 等轻量模型

模型、缓存、输出目录已经加入 `.gitignore`，不要把大模型提交进 Git。

## Windows / Python 3.14 note

Phase-1 mock image server has been changed to avoid Pillow. It only depends on FastAPI and Uvicorn, and generates valid PNG files with Python stdlib. This avoids native compilation failures on Python 3.14.
