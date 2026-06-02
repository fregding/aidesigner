
# AI Designer Lite 本地开发与部署说明

AI Designer Lite 是一个本地优先的 AI 创作演示项目，包含：

* 图片生成：本地 OpenVINO SD-Turbo 服务优先，失败或超时后可回退到 Pollinations API。
* PPT 生成：后端调用 PPT Agent，根据文本模型返回内容生成 PPT 页面。
* Web 前端：静态 HTML 页面，由 Node.js 后端统一托管。
* 后端 API：Express 服务，默认运行在 `http://localhost:3000`。

当前仓库主要目录如下：

```text
aidesigner/
├─ backend/                  # Node.js / Express 后端
│  ├─ src/
│  │  ├─ index.js             # 后端入口，挂载 API 和静态页面
│  │  ├─ routes/ai.js         # 图片、PPT 等 AI 接口
│  │  ├─ services/            # AI 调用、PPT、文件、配置等服务
│  │  └─ config/appConfig.js  # 读取 .env / .env.local 配置
│  └─ package.json
│
├─ local-openvino-server/     # 本地图片生成服务，OpenVINO + SD-Turbo
│  ├─ setup_windows.bat       # 创建 Python 虚拟环境并安装依赖
│  ├─ start_windows.bat       # 启动本地图片服务，默认 18081
│  ├─ app.py                  # FastAPI 图片生成接口
│  └─ .env.example
│
├─ local-text-server/         # 本地文本服务，默认 mock/OpenAI-compatible 风格
│  ├─ start_windows.bat       # 启动本地文本服务，默认 18082
│  └─ app.js
│
├─ assets/                    # 前端资源
├─ image.html                 # 图片生成页面
├─ ppt.html                   # PPT 生成页面
├─ dashboard.html             # 控制台页面
├─ start_all.bat              # Windows 一键启动脚本
└─ package.json
```

仓库根目录中能看到 `backend`、`local-openvino-server`、`local-text-server`、`image.html`、`ppt.html`、`start_all.bat` 等文件和目录。([GitHub][1]) 后端入口会托管 `/assets` 静态资源，并把根目录下的 `*.html` 页面按路由返回，例如 `/dashboard.html`、`/image.html`、`/ppt.html`。([GitHub][2])

---

## 1. 环境要求

### 必装

1. **Windows 10 / Windows 11**
2. **Node.js LTS**

   * 用于运行后端、local-text-server。
3. **Python 3.10 或 Python 3.11**

   * 用于运行 `local-openvino-server`。
   * 不建议使用 Python 3.12 / 3.13，因为本地 OpenVINO 图片服务依赖要求 Python 3.10/3.11。仓库的 `setup_windows.bat` 也会检查 Python 3.10 或 3.11。([GitHub][3])
4. **Git**

   * 用于拉取代码。

### 可选

1. **Ollama**

   * 如果你想让 PPT 文案由本地大模型生成，可以后续把文本服务改成 Ollama 或其他 OpenAI-compatible API。
   * 如果不装，`local-text-server` 也能以 mock 模式跑通 PPT 生成流程。仓库脚本里也明确写了：找不到 Ollama 时，PPT 会使用本地 mock 文本模式。([GitHub][4])

---

## 2. 拉取代码

```bat
git clone -b version-3 https://github.com/fregding/aidesigner.git
cd aidesigner
```

---

## 3. 配置后端环境变量

后端默认从 `backend/.env` 读取配置，也可以通过 `ENV_FILE` 指定其他配置文件。`backend/src/config/appConfig.js` 中会读取 `process.env.ENV_FILE`，没有指定时使用 `backend/.env`。([GitHub][5])

推荐本地开发使用：

```text
backend/.env.local
```

如果仓库里没有现成模板，可以手动创建 `backend/.env.local`：

