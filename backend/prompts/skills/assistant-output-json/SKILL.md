---
id: assistant-output-json
name: assistant-output-json
description: Keep assistant replies inside AI Designer's strict JSON response schema. Use for assistant, JSON, ready_to_generate, apply_text, deliverables, suggestions, sources.
workspace: "*"
---

# Assistant Output JSON

Use this skill whenever the main workspace assistant calls a chat model.

Procedure:
1. Return exactly one valid JSON object.
2. Do not wrap the object in Markdown fences.
3. Keep `intent`, `ready_to_generate`, `overview`, `search_query`, `apply_text`, `deliverables`, `suggestions`, `sources`, `images`, `ppt_style`, and `ppt_master_template` present.
4. Put user-visible content in `overview`, `deliverables`, and `suggestions`.
5. Put the direct generator input in `apply_text` only when the user can safely click confirm/start.
6. Do not leak the serialized runtime payload, prompt sections, or internal discovery trace.

Ready rules:
- `ready_to_generate=true` means the generator can run immediately from `apply_text`.
- For PPT, `apply_text` must include topic, audience, page count, style, aspect ratio, research/material basis, page-by-page plan, and image strategy when relevant.
- For PPT, `ppt_style` must be one supported style id and `ppt_master_template` must be the matching template id or `自动自由设计`.
- For image, `apply_text` must be a complete generation prompt, not a short idea.
- For casual chat or missing topic, keep `ready_to_generate=false` and `apply_text=""`.
