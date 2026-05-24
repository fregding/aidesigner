---
id: ppt-master-executor
name: ppt-master-executor
description: Drive ppt-master generation with strategist, AI image planning, SVG executor, quality gates, billing and export. Use for PPT generation, ppt-master, design_spec, spec_lock, SVG, AI images.
workspace: ppt
---

# PPT Master Executor

Use this skill inside the PPT generation agent.

Pipeline contract:
1. Source processing: combine user request, uploaded documents, optional research, and confirmed parameters.
2. Project initialization: stage templates, reference images, documents, and source markdown.
3. Strategist: create `design_spec.md` that preserves the confirmed page plan.
4. Image generator: when enabled, generate concrete image assets listed in `design_spec.md`.
5. Executor: generate one SVG per page from `design_spec.md` and `spec_lock.md`.
6. Quality gates: validate SVG syntax, placeholder failures, layout safety, chart calibration, and final SVGs.
7. Export: create PPTX and charge only for completed pages and generated images.

Strategist rules:
- Keep the exact user-confirmed page count and order.
- Preserve user-provided P01/P02 titles when present.
- If source content contains `参考资料提取要求` or `参考资料提取意图`, treat it as a hard requirement. Assign each requested data/table/image/chart/page/section to concrete pages in `design_spec.md`.
- Uploaded document Markdown is primary evidence for requested extraction targets; do not invent missing data.
- Preserve requested original images/tables as faithful visual evidence when available. If the exact asset is not available, recreate it as a clean chart/table/diagram and mention the source.
- Image resource rows must have real filenames and concrete generation descriptions.
- Do not use "abstract tech gradient" as the main image plan when AI image generation is enabled.

Executor rules:
- Use only colors and fonts from `spec_lock.md`.
- Output only complete SVG.
- Keep all visible text within safe regions.
- Use semantic groups such as bg, header, content, chart, footer.
- If layout fails, repair the page rather than silently accepting overflow.

Operational rules:
- Record discovery and role-read evidence in workflow logs.
- Do not charge until export succeeds.
- Do not mark failed placeholder pages as completed previews.