```env
PORT=3000
NODE_ENV=development
TRUST_PROXY=false
PUBLIC_UPLOADS_ENABLED=true
SIGNED_UPLOADS_ENABLED=false

DATA_DIR=./data
DB_PATH=./data/aimaster.db
UPLOAD_DIR=./uploads
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

ADMIN_EMAIL=admin@localhost
ADMIN_PASSWORD=AdminLocal@2026
JWT_SECRET=local-dev-jwt-secret-change-before-production-1234567890
CONFIG_ENCRYPTION_KEY=local-dev-config-key-change-before-production-1234567890

# 图片生成：优先本地 OpenVINO
ENABLE_LOCAL_IMAGE=true
IMAGE_PROVIDER=local-openvino
IMAGE_BASE_URL=http://127.0.0.1:18081/v1
IMAGE_API_KEY=local-dev-key
IMAGE_MODEL=sd-turbo-openvino

# 图片生成兜底：Pollinations
# 具体是否自动兜底取决于后端 aiService 当前实现；
# local-openvino-server 在生成失败时会返回 503，便于 Node 后端触发 fallback。
POLLINATIONS_IMAGE_BASE_URL=https://image.pollinations.ai
POLLINATIONS_IMAGE_MODEL=flux
IMAGE_TIMEOUT_MS=600000

# PPT / 文本生成
ENABLE_LOCAL_PPT=true
PPT_PROVIDER=local
TEXT_API_BASE_URL=http://127.0.0.1:18082/v1
TEXT_API_KEY=local-dev-key
TEXT_MODEL=local-text-mock

EMAIL_DEV_LOG_CODES=true
ALIPAY_ENABLED=false
OFFICE_PREVIEW_AUTO_RENDER=false
UNOSERVER_ENABLED=false
```

如果只想直接切到 Pollinations 图片 API，可以使用下面这组配置：

```env
ENABLE_LOCAL_IMAGE=false
IMAGE_PROVIDER=pollinations
IMAGE_BASE_URL=https://image.pollinations.ai
IMAGE_API_KEY=
IMAGE_MODEL=flux
IMAGE_TIMEOUT_MS=600000
```

仓库里的 `fix_sqlite_and_enable_pollinations.bat` 会重写 `backend/.env.local`，并把 `IMAGE_PROVIDER` 设置为 `pollinations`、`IMAGE_BASE_URL` 设置为 `https://image.pollinations.ai`、`IMAGE_MODEL` 设置为 `flux`。([GitHub][6])

---

## 4. 安装后端依赖

进入后端目录：

```bat
cd backend
npm install
cd ..
```

后端依赖和启动脚本在 `backend/package.json` 中，主入口是 `src/index.js`，`npm start` 实际执行 `node src/index.js`。([GitHub][7])

---

## 5. 配置并启动本地 OpenVINO 图片服务

### 5.1 初始化 Python 环境

第一次使用时运行：

```bat
cd local-openvino-server
setup_windows.bat
cd ..
```

这个脚本会：

* 检查 Python 3.10 / 3.11；
* 创建 `local-openvino-server/.venv`；
* 安装 PyTorch CPU、OpenVINO、Optimum Intel、Diffusers 等依赖；
* 优先使用预编译包，降低 Windows 安装失败概率。([GitHub][3])

### 5.2 配置 local-openvino-server

默认配置来自：

```text
local-openvino-server/.env.example
```

默认端口是 `18081`，默认模型是 `rupeshs/sd-turbo-openvino`，默认设备是 CPU，默认输出尺寸是 `512x512`。([GitHub][8])

可以复制一份：

```bat
copy local-openvino-server\.env.example local-openvino-server\.env
```

常用配置：

```env
LOCAL_IMAGE_HOST=127.0.0.1
LOCAL_IMAGE_PORT=18081
LOCAL_IMAGE_ENGINE=openvino
OPENVINO_DEVICE=CPU
LOCAL_MODEL_ID=rupeshs/sd-turbo-openvino
LOCAL_MODEL_DIR=./models/sd-turbo-openvino
LOCAL_IMAGE_SIZE=512x512
LOCAL_IMAGE_STEPS=2
LOCAL_IMAGE_GUIDANCE_SCALE=0.0
LOCAL_IMAGE_MAX_IMAGES=1
LOCAL_IMAGE_ALLOW_DOWNLOAD=true
```

