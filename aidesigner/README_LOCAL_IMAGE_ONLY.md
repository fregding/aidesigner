# AI Designer 本地图片版

这个版本已按本地图片生成 MVP 改造：

- 后端地址：`http://localhost:3000`
- 管理员账号：`admin@localhost`
- 管理员密码：`AdminLocal@2026`
- 本地图片接口：`http://127.0.0.1:18080`
- 图片接口密钥：`local-ai-dev-key`

默认只启用：登录/注册、用户中心、管理后台、图片生成、任务历史、图库保存。

默认关闭：视频、PPT、支付宝、Tavily 搜索、外部 AI 助手。

## Windows 一键启动

```bat
scripts\start-local.bat
```

这会分别启动：

1. `local-image-server`，监听 `127.0.0.1:18080`
2. Node 后端，监听 `localhost:3000`

## 分开启动

图片模型服务：

```bat
cd local-image-server
start_local_image_server.bat
```

后端：

```bat
cd backend
npm install
npm run init-db
npm start
```

## 模型下载策略

模型不会放进 Git，也不会打进压缩包。首次运行会下载到：

```text
runtime/hf-cache
```

默认模型：

```text
OpenVINO/stable-diffusion-v1-5-int8-ov
```

如果你想手动下载，先把模型放到 Hugging Face 缓存或修改 `local-image-server/.env` 的 `LOCAL_IMAGE_MODEL_ID` 指向本地目录。

## 先验证后端链路

如果暂时不想下载真实模型，可把 `local-image-server/.env` 里的：

```env
LOCAL_IMAGE_BACKEND=openvino
```

改成：

```env
LOCAL_IMAGE_BACKEND=mock
```

这样会生成占位图，用来确认登录、任务、保存、图库链路都正常。

## 机器建议

你的 i7-13700H + Iris Xe + 16GB RAM 建议先跑 512x512、单张、低并发。首次加载和首次生成会比较慢。
