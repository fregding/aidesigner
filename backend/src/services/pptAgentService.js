const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const AiTask = require('../models/AiTask');
const File = require('../models/File');
const User = require('../models/User');
const AiService = require('./aiService');
const AssistantService = require('./assistantService');
const RuntimeConfigService = require('./runtimeConfigService');
const TavilyService = require('./tavilyService');
const appConfig = require('../config/appConfig');

const UPLOAD_DIR = appConfig.uploadDir;
const DEFAULT_PPT_MASTER_ROOT = appConfig.defaultPptMasterRoot;
const DEFAULT_PPT_MASTER_PYTHON = appConfig.defaultPptMasterPython;

class PptAgentService {
  static async generate({ userId, prompt, params = {} }) {
    const task = AiTask.create({
      userId,
      type: 'ppt',
      prompt,
      params
    });

    this.updateProgress(task.id, {
      progress: 2,
      stage: 'queued',
      message: 'PPT 生成任务已创建'
    });
    AiTask.updateStatus(task.id, 'processing');

    setImmediate(() => {
      this.runTask(task.id).catch(error => {
        console.error('PPT Agent 任务失败:', error);
        AiTask.updateStatus(task.id, 'failed', {
          error_message: error.message,
          result_data: {
            status: 'failed',
            stage: 'error',
            progress: 100,
            error: error.message
          }
        });
      });
    });

    return {
      task: AiTask.findById(task.id),
      result: {
        status: 'processing',
        task_id: task.id
      }
    };
  }

