import base64
import io
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

load_dotenv()

APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = Path(os.getenv("LOCAL_IMAGE_OUTPUT_DIR", APP_DIR / "outputs")).resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR = Path(os.getenv("LOCAL_IMAGE_CACHE_DIR", APP_DIR / "cache")).resolve()
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HOST = os.getenv("LOCAL_IMAGE_HOST", "127.0.0.1")
PORT = int(os.getenv("LOCAL_IMAGE_PORT", "18081"))
ENGINE = os.getenv("LOCAL_IMAGE_ENGINE", "openvino").strip().lower()
DEVICE = os.getenv("OPENVINO_DEVICE", "CPU").strip() or "CPU"
MODEL_ID = os.getenv("LOCAL_MODEL_ID", "rupeshs/sd-turbo-openvino").strip()
MODEL_DIR = Path(os.getenv("LOCAL_MODEL_DIR", APP_DIR / "models" / "sd-turbo-openvino")).resolve()
ALLOW_DOWNLOAD = os.getenv("LOCAL_IMAGE_ALLOW_DOWNLOAD", "false").strip().lower() in {"1", "true", "yes", "on"}
DEFAULT_SIZE = os.getenv("LOCAL_IMAGE_SIZE", "512x512")
DEFAULT_STEPS = int(os.getenv("LOCAL_IMAGE_STEPS", "1"))
DEFAULT_GUIDANCE = float(os.getenv("LOCAL_IMAGE_GUIDANCE_SCALE", "1.0"))
MAX_IMAGES = max(1, min(int(os.getenv("LOCAL_IMAGE_MAX_IMAGES", "1")), 4))
PRELOAD = os.getenv("LOCAL_IMAGE_PRELOAD", "false").strip().lower() in {"1", "true", "yes", "on"}

