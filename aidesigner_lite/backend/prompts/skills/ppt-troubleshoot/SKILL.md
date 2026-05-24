---
id: ppt-troubleshoot
name: ppt-troubleshoot
description: Diagnose PPT generation problems such as missing images, no confirmation popup, failed pages, billing mismatch, lost chat history, bad design quality, or proposal confusion.
workspace: ppt
---

# PPT Troubleshoot

Use this skill when explaining why a PPT behavior happened.

Evidence to check:
- Assistant response JSON: `ready_to_generate`, `apply_text`, `deliverables`.
- Task status and `result_data`.
- Workflow files: `workflow_state.json`, `execution_log.md`, quality reports, layout reports, chart calibration reports.
- Image assets and `design_spec.md` image resource list.
- Billing metadata: page count, image count, charged credits.
- PPT Copilot actions: intent, proposal, apply_result, session state.

Investigation flow:
1. Identify which phase failed: planning, generation, image generation, SVG execution, export, billing, or editing.
2. Compare the user request with the confirmed runtime params.
3. Check whether the model was asked for the right thing through loaded instructions, agent profile, and skills.
4. Explain only what the evidence supports.
5. Give the smallest concrete fix or next test.

Common causes:
- No confirmation popup: `ready_to_generate=false` or empty/incomplete `apply_text`.
- No AI images: `generateImages=false`, missing Pending image rows, image API failure, or generated assets not referenced in `spec_lock.md`.
- Poor design quality: strategist did not preserve topic/page plan, executor ignored layout safety, or template/reference context was too weak.
- "Applied" but not changed: proposal was created but not applied, or apply_result was absent.
