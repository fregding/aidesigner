import base64
import os
import struct
import time
import zlib
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_HOST = os.getenv('LOCAL_IMAGE_HOST', '0.0.0.0')
APP_PORT = int(os.getenv('LOCAL_IMAGE_PORT', '18080'))
API_KEY = os.getenv('LOCAL_IMAGE_API_KEY', 'local-dev-key')
BACKEND = os.getenv('LOCAL_IMAGE_BACKEND', 'mock-stdlib')
MODEL = os.getenv('LOCAL_IMAGE_MODEL_ID', 'local-mock-image')
MAX_N = int(os.getenv('LOCAL_IMAGE_MAX_N', '1'))

app = FastAPI(title='AI Designer Local Image Server', version='0.1.1')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


class ImageGenerationRequest(BaseModel):
    model: Optional[str] = None
    prompt: str = Field(default='')
    size: Optional[str] = '512x512'
    n: Optional[int] = 1
    quality: Optional[str] = None
    output_format: Optional[str] = 'png'
    user: Optional[str] = None


def check_auth(authorization: Optional[str]):
    if not API_KEY:
        return
    expected = f'Bearer {API_KEY}'
    if authorization != expected:
        raise HTTPException(status_code=401, detail='Invalid local image API key')


def parse_size(size: Optional[str]):
    raw = (size or '512x512').lower().strip()
    if ':' in raw:
        mapping = {
            '1:1': (512, 512),
            '4:3': (640, 480),
            '3:4': (480, 640),
            '16:9': (768, 432),
            '9:16': (432, 768),
        }
        return mapping.get(raw, (512, 512))
    parts = raw.replace('*', 'x').split('x')
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        width = max(128, min(int(parts[0]), 1024))
        height = max(128, min(int(parts[1]), 1024))
        return width, height
    return 512, 512


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack('>I', len(data))
        + chunk_type
        + data
        + struct.pack('>I', zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def make_mock_png(prompt: str, size: str, index: int = 0) -> bytes:
    """Create a valid RGB PNG using only Python stdlib.

    This avoids Pillow, so the phase-1 mock service works on Python 3.14
    without native build tools or zlib headers.
    """
    width, height = parse_size(size)
    seed = zlib.crc32((prompt or 'empty').encode('utf-8')) + index * 9973
    rows = []
    for y in range(height):
        row = bytearray([0])  # PNG filter type 0
        for x in range(width):
            # Deterministic soft gradient / blocks, enough to prove the image pipeline works.
            r = 80 + ((x * 3 + y + seed) % 150)
            g = 95 + ((x + y * 2 + seed // 7) % 135)
            b = 120 + ((x * 2 + y * 3 + seed // 13) % 110)
            # Light central card area.
            if width * 0.12 < x < width * 0.88 and height * 0.18 < y < height * 0.82:
                r = int(r * 0.35 + 245 * 0.65)
                g = int(g * 0.35 + 247 * 0.65)
                b = int(b * 0.35 + 251 * 0.65)
            row.extend((r, g, b))
        rows.append(bytes(row))

    raw = b''.join(rows)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', ihdr)
        + png_chunk(b'tEXt', f'Prompt\x00{prompt[:500]}'.encode('utf-8', errors='replace'))
        + png_chunk(b'tEXt', f'Generated\x00{datetime.now().isoformat()}'.encode('utf-8'))
        + png_chunk(b'IDAT', zlib.compress(raw, level=6))
        + png_chunk(b'IEND', b'')
    )


def make_mock_image(prompt: str, size: str, index: int = 0) -> str:
    return base64.b64encode(make_mock_png(prompt, size, index)).decode('ascii')


@app.get('/health')
def health():
    return {
        'ok': True,
        'backend': BACKEND,
        'model': MODEL,
        'device': 'CPU/mock-stdlib',
        'time': int(time.time()),
        'note': 'phase-1 mock service, no Pillow required',
    }


@app.post('/v1/images/generations')
def generate_images(payload: ImageGenerationRequest, authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)
    prompt = (payload.prompt or '').strip()
    if not prompt:
        raise HTTPException(status_code=400, detail='prompt is required')
    count = max(1, min(int(payload.n or 1), MAX_N))
    size = payload.size or '512x512'
    return {
        'created': int(time.time()),
        'data': [
            {'b64_json': make_mock_image(prompt, size, i)}
            for i in range(count)
        ],
        'model': payload.model or MODEL,
        'backend': BACKEND,
    }


@app.post('/v1/images/edits')
def edit_images(authorization: Optional[str] = Header(default=None)):
    check_auth(authorization)
    raise HTTPException(status_code=501, detail='mock service only supports text-to-image in phase 1')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run('app:app', host=APP_HOST, port=APP_PORT, reload=False)
