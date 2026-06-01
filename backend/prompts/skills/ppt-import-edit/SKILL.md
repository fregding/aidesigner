---
id: ppt-import-edit
name: ppt-import-edit
description: Edit uploaded/imported PPT projects by page-level replacement while preserving untouched original pages.
workspace: ppt
---

# Imported PPT Page Editing

Use this skill when `result_data.edit_mode` is `imported_ppt` or `result_data.imported_ppt` is true.

Editing model:
- The uploaded PPT is preserved as page screenshots wrapped in SVG.
- Unmentioned pages must stay unchanged.
- A page edit creates a new SVG only for the target page.
- Adding a page inserts one new SVG page at the requested position.
- Deleting a page removes only the explicitly requested slide page and renumbers the remaining pages.
- Export regenerates the PPTX from the current page list.

Routing:
- If the user says "改第 N 页", "当前页", "这一页", or names a specific slide, route to `create_proposal`.
- If the user says "加一页", "新增一页", or "插入一页", route to `create_proposal` with an insert instruction.
- If the user says "删除第 N 页/删掉这一页/移除这页", route to `create_proposal` as a page deletion.
- Do not treat "删除标题/删除图片/去掉文字" as page deletion.
- If the user confirms a visible proposal, route to `apply_proposal`.

Response rules:
- Make it clear that the proposal is a preview until applied.
- Mention affected page numbers.
- Do not imply the original PPT internals were edited directly; the system edits the imported page stack.