  static sanitizePromptText(text = '') {
    const source = String(text || '');
    if (!source) return '';
    return source
      .replace(/{{\s*([^}]+?)\s*}}/g, '[$1]')
      .replace(/\bppt-master\b/gi, '版式系统')
      .replace(/\bPPT Master\b/gi, '版式系统')
      .replace(/\bTemplate Option\b/gi, '版式参考')
      .replace(/\bTemplate\b/gi, '版式')
      .replace(/资料来源/gi, '参考信息')
      .replace(/数据来源/gi, '参考信息')
      .replace(/上传文档|上传文件|上传资料/gi, '源材料')
      .replace(/文件名/gi, '文件标识')
      .replace(/内部路径/gi, '内部标识')
      .replace(/workflow/gi, '流程')
      .replace(/pipeline/gi, '流程线')
      .replace(/\bSource Document\b/gi, '源材料')
      .replace(/\bSource\b/gi, '参考')
      .replace(/\bStrategist\b/gi, '策划')
      .replace(/\bExecutor\b/gi, '执行');
  }

  static async runTask(taskId) {
    const task = AiTask.findById(taskId);
    if (!task) {
      throw new Error('PPT任务不存在');
    }

    const params = this.safeJsonParse(task.params, {});
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const pageCount = this.normalizePageCount(params.pageCount || params.page_count, runtimeConfig);
    const canvasFormat = params.canvasFormat || params.canvas_format || 'ppt169';
    const style = this.mapStyle(params.style || params.template);
    const enableResearch = this.shouldEnableResearch(params);
    const title = this.deriveTitle(params.title || task.prompt);
    const projectPath = this.createProjectDirectory({
      userId: task.user_id,
      taskId: task.id,
      title,
      canvasFormat
    });

    this.updateProgress(task.id, {
      progress: 8,
      stage: 'outline',
      message: '正在整理标题、大纲和表达重点',
      project_dir: projectPath
    });

    const assistantPayload = await this.buildAssistantOutline({
      prompt: task.prompt,
      params,
      enableResearch
    });

    this.updateProgress(task.id, {
      progress: 14,
      stage: 'research',
      message: enableResearch
        ? '正在使用 Tavily 补充检索资料'
        : '已跳过联网检索，直接进入内容策划'
    });

    const fallbackResearch = enableResearch
      ? await this.buildFallbackResearchContext({
        prompt: task.prompt,
        title,
        assistantPayload
      })
      : {
        search_used: false,
        query: '',
        answer: '',
        sources: [],
        disabled: true
      };

    this.updateProgress(task.id, {
      progress: 20,
      stage: 'assets',
      message: '正在准备 PPT 生成资源'
    });

    const imageAssets = await this.generateImageAssets({
      task,
      projectPath,
      title,
      params,
      assistantPayload,
      runtimeConfig
    });

    const sourceContent = this.buildSourceContent({
      task,
      params,
      title,
      pageCount,
      style,
      assistantPayload,
      fallbackResearch,
      imageAssets
    });
    fs.writeFileSync(path.join(projectPath, 'sources', 'source.md'), sourceContent, 'utf-8');

    this.updateProgress(task.id, {
      progress: 28,
      stage: 'strategist',
      message: '正在生成 design_spec.md'
    });

    const designSpec = await this.generateDesignSpec({
      task,
      sourceContent,
      pageCount,
      style,
      canvasFormat,
      runtimeConfig
    });
    fs.writeFileSync(path.join(projectPath, 'design_spec.md'), designSpec, 'utf-8');

    const svgFiles = [];
    let previousPagesSummary = '';

    for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
      this.updateProgress(task.id, {
        progress: 30 + Math.round((pageNum - 1) / pageCount * 45),
        stage: 'executor',
        message: `正在生成第 ${pageNum}/${pageCount} 页`,
        current_page: pageNum,
        total_pages: pageCount
      });

      const pageResult = await this.generateSvgPage({
        task,
        designSpec,
        sourceContent,
        style,
        pageNum,
        pageCount,
        previousPagesSummary,
        runtimeConfig
      });

      const filename = this.sanitizeSvgFilename(pageResult.filename, pageNum);
      const svgPath = path.join(projectPath, 'svg_output', filename);
      fs.writeFileSync(svgPath, pageResult.svg, 'utf-8');
      svgFiles.push(filename);
      previousPagesSummary += `Page ${pageNum}: ${filename}\n`;

      this.updateProgress(task.id, {
        progress: 30 + Math.round(pageNum / pageCount * 45),
        stage: 'executor',
        message: `第 ${pageNum}/${pageCount} 页已生成`,
        preview_svgs: this.buildPreviewUrls(projectPath, svgFiles, 'svg_output')
      });
    }

    this.updateProgress(task.id, {
      progress: 82,
      stage: 'postprocess',
      message: '正在优化页面预览'
    });

    await this.runPptMasterScript('finalize_svg.py', [projectPath], {
      timeoutMs: 180000
    });

    this.updateProgress(task.id, {
      progress: 91,
      stage: 'export',
      message: '正在导出可编辑 PPTX'
    });

    await this.runPptMasterScript('svg_to_pptx.py', [projectPath, '-s', 'final'], {
      timeoutMs: 240000
    });

    const pptxFile = this.findGeneratedPptx(projectPath);
    if (!pptxFile) {
      throw new Error('PPTX导出完成但未找到文件');
    }

    const previewSvgs = this.listPreviewSvgUrls(projectPath);
    const pptxUrl = this.toUploadUrl(pptxFile);
    const fileRecord = File.create({
      userId: task.user_id,
      taskId: task.id,
      filename: path.basename(pptxFile),
      originalName: `${title}.pptx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: fs.statSync(pptxFile).size,
      path: pptxFile,
      url: pptxUrl
    });

    const billedPageCount = Math.max(1, previewSvgs.length || Number(pageCount || 1) || 1);
    const billedImageCount = Array.isArray(imageAssets) ? imageAssets.length : 0;
    const pptCreditsPerPage = User.creditsPerPptPage();
    const pptCreditsPerImage = User.creditsPerPptImage();
    const billedPageCredits = billedPageCount * pptCreditsPerPage;
    const billedImageCredits = billedImageCount * pptCreditsPerImage;
    const originalCredits = Math.max(1, Math.ceil(billedPageCredits + billedImageCredits));
    const billing = User.buildCreditBilling(originalCredits, task.user_id);
    const requestedChargedCredits = billing.chargedCredits;
    const debit = User.updateQuota(task.user_id, 'ppt', requestedChargedCredits, {
      note: billedImageCount > 0
        ? `PPT生成 ${billedPageCount} 页 + AI配图 ${billedImageCount} 张${User.creditBillingNoteSuffix(billing)}`
        : `PPT生成 ${billedPageCount} 页${User.creditBillingNoteSuffix(billing)}`,
      capToAvailable: true
    });
    const chargedCredits = Math.max(0, Number(debit.deducted) || 0);

    const resultData = {
      status: 'completed',
      stage: 'done',
      progress: 100,
      title,
      page_count: pageCount,
      style,
      canvas_format: canvasFormat,
      download_url: pptxUrl,
      pptx_url: pptxUrl,
      file_id: fileRecord.id,
      preview_svgs: previewSvgs,
      image_assets: imageAssets.map(asset => ({
        filename: asset.filename,
        url: asset.url,
        description: asset.description
      })),
      billing: {
        ...User.creditBillingMetadata(billing),
        requested_charged_credits: requestedChargedCredits,
        charged_credits: chargedCredits,
        capped_to_available: Boolean(debit.cappedToAvailable),
        page_credits: billedPageCredits,
        image_credits: billedImageCredits,
        page_count: billedPageCount,
        image_count: billedImageCount,
        credits_per_image: pptCreditsPerImage,
        credits_per_page: pptCreditsPerPage,
        charge_reason: billedImageCount > 0
          ? 'completed_pages_and_embedded_images'
          : 'completed_pages_only'
      },
      project_dir: this.toUploadUrl(projectPath)
    };

    AiTask.updateStatus(task.id, 'completed', {
      result_url: pptxUrl,
      result_data: resultData
    });

    return {
      task: AiTask.findById(task.id),
      result: resultData
    };
  }

  static async buildAssistantOutline({ prompt, params, enableResearch = true }) {
    try {
      const draft = [
        params.title ? `标题：${params.title}` : '',
        params.audience ? `受众：${params.audience}` : '',
        params.scenario ? `场景：${params.scenario}` : '',
        params.content ? `内容：${params.content}` : '',
        params.extraRequirements ? `额外要求：${params.extraRequirements}` : '',
        params.pageCount ? `页数：${params.pageCount}` : '',
        params.template ? `风格：${params.template}` : '',
        params.canvasFormat || params.canvas_format ? `画幅：${this.describeCanvasFormat(params.canvasFormat || params.canvas_format)}` : '',
        params.toneStyle ? `表达方式：${params.toneStyle}` : '',
        params.detailLevel ? `内容密度：${params.detailLevel}` : ''
      ].filter(Boolean).join('\n');

      const response = await AssistantService.respond({
        workspace: 'ppt',
        message: prompt,
        draft,
        conversation: [],
        allowSearch: enableResearch
      });

      return response.assistant || null;
    } catch (error) {
      console.warn('PPT Agent 大纲整理失败，使用原始需求继续:', error.message);
      return null;
    }
  }

  static async buildFallbackResearchContext({ prompt, title, assistantPayload }) {
    if (!TavilyService.isConfigured()) {
      return {
        search_used: Boolean(assistantPayload?.search_used),
        query: assistantPayload?.search_query || '',
        sources: assistantPayload?.sources || []
      };
    }

    if (assistantPayload?.search_used && Array.isArray(assistantPayload.sources) && assistantPayload.sources.length > 0) {
      return {
        search_used: true,
        query: assistantPayload.search_query || '',
        sources: assistantPayload.sources
      };
    }

    const query = `${title || prompt} 资料 数据 案例 趋势`;
    const research = await TavilyService.search({
      query,
      topic: 'general',
      includeImages: false,
      maxResults: 5
    });

    return {
      search_used: Boolean(research.configured),
      query: research.query || query,
      answer: research.answer || '',
      sources: (research.results || []).slice(0, 5).map(item => ({
        title: item.title || item.url || '',
        url: item.url || '',
        snippet: this.trimText(item.content || item.snippet || '', 260)
      }))
    };
  }

  static async generateImageAssets({ task, projectPath, title, params, assistantPayload, runtimeConfig }) {
    const shouldGenerate = params.generateImages === true
      || params.generate_images === true
      || String(params.generateImages || params.generate_images || '').toLowerCase() === 'true'
      || runtimeConfig.pptGenerateImages;

    if (!shouldGenerate || !runtimeConfig.imageApiKey) {
      return [];
    }

    const outputFormat = runtimeConfig.imageOutputFormat || 'png';
    const extension = AiService.getImageExtension(outputFormat);
    const prompt = this.buildCoverImagePrompt({
      title,
      params,
      assistantPayload
    });

    try {
      const responseData = await AiService.requestImageGeneration({
        userId: task.user_id,
        taskId: task.id,
        prompt,
        params: {
          n: 1,
          quality: params.imageQuality || runtimeConfig.imageQuality || 'high'
        },
        size: AiService.sizeMap['16:9'] || '1280x720',
        outputFormat,
        runtimeConfig
      });

      const normalized = AiService.normalizeGeneratedImages(responseData, outputFormat);
      const imageDir = path.join(projectPath, 'images');
      return normalized.slice(0, 1).map((image, index) => {
        const filename = `cover_visual_${index + 1}.${extension}`;
        const imagePath = path.join(imageDir, filename);
        fs.writeFileSync(imagePath, Buffer.from(image.b64_json, 'base64'));
        return {
          filename,
          path: imagePath,
          relativePath: `images/${filename}`,
          url: this.toUploadUrl(imagePath),
          description: `自动生成的封面/章节主视觉：${title}`
        };
      });
    } catch (error) {
      console.warn('PPT Agent 配图生成失败，继续生成无配图 PPT:', error.message);
      return [];
    }
  }

  static buildCoverImagePrompt({ title, params, assistantPayload }) {
    const outline = this.assistantToText(assistantPayload);
    const style = this.describeStyle(params.style || params.template);
    return [
      `生成一张 16:9 的高端演示文稿主视觉背景图，主题是「${title}」。`,
      `视觉方向：${style}，适合商务汇报或专业演示。`,
      params.scenario ? `使用场景：${params.scenario}。` : '',
      params.toneStyle ? `表达气质：${params.toneStyle}。` : '',
      outline ? `内容语境：${this.trimText(outline, 420)}` : '',
      '画面要求：主体清晰但不要占满画布，左侧或上方保留足够留白用于叠加标题，光影高级，层次丰富，质感真实。',
      '严格不要生成可读文字、不要水印、不要 logo、不要低端模板感。'
    ].filter(Boolean).join('\n');
  }

  static async generateDesignSpec({ task, sourceContent, pageCount, style, canvasFormat, runtimeConfig }) {
    const prompt = this.buildStrategistPrompt({
      sourceContent,
      pageCount,
      style,
      canvasFormat
    });

    return await this.callPptModel({
      task,
      runtimeConfig,
      systemPrompt: prompt,
      userMessage: '请直接输出完整 design_spec.md 内容，不要添加解释。',
      maxTokens: 8192,
      temperature: 0.35
    });
  }

  static async generateSvgPage({
    task,
    designSpec,
    sourceContent,
    style,
    pageNum,
    pageCount,
    previousPagesSummary,
    runtimeConfig
  }) {
    let lastRaw = '';

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = this.buildExecutorPrompt({
        designSpec,
        sourceContent,
        style,
        pageNum,
        pageCount,
        previousPagesSummary,
        repairHint: attempt > 1 ? `上次输出未能提取有效 SVG，请只输出 PAGE 注释和完整 <svg>...</svg>。上次输出片段：${this.trimText(lastRaw, 1200)}` : ''
      });

      lastRaw = await this.callPptModel({
        task,
        runtimeConfig,
        systemPrompt: prompt,
        userMessage: '请生成这一页 SVG。',
        maxTokens: 6000,
        temperature: 0.3
      });

      const extracted = this.extractSvgAndFilename(lastRaw);
      if (extracted.svg) {
        return {
          svg: this.normalizeSvg(extracted.svg),
          filename: extracted.filename
        };
      }
    }

    throw new Error(`第 ${pageNum} 页未返回有效 SVG`);
  }

  static async callPptModel({ task, runtimeConfig, systemPrompt, userMessage, maxTokens, temperature }) {
    const response = await AiService.chat({
      userId: task.user_id,
      model: runtimeConfig.pptModel || runtimeConfig.chatModel || 'gpt-5.5',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      params: {
        route: 'ppt',
        temperature,
        max_tokens: maxTokens,
        timeout_ms: runtimeConfig.pptTimeoutMs
      },
      allowConfigOverride: true
    });

    const content = response.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
      throw new Error('PPT模型返回空内容');
    }
    return content.trim();
  }

  static buildStrategistPrompt({ sourceContent, pageCount, style, canvasFormat }) {
    const strategistRef = this.loadPptMasterFile('skills/ppt-master/references/strategist.md', 8000);
    const sharedRef = this.loadPptMasterFile('skills/ppt-master/references/shared-standards.md', 3000);
    const designSpecTemplate = this.loadPptMasterFile('skills/ppt-master/templates/design_spec_reference.md', 9000);

    const canvasDesc = canvasFormat === 'ppt43'
      ? 'PPT 4:3，viewBox: 0 0 1024 768，尺寸 1024×768'
      : 'PPT 16:9，viewBox: 0 0 1280 720，尺寸 1280×720';

    return `你是世界顶级的 AI 演示文稿策划师（Strategist）。

## 任务
根据下方源内容，制作一份完整的 Design Specification & Content Outline（design_spec.md）。

## 固定参数
- 画布格式：${canvasDesc}
- 页面数量：约 ${pageCount} 页
- 设计风格：${this.describeStyle(style)}

## Strategist 角色定义
${this.sanitizePromptText(strategistRef)}

## 技术约束
${this.sanitizePromptText(sharedRef)}

## Design Spec 模板
${this.sanitizePromptText(designSpecTemplate)}

## 源内容
${this.sanitizePromptText(sourceContent)}

## 输出要求
1. 只输出完整 design_spec.md。
2. 必须保留模板的 Section I 到 Section XI 结构。
3. 内容语言使用简体中文。
4. 如果源内容包含图片资源列表，必须在 Image Resource List 中引用真实文件名。`;
  }

  static buildExecutorPrompt({
    designSpec,
    sourceContent,
    style,
    pageNum,
    pageCount,
    previousPagesSummary,
    repairHint
  }) {
    const executorBase = this.loadPptMasterFile('skills/ppt-master/references/executor-base.md', 3500);
    const sharedRef = this.loadPptMasterFile('skills/ppt-master/references/shared-standards.md', 2500);
    const styleRef = this.loadPptMasterFile(`skills/ppt-master/references/${this.executorStyleFile(style)}`, 2800);

    return `你是世界顶级的 AI 幻灯片 SVG 绘制执行者（Executor）。

## 当前任务
为演示文稿生成第 ${pageNum}/${pageCount} 页的 SVG 代码。

## Executor 通用规范
${this.sanitizePromptText(executorBase)}

## 风格专项规范
${this.sanitizePromptText(styleRef)}

## SVG 技术约束
${this.sanitizePromptText(sharedRef)}

${previousPagesSummary ? `## 已生成页面摘要\n${this.sanitizePromptText(previousPagesSummary)}` : ''}
${repairHint ? `## 修复要求\n${this.sanitizePromptText(repairHint)}` : ''}

## 布局质量强制要求
1. 文字不得溢出容器，长文本必须拆分成 tspan 多行。
2. 可见元素之间至少保留 8px 间距。
3. 所有内容距画布边缘至少 40px。
4. 标题字号 28-48px，正文 16-24px，注释 12-16px。
5. 如果使用图片，href 必须指向 ../images/ 下的真实文件名。

## Design Specification & Content Outline
${this.sanitizePromptText(this.trimText(designSpec, 6200))}

## 源内容参考
${this.sanitizePromptText(this.trimText(sourceContent, 1800))}

## 输出格式
1. 第一行输出：<!-- PAGE:${pageNum} FILENAME:${String(pageNum).padStart(2, '0')}_slide_${pageNum}.svg -->
2. 然后输出完整 SVG，以 <svg 开头，以 </svg> 结尾。
3. SVG 必须使用 viewBox="0 0 1280 720" 和 xmlns="http://www.w3.org/2000/svg"。
4. 禁止使用：<style>、class、mask、foreignObject、<symbol>+<use>、textPath、@font-face、animate、script。
5. 不要输出 SVG 以外的解释文字。`;
  }

  static buildSourceContent({
    task,
    params,
    title,
    pageCount,
    style,
    assistantPayload,
    fallbackResearch,
    imageAssets
    }) {
    const lines = [
      `# ${title}`,
      '',
      '## 用户原始需求',
      this.sanitizePromptText(task.prompt),
      '',
      '## 生成参数',
      `- 页数：${pageCount}`,
      `- 风格：${this.sanitizePromptText(this.describeStyle(style))}`,
      params.audience ? `- 受众：${this.sanitizePromptText(params.audience)}` : '',
      params.scenario ? `- 场景：${this.sanitizePromptText(params.scenario)}` : '',
      params.canvasFormat || params.canvas_format ? `- 画幅：${this.sanitizePromptText(this.describeCanvasFormat(params.canvasFormat || params.canvas_format))}` : '',
      params.toneStyle ? `- 表达方式：${this.sanitizePromptText(params.toneStyle)}` : '',
      params.detailLevel ? `- 内容密度：${this.sanitizePromptText(params.detailLevel)}` : '',
      this.shouldEnableResearch(params) ? '- 联网资料：启用' : '- 联网资料：关闭',
      params.extraRequirements ? `- 额外要求：${this.sanitizePromptText(params.extraRequirements)}` : '',
      '',
      '## 乐米整理的大纲',
      this.sanitizePromptText(this.assistantToText(assistantPayload) || '无结构化大纲，直接依据用户原始需求生成。'),
      ''
    ].filter(line => line !== '');

    if (fallbackResearch?.search_used) {
      lines.push('## Tavily 检索补充资料');
      if (fallbackResearch.query) lines.push(`检索词：${this.sanitizePromptText(fallbackResearch.query)}`);
      if (fallbackResearch.answer) lines.push(`摘要：${this.sanitizePromptText(fallbackResearch.answer)}`);
      (fallbackResearch.sources || []).forEach((source, index) => {
        lines.push(`${index + 1}. ${this.sanitizePromptText(source.title)} - ${this.sanitizePromptText(source.url)}`);
        if (source.snippet) lines.push(`   ${this.sanitizePromptText(source.snippet)}`);
      });
      lines.push('');
    }

    if (imageAssets.length > 0) {
      lines.push('## 图片资源列表');
      imageAssets.forEach(asset => {
        lines.push(`- ${asset.relativePath}：${this.sanitizePromptText(asset.description)}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  static createProjectDirectory({ userId, taskId, title, canvasFormat }) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeTitle = this.slugify(title).slice(0, 32) || 'ppt';
    const projectName = `${taskId}_${safeTitle}_${canvasFormat}_${date}`;
    const projectPath = path.join(UPLOAD_DIR, 'ppt', String(userId), projectName);

    ['svg_output', 'svg_final', 'images', 'notes', 'templates', 'sources', 'exports'].forEach(dir => {
      fs.mkdirSync(path.join(projectPath, dir), { recursive: true });
    });

    fs.writeFileSync(
      path.join(projectPath, 'README.md'),
      [
        `# ${title}`,
        '',
        `- Canvas format: ${canvasFormat}`,
        `- Created: ${date}`,
        '- Generated by AI Designer PPT Agent + PPT Master'
      ].join('\n'),
      'utf-8'
    );

    return projectPath;
  }

  static async runPptMasterScript(scriptName, args, { timeoutMs }) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const root = runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const python = this.resolvePython(runtimeConfig.pptMasterPython || DEFAULT_PPT_MASTER_PYTHON);
    const scriptPath = path.join(root, 'skills', 'ppt-master', 'scripts', scriptName);

    if (!fs.existsSync(scriptPath)) {
      throw new Error('PPT 生成服务暂时不可用，请联系管理员检查部署配置。');
    }

    await new Promise((resolve, reject) => {
      execFile(
        python,
        [scriptPath, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr || stdout || error.message;
            reject(new Error(`${scriptName} 执行失败：${this.trimText(detail, 2000)}`));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  static loadPptMasterFile(relativePath, maxChars = 6000) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const root = runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
      return '';
    }
    const text = fs.readFileSync(filePath, 'utf-8');
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[... 内容已截断 ...]`
      : text;
  }

  static resolvePython(candidate) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
    const fallback = path.join(DEFAULT_PPT_MASTER_ROOT, 'venv', 'bin', 'python');
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    return process.env.PYTHON_BIN || 'python3';
  }

  static findGeneratedPptx(projectPath) {
    const exportsDir = path.join(projectPath, 'exports');
    if (!fs.existsSync(exportsDir)) return null;

    return fs.readdirSync(exportsDir)
      .filter(name => name.endsWith('.pptx') && !name.includes('_svg'))
      .map(name => path.join(exportsDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  }

  static listPreviewSvgUrls(projectPath) {
    const svgDir = fs.existsSync(path.join(projectPath, 'svg_final'))
      ? path.join(projectPath, 'svg_final')
      : path.join(projectPath, 'svg_output');

    if (!fs.existsSync(svgDir)) return [];
    return fs.readdirSync(svgDir)
      .filter(name => name.endsWith('.svg'))
      .sort()
      .map(name => this.toUploadUrl(path.join(svgDir, name)));
  }

  static buildPreviewUrls(projectPath, filenames, subdir) {
    return filenames.map(filename => this.toUploadUrl(path.join(projectPath, subdir, filename)));
  }

  static toUploadUrl(filePath) {
    return appConfig.pathToUploadUrl(filePath);
  }

  static extractSvgAndFilename(text) {
    const filenameMatch = text.match(/FILENAME:([\w\u4e00-\u9fff\-_.]+\.svg)/);
    const svgMatch = text.match(/(<svg[\s\S]*?<\/svg>)/i);
    return {
      filename: filenameMatch ? filenameMatch[1] : '',
      svg: svgMatch ? svgMatch[1] : ''
    };
  }

  static normalizeSvg(svg) {
    let next = svg.trim();
    if (!/<svg[^>]+xmlns=/.test(next)) {
      next = next.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!/<svg[^>]+viewBox=/.test(next)) {
      next = next.replace(/<svg\b/i, '<svg viewBox="0 0 1280 720"');
    }
    return next;
  }

  static sanitizeSvgFilename(filename, pageNum) {
    const fallback = `${String(pageNum).padStart(2, '0')}_slide_${pageNum}.svg`;
    const raw = filename || fallback;
    const cleaned = raw
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_.-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned.endsWith('.svg') ? cleaned : fallback;
  }

  static mapStyle(value = '') {
    const key = String(value || '').toLowerCase();
    const map = {
      business: 'consulting',
      consulting: 'consulting',
      consulting_top: 'consulting_top',
      mckinsey: 'consulting_top',
      exhibit: 'consulting_top',
      creative: 'google',
      google: 'google',
      google_style: 'google',
      minimal: 'mckinsey',
      academic: 'academic',
      academic_defense: 'academic',
      medical: 'academic',
      medical_university: 'academic',
      zen: 'zen',
      pixel: 'pixel',
      pixel_retro: 'pixel',
      psychology: 'general',
      psychology_attachment: 'general',
      anthropic: 'general',
      ai_ops: 'general',
      tech_blue: 'consulting',
      dark_tech: 'general',
      government_blue: 'consulting',
      government_red: 'consulting',
      finance_cmb: 'consulting',
      telecom: 'consulting',
      powerchina_modern: 'consulting',
      catarc_modern: 'consulting',
      '科技蓝商务': 'consulting',
      '招商银行': 'consulting',
      '中国电信': 'consulting',
      '中国电建_现代': 'consulting',
      '中汽研_现代': 'consulting',
      general: 'general'
    };
    return map[key] || 'general';
  }

  static executorStyleFile(style) {
    const map = {
      consulting: 'executor-consultant.md',
      consulting_top: 'executor-consultant-top.md',
      mckinsey: 'executor-consultant-top.md'
    };
    return map[style] || 'executor-general.md';
  }

  static describeStyle(style) {
    const map = {
      business: '商务咨询风，结构清晰，适合正式汇报',
      consulting: '咨询风，数据清晰，结构严谨',
      consulting_top: '顶级咨询风，结论驱动，说服力强',
      mckinsey: '麦肯锡极简风，大字标题，强对比，数据突出',
      creative: '创意现代风，视觉冲击力强，适合发布会和方案展示',
      google: 'Google Material 风，活泼多彩，清晰圆润',
      minimal: '极简专业风，留白充足，信息密度克制',
      academic: '学术论文风，规范正式，层次清晰',
      medical: '医疗科研风，专业克制，适合病例和研究汇报',
      zen: '禅意东方风，克制留白，东方审美',
      pixel: '像素复古风，8-bit 游戏美学',
      psychology: '心理疗愈风，温暖克制，适合咨询培训和课程',
      anthropic: 'AI 技术分享风，适合大模型、Agent 和开发者内容',
      ai_ops: '企业数智风，适合数字化转型和运维架构方案',
      dark_tech: '暗色科技风，适合技术架构演示',
      general: '通用专业风，平衡专业度与视觉表现'
    };
    return map[style] || map.general;
  }

  static normalizePageCount(value, runtimeConfig) {
    const minPages = Math.max(parseInt(runtimeConfig.pptMinPages, 10) || 3, 1);
    const maxPages = Math.max(parseInt(runtimeConfig.pptMaxPages, 10) || 30, minPages);
    const defaultCount = Math.min(
      Math.max(parseInt(runtimeConfig.defaultPptPageCount, 10) || 10, minPages),
      maxPages
    );
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultCount;
    return Math.min(Math.max(parsed, minPages), maxPages);
  }

  static shouldEnableResearch(params = {}) {
    const rawValue = params.enableResearch ?? params.enable_research;
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return true;
    }
    if (typeof rawValue === 'boolean') {
      return rawValue;
    }
    const normalized = String(rawValue).trim().toLowerCase();
    return normalized !== 'false' && normalized !== '0' && normalized !== 'off' && normalized !== 'no';
  }

  static describeCanvasFormat(value) {
    return value === 'ppt43' ? '4:3 经典比例' : '16:9 宽屏比例';
  }

  static deriveTitle(value) {
    const text = String(value || 'AI生成PPT').replace(/\s+/g, ' ').trim();
    return this.trimText(text, 36) || 'AI生成PPT';
  }

  static slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'ppt';
  }

  static assistantToText(payload) {
    if (!payload) return '';

    const parts = [];
    if (payload.overview) parts.push(`概述：${payload.overview}`);
    if (payload.apply_text) parts.push(payload.apply_text);
    if (Array.isArray(payload.deliverables)) {
      payload.deliverables.forEach(item => {
        if (item.label) parts.push(`### ${item.label}`);
        if (item.content) parts.push(item.content);
        if (Array.isArray(item.items) && item.items.length > 0) {
          parts.push(item.items.map(entry => `- ${entry}`).join('\n'));
        }
      });
    }
    return parts.filter(Boolean).join('\n\n');
  }

  static updateProgress(taskId, data) {
    const task = AiTask.findById(taskId);
    const previous = this.safeJsonParse(task?.result_data, {});
    AiTask.update(taskId, {
      result_data: {
        ...previous,
        status: 'processing',
        updated_at: new Date().toISOString(),
        ...data
      }
    });
  }

  static safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  static trimText(text, maxLength) {
    const value = String(text || '').trim();
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}…`;
  }
}

module.exports = PptAgentService;
