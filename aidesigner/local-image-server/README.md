# 本地图片模型服务

该服务提供 OpenAI 兼容图片接口：

- `GET /health`
- `GET /v1/models`
- `POST /v1/images/generations`
- `POST /v1/images/edits`（兼容表单，当前轻量版会忽略参考图，只按 prompt 文生图）

默认地址和密钥：

```text
http://127.0.0.1:18080
local-ai-dev-key
```

默认模型：`OpenVINO/stable-diffusion-v1-5-int8-ov`。首次运行会下载到 `../runtime/hf-cache`，不会进入 Git。

Windows 启动：

```bat
start_local_image_server.bat
```

macOS/Linux 启动：

```bash
bash start_local_image_server.sh
```

如果只是想先验证后端链路，不加载真实模型，可以把 `.env` 中的 `LOCAL_IMAGE_BACKEND=openvino` 改成：

```env
LOCAL_IMAGE_BACKEND=mock
```

真实生成建议先保持 512x512、单图、低并发。你的 i7-13700H + Iris Xe + 16GB RAM 可以做本地 Demo，但速度会明显慢于云端 GPU。
