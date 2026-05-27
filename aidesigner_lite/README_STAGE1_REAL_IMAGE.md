# Stage 1 Real Image API Integration

## What changed

This version separates image generation into two modes:

1. **Offline placeholder mode**  
   - Default mode.
   - Starts `local-image-server/app-node.js`.
   - Does not require GPU, Python, Docker, SD WebUI, or API key.
   - Used only to verify the project pipeline.

2. **Real image API mode**
   - Uses a real OpenAI-compatible image generation API.
   - Supports services that implement:

```text
POST /v1/images/generations
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

and return:

```json
{
  "data": [
    {
      "b64_json": "..."
    }
  ]
}
```

This is compatible with many gateway APIs and can also be used with a self-hosted LocalAI-style endpoint if its image API follows the OpenAI format.

## Why not bundle Stable Diffusion WebUI directly?

The target machine has Intel Iris Xe integrated graphics and 16GB RAM. Bundling SD WebUI or large diffusion weights would make the project very large and unreliable on this computer.

So Stage 1 chooses the safest route:

```text
Project one-click start
  -> Backend
  -> Real OpenAI-compatible image API
```

If no real API is configured, the project falls back to the offline placeholder service.

## How to use real image generation

Double-click:

```bat
configure_real_image_api.bat
```

Enter:

```text
Image API Base URL: https://your-provider.example/v1
Image API Key: your-key
Image model name: gpt-image-1
```

Then close old windows and run:

```bat
start_all.bat
```

## How to return to offline mode

Double-click:

```bat
reset_to_offline_image.bat
```

Then run:

```bat
start_all.bat
```

## Manual configuration

Edit:

```text
backend/.env.local
```

Real API mode:

```env
ENABLE_LOCAL_IMAGE=false
IMAGE_PROVIDER=openai-compatible
IMAGE_BASE_URL=https://your-provider.example/v1
IMAGE_API_KEY=your-api-key
IMAGE_MODEL=gpt-image-1
```

Offline placeholder mode:

```env
ENABLE_LOCAL_IMAGE=true
IMAGE_PROVIDER=mock
LOCAL_IMAGE_API_BASE_URL=http://127.0.0.1:18080/v1
LOCAL_IMAGE_API_KEY=local-dev-key
LOCAL_IMAGE_MODEL=local-cpu-safe-image
```

## Important

No free API key is included in this package. You must use your own provider key, or point it to your own LocalAI/OpenAI-compatible service.