说明：

* `LOCAL_IMAGE_ALLOW_DOWNLOAD=true`：允许首次启动时自动从 Hugging Face 下载模型。
* 如果网络不稳定，也可以提前手动下载模型到 `local-openvino-server/models/sd-turbo-openvino`。
* 服务会检查模型目录中是否存在 `model_index.json`，如果目录不完整，会报错提示重新下载。([GitHub][9])

### 5.3 启动图片服务

```bat
cd local-openvino-server
start_windows.bat
```

启动后访问：

```text
http://127.0.0.1:18081/health
```

如果想触发模型加载检查：

```text
http://127.0.0.1:18081/health?load=true
```

`local-openvino-server` 提供 OpenAI-compatible 风格接口：

```text
POST /v1/images/generations
```

生成失败时，它会返回 `503`，这样 Node 后端可以识别本地生成失败并进入兜底流程。([GitHub][9])

---

## 6. 启动本地文本服务，用于 PPT 生成

PPT 生成需要文本模型提供大纲、页面内容、视觉描述等文本结果。

本地开发时可以先使用仓库自带的 mock 文本服务：

```bat
cd local-text-server
start_windows.bat
cd ..
```

默认端口：

```text
http://127.0.0.1:18082
```

健康检查：

```text
http://127.0.0.1:18082/health
```

这个服务提供：

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

`local-text-server` 默认模型名是 `local-text-mock`，接口形式接近 OpenAI Chat Completions。对于 PPT 请求，它会返回一段模板化结构，主要用于本地联调流程；如果需要高质量内容，可以后续接入 Ollama、Qwen、OpenAI-compatible API 或其他文本模型。([GitHub][10])

---

## 7. 启动后端服务

推荐在项目根目录执行：

```bat
cd backend
set ENV_FILE=%cd%\.env.local
node src/index.js
```

或者在项目根目录执行：

```bat
set ENV_FILE=%cd%\backend\.env.local
cd backend
node src/index.js
```

启动成功后打开：

```text
http://localhost:3000/dashboard.html
```

后端默认监听 `3000` 端口。后端启动后会提供：

```text
GET  /api/health
POST /api/auth/login
POST /api/auth/register
POST /api/ai/generate/image
POST /api/ai/generate/ppt
GET  /api/files
POST /api/files/upload
```

后端入口中明确挂载了 `/api/ai`、`/api/files`、`/api/auth`、`/api/admin` 等路由，并托管前端页面。([GitHub][2])

---

## 8. 一键启动方式

仓库提供了 Windows 一键启动脚本：

```bat
start_all.bat
```

它会依次检查并启动：

1. Node.js / npm；
2. 图片服务：

   * 如果 `IMAGE_PROVIDER=local-openvino`、`openvino`、`sd-turbo-local`，或 `IMAGE_BASE_URL` 指向 `127.0.0.1:18081`，会启动 `local-openvino-server/start_windows.bat`；
   * 如果是真实 API 模式，则跳过本地图片服务；
   * 否则会启动离线占位图片服务。
3. PPT / 文本服务：

   * 如果 `PPT_PROVIDER=local` 且 `ENABLE_LOCAL_PPT` 不是 `false`，会启动 `local-text-server/start_windows.bat`；
   * 如果是真实文本 API 模式，则跳过本地文本服务。
4. 安装后端依赖；
5. 启动后端 `node src/index.js`。([GitHub][4])

启动完成后访问：

```text
http://localhost:3000/dashboard.html
```

---

## 9. 图片生成请求流

图片生成的推荐本地流程如下：

```text
浏览器 image.html
   ↓
POST /api/ai/generate/image
   ↓
backend/src/routes/ai.js
   ↓
backend/src/services/aiService.js
   ↓
优先请求 local-openvino-server
   ↓
POST http://127.0.0.1:18081/v1/images/generations
   ↓
成功：返回 b64 图片，后端保存并展示
失败/超时：回退到 Pollinations API
   ↓
返回图片结果
```

