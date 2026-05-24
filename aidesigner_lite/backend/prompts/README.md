# 提示词目录 / Prompts Directory

本目录包含AI系统的所有提示词配置。

## 目录结构

```
prompts/
├── README.md           # 本文件
├── chat.txt            # AI对话系统提示词
├── assistant_core.txt  # 创作助手核心人格
├── assistant_output.txt # 创作助手输出协议
├── assistant_workspace_*.txt # 分工作区系统提示词
├── assistant_image_templates.txt # GPT-Image-2 图片模板库规则
├── image.txt           # 图片生成系统提示词
├── ppt.txt             # PPT生成系统提示词
├── video.txt           # 视频生成系统提示词
└── skills/              # 技能提示词
    ├── image_enhancer.txt
    └── prompt_writer.txt
```

## 使用方法

生成类提示词由 `backend/src/services/aiService.js` 加载。
创作助手提示词由 `backend/src/services/assistantService.js` 组合加载。
图片模板库由 `backend/src/services/imageTemplateService.js` 加载，并参考 `external/awesome-gpt-image-2/docs/templates.md` 的 GPT-Image-2 Prompt-as-Code 结构。

## 修改提示词

直接在对应的 `.txt` 文件中修改内容即可。修改后重启服务生效。

## 注意事项

- 文件编码: UTF-8
- 不要在文件末尾添加多余的空行
- 提示词内容应简洁明了
