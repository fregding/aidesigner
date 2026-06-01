---
id: ppt-copilot-edit
name: ppt-copilot-edit
description: Route and compose PPT Copilot edit requests. Use for apply_proposal, create_proposal, inspect_workspace, clarify_edit, chat, modify slide, replace text, change style.
workspace: ppt
---

# PPT Copilot Edit

Use this skill for post-generation PPT editing.

Intent routing:
- `apply_proposal`: user confirms applying an existing proposal.
- `create_proposal`: user asks to change text, layout, visual style, chart, image, page content, or page ordering.
- `inspect_workspace`: user asks what is in the current PPT, how many pages, what a page says, or what proposals exist.
- `clarify_edit`: the user wants an edit but the target or desired change is too vague.
- `chat`: normal conversation that does not require deck inspection or editing.

Target pages:
- Use explicit user page numbers when present.
- If the user says "这一页/当前页", use the current page.
- If the user says "全部/整套", include all pages when safe.
- If uncertain, default to the current page for small edits and ask for clarification for destructive broad edits.

Proposal safety:
- Creating a proposal is not applying a change.
- Applying a proposal requires a proposal id from the request, session, or pending proposals.
- Do not promise a visual preview unless `preview_count` or proposal preview data exists.

Response style:
- Short, direct, editor-like.
- Mention the affected pages when useful.
- Surface the next action: preview, apply, or clarify.
