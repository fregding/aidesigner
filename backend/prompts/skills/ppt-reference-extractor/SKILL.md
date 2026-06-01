---
id: ppt-reference-extractor
name: ppt-reference-extractor
description: Extract and use explicit data, tables, images, charts, pages, or sections from uploaded PPT/PDF/Word/Excel reference materials. Use when the user says use reference data, extract from attachment, keep original tables/images, use page N, use this document, 按附件, 用参考, 提取数据, 表格, 图片, 图表.
workspace: ppt
keywords: 参考 附件 上传 文件 资料 文档 数据 表格 图片 图表 截图 原图 第几页 某页 提取 保留 原文 原始 PDF Word Excel PPT
---

# PPT Reference Extractor

Use this skill whenever the user explicitly asks to use material from uploaded or referenced files, such as:
- "用附件里的数据"
- "按这个 PDF/Word/PPT 生成"
- "把第 3 页的表格放进去"
- "保留原文档里的图片/图表"
- "参考图里的数据要用上"
- "从上传资料里提取实验结果/财务表/流程图/架构图"

Do not treat referenced files as vague inspiration in these cases. Treat the requested reference as source material that must be extracted, cited in the plan, and transformed into slide-ready content.

Planning rules:
1. Identify the extraction target in the confirmation plan:
   - File or material name if known.
   - Content type: text section, data table, chart, figure/image, screenshot, slide/page, or appendix.
   - Scope: exact page/slide/sheet/section when the user mentions it; otherwise say "from uploaded material".
2. In `apply_text`, add a dedicated section titled `参考资料提取要求`.
3. For each extraction target, write one bullet in this shape:
   - `- 从「文件名或上传资料」提取：<数据/表格/图片/第N页/章节>；用途：放入 Pxx <页面标题>；处理方式：<原样保留/转成图表/压缩摘要/重绘为清晰表格/作为证据图>`
4. If the user asks to preserve original images, figures, screenshots, or tables, prefer "原样保留为图片/表格证据" unless they ask for redesign.
5. If the user asks to use data, do not invent numbers. If extraction is uncertain, state that generation will prioritize uploaded material and preserve uncertainty instead of fabricating.
6. If there are multiple uploaded files and the user does not specify which one, use all relevant uploaded materials and mention this in the plan. Ask at most one clarifying question only when using the wrong file would clearly break the result.

Generation rules:
1. Uploaded document Markdown is the primary evidence for requested extraction targets.
2. Use extracted tables as actual slide table/chart content, not just a sentence saying a table exists.
3. Use extracted figure/image/page references as slide visual requirements. If an exact original image asset is available in the project, use it; if not, recreate the figure as a clean diagram and note the source in page content.
4. Preserve page/slide/sheet references in `design_spec.md` so the executor knows why the element must appear.
5. When the user asks for a specific page/slide/sheet, do not replace it with generic background/context pages.

Quality checks before finalizing a plan or design spec:
- Does every explicit "use/extract/reference" request appear in the page plan?
- Does `apply_text` contain `参考资料提取要求` when extraction is requested?
- Are requested tables/data assigned to concrete pages?
- Are requested images/figures assigned to concrete pages or marked for faithful recreation?
- Are invented facts avoided when the uploaded material does not provide them?