本地 OpenVINO 服务内部流程：

```text
FastAPI app.py
   ↓
读取 local-openvino-server/.env
   ↓
加载 OpenVINO / Diffusers pipeline
   ↓
检查模型目录或自动下载模型
   ↓
生成 PNG
   ↓
返回 OpenAI-compatible 格式：
{
  "created": 1234567890,
  "data": [
    { "b64_json": "..." }
  ],
  "model": "..."
}
```

`local-openvino-server/app.py` 的 `/v1/images/generations` 会读取 prompt、size、n、steps、guidance_scale 等参数，并返回 `b64_json` 图片数据；如果本地模型加载或生成失败，会返回 503。([GitHub][9])

---

## 10. PPT 生成请求流

PPT 生成流程如下：

```text
浏览器 ppt.html
   ↓
POST /api/ai/generate/ppt
   ↓
backend/src/routes/ai.js
   ↓
PPT Agent / PPT Service
   ↓
文本模型服务
   ├─ 本地 local-text-server: http://127.0.0.1:18082/v1/chat/completions
   └─ 或 OpenAI-compatible 文本 API
   ↓
生成 PPT 大纲、页面文案、视觉描述
   ↓
后端生成 PPT 页面/文件
   ↓
前端展示或下载结果
```

本地 `local-text-server` 主要用于跑通开发流程。它实现了 `/v1/chat/completions`，并在识别到 PPT、slide、演示、幻灯片等关键词时返回模板化的 PPT 结构建议。([GitHub][10])

如果要让 PPT 质量更高，建议把文本服务替换成真实模型，例如：

```env
PPT_PROVIDER=openai-compatible
ENABLE_LOCAL_PPT=false
TEXT_API_BASE_URL=http://127.0.0.1:11434/v1
TEXT_API_KEY=ollama
TEXT_MODEL=qwen3
```

或：

```env
PPT_PROVIDER=openai-compatible
ENABLE_LOCAL_PPT=false
TEXT_API_BASE_URL=https://your-provider.example/v1
TEXT_API_KEY=your-api-key
TEXT_MODEL=your-model-name
```

---

## 11. 常见问题

### 11.1 Python 版本不对

如果运行 `local-openvino-server/setup_windows.bat` 提示 Python 不支持，请安装 Python 3.10 或 3.11。

可以并存安装，不需要卸载系统里的 Python 3.12。脚本会优先尝试 `py -3.11` 或 `py -3.10`。([GitHub][3])

---

### 11.2 OpenVINO 模型目录不完整

如果访问：

```text
http://127.0.0.1:18081/health?load=true
```

看到模型目录不完整，通常是模型下载中断。

处理方式：

```bat
cd local-openvino-server
rmdir /s /q models\sd-turbo-openvino
start_windows.bat
```

或者手动重新下载 `rupeshs/sd-turbo-openvino` 到：

```text
local-openvino-server/models/sd-turbo-openvino
```

服务会检查 `model_index.json` 是否存在，用来判断模型目录是否有效。([GitHub][9])

---

### 11.3 端口被占用

默认端口：

```text
3000   后端服务
18081  本地 OpenVINO 图片服务
18082  本地文本服务
```

`start_all.bat` 会检查这些端口，如果端口已经在监听，会跳过对应服务启动。([GitHub][4])

---

### 11.4 PPT 生成内容很简单

这是正常的。

默认 `local-text-server` 是 mock 文本服务，主要用于本地流程联调，不负责高质量内容生成。想生成更好的 PPT，需要接入真实文本模型，例如 Ollama、Qwen、OpenAI-compatible API 等。

---

### 11.5 图片本地生成慢或失败

本地 OpenVINO SD-Turbo 默认使用 CPU，首次加载模型会比较慢。建议：

