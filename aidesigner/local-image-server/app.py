import base64
import io
import os
import random
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Header, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

if load_dotenv:
    load_dotenv(Path(__file__).with_name('.env'))

API_KEY = os.getenv('LOCAL_IMAGE_API_KEY', 'local-ai-dev-key').strip()
BACKEND = os.getenv('LOCAL_IMAGE_BACKEND', 'openvino').strip().lower()
MODEL_ID = os.getenv('LOCAL_IMAGE_MODEL_ID', 'OpenVINO/stable-diffusion-v1-5-int8-ov').strip()
DEVICE = os.getenv('LOCAL_IMAGE_DEVICE', 'CPU').strip()
CACHE_DIR = Path(os.getenv('LOCAL_IMAGE_CACHE_DIR', '../runtime/hf-cache')).expanduser().resolve()
OUTPUT_DIR = Path(os.getenv('LOCAL_IMAGE_OUTPUT_DIR', '../runtime/generated')).expanduser().resolve()
MAX_SIZE = max(256, min(1024, int(os.getenv('LOCAL_IMAGE_MAX_SIZE', '512') or '512')))
DEFAULT_STEPS = max(1, min(50, int(os.getenv('LOCAL_IMAGE_STEPS', '12') or '12')))
DEFAULT_GUIDANCE_SCALE = float(os.getenv('LOCAL_IMAGE_GUIDANCE_SCALE', '7.0') or '7.0')
ALLOW_DOWNLOAD = os.getenv('LOCAL_IMAGE_ALLOW_DOWNLOAD', '1').strip().lower() not in {'0', 'false', 'no', 'off'}

CACHE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title='AI Designer Local Image Server', version='1.0.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:3000', 'http://127.0.0.1:3000'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

_pipeline = None
_pipeline_lock = threading.Lock()
_pipeline_error = None


def _round_to_8(value: int) -> int:
    return max(256, min(MAX_SIZE, int(round(value / 8) * 8)))


def parse_size(size: str = '512x512') -> Tuple[int, int]:
    raw = str(size or '').lower().strip()
    if raw == 'auto' or 'x' not in raw:
        return MAX_SIZE, MAX_SIZE
    try:
        width_s, height_s = raw.split('x', 1)
        width = int(width_s)
        height = int(height_s)
    except Exception:
        return MAX_SIZE, MAX_SIZE
    scale = min(1.0, MAX_SIZE / max(width, height, 1))
    width = _round_to_8(width * scale)
    height = _round_to_8(height * scale)
    return width, height


def check_auth(authorization: Optional[str]) -> None:
    if not API_KEY:
        return
    expected = f'Bearer {API_KEY}'
    if authorization != expected:
        raise HTTPException(status_code=401, detail='Invalid local image API key')


def image_to_b64(image: Image.Image, fmt: str = 'PNG') -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return base64.b64encode(buffer.getvalue()).decode('utf-8')


def make_mock_image(prompt: str, width: int, height: int) -> Image.Image:
    image = Image.new('RGB', (width, height), (245, 245, 245))
    draw = ImageDraw.Draw(image)
    title = 'LOCAL IMAGE SERVER\nmock backend'
    draw.rectangle((16, 16, width - 16, height - 16), outline=(80, 80, 80), width=2)
    draw.text((32, 32), title, fill=(30, 30, 30))
    wrapped = str(prompt or '')[:160]
    y = 96
    for i in range(0, len(wrapped), 28):
        draw.text((32, y), wrapped[i:i + 28], fill=(60, 60, 60))
        y += 24
    return image


def load_pipeline():
    global _pipeline, _pipeline_error
    if _pipeline is not None:
        return _pipeline
    if _pipeline_error is not None:
        raise _pipeline_error
    with _pipeline_lock:
        if _pipeline is not None:
            return _pipeline
        try:
            if BACKEND == 'mock':
                _pipeline = 'mock'
                return _pipeline
            if BACKEND == 'openvino':
                from optimum.intel.openvino import OVStableDiffusionPipeline
                kwargs: Dict[str, Any] = {
                    'cache_dir': str(CACHE_DIR),
                    'local_files_only': not ALLOW_DOWNLOAD,
                }
                try:
                    pipe = OVStableDiffusionPipeline.from_pretrained(MODEL_ID, device=DEVICE, **kwargs)
                except TypeError:
                    kwargs.pop('local_files_only', None)
                    pipe = OVStableDiffusionPipeline.from_pretrained(MODEL_ID, **kwargs)
                    try:
                        pipe.to(DEVICE)
                    except Exception:
                        pass
                _pipeline = pipe
                return _pipeline
            if BACKEND == 'diffusers':
                import torch
                from diffusers import StableDiffusionPipeline
                dtype = torch.float32
                pipe = StableDiffusionPipeline.from_pretrained(
                    MODEL_ID,
                    torch_dtype=dtype,
                    cache_dir=str(CACHE_DIR),
                    local_files_only=not ALLOW_DOWNLOAD,
                    safety_checker=None,
                    requires_safety_checker=False,
                )
                pipe = pipe.to('cpu')
                try:
                    pipe.enable_attention_slicing()
                except Exception:
                    pass
                _pipeline = pipe
                return _pipeline
            raise RuntimeError(f'Unsupported LOCAL_IMAGE_BACKEND={BACKEND}')
        except Exception as exc:
            _pipeline_error = RuntimeError(
                '本地图片模型加载失败。请确认已安装 requirements.txt，且模型已下载到缓存目录；'
                f'backend={BACKEND}, model={MODEL_ID}, cache={CACHE_DIR}. 原始错误: {exc}'
            )
            raise _pipeline_error