app = FastAPI(title="AI Designer Local OpenVINO Image Server", version="1.0.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_pipeline = None
_pipeline_error: Optional[str] = None
_last_generation_error: Optional[str] = None
_last_loaded_from: Optional[str] = None


class ImageGenerationRequest(BaseModel):
    model: Optional[str] = None
    prompt: str
    size: Optional[str] = None
    n: Optional[int] = 1
    quality: Optional[str] = None
    output_format: Optional[str] = "png"
    response_format: Optional[str] = None
    seed: Optional[int] = None
    steps: Optional[int] = None
    num_inference_steps: Optional[int] = None
    guidance_scale: Optional[float] = None


def _short_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def _trace_error(exc: BaseException) -> str:
    return f"{_short_error(exc)}\n{traceback.format_exc()}"


def _model_dir_looks_valid(path: Path) -> bool:
    if not path.exists() or not path.is_dir():
        return False
    # Hugging Face OpenVINO diffusion repos normally contain model_index.json.
    # Some partial downloads only contain .cache or refs; do not treat them as a valid model.
    return (path / "model_index.json").exists()


def _resolve_model_source() -> str:
    if _model_dir_looks_valid(MODEL_DIR):
        return str(MODEL_DIR)
    if MODEL_DIR.exists() and any(MODEL_DIR.iterdir()):
        raise RuntimeError(
            f"Model directory exists but is incomplete: {MODEL_DIR}. "
            "Expected model_index.json. Re-download with: "
            "huggingface-cli download rupeshs/sd-turbo-openvino --local-dir models\\sd-turbo-openvino --local-dir-use-symlinks False"
        )
    if not ALLOW_DOWNLOAD:
        raise RuntimeError(
            f"Model directory not found: {MODEL_DIR}. Download it first or set LOCAL_IMAGE_ALLOW_DOWNLOAD=true."
        )
    return MODEL_ID


def _parse_size(size: Optional[str]) -> tuple[int, int]:
    raw = str(size or DEFAULT_SIZE or "512x512").lower().replace(" ", "")
    if raw in {"auto", "", "none", "null"}:
        raw = DEFAULT_SIZE or "512x512"
    if "x" not in raw:
        return 512, 512
    left, right = raw.split("x", 1)
    try:
        width = int(left)
        height = int(right)
    except ValueError:
        return 512, 512
    # Keep the default conservative for 16 GB RAM / Intel integrated graphics.
    width = max(256, min(width, 512))
    height = max(256, min(height, 512))
    width = (width // 8) * 8
    height = (height // 8) * 8
    return width or 512, height or 512


def _image_to_b64_png(image: Image.Image) -> str:
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _load_pipeline():
    global _pipeline, _pipeline_error, _last_loaded_from
    if _pipeline is not None:
        return _pipeline
    if _pipeline_error:
        raise RuntimeError(_pipeline_error)

    try:
        source = _resolve_model_source()
        _last_loaded_from = source
        print(f"[Local OpenVINO] Loading pipeline: engine={ENGINE} device={DEVICE} source={source}", flush=True)

        if ENGINE == "openvino":
            # Import path used by the model card of rupeshs/sd-turbo-openvino.
            try:
                from optimum.intel.openvino.modeling_diffusion import OVStableDiffusionPipeline
            except Exception:
                from optimum.intel.openvino import OVStableDiffusionPipeline

            kwargs: Dict[str, Any] = {
                "ov_config": {"CACHE_DIR": str(CACHE_DIR)},
            }
            # optimum-intel versions differ: some accept device in from_pretrained, some expose .to().
            try:
                _pipeline = OVStableDiffusionPipeline.from_pretrained(source, device=DEVICE, **kwargs)
            except TypeError:
                _pipeline = OVStableDiffusionPipeline.from_pretrained(source, **kwargs)
                try:
                    _pipeline.to(DEVICE)
                except Exception:
                    pass
        elif ENGINE == "diffusers":
            # CPU fallback. Slower than OpenVINO, but useful if optimum-intel has installation issues.
            import torch
            from diffusers import AutoPipelineForText2Image

            _pipeline = AutoPipelineForText2Image.from_pretrained(source, torch_dtype=torch.float32)
            _pipeline = _pipeline.to("cpu")
        else:
            raise RuntimeError(f"Unsupported LOCAL_IMAGE_ENGINE={ENGINE!r}. Use openvino or diffusers.")

        print("[Local OpenVINO] Pipeline loaded successfully.", flush=True)
        _pipeline_error = None
        return _pipeline
    except Exception as exc:
        _pipeline_error = _trace_error(exc)
        print("[Local OpenVINO] Pipeline load failed:", _pipeline_error, file=sys.stderr, flush=True)
        raise


@app.on_event("startup")
def _startup_preload():
    print(
        f"[Local OpenVINO] Server starting. engine={ENGINE} device={DEVICE} model_dir={MODEL_DIR} preload={PRELOAD}",
        flush=True,
    )
    if PRELOAD:
        try:
            _load_pipeline()
        except Exception:
            # Keep server alive so /health can report the exact error and Node can fallback.
            pass


@app.get("/health")
def health(load: bool = Query(False, description="Set true to try loading the model before returning health.")):
    if load and _pipeline is None and _pipeline_error is None:
        try:
            _load_pipeline()
        except Exception:
            pass
    return {
        "ok": _pipeline_error is None,
        "loaded": _pipeline is not None,
        "engine": ENGINE,
        "device": DEVICE,
        "model_id": MODEL_ID,
        "model_dir": str(MODEL_DIR),
        "model_dir_exists": MODEL_DIR.exists(),
        "model_dir_valid": _model_dir_looks_valid(MODEL_DIR),
        "loaded_from": _last_loaded_from,
        "allow_download": ALLOW_DOWNLOAD,
        "default_size": DEFAULT_SIZE,
        "default_steps": DEFAULT_STEPS,
        "default_guidance_scale": DEFAULT_GUIDANCE,
        "python": sys.version,
        "pipeline_error": _pipeline_error,
        "last_generation_error": _last_generation_error,
    }


@app.post("/v1/images/generations")
def images_generations(payload: ImageGenerationRequest, request: Request):
    global _last_generation_error
    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    width, height = _parse_size(payload.size)
    n = max(1, min(int(payload.n or 1), MAX_IMAGES))
    steps = max(1, min(int(payload.num_inference_steps or payload.steps or DEFAULT_STEPS), 4))
    guidance = float(payload.guidance_scale if payload.guidance_scale is not None else DEFAULT_GUIDANCE)

    try:
        pipe = _load_pipeline()
        images = []
        for i in range(n):
            kwargs: Dict[str, Any] = {
                "prompt": prompt,
                "width": width,
                "height": height,
                "num_inference_steps": steps,
                "guidance_scale": guidance,
            }
            if payload.seed is not None:
                # OpenVINO pipelines do not consistently accept torch.Generator. Keep seed best-effort via numpy.
                try:
                    import numpy as np

                    np.random.seed(int(payload.seed) + i)
                except Exception:
                    pass
            print(
                f"[Local OpenVINO] Generating image size={width}x{height} steps={steps} guidance={guidance} prompt_chars={len(prompt)}",
                flush=True,
            )
            result = pipe(**kwargs)
            image = result.images[0]
            images.append({"b64_json": _image_to_b64_png(image)})

        _last_generation_error = None
        return {
            "created": int(time.time()),
            "data": images,
            "model": payload.model or MODEL_ID,
            "local_provider": {
                "engine": ENGINE,
                "device": DEVICE,
                "size": f"{width}x{height}",
                "steps": steps,
                "guidance_scale": guidance,
            },
        }
    except Exception as exc:
        _last_generation_error = _trace_error(exc)
        print("[Local OpenVINO] Generation failed:", _last_generation_error, file=sys.stderr, flush=True)
        # Return 503 so the Node backend can fall back to Pollinations automatically.
        raise HTTPException(status_code=503, detail=f"Local model generation failed: {_short_error(exc)}")


@app.post("/v1/images/edits")
def images_edits():
    raise HTTPException(
        status_code=501,
        detail="Local image edit is not supported yet. Text-to-image fallback can still use Pollinations.",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host=HOST, port=PORT, reload=False)
