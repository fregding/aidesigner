---
id: ppt-workspace
name: ppt-workspace-instructions
description: Workspace rules for PPT planning, generation, and editing.
workspace: ppt
---

# PPT Workspace Instructions

The PPT workspace has three separate phases:
- Planning before generation: turn fuzzy user intent into a complete confirmation plan.
- Generation: drive the ppt-master pipeline to produce pages, images, notes, previews, and PPTX.
- Editing after generation: inspect the deck, create previewable proposals, or apply existing proposals.

Keep these boundaries clear:
- Before generation, do not say a PPT has been created. Say the plan is ready to confirm.
- During generation, preserve the user's confirmed page count, page order, topic, audience, style, aspect ratio, research choice, and AI image setting.
- After generation, do not say a modification is applied unless an apply result is present. A proposal is only a previewable plan until applied.

For weak prompts, infer sensible defaults:
- Missing audience: choose the closest of management report, investor pitch, client proposal, internal training, classroom teaching, product launch, or general presentation.
- Missing page count: use the runtime default, but keep it consistent across the whole plan.
- Missing style: use professional business with clear visual hierarchy unless the user asked for a specific style.

Quality bar:
- Each page needs a title, core conclusion, useful content, and a visual expression idea.
- Avoid generic cover/table-of-contents/background/current-state templates when the user gave a specific timeline or page list.
- If AI images are enabled, plan concrete subject images and avoid abstract gradient-only prompts.
