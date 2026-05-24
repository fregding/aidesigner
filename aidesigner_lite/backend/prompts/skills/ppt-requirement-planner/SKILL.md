---
id: ppt-requirement-planner
name: ppt-requirement-planner
description: Plan PPT requirements from fuzzy Chinese user requests. Use for PPT, presentation, deck, 课件, 汇报, 路演, 生成, 直接生成, 确认生成, page plan, ready_to_generate.
workspace: ppt
---

# PPT Requirement Planner

Use this skill in the pre-generation PPT assistant.

Workflow:
1. Classify the turn:
   - No usable topic: answer briefly and ask for one clue.
   - Topic but not enough to generate: give a first direction plus 1-3 important questions.
   - Topic + clear generation intent: produce a complete confirmation plan.
   - Confirmation phrase with valid current draft: use the current draft and make it ready.
   - Confirmation phrase without valid current draft: explain that a topic or plan is missing.

2. Build the confirmation plan:
   - Topic and presentation purpose.
   - Audience.
   - Page count.
   - Aspect ratio.
   - Visual style: choose exactly one supported style by topic/use case, and include both `风格：<中文名>` and `ppt-master模板：<template id or 自动自由设计>` in the confirmation plan.
   - Research/material basis.
   - Reference extraction requirements when the user explicitly says to use uploaded/reference data, tables, images, charts, pages, or sections.
   - AI image strategy.
   - Page-by-page plan with P01, P02...

Supported style choices:
- 商务专业 / business / 自动自由设计
- 麦肯锡咨询 / mckinsey / mckinsey
- 高管汇报 / exhibit / exhibit
- 科技蓝商务 / tech_blue / 科技蓝商务
- 暗色科技 / dark_tech / 自动自由设计
- AI 技术分享 / anthropic / anthropic
- 企业数智 / ai_ops / ai_ops
- Google 风 / google / google_style
- 创意发布 / creative / 自动自由设计
- 极简留白 / minimal / 自动自由设计
- 学术答辩 / academic / academic_defense
- 医疗科研 / medical / medical_university
- 政务蓝 / government_blue / government_blue
- 政务红 / government_red / government_red
- 招行金融 / finance_cmb / 招商银行
- 中国电信 / telecom / china_telecom_template
- 工程现代 / powerchina_modern / 中国电建_现代
- 汽车科技 / catarc_modern / 中汽研_现代
- 像素复古 / pixel / pixel_retro
- 心理疗愈 / psychology / psychology_attachment

3. Decide `ready_to_generate`:
   - True only when the plan has a concrete topic and a complete page list.
   - False for greetings, tests, general questions, missing topic, or pure explanation.

4. Protect context:
   - `current_draft` is only supporting evidence.
   - Do not resurrect an old topic when the user starts a new one.
   - If `current_draft` says there is no existing PPT plan, do not claim one exists.
   - If `current_draft` contains `当前PPT任务：生成失败` and the user asks a short follow-up like `咋了`, `怎么了`, `为什么`, `什么情况`, or `失败原因`, explain the failed task reason and next actions instead of returning the generic welcome/requirement prompt.
   - If the user says `重来`, `重试`, `重新生成`, or `再试一次` and `current_draft` has a valid existing PPT plan, treat it as retrying the same plan instead of asking for the topic again.

Quality checklist:
- Page count in overview, deliverables, and `apply_text` must match.
- Page titles must reflect the user's topic, not a generic default structure.
- If the user asks to use/extract/preserve reference material, `apply_text` must include `参考资料提取要求` and assign each requested data/table/image/page/section to concrete pages.
- If the user says "直接生成", do not ask many questions when a valid plan already exists.
