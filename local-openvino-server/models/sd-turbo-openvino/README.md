---
language:
- en
pipeline_tag: text-to-image
tags:
- stablediffusion
- openvino
- sdturbo
---

The SD Turbo model is converted to OpenVINO for fast inference on CPU. This model is intended for research purpose only. 

Original Model : [sd-turbo](https://huggingface.co/stabilityai/sd-turbo)

You can use this model with [FastSD CPU](https://github.com/rupeshs/fastsdcpu).

![Sample](./sample.png)

To run the model yourself, you can leverage the 🧨 Diffusers library:

1. Install the dependencies:
```
pip install optimum-intel openvino diffusers onnx
```
2. Run the model:
```py
from optimum.intel.openvino.modeling_diffusion import OVStableDiffusionPipeline

pipeline = OVStableDiffusionPipeline.from_pretrained(
    "rupeshs/sd-turbo-openvino",
    ov_config={"CACHE_DIR": ""},
)
prompt = "a cat wearing santa claus dress,portrait"

images = pipeline(
    prompt=prompt,
    width=512,
    height=512,
    num_inference_steps=1,
    guidance_scale=1.0,
).images
images[0].save("out_image.png")
```

## License 
The SD Turbo Model is licensed under the Stability AI Non-Commercial Research Community License, Copyright (c) Stability AI Ltd. All Rights Reserved.