def generate_one(prompt: str, width: int, height: int, steps: int, guidance_scale: float, seed: Optional[int]) -> Image.Image:
    pipe = load_pipeline()
    if pipe == 'mock':
        return make_mock_image(prompt, width, height)

    generator = None
    if seed is not None:
        try:
            import torch
            generator = torch.Generator(device='cpu').manual_seed(seed)
        except Exception:
            generator = None

    kwargs: Dict[str, Any] = {
        'prompt': prompt,
        'width': width,
        'height': height,
        'num_inference_steps': steps,
        'guidance_scale': guidance_scale,
    }
    if generator is not None:
        kwargs['generator'] = generator
    result = pipe(**kwargs)
    images = getattr(result, 'images', None) or result[0]
    if not images:
        raise RuntimeError('Pipeline returned no images')
    return images[0].convert('RGB')


class ImageGenerationRequest(BaseModel):
    model: str = Field(default='local-sd15-openvino')
    prompt: str
    size: str = Field(default='512x512')
    n: int = Field(default=1, ge=1, le=4)
    quality: Optional[str] = None
    output_format: Optional[str] = Field(default='png')
    response_format: Optional[str] = Field(default='b64_json')
    user: Optional[str] = None
    seed: Optional[int] = None
    num_inference_steps: Optional[int] = None
    guidance_scale: Optional[float] = None


@app.get('/health')
def health():
    return {
        'status': 'ok',
        'backend': BACKEND,
        'model': MODEL_ID,
        'device': DEVICE,
        'cache_dir': str(CACHE_DIR),
        'max_size': MAX_SIZE,
    }


@app.get('/v1/models')
def models(authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)
    return {'object': 'list', 'data': [{'id': 'local-sd15-openvino', 'object': 'model', 'owned_by': 'local'}]}


@app.post('/v1/images/generations')
def image_generations(payload: ImageGenerationRequest, authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)
    width, height = parse_size(payload.size)
    count = max(1, min(int(payload.n or 1), 4))
    steps = max(1, min(50, int(payload.num_inference_steps or DEFAULT_STEPS)))
    guidance_scale = float(payload.guidance_scale or DEFAULT_GUIDANCE_SCALE)
    base_seed = payload.seed
    if base_seed is None and os.getenv('LOCAL_IMAGE_SEED'):
        base_seed = int(os.getenv('LOCAL_IMAGE_SEED'))
    data: List[Dict[str, str]] = []
    for index in range(count):
        seed = None if base_seed is None else int(base_seed) + index
        image = generate_one(payload.prompt, width, height, steps, guidance_scale, seed)
        fmt = 'JPEG' if str(payload.output_format).lower() in {'jpg', 'jpeg'} else 'PNG'
        data.append({'b64_json': image_to_b64(image, fmt), 'revised_prompt': payload.prompt})
    return {'created': int(time.time()), 'data': data}


@app.post('/v1/images/edits')
async def image_edits(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    prompt: str = Form(...),
    model: str = Form(default='local-sd15-openvino'),
    size: str = Form(default='512x512'),
    n: int = Form(default=1),
    output_format: str = Form(default='png'),
    image: Optional[UploadFile] = File(default=None),
):
    # 本地轻量版暂不做真正图生图/局部编辑；为了兼容原工程参考图表单，这里只使用 prompt 进行文生图。
    check_auth(authorization)
    payload = ImageGenerationRequest(model=model, prompt=prompt, size=size, n=n, output_format=output_format)
    return image_generations(payload, authorization=authorization)


if __name__ == '__main__':
    import uvicorn
    host = os.getenv('LOCAL_IMAGE_HOST', '127.0.0.1')
    port = int(os.getenv('LOCAL_IMAGE_PORT', '18080') or '18080')
    uvicorn.run(app, host=host, port=port)
