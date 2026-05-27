# Stage 1 Real Image Changelog

## Added

- `configure_real_image_api.bat`
  - Switches the project from offline placeholder images to a real OpenAI-compatible image API.
- `reset_to_offline_image.bat`
  - Switches back to offline placeholder mode.
- `test_real_image_api.bat`
  - Tests the configured image API directly.
- `README_STAGE1_REAL_IMAGE.md`
  - Explains real image API mode and offline mode.
- `GET /api/ai/image-provider/status`
  - Returns current provider information for debugging.

## Changed

- `backend/src/services/aiService.js`
  - Added explicit provider modes:
    - `mock`
    - `openai-compatible`
    - `real-api`
    - `localai`
  - Prevented accidental use of the offline placeholder when real API mode is configured.
  - Real image mode reads:
    - `IMAGE_PROVIDER`
    - `IMAGE_BASE_URL`
    - `IMAGE_API_KEY`
    - `IMAGE_MODEL`
- `start_all.bat`
  - Starts the local placeholder image server only in `mock` mode.
  - Skips the placeholder server in real API mode.

## Default behavior

The package still starts out of the box with placeholder mode:

```env
ENABLE_LOCAL_IMAGE=true
IMAGE_PROVIDER=mock
```

To enable real image generation, run:

```bat
configure_real_image_api.bat
```