```env
LOCAL_IMAGE_SIZE=512x512
LOCAL_IMAGE_STEPS=2
LOCAL_IMAGE_MAX_IMAGES=1
```

仓库默认配置也把尺寸限制在较保守范围内，`app.py` 会把图片宽高限制在 256 到 512 之间，并按 8 的倍数修正，以适配 16GB 内存和普通 Intel 核显/CPU 场景。([GitHub][9])

如果本地失败，可以临时切到 Pollinations：

```env
ENABLE_LOCAL_IMAGE=false
IMAGE_PROVIDER=pollinations
IMAGE_BASE_URL=https://image.pollinations.ai
IMAGE_MODEL=flux
IMAGE_TIMEOUT_MS=600000
```

---

## 12. 推荐开发启动顺序

第一次配置：

```bat
git clone -b version-3 https://github.com/fregding/aidesigner.git
cd aidesigner

cd backend
npm install
cd ..

cd local-openvino-server
setup_windows.bat
cd ..
```

日常启动：

```bat
start_all.bat
```

手动分窗口启动：

```bat
cd local-openvino-server
start_windows.bat
```

```bat
cd local-text-server
start_windows.bat
```

```bat
cd backend
set ENV_FILE=%cd%\.env.local
node src/index.js
```

然后访问：

```text
http://localhost:3000/dashboard.html
```

---

## 13. 简要架构说明

```text
┌─────────────────────────┐
│        Browser           │
│ dashboard/image/ppt HTML │
└───────────┬─────────────┘
            │
            │ HTTP
            ▼
┌─────────────────────────┐
│     Node.js Backend      │
│ Express / API / Auth     │
│ Port: 3000               │
└───────┬─────────┬───────┘
        │         │
        │         │
        ▼         ▼
┌──────────────┐  ┌────────────────┐
│ Image Flow   │  │ PPT Flow        │
│ aiService    │  │ PptAgent/Service│
└──────┬───────┘  └───────┬────────┘
       │                  │
       ▼                  ▼
┌──────────────────┐  ┌──────────────────┐
│ local-openvino    │  │ local-text-server │
│ FastAPI / 18081   │  │ Node / 18082      │
│ SD-Turbo OpenVINO │  │ mock or LLM API   │
└────────┬─────────┘  └──────────────────┘
         │
         │ fail / timeout
         ▼
┌──────────────────┐
│ Pollinations API  │
│ image fallback    │
└──────────────────┘
```

核心思想：

* 前端不直接调用模型服务，只调用 Node 后端。
* Node 后端负责鉴权、任务记录、文件保存、模型服务路由和 fallback。
* 本地图片服务只负责把 prompt 变成图片。
* 本地文本服务只负责提供 Chat Completions 风格文本输出。
* PPT 生成由后端组织流程，文本模型只提供内容和结构。

---

另外我建议你在仓库里补一个 `backend/.env.local.example`，因为现在 `start_all.bat` 会尝试从 `backend\.env.local.SD-Turbo.clean` 创建本地配置；如果别人 clone 后没有这个文件，一键启动会卡住。脚本里确实写了找不到该模板就报错退出。([GitHub][4])

[1]: https://github.com/fregding/aidesigner/tree/version-3 "GitHub - fregding/aidesigner at version-3 · GitHub"
[2]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/backend/src/index.js "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/local-openvino-server/setup_windows.bat "raw.githubusercontent.com"
[4]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/start_all.bat "raw.githubusercontent.com"
[5]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/backend/src/config/appConfig.js "raw.githubusercontent.com"
[6]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/fix_sqlite_and_enable_pollinations.bat "raw.githubusercontent.com"
[7]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/backend/package.json "raw.githubusercontent.com"
[8]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/local-openvino-server/.env.example "raw.githubusercontent.com"
[9]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/local-openvino-server/app.py "raw.githubusercontent.com"
[10]: https://raw.githubusercontent.com/fregding/aidesigner/version-3/local-text-server/app.js "raw.githubusercontent.com"
