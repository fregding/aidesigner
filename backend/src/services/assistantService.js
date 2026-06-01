const AiService = require('./aiService');
const TavilyService = require('./tavilyService');
const RuntimeConfigService = require('./runtimeConfigService');
const AgentCustomizationService = require('./agentCustomizationService');
const DocumentConverterService = require('./documentConverterService');
const File = require('../models/File');
const User = require('../models/User');
const appConfig = require('../config/appConfig');
const path = require('path');
const fs = require('fs');

const ASSISTANT_NAME = '乐米';
const WORKSPACE_LABELS = {
  image: '图片创作',
  ppt: 'PPT 创作',
  video: '视频创作',
  general: '通用创作'
};

class AssistantService {
  static async respond({
    userId = null,
    workspace = 'general',
    message,
    draft = '',
    conversation = [],
    attachments = [],
    allowSearch = true,
    onPhase
  }) {
    const normalizedWorkspace = WORKSPACE_LABELS[workspace] ? workspace : 'general';
    const effectiveDraft = draft || '';
    const effectiveConversation = conversation;

    const plan = this.buildPlan({
      workspace: normalizedWorkspace,
      message,
      draft: effectiveDraft,
      conversation: effectiveConversation,
      allowSearch
    });
    if (onPhase) {
      onPhase({
        phase: 'understand_request',
        publicTitle: `${ASSISTANT_NAME}正在理解你的需求`,
        title: `${ASSISTANT_NAME}正在理解你的需求`,
        message: '正在判断需要读取哪些资料、是否需要检索'
      });
    }
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const assistantRuntimeConfig = this.getAssistantRuntimeConfig(runtimeConfig, normalizedWorkspace);
    await this.resolveSearchPlanWithModel({
      plan,
      workspace: normalizedWorkspace,
      message,
      draft: effectiveDraft,
      conversation: effectiveConversation,
      allowSearch,
      runtimeConfig,
      assistantRuntimeConfig
    });
    const resourceReadContext = this.buildPptResourceReadContext(message, attachments);
    const assistantAttachments = await this.normalizeAssistantAttachments(attachments, normalizedWorkspace, userId, {
      message,
      resourceReadContext
    });

    const resourceTrace = this.buildPptResourceTrace(normalizedWorkspace, resourceReadContext, assistantAttachments);
    const trace = [
      {
        kind: 'analysis',
        label: `${ASSISTANT_NAME}正在理解需求`,
        detail: plan.analysisDetail
      },
      resourceTrace
    ].filter(Boolean);

    let research = TavilyService.emptyResult();
    if (plan.search.enabled) {
      const searchStep = {
        kind: 'search',
        label: 'Web search · 检索资料',
        detail: plan.search.query
      };
      trace.push(searchStep);
      try {
        research = await TavilyService.search(plan.search);
        Object.assign(searchStep, this.buildResearchToolResult(research));
        searchStep.status = 'completed';
      } catch (error) {
        trace.push({
          kind: 'search',
          label: `${ASSISTANT_NAME}检索未完成`,
          detail: error.message || '联网检索失败，先基于已有信息整理',
          status: 'failed'
        });
        research = TavilyService.emptyResult();
      }
    }

    trace.push({
      kind: 'compose',
      label: `${ASSISTANT_NAME}正在整理交付内容`,
      detail: this.composeDetail(normalizedWorkspace, plan.intent)
    });

    const contextPayload = {
      assistant_name: ASSISTANT_NAME,
      workspace: normalizedWorkspace,
      workspace_label: WORKSPACE_LABELS[normalizedWorkspace],
      intent: plan.intent,
      user_request: message,
      recent_conversation: this.normalizeConversation(effectiveConversation).slice(-6),
      current_draft: plan.useDraft ? (effectiveDraft || '') : '',
      uploaded_images: assistantAttachments
        .filter(item => item.type === 'image')
        .map(item => ({
          name: item.name,
          mime_type: item.mimeType,
          selected: Boolean(item.selected),
          note: resourceReadContext.shouldInspectImages
            ? '用户请求涉及图片/封面/配图，图片已随本次消息上传，请直接观察图片内容并用于理解用户需求。'
            : '图片已随本次消息上传，请直接观察图片内容并用于理解用户需求。'
        })),
      uploaded_documents: assistantAttachments
        .filter(item => item.type === 'document' || item.type === 'template')
        .map(item => ({
          name: item.name,
          mime_type: item.mimeType,
          kind: item.type,
          selected: Boolean(item.selected),
          current_page: item.currentPage || null,
          page_count: item.pageCount || null,
          read_scope: item.readScope || '',
          read_note: item.readNote || '',
          content_preview: item.text || item.error || ''
        })),
      resource_reading: this.buildPptResourceReadingPayload(normalizedWorkspace, resourceReadContext, assistantAttachments),
      search_used: plan.search.enabled,
      search_query: research.query || plan.search.query || '',
      search_answer: research.answer || '',
      search_results: research.results.slice(0, 5).map(item => ({
        title: item.title || '',
        url: item.url || '',
        snippet: this.trimText(item.content || item.snippet || '', 360)
      })),
      image_results: (research.images || []).slice(0, 6),
      instructions: {
        cite_sources_when_using_search: plan.search.enabled,
        keep_language: 'zh-CN',
        keep_tone: '简洁、专业、像平台内置创作助手'
      }
    };

    const promptBundle = this.buildAssistantPromptBundle({
      workspace: normalizedWorkspace,
      intent: plan.intent,
      message,
      draft: effectiveDraft,
      trace
    });

    const messages = [
      {
        role: 'system',
        content: promptBundle.prompt
      },
      ...(plan.useDraft ? this.normalizeConversation(effectiveConversation) : []),
      {
        role: 'user',
        content: this.buildUserMessageContent(contextPayload, assistantAttachments)
      }
    ];

    const modelResponse = await AiService.chat({
      userId: 'assistant',
      messages,
      model: assistantRuntimeConfig.model,
      params: {
        route: assistantRuntimeConfig.route || (normalizedWorkspace === 'image' ? 'image_assistant' : 'assistant'),
        temperature: 0.4,
        max_tokens: 2200,
        timeout_ms: assistantRuntimeConfig.timeoutMs
      },
      runtimeConfig: assistantRuntimeConfig.runtimeConfig,
      allowConfigOverride: true
    });

    const payload = this.parseAssistantPayload(
      modelResponse.choices?.[0]?.message?.content || '',
      {
        workspace: normalizedWorkspace,
        intent: plan.intent,
        userRequest: message,
        trace,
        research
      }
    );
    const usageBilling = this.billAssistantTokenUsage({
      userId,
      workspace: normalizedWorkspace,
      usage: modelResponse.usage,
      messages,
      content: modelResponse.choices?.[0]?.message?.content || '',
      model: assistantRuntimeConfig.model,
      route: assistantRuntimeConfig.route || (normalizedWorkspace === 'image' ? 'image_assistant' : 'assistant')
    });

    return {
      assistant: payload,
      usage: modelResponse.usage,
      usage_billing: usageBilling
    };
  }

  static async respondStream({
    userId = null,
    workspace = 'general',
    message,
    draft = '',
    conversation = [],
    attachments = [],
    allowSearch = true,
    onDelta,
    onTool,
    onPhase
  }) {
    const normalizedWorkspace = WORKSPACE_LABELS[workspace] ? workspace : 'general';
    const effectiveDraft = draft || '';
    const effectiveConversation = conversation;

    const plan = this.buildPlan({
      workspace: normalizedWorkspace,
      message,
      draft: effectiveDraft,
      conversation: effectiveConversation,
      allowSearch
    });
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const assistantRuntimeConfig = this.getAssistantRuntimeConfig(runtimeConfig, normalizedWorkspace);
    await this.resolveSearchPlanWithModel({
      plan,
      workspace: normalizedWorkspace,
      message,
      draft: effectiveDraft,
      conversation: effectiveConversation,
      allowSearch,
      runtimeConfig,
      assistantRuntimeConfig,
      onTool
    });
    const resourceReadContext = this.buildPptResourceReadContext(message, attachments);
    if (onPhase && Array.isArray(attachments) && attachments.length > 0) {
      onPhase({
        phase: 'read_resources',
        publicTitle: `${ASSISTANT_NAME}正在读取上传资料`,
        title: `${ASSISTANT_NAME}正在读取上传资料`,
        message: '正在提取文档、图片和当前工作区内容'
      });
    }
    const assistantAttachments = await this.normalizeAssistantAttachments(attachments, normalizedWorkspace, userId, {
      message,
      resourceReadContext
    });

    const trace = [];
    const analysisStep = {
      kind: 'analysis',
      label: `${ASSISTANT_NAME}正在理解需求`,
      detail: plan.analysisDetail
    };
    trace.push(analysisStep);
    if (onTool) onTool({ ...analysisStep, status: 'completed' });

    const resourceTrace = this.buildPptResourceTrace(normalizedWorkspace, resourceReadContext, assistantAttachments);
    if (resourceTrace) {
      trace.push(resourceTrace);
      if (onTool) onTool({ ...resourceTrace, status: 'completed' });
    }

    let research = TavilyService.emptyResult();
    if (plan.search.enabled) {
      const searchStep = {
        kind: 'search',
        label: 'Web search · 检索资料',
        detail: plan.search.query
      };
      trace.push(searchStep);
      if (onPhase) {
        onPhase({
          phase: 'search_resources',
          publicTitle: `${ASSISTANT_NAME}正在检索相关内容`,
          title: `${ASSISTANT_NAME}正在检索相关内容`,
          message: '正在补充外部资料'
        });
      }
      if (onTool) onTool({ ...searchStep, status: 'running' });
      try {
        research = await TavilyService.search(plan.search);
        Object.assign(searchStep, this.buildResearchToolResult(research));
        searchStep.status = 'completed';
        if (onTool) onTool({ ...searchStep, status: 'completed' });
      } catch (error) {
        const failedStep = {
          kind: 'search',
          label: `${ASSISTANT_NAME}检索未完成`,
          detail: error.message || '联网检索失败，先基于已有信息整理',
          status: 'failed'
        };
        trace.push(failedStep);
        if (onTool) onTool({ ...failedStep, status: 'failed' });
        research = TavilyService.emptyResult();
      }
    }

    const composeStep = {
      kind: 'compose',
      label: `${ASSISTANT_NAME}正在整理交付内容`,
      detail: this.composeDetail(normalizedWorkspace, plan.intent)
    };
    trace.push(composeStep);
    if (onTool) onTool({ ...composeStep, status: 'running' });
    if (onPhase) {
      onPhase({
        phase: 'compose_context',
        publicTitle: `${ASSISTANT_NAME}正在整理可用内容`,
        title: `${ASSISTANT_NAME}正在整理可用内容`,
        message: this.composeDetail(normalizedWorkspace, plan.intent)
      });
    }

    const contextPayload = {
      assistant_name: ASSISTANT_NAME,
      workspace: normalizedWorkspace,
      workspace_label: WORKSPACE_LABELS[normalizedWorkspace],
      intent: plan.intent,
      user_request: message,
      recent_conversation: this.normalizeConversation(effectiveConversation).slice(-6),
      current_draft: plan.useDraft ? (effectiveDraft || '') : '',
      uploaded_images: assistantAttachments
        .filter(item => item.type === 'image')
        .map(item => ({
          name: item.name,
          mime_type: item.mimeType,
          selected: Boolean(item.selected),
          note: resourceReadContext.shouldInspectImages
            ? '用户请求涉及图片/封面/配图，图片已随本次消息上传，请直接观察图片内容并用于理解用户需求。'
            : '图片已随本次消息上传，请直接观察图片内容并用于理解用户需求。'
        })),
      uploaded_documents: assistantAttachments
        .filter(item => item.type === 'document' || item.type === 'template')
        .map(item => ({
          name: item.name,
          mime_type: item.mimeType,
          kind: item.type,
          selected: Boolean(item.selected),
          current_page: item.currentPage || null,
          page_count: item.pageCount || null,
          read_scope: item.readScope || '',
          read_note: item.readNote || '',
          content_preview: item.text || item.error || ''
        })),
      resource_reading: this.buildPptResourceReadingPayload(normalizedWorkspace, resourceReadContext, assistantAttachments),
      search_used: plan.search.enabled,
      search_query: research.query || plan.search.query || '',
      search_answer: research.answer || '',
      search_results: research.results.slice(0, 5).map(item => ({
        title: item.title || '',
        url: item.url || '',
        snippet: this.trimText(item.content || item.snippet || '', 360)
      })),
      image_results: (research.images || []).slice(0, 6),
      instructions: {
        cite_sources_when_using_search: plan.search.enabled,
        keep_language: 'zh-CN',
        keep_tone: '简洁、专业、像平台内置创作助手'
      }
    };

    const promptBundle = this.buildAssistantPromptBundle({
      workspace: normalizedWorkspace,
      intent: plan.intent,
      message,
      draft: effectiveDraft,
      trace,
      onTool
    });

    const messages = [
      {
        role: 'system',
        content: promptBundle.prompt
      },
      ...(plan.useDraft ? this.normalizeConversation(effectiveConversation) : []),
      {
        role: 'user',
        content: this.buildUserMessageContent(contextPayload, assistantAttachments)
      }
    ];

    const visibleEmitter = this.createVisibleAssistantDeltaEmitter(onDelta);

    if (onPhase) {
      onPhase({
        phase: 'model_stream',
        publicTitle: '正在组织回复内容',
        title: '正在组织回复内容',
        treeTitle: '整理回复',
        message: '乐米正在组织可用内容'
      });
    }

    let rawContent = '';
    const modelResponse = await AiService.chatStream({
      userId: 'assistant',
      messages,
      model: assistantRuntimeConfig.model,
      params: {
        route: assistantRuntimeConfig.route || (normalizedWorkspace === 'image' ? 'image_assistant' : 'assistant'),
        temperature: 0.4,
        max_tokens: 2200,
        timeout_ms: assistantRuntimeConfig.timeoutMs
      },
      runtimeConfig: assistantRuntimeConfig.runtimeConfig,
      allowConfigOverride: true,
      onDelta: delta => {
        rawContent += String(delta || '');
        visibleEmitter.push(rawContent);
      }
    });

    if (onTool) onTool({ ...composeStep, status: 'completed' });

    const payload = this.parseAssistantPayload(
      modelResponse.choices?.[0]?.message?.content || rawContent || '',
      {
        workspace: normalizedWorkspace,
        intent: plan.intent,
        userRequest: message,
        trace,
        research
      }
    );

    if (!visibleEmitter.getText()) {
      visibleEmitter.emitFinal(this.assistantPayloadToVisibleText(payload));
    }
    const usageBilling = this.billAssistantTokenUsage({
      userId,
      workspace: normalizedWorkspace,
      usage: modelResponse.usage,
      messages,
      content: modelResponse.choices?.[0]?.message?.content || rawContent || '',
      model: assistantRuntimeConfig.model,
      route: assistantRuntimeConfig.route || (normalizedWorkspace === 'image' ? 'image_assistant' : 'assistant')
    });

    return {
      assistant: payload,
      _streamed_text: visibleEmitter.getText(),
      usage: modelResponse.usage,
      usage_billing: usageBilling
    };
  }

  static billAssistantTokenUsage({
    userId,
    workspace = 'general',
    usage,
    messages = [],
    content = '',
    model = '',
    route = 'assistant'
  } = {}) {
    const safeUserId = parseInt(userId, 10);
    if (!safeUserId) return null;
    return User.billTokenUsage(safeUserId, usage, {
      source: 'chat',
      legacyType: 'chat',
      notePrefix: `${WORKSPACE_LABELS[workspace] || 'AI'}助手对话 token 计费`,
      fallback: { messages, content },
      model,
      route
    });
  }

  static async normalizeAssistantAttachments(attachments = [], workspace = 'general', userId = null, options = {}) {
    if (!Array.isArray(attachments)) return [];
    if (workspace !== 'image' && workspace !== 'ppt') return [];

    const readContext = options.resourceReadContext || this.buildPptResourceReadContext(options.message || '', attachments);

    const imageAttachments = attachments
      .filter(item => item && item.type === 'image' && (typeof item.dataUrl === 'string' || typeof item.url === 'string'))
      .map(item => ({
        name: this.trimText(item.name || '上传图片', 120),
        mimeType: this.trimText(item.mimeType || this.mimeTypeFromDataUrl(item.dataUrl), 80),
        dataUrl: typeof item.dataUrl === 'string' ? item.dataUrl.trim() : '',
        url: typeof item.url === 'string' ? item.url.trim() : '',
        selected: Boolean(item.selected)
      }))
      .filter(item => /^data:image\/[^;]+;base64,/i.test(item.dataUrl) || Boolean(item.url))
      .sort((a, b) => Number(b.selected) - Number(a.selected))
      .slice(0, readContext.shouldInspectImages ? 6 : 4);

    const normalized = [];
    for (const item of imageAttachments) {
      if (!item.dataUrl && item.url) {
        const asset = await AiService.resolveReferenceImageAsset({
          src: item.url,
          label: item.name
        });

        normalized.push({
          type: 'image',
          name: item.name,
          mimeType: asset.mimeType,
          dataUrl: `data:${asset.mimeType};base64,${asset.buffer.toString('base64')}`,
          url: '',
          selected: item.selected
        });
        continue;
      }

      if (!item.dataUrl || (!this.isHeicDataUrl(item.dataUrl) && !AiService.isHeicMimeType(item.mimeType || ''))) {
        normalized.push({
          type: 'image',
          name: item.name,
          mimeType: item.mimeType,
          dataUrl: item.dataUrl,
          url: item.url,
          selected: item.selected
        });
        continue;
      }

      const asset = await AiService.normalizeReferenceImageAsset(
        AiService.parseDataUrlReference(item.dataUrl, item.name),
        item.name
      );

      normalized.push({
        type: 'image',
        name: item.name,
        mimeType: asset.mimeType,
        dataUrl: `data:${asset.mimeType};base64,${asset.buffer.toString('base64')}`,
        url: '',
        selected: item.selected
      });
    }

    if (workspace === 'ppt') {
      normalized.push(...await this.normalizePptDocumentAttachments(attachments, userId, readContext));
    }

    return normalized;
  }

  static async normalizePptDocumentAttachments(attachments = [], userId = null, readContext = {}) {
    const candidates = attachments
      .filter(item => item && item.type !== 'image')
      .map(item => ({
        type: item.type === 'template' ? 'template' : 'document',
        id: item.fileId || item.id || '',
        name: this.trimText(item.name || item.originalName || item.filename || '上传资料', 160),
        mimeType: this.trimText(item.mimeType || item.mime_type || '', 100),
        url: typeof item.url === 'string' ? item.url.trim() : '',
        selected: Boolean(item.selected),
        currentPage: this.normalizePositiveInteger(item.currentPage),
        currentPageIndex: Number.isFinite(Number(item.currentPageIndex)) ? Number(item.currentPageIndex) : null,
        pageCount: this.normalizePositiveInteger(item.pageCount),
        previewMode: this.trimText(item.previewMode || '', 80),
        readScopeHint: this.trimText(item.readScope || item.resourceReadScope || '', 40)
      }))
      .filter(item => item.id || item.url || item.name)
      .sort((a, b) => Number(b.selected) - Number(a.selected))
      .slice(0, 6);

    const normalized = [];
    for (const item of candidates) {
      const resolved = await this.resolvePptAttachmentFile(item, userId);
      if (!resolved.file) {
        normalized.push({
          ...item,
          text: '',
          readScope: this.resolvePptDocumentReadScope(item, readContext),
          readNote: '未能定位文件，因此没有可读取内容。',
          error: `未能读取上传资料：${resolved.error || '文件不存在'}`
        });
        continue;
      }

      const filePath = resolved.file.path || '';
      const converter = DocumentConverterService.detectConverter(filePath || resolved.file.original_name || resolved.file.filename || item.name);
      if (!converter) {
        normalized.push({
          ...item,
          name: resolved.file.original_name || item.name,
          mimeType: resolved.file.mime_type || item.mimeType,
          text: '',
          readScope: this.resolvePptDocumentReadScope(item, readContext),
          readNote: '该格式暂不支持文本抽取。',
          error: '这个文件暂不支持自动提取文本'
        });
        continue;
      }

      try {
        const outputDir = path.join(appConfig.uploadDir, 'assistant_previews', String(resolved.file.user_id || 'shared'), String(resolved.file.id || item.id || 'upload'));
        const outputPath = path.join(outputDir, `${path.basename(filePath, path.extname(filePath))}.md`);
        let markdown = '';
        const sourceStat = fs.statSync(filePath);
        const cachedMarkdown = DocumentConverterService.readCachedMarkdown(outputPath, sourceStat.mtimeMs);

        if (cachedMarkdown !== null) {
          markdown = cachedMarkdown;
        } else {
          const converted = await DocumentConverterService.convert(filePath, {
            outputDir,
            converter,
            timeoutMs: 120000
          });
          markdown = converted.markdown || '';
          DocumentConverterService.markCacheFresh(outputDir);
        }

        if (DocumentConverterService.isProbablyGarbledMarkdown(markdown)) {
          throw new Error('文本抽取疑似乱码。请查看页面预览，或上传 docx/pdf 获取更稳定的可读文本。');
        }

        const preview = this.buildPptDocumentAttachmentPreview(markdown, {
          ...item,
          readContext
        });
        normalized.push({
          ...item,
          name: resolved.file.original_name || item.name,
          mimeType: resolved.file.mime_type || item.mimeType,
          text: preview.text,
          readScope: preview.scope,
          readNote: preview.note,
          documentStats: preview.stats
        });
      } catch (error) {
        normalized.push({
          ...item,
          name: resolved.file.original_name || item.name,
          mimeType: resolved.file.mime_type || item.mimeType,
          text: '',
          readScope: this.resolvePptDocumentReadScope(item, readContext),
          readNote: '文件转换或读取失败。',
          error: `文件内容提取失败：${this.trimText(error.message || '未知错误', 240)}`
        });
      }
    }

    return normalized;
  }

  static buildPptDocumentAttachmentPreview(markdown = '', item = {}) {
    const text = String(markdown || '');
    const stats = this.getMarkdownDocumentStats(text);
    const scope = this.resolvePptDocumentReadScope(item, item.readContext || {});
    if (!text.trim()) {
      return {
        text: '',
        scope,
        note: '文档为空或转换后没有可读文本。',
        stats
      };
    }

    const pageNumber = this.getPptDocumentTargetPage(item, item.readContext || {});
    const pageCount = this.normalizePositiveInteger(item.pageCount);
    if (scope === 'page' && pageNumber) {
      const pageWindow = this.extractMarkdownPageWindow(text, pageNumber, 1);
      const header = [
        item.selected ? '当前打开的上传资料' : '上传资料',
        `读取范围：当前预览页，第 ${pageNumber}${pageCount ? ` / ${pageCount}` : ''} 页，并补充相邻页避免断章。`,
        '回答用户关于当前页的问题时，优先使用“当前预览页”内容。'
      ].filter(Boolean).join('\n');

      const currentFocusedText = pageWindow
        ? this.trimText(pageWindow, 12000)
        : this.trimText(text, 10000);

      const fallbackPrefix = pageWindow ? '' : '\n\n注意：未在转换文本中找到精确分页标记，以下为全文开头片段，回答时需要说明不确定性。';
      return {
        text: `${header}${fallbackPrefix}\n\n${currentFocusedText}`.trim(),
        scope,
        note: pageWindow
          ? `已读取第 ${pageNumber} 页及相邻页。`
          : '未找到分页标记，已改用全文开头片段。',
        stats
      };
    }

    if (scope === 'full') {
      const fullText = this.buildFullMarkdownDocumentScan(text, {
        selected: item.selected,
        name: item.name,
        pageCount,
        maxLength: item.selected ? 26000 : 18000
      });
      return {
        text: fullText,
        scope,
        note: '已按完整文档结构从头到尾扫读；长文档会保留全文结构、目录、逐页/逐段摘录和关键开头结尾，供模型基于全局内容规划。',
        stats
      };
    }

    const autoText = this.buildAutoMarkdownDocumentPreview(text, {
      selected: item.selected,
      name: item.name,
      pageNumber,
      pageCount
    });
    return {
      text: autoText,
      scope,
      note: pageNumber && item.selected
        ? `已优先读取当前第 ${pageNumber} 页，并附带全局结构概览。`
        : '已读取文档开头和全局结构概览；如用户要求整篇会自动切换到全文结构扫读。',
      stats
    };
  }

  static buildPptResourceReadContext(message = '', attachments = []) {
    const text = String(message || '').trim();
    const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
    const documents = list.filter(item => item.type !== 'image');
    const images = list.filter(item => item.type === 'image');
    const selectedDocuments = documents.filter(item => item.selected);
    const selectedImages = images.filter(item => item.selected);
    const requestedPages = this.extractRequestedDocumentPages(text);
    const explicitPageRequested = requestedPages.length > 0 || /(当前页|当前预览页|这一页|这页|本页)/.test(text);
    const pageQuestionIntent = /(讲.*什么|讲了什么|内容是什么|是什么内容|说.*什么|概括|总结|摘要|提炼|解释|看一下|帮我看|分析|重点|要点|什么意思|提取|读|阅读|看看)/.test(text);
    const explicitFull = /(全部|所有|整份|整个|全文|完整|通读|从头到尾|全读|完整读|读完|读一遍|全部读|完整页内容|上传完整页内容)/.test(text);
    const allUploaded = /(所有|全部).{0,8}(上传|附件|资料|文档|文件|资源)|资源区.{0,12}(所有|全部|完整)|上传.{0,8}(所有|全部|完整)/.test(text);
    const materialDocumentRef = /(根据|基于|按照|参考|用|利用|就按|从).{0,18}(上传|资源区|附件|资料|文档|PDF|pdf|论文|文件|材料|左侧|工作台|这份|这个文件|这个PDF|当前文档|当前资料)/.test(text);
    const resourceSummaryRequest = !explicitPageRequested && (
      /(总结|概括|摘要|提炼|分析|阅读|读|看一下|帮我看|梳理|整理).{0,18}(上传|资源区|附件|资料|文档|PDF|pdf|论文|文件|材料|这份|这个文件|这个PDF|当前文档|当前资料)/.test(text)
      || /(上传|资源区|附件|资料|文档|PDF|pdf|论文|文件|材料|这份|这个文件|这个PDF|当前文档|当前资料).{0,18}(总结|概括|摘要|提炼|分析|阅读|读|看一下|帮我看|梳理|整理)/.test(text)
    );
    const paperPptRequest = documents.length > 0 && (
      /(论文|paper|PDF|pdf|文献|报告).{0,24}(PPT|ppt|汇报|课件|演示)/.test(text)
      || /(生成|制作|做|创建|整理).{0,24}(论文|文献|报告|PDF|pdf).{0,16}(汇报|PPT|ppt|课件|演示)/.test(text)
    );
    const createFromMaterial = /(生成|制作|做|创建|整理|提炼|总结|概括|分析|改写).{0,28}(PPT|ppt|汇报|课件|简报|大纲|目录|方案|内容)/.test(text)
      && (materialDocumentRef || allUploaded || paperPptRequest);
    const fullRead = documents.length > 0 && (explicitFull || allUploaded || paperPptRequest || createFromMaterial || resourceSummaryRequest);
    const pageRead = documents.length > 0 && !fullRead && explicitPageRequested && pageQuestionIntent;
    const imageIntent = /(图片|图像|照片|封面|配图|插图|截图|参考图|原图|看图|看看图片|这张图|这张|这幅|视觉|构图|色彩|素材图|产品图|人物图|背景图)/.test(text);
    const shouldInspectImages = images.length > 0 && (imageIntent || allUploaded || /参考.{0,8}(图|图片|上传|附件|资源)/.test(text));

    let scope = 'auto';
    if (fullRead) scope = 'full';
    else if (pageRead) scope = 'page';

    return {
      scope,
      message: text,
      documentCount: documents.length,
      imageCount: images.length,
      selectedDocumentCount: selectedDocuments.length,
      selectedImageCount: selectedImages.length,
      hasSelectedDocument: selectedDocuments.length > 0,
      hasSelectedImage: selectedImages.length > 0,
      requestedPages,
      targetPage: requestedPages[0] || null,
      explicitPageRequested,
      fullRead,
      allUploaded,
      materialDocumentRef,
      resourceSummaryRequest,
      paperPptRequest,
      shouldInspectImages
    };
  }

  static buildPptResourceTrace(workspace = 'general', readContext = {}, attachments = []) {
    if (workspace !== 'ppt') return null;
    const documents = attachments.filter(item => item.type === 'document' || item.type === 'template');
    const images = attachments.filter(item => item.type === 'image');
    if (!documents.length && !images.length) return null;

    const scopeLabel = {
      full: '按整篇/全部资料读取',
      page: '按指定页或当前页读取',
      auto: '按请求自动匹配资源'
    }[readContext.scope] || '按请求自动匹配资源';

    const docSummary = documents.length ? `${documents.length} 份文档` : '';
    const imageSummary = images.length ? `${images.length} 张图片` : '';
    return {
      kind: 'resource_read',
      label: '读取资源区材料',
      detail: [docSummary, imageSummary, scopeLabel].filter(Boolean).join('；'),
      status: 'completed',
      output: {
        read_scope: readContext.scope || 'auto',
        requested_pages: readContext.requestedPages || [],
        documents: documents.map(item => ({
          name: item.name,
          selected: Boolean(item.selected),
          read_scope: item.readScope || '',
          read_note: item.readNote || ''
        })),
        images: images.map(item => ({
          name: item.name,
          selected: Boolean(item.selected)
        }))
      }
    };
  }

  static buildPptResourceReadingPayload(workspace = 'general', readContext = {}, attachments = []) {
    if (workspace !== 'ppt') return null;
    const documents = attachments.filter(item => item.type === 'document' || item.type === 'template');
    const images = attachments.filter(item => item.type === 'image');
    if (!documents.length && !images.length) return null;

    const instructions = [
      '资源区材料已经随本轮请求自动读取；不要要求用户重新上传或手动打开文件。',
      readContext.scope === 'full'
        ? '用户请求涉及整篇、全部资料或基于上传材料生成内容：优先使用 uploaded_documents 中按完整文档结构扫读后的内容。'
        : '',
      readContext.scope === 'page'
        ? '用户请求涉及指定页或当前页：优先使用对应页内容，再用相邻页补上下文。'
        : '',
      readContext.shouldInspectImages
        ? '用户请求涉及图片、封面或配图：必须观察 uploaded_images 中随消息上传的图片，并把可见内容纳入方案。'
        : '',
      documents.length > 1 && (readContext.allUploaded || readContext.scope === 'full')
        ? '多份资料同时存在时，默认综合所有上传资料；只有用户指定某一份时才排除其他资料。'
        : ''
    ].filter(Boolean);

    return {
      strategy: readContext.scope || 'auto',
      requested_pages: readContext.requestedPages || [],
      should_inspect_images: Boolean(readContext.shouldInspectImages),
      instructions,
      documents: documents.map(item => ({
        name: item.name,
        kind: item.type,
        selected: Boolean(item.selected),
        current_page: item.currentPage || null,
        page_count: item.pageCount || item.documentStats?.pageCount || null,
        read_scope: item.readScope || '',
        read_note: item.readNote || '',
        stats: item.documentStats || null
      })),
      images: images.map(item => ({
        name: item.name,
        selected: Boolean(item.selected),
        note: '图片已作为视觉输入随消息发送'
      }))
    };
  }

  static resolvePptDocumentReadScope(item = {}, readContext = {}) {
    const hint = String(item.readScopeHint || '').trim().toLowerCase();
    if (['full', 'page', 'auto'].includes(hint)) return hint;

    if (readContext.scope === 'full') return 'full';
    if (readContext.scope === 'page') {
      if (item.selected || this.pptAttachmentMatchesMessage(item, readContext.message) || !readContext.hasSelectedDocument || readContext.documentCount <= 1) {
        return 'page';
      }
      return 'auto';
    }
    return 'auto';
  }

  static pptAttachmentMatchesMessage(item = {}, message = '') {
    const text = String(message || '').replace(/\s+/g, '').toLowerCase();
    if (!text) return false;
    const rawName = String(item.name || item.filename || '').trim();
    if (!rawName) return false;
    const normalizedName = rawName.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/\s+/g, '').toLowerCase();
    if (!normalizedName || normalizedName.length < 3) return false;
    if (text.includes(normalizedName)) return true;

    const parts = normalizedName
      .split(/[._\-—–（）()【】\[\]《》]+/)
      .map(part => part.trim())
      .filter(part => part.length >= 4);
    return parts.some(part => text.includes(part));
  }

  static getPptDocumentTargetPage(item = {}, readContext = {}) {
    if (Array.isArray(readContext.requestedPages) && readContext.requestedPages.length) {
      return readContext.requestedPages[0];
    }
    return this.normalizePositiveInteger(
      item.currentPage || (Number.isFinite(Number(item.currentPageIndex)) ? Number(item.currentPageIndex) + 1 : null)
    );
  }

  static extractRequestedDocumentPages(text = '') {
    const value = String(text || '');
    const pages = [];
    const push = token => {
      const number = this.parseLoosePositiveInteger(token);
      if (number && !pages.includes(number)) pages.push(number);
    };

    let match;
    const pagePattern = /第\s*([0-9]{1,4}|[零〇一二两三四五六七八九十百千]+)\s*(?:页|頁|张|張|屏)/g;
    while ((match = pagePattern.exec(value)) !== null) push(match[1]);

    const englishPattern = /\b(?:page|Page)\s*([0-9]{1,4})\b/g;
    while ((match = englishPattern.exec(value)) !== null) push(match[1]);

    const slidePattern = /\b[Pp]\s*([0-9]{1,3})\b/g;
    while ((match = slidePattern.exec(value)) !== null) push(match[1]);

    return pages.slice(0, 8);
  }

  static parseLoosePositiveInteger(value) {
    const token = String(value || '').trim();
    if (!token) return null;
    if (/^\d+$/.test(token)) return this.normalizePositiveInteger(token);
    return this.parseChinesePositiveInteger(token);
  }

  static parseChinesePositiveInteger(value = '') {
    const token = String(value || '').replace(/[零〇]/g, '').replace(/两/g, '二').trim();
    if (!token) return null;
    const digits = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9
    };

    if (digits[token]) return digits[token];

    const parseUnderHundred = part => {
      if (!part) return 0;
      if (digits[part]) return digits[part];
      const tenIndex = part.indexOf('十');
      if (tenIndex >= 0) {
        const tenPart = part.slice(0, tenIndex);
        const onePart = part.slice(tenIndex + 1);
        const tens = tenPart ? (digits[tenPart] || 0) : 1;
        const ones = onePart ? (digits[onePart] || 0) : 0;
        return tens * 10 + ones;
      }
      return 0;
    };

    const hundredIndex = token.indexOf('百');
    if (hundredIndex >= 0) {
      const hundredPart = token.slice(0, hundredIndex);
      const tail = token.slice(hundredIndex + 1);
      const hundreds = hundredPart ? (digits[hundredPart] || 0) : 1;
      const number = hundreds * 100 + parseUnderHundred(tail);
      return this.normalizePositiveInteger(number);
    }

    return this.normalizePositiveInteger(parseUnderHundred(token));
  }

  static getMarkdownDocumentStats(markdown = '') {
    const text = String(markdown || '');
    const pageSegments = this.splitMarkdownIntoPageSegments(text);
    const headings = this.extractMarkdownHeadings(text, 80);
    return {
      charCount: text.length,
      pageCount: pageSegments.length || null,
      headingCount: headings.length,
      hasPageMarkers: pageSegments.length > 0
    };
  }

  static buildAutoMarkdownDocumentPreview(markdown = '', options = {}) {
    const text = this.normalizeMarkdownForAssistant(markdown);
    const pageNumber = this.normalizePositiveInteger(options.pageNumber);
    const pageCount = this.normalizePositiveInteger(options.pageCount);
    const segments = this.splitMarkdownIntoPageSegments(text);
    const structure = this.buildMarkdownStructureIndex(text, segments, 40);
    const nameLine = options.name ? `资料名称：${options.name}` : '';

    if (options.selected && pageNumber) {
      const pageWindow = this.extractMarkdownPageWindow(text, pageNumber, 1);
      return [
        options.selected ? '当前打开的上传资料' : '上传资料',
        nameLine,
        `读取范围：自动。已优先读取当前预览页第 ${pageNumber}${pageCount ? ` / ${pageCount}` : ''} 页，并附带文档结构概览。`,
        pageWindow ? this.trimText(pageWindow, 10000) : this.trimText(text, 9000),
        structure ? `\n\n## 文档结构概览\n${structure}` : ''
      ].filter(Boolean).join('\n\n').trim();
    }

    if (text.length <= 12000) {
      return [
        '读取范围：自动。文档较短，已完整放入上下文。',
        nameLine,
        text
      ].filter(Boolean).join('\n\n');
    }

    return [
      '读取范围：自动。以下包含文档结构、开头、中段和结尾片段；如果用户要求整篇或全部资料，会切换为完整结构扫读。',
      nameLine,
      structure ? `## 文档结构概览\n${structure}` : '',
      this.buildDistributedMarkdownExcerpts(text, 9000)
    ].filter(Boolean).join('\n\n').trim();
  }

  static buildFullMarkdownDocumentScan(markdown = '', options = {}) {
    const text = this.normalizeMarkdownForAssistant(markdown);
    const maxLength = Math.max(9000, Number(options.maxLength) || 22000);
    const segments = this.splitMarkdownIntoPageSegments(text);
    const headings = this.extractMarkdownHeadings(text, 120);
    const statsLine = [
      options.name ? `资料名称：${options.name}` : '',
      `字符数：${text.length}`,
      segments.length ? `页数：${segments.length}` : '',
      headings.length ? `标题数：${headings.length}` : ''
    ].filter(Boolean).join('；');

    if (text.length <= maxLength - 600) {
      return [
        '读取范围：整篇文档原文。',
        '读取结果：文档长度在预算内，全文已完整放入上下文。',
        statsLine,
        text
      ].filter(Boolean).join('\n\n').trim();
    }

    const intro = [
      '读取范围：整篇文档。',
      '读取结果：文档过长，已从开头到结尾逐页/逐段扫读并做预算压缩；这不是只截取开头。回答或生成 PPT 时必须综合全局结构、各页摘录和结尾内容。',
      statsLine
    ].filter(Boolean).join('\n');

    const rawStructure = this.buildMarkdownStructureIndex(text, segments, 120);
    const structure = this.trimText(rawStructure, Math.max(1800, Math.floor(maxLength * 0.22)));
    if (segments.length) {
      return this.buildFullPageScanWithinBudget({
        intro,
        structure,
        segments,
        maxLength
      });
    }

    const sectionScan = this.buildHeadingSectionScanWithinBudget({
      intro,
      structure,
      text,
      maxLength
    });
    if (sectionScan) return sectionScan;

    return this.trimText([
      intro,
      structure ? `## 文档结构索引\n${structure}` : '',
      this.buildDistributedMarkdownExcerpts(text, maxLength - intro.length - 1200)
    ].filter(Boolean).join('\n\n'), maxLength);
  }

  static buildFullPageScanWithinBudget({ intro = '', structure = '', segments = [], maxLength = 22000 } = {}) {
    const safeSegments = Array.isArray(segments) ? segments : [];
    const structureText = this.trimText(structure, Math.max(1600, Math.floor(maxLength * 0.22)));
    let perPageBudget = Math.max(50, Math.floor((maxLength - intro.length - structureText.length - safeSegments.length * 18) / Math.max(safeSegments.length, 1)));
    perPageBudget = Math.min(1600, perPageBudget);

    let result = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pageScan = safeSegments.map(segment => {
        const body = this.condenseMarkdownBlock(segment.content, perPageBudget);
        return `## Page ${segment.page}\n\n${body || '（本页未提取到可读文本）'}`;
      }).join('\n\n');

      result = [
        intro,
        structureText ? `## 文档结构索引\n${structureText}` : '',
        '## 逐页扫读摘录',
        pageScan
      ].filter(Boolean).join('\n\n').trim();

      if (result.length <= maxLength || perPageBudget <= 40) break;
      perPageBudget = Math.max(40, Math.floor(perPageBudget * 0.78));
    }

    return this.trimText(result, maxLength);
  }

  static buildHeadingSectionScanWithinBudget({ intro = '', structure = '', text = '', maxLength = 22000 } = {}) {
    const sections = this.splitMarkdownIntoHeadingSections(text);
    if (!sections.length) return '';

    const structureText = this.trimText(structure, Math.max(1600, Math.floor(maxLength * 0.22)));
    let perSectionBudget = Math.max(60, Math.floor((maxLength - intro.length - structureText.length - sections.length * 20) / Math.max(sections.length, 1)));
    perSectionBudget = Math.min(1800, perSectionBudget);
    let result = '';

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sectionScan = sections.map((section, index) => {
        const title = section.title || `Section ${index + 1}`;
        return `## ${title}\n\n${this.condenseMarkdownBlock(section.content, perSectionBudget)}`;
      }).join('\n\n');
      result = [
        intro,
        structureText ? `## 文档结构索引\n${structureText}` : '',
        '## 分段扫读摘录',
        sectionScan
      ].filter(Boolean).join('\n\n').trim();
      if (result.length <= maxLength || perSectionBudget <= 45) break;
      perSectionBudget = Math.max(45, Math.floor(perSectionBudget * 0.78));
    }

    return this.trimText(result, maxLength);
  }

  static buildDistributedMarkdownExcerpts(markdown = '', maxLength = 9000) {
    const text = this.normalizeMarkdownForAssistant(markdown);
    const budget = Math.max(1200, Number(maxLength) || 9000);
    if (text.length <= budget) return text;

    const headBudget = Math.floor(budget * 0.42);
    const middleBudget = Math.floor(budget * 0.26);
    const tailBudget = Math.floor(budget * 0.24);
    const middleStart = Math.max(0, Math.floor(text.length / 2 - middleBudget / 2));
    return [
      '## 开头片段',
      text.slice(0, headBudget).trim(),
      '## 中段片段',
      text.slice(middleStart, middleStart + middleBudget).trim(),
      '## 结尾片段',
      text.slice(Math.max(0, text.length - tailBudget)).trim()
    ].join('\n\n');
  }

  static splitMarkdownIntoPageSegments(markdown = '') {
    const text = String(markdown || '');
    const markerPattern = /<!--\s*Page\s+(\d+)\s*-->/gi;
    const markers = [];
    let match;
    while ((match = markerPattern.exec(text)) !== null) {
      const page = Number(match[1]);
      if (Number.isFinite(page)) {
        markers.push({ page, index: match.index, end: markerPattern.lastIndex });
      }
    }

    if (!markers.length) return [];
    const prefix = text.slice(0, markers[0].index).trim();
    return markers.map((marker, index) => {
      const next = markers[index + 1];
      const content = text.slice(marker.end, next ? next.index : text.length).trim();
      return {
        page: marker.page,
        content: index === 0 && prefix ? `${prefix}\n\n${content}`.trim() : content
      };
    });
  }

  static splitMarkdownIntoHeadingSections(markdown = '') {
    const text = String(markdown || '');
    const headingPattern = /^(#{1,4})\s+(.+)$/gm;
    const headings = [];
    let match;
    while ((match = headingPattern.exec(text)) !== null) {
      headings.push({
        title: String(match[2] || '').trim(),
        index: match.index,
        end: headingPattern.lastIndex
      });
    }

    if (!headings.length) return [];
    return headings.slice(0, 80).map((heading, index) => {
      const next = headings[index + 1];
      return {
        title: heading.title,
        content: text.slice(heading.end, next ? next.index : text.length).trim()
      };
    }).filter(section => section.title || section.content);
  }

  static buildMarkdownStructureIndex(markdown = '', pageSegments = [], maxItems = 80) {
    const segments = Array.isArray(pageSegments) ? pageSegments : [];
    if (segments.length) {
      return segments.slice(0, maxItems).map(segment => {
        const label = this.extractMarkdownSegmentLabel(segment.content) || '未提取到标题';
        return `- Page ${segment.page}: ${this.trimText(label, 140)}${segment.content ? `（约 ${segment.content.length} 字）` : ''}`;
      }).join('\n');
    }

    const headings = this.extractMarkdownHeadings(markdown, maxItems);
    if (headings.length) {
      return headings.map(item => `- ${item}`).join('\n');
    }

    return '';
  }

  static extractMarkdownHeadings(markdown = '', maxItems = 80) {
    return String(markdown || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^#{1,6}\s+\S/.test(line))
      .map(line => line.replace(/^#{1,6}\s+/, '').trim())
      .filter(Boolean)
      .slice(0, maxItems);
  }

  static extractMarkdownSegmentLabel(content = '') {
    const lines = String(content || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const heading = lines.find(line => /^#{1,6}\s+\S/.test(line));
    if (heading) return heading.replace(/^#{1,6}\s+/, '').trim();
    const listItem = lines.find(line => !/^[-*_`|:：]+$/.test(line));
    return listItem || '';
  }

  static condenseMarkdownBlock(content = '', maxLength = 800) {
    const text = this.normalizeMarkdownForAssistant(content);
    const budget = Math.max(40, Number(maxLength) || 800);
    if (text.length <= budget) return text;

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const keyLines = lines
      .filter(line => /^#{1,6}\s+/.test(line)
        || /^\|.+\|$/.test(line)
        || /(?:\d+(?:\.\d+)?%?|\d+万|\d+亿|结论|问题|原因|方法|结果|目标|建议|风险|趋势|数据|表格|图表)/.test(line))
      .slice(0, 8);

    const headBudget = Math.floor(budget * 0.58);
    const tailBudget = Math.floor(budget * 0.24);
    const head = text.slice(0, headBudget).trim();
    const tail = text.slice(Math.max(0, text.length - tailBudget)).trim();
    const keyText = keyLines.length ? `\n\n关键行：\n${keyLines.map(line => `- ${this.trimText(line, 180)}`).join('\n')}` : '';

    return this.trimText([
      head,
      keyText,
      tail ? `\n\n结尾片段：\n${tail}` : ''
    ].filter(Boolean).join('\n'), budget);
  }

  static normalizeMarkdownForAssistant(markdown = '') {
    return String(markdown || '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  static normalizePositiveInteger(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const integer = Math.floor(number);
    return integer > 0 ? integer : null;
  }

  static extractMarkdownPageWindow(markdown = '', pageNumber, radius = 1) {
    const targetPage = this.normalizePositiveInteger(pageNumber);
    if (!targetPage) return '';

    const text = String(markdown || '');
    const markerPattern = /<!--\s*Page\s+(\d+)\s*-->/gi;
    const markers = [];
    let match;
    while ((match = markerPattern.exec(text)) !== null) {
      const page = Number(match[1]);
      if (Number.isFinite(page)) {
        markers.push({ page, index: match.index, end: markerPattern.lastIndex });
      }
    }

    if (!markers.length) return '';

    const titleEnd = markers[0].index;
    const firstPageStart = 0;
    const segments = [];
    const firstPageEnd = markers[0].index;
    if (firstPageEnd > firstPageStart) {
      segments.push({
        page: 1,
        content: text.slice(firstPageStart, firstPageEnd).trim()
      });
    }

    markers.forEach((marker, index) => {
      const next = markers[index + 1];
      segments.push({
        page: marker.page,
        content: text.slice(marker.end, next ? next.index : text.length).trim()
      });
    });

    const startPage = Math.max(1, targetPage - Math.max(0, Number(radius) || 0));
    const endPage = targetPage + Math.max(0, Number(radius) || 0);
    const selected = segments
      .filter(segment => segment.page >= startPage && segment.page <= endPage && segment.content)
      .sort((a, b) => {
        const aDistance = Math.abs(a.page - targetPage);
        const bDistance = Math.abs(b.page - targetPage);
        if (aDistance !== bDistance) return aDistance - bDistance;
        return a.page - b.page;
      });

    if (!selected.length) return '';

    const documentTitle = text.slice(0, titleEnd).trim().split(/\n{2,}/).slice(0, 1).join('\n').trim();
    return [
      documentTitle,
      ...selected.map(segment => `## Page ${segment.page}${segment.page === targetPage ? '（当前预览页）' : ''}\n\n${segment.content}`)
    ].filter(Boolean).join('\n\n');
  }

  static async resolvePptAttachmentFile(item = {}, userId = null) {
    const id = String(item.id || '').trim();
    if (id) {
      const file = File.findById(id);
      if (!file) return { file: null, error: '文件记录不存在' };
      if (userId && String(file.user_id) !== String(userId)) return { file: null, error: '无权访问此文件' };
      if (!file.path || !fs.existsSync(file.path)) return { file: null, error: '文件已丢失' };
      return { file };
    }

    if (!id && item.url && /^\/uploads\//.test(item.url)) {
      try {
        const filePath = appConfig.uploadUrlToPath(item.url);
        if (!fs.existsSync(filePath)) return { file: null, error: '文件已丢失' };
        if (userId) {
          const relative = path.relative(path.join(appConfig.uploadDir, String(userId)), filePath);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { file: null, error: '无权访问此文件' };
          }
        }
        return {
          file: {
            id: item.url,
            user_id: userId,
            path: filePath,
            original_name: item.name,
            filename: path.basename(filePath),
            mime_type: item.mimeType
          }
        };
      } catch (error) {
        return { file: null, error: error.message };
      }
    }

    return { file: null, error: '缺少文件标识' };
  }

  static createVisibleAssistantDeltaEmitter(onDelta) {
    let lastText = '';
    return {
      push(rawContent) {
        if (!onDelta) return;
        const text = AssistantService.extractVisibleTextFromAssistantJsonStream(rawContent);
        if (!text || text.length <= lastText.length || !text.startsWith(lastText)) return;
        const delta = text.slice(lastText.length);
        lastText = text;
        if (delta) onDelta(delta);
      },
      emitFinal(text) {
        if (!onDelta) return;
        const value = String(text || '').trim();
        if (!value || value.length <= lastText.length || !value.startsWith(lastText)) return;
        const delta = value.slice(lastText.length);
        lastText = value;
        if (delta) onDelta(delta);
      },
      getText() {
        return lastText;
      }
    };
  }

  static buildAssistantPromptBundle({
    workspace = 'general',
    intent = '',
    message = '',
    draft = '',
    trace,
    onTool
  } = {}) {
    const basePrompts = [
      'assistant_core',
      'assistant_output',
      `assistant_workspace_${workspace}`
    ];

    if (workspace === 'image') {
      basePrompts.push('assistant_image_templates');
    }

    const bundle = AgentCustomizationService.buildPromptBundle({
      basePrompts,
      workspace,
      intent,
      agent: this.assistantAgentForWorkspace(workspace),
      skillNames: this.assistantSkillNamesForWorkspace(workspace),
      context: { message, draft }
    });

    const loadedSkills = bundle.discovery.loaded_skills || [];
    const discoveryStep = {
      kind: 'discovery',
      label: '加载工作区指令与技能',
      detail: [
        bundle.discovery.loaded_agent?.id ? `Agent: ${bundle.discovery.loaded_agent.id}` : '',
        loadedSkills.length ? `Skills: ${loadedSkills.map(item => item.name || item.id).join(', ')}` : 'Skills: none',
        (bundle.discovery.loaded_instructions || []).length
          ? `Instructions: ${bundle.discovery.loaded_instructions.map(item => item.name || item.id).join(', ')}`
          : ''
      ].filter(Boolean).join('；'),
      status: 'completed',
      discovery: bundle.discovery
    };

    if (Array.isArray(trace)) {
      trace.push(discoveryStep);
    }
    if (onTool) {
      onTool(discoveryStep);
    }

    return bundle;
  }

  static assistantAgentForWorkspace(workspace) {
    if (workspace === 'ppt') return 'ppt-planner';
    if (workspace === 'image') return 'image-assistant';
    if (workspace === 'video') return 'video-assistant';
    return 'general-assistant';
  }

  static assistantSkillNamesForWorkspace(workspace) {
    if (workspace === 'ppt') {
      return ['assistant-output-json', 'ppt-requirement-planner', 'ppt-reference-extractor'];
    }
    if (workspace === 'image') {
      return ['assistant-output-json'];
    }
    if (workspace === 'video') {
      return ['assistant-output-json'];
    }
    return ['assistant-output-json'];
  }

  static extractVisibleTextFromAssistantJsonStream(rawContent = '') {
    const raw = String(rawContent || '');
    const parsed = this.safeParseJsonQuiet(raw);
    if (parsed && typeof parsed === 'object') {
      return this.visibleTextFromRawAssistantPayload(parsed);
    }

    const deliverablesSlice = this.extractPartialJsonArraySection(raw, 'deliverables');
    const deliverableContents = this.extractPartialJsonStringValues(deliverablesSlice, 'content')
      .filter(item => this.isAssistantVisibleText(item))
      .slice(0, 2);
    const deliverableItems = this.extractPartialJsonArrayStrings(deliverablesSlice, 'items')
      .filter(item => this.isAssistantVisibleText(item))
      .slice(0, 6);

    const parts = [...deliverableContents];
    if (deliverableItems.length) {
      parts.push(deliverableItems.map(item => `- ${item}`).join('\n'));
    }
    return parts.filter(Boolean).join('\n\n').trim();
  }

  static visibleTextFromRawAssistantPayload(payload = {}) {
    const parts = [];
    if (payload.overview) parts.push(String(payload.overview));
    if (Array.isArray(payload.deliverables)) {
      payload.deliverables.slice(0, 2).forEach(item => {
        if (this.isAssistantVisibleText(item?.content)) parts.push(String(item.content));
        if (Array.isArray(item?.items) && item.items.length) {
          const items = item.items.filter(entry => this.isAssistantVisibleText(entry)).slice(0, 4);
          if (items.length) parts.push(items.map(entry => `- ${entry}`).join('\n'));
        }
      });
    }
    return parts.join('\n\n').trim();
  }

  static assistantPayloadToVisibleText(payload = {}) {
    const parts = [];
    if (payload.overview) parts.push(payload.overview);
    if (Array.isArray(payload.deliverables)) {
      payload.deliverables.slice(0, 2).forEach(item => {
        if (this.isAssistantVisibleText(item.content)) parts.push(item.content);
        if (Array.isArray(item.items) && item.items.length) {
          const items = item.items.filter(entry => this.isAssistantVisibleText(entry)).slice(0, 4);
          if (items.length) parts.push(items.map(entry => `- ${entry}`).join('\n'));
        }
      });
    }
    return parts.join('\n\n').trim();
  }

  static safeParseJsonQuiet(rawContent) {
    if (!rawContent) return null;
    const cleaned = String(rawContent)
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch (error) {
      return null;
    }
  }

  static extractJsonObject(rawContent) {
    const raw = String(rawContent || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const direct = this.safeParseJsonQuiet(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = this.safeParseJsonQuiet(raw.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
    return null;
  }

  static extractPartialJsonStringValue(raw, key) {
    return this.extractPartialJsonStringValues(raw, key)[0] || '';
  }

  static extractPartialJsonStringValues(raw, key) {
    const values = [];
    const pattern = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      const value = this.readPartialJsonString(raw, match.index + match[0].length);
      if (value) values.push(value);
    }
    return values;
  }

  static extractPartialJsonArraySection(raw, key) {
    const source = String(raw || '');
    const pattern = new RegExp(`"${key}"\\s*:\\s*\\[`, 'g');
    const match = pattern.exec(source);
    if (!match) return '';
    const start = match.index + match[0].length;
    const tail = source.slice(start);
    const boundary = tail.search(/(?:^|[\r\n,])\s*"(?:suggestions|sources|images|search_query|apply_text|ready_to_generate|overview|ppt_style|ppt_master_template)"\s*:/);
    return boundary >= 0 ? tail.slice(0, boundary) : tail;
  }

  static extractPartialJsonArrayStrings(raw, key) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*\\[`, 'g');
    const values = [];
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      const slice = raw.slice(match.index + match[0].length);
      const stringPattern = /"((?:\\.|[^"\\])*)"?/g;
      let itemMatch;
      while ((itemMatch = stringPattern.exec(slice)) !== null) {
        if (itemMatch.index > 1200) break;
        const value = this.decodeJsonStringFragment(itemMatch[1] || '');
        if (value) values.push(value);
        if (slice[itemMatch.index + itemMatch[0].length] === ']') break;
      }
    }
    return values;
  }

  static readPartialJsonString(raw, startIndex) {
    let escaped = false;
    let value = '';
    for (let index = startIndex; index < raw.length; index += 1) {
      const char = raw[index];
      if (escaped) {
        value += `\\${char}`;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') break;
      value += char;
    }
    return this.decodeJsonStringFragment(value);
  }

  static decodeJsonStringFragment(value) {
    const text = String(value || '');
    if (!text) return '';
    try {
      return JSON.parse(`"${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`);
    } catch (error) {
      return text
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\\t/g, '    ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
    }
  }

  static isAssistantVisibleText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || /^\s*https?:\/\//i.test(text)) return false;
    return !this.looksLikeLeakedAssistantContext(text);
  }

  static looksLikeLeakedAssistantContext(text = '') {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    if (/当前工作台上下文仅供参考/.test(value)) return true;
    if (/我们被问到|根据指令|输出结构必须符合JSON|输出纯JSON|不要用Markdown代码块|用户只是.*(?:打招呼|测试|闲聊)/.test(value)) return true;
    const markers = [
      '已有PPT方案',
      '默认页数',
      '页数策略',
      '默认风格',
      '默认比例',
      '联网搜索',
      'AI生图',
      'current_draft',
      'user_request',
      'search_results',
      'workspace_label',
      'uploaded_images',
      'ready_to_generate',
      'deliverables',
      'apply_text',
      'search_query',
      'intent'
    ];
    const markerCount = markers.filter(marker => value.includes(marker)).length;
    return markerCount >= 2;
  }

  static mimeTypeFromDataUrl(dataUrl = '') {
    const match = String(dataUrl || '').match(/^data:(image\/[^;]+);base64,/i);
    return match ? match[1].toLowerCase() : '';
  }

  static isHeicDataUrl(dataUrl = '') {
    return /^data:image\/(?:x-)?hei[cf](?:-sequence)?;base64,/i.test(String(dataUrl || ''));
  }

  static buildUserMessageContent(contextPayload, attachments = []) {
    const text = JSON.stringify(contextPayload, null, 2);
    const imageAttachments = attachments
      .filter(item => item?.type === 'image' && (item.dataUrl || item.url));
    if (!imageAttachments.length) return text;

    return [
      { type: 'text', text },
      ...imageAttachments.map(item => ({
        type: 'image_url',
        image_url: {
          url: item.dataUrl || item.url,
          detail: 'auto'
        }
      }))
    ];
  }

  static getAssistantRuntimeConfig(runtimeConfig, workspace) {
    if (workspace === 'image') {
      return {
        model: runtimeConfig.imageAssistantModel || 'gpt-5.5',
        route: 'image_assistant',
        timeoutMs: Math.max(parseInt(runtimeConfig.imageAssistantTimeoutMs, 10) || 60000, 90000),
        runtimeConfig: {
          ...runtimeConfig,
          providerBaseUrl: runtimeConfig.imageAssistantBaseUrl || runtimeConfig.imageBaseUrl || runtimeConfig.providerBaseUrl,
          providerApiKey: runtimeConfig.imageAssistantApiKey || runtimeConfig.imageApiKey || runtimeConfig.providerApiKey,
          openAiChatFailoverEnabled: runtimeConfig.imageAssistantFailoverEnabled,
          openAiChatFallbackBaseUrl: runtimeConfig.imageAssistantFallbackBaseUrl || runtimeConfig.imageFallbackBaseUrl,
          openAiChatFallbackApiKey: runtimeConfig.imageAssistantFallbackApiKey || runtimeConfig.imageFallbackApiKey,
          openAiChatFallbackModel: runtimeConfig.imageAssistantFallbackModel || ''
        }
      };
    }

    if (workspace === 'ppt') {
      return {
        model: runtimeConfig.pptModel || runtimeConfig.assistantModel || 'claude-opus-4-7',
        route: 'ppt',
        timeoutMs: Math.max(
          parseInt(runtimeConfig.pptTimeoutMs, 10) || 0,
          parseInt(runtimeConfig.assistantTimeoutMs, 10) || 0,
          180000
        ),
        runtimeConfig
      };
    }

    return {
      model: runtimeConfig.assistantModel || 'claude-opus-4-7',
      route: 'assistant',
      timeoutMs: Math.max(parseInt(runtimeConfig.assistantTimeoutMs, 10) || 60000, 120000),
      runtimeConfig
    };
  }

  static async resolveSearchPlanWithModel({
    plan,
    workspace,
    message,
    draft = '',
    conversation = [],
    allowSearch = true,
    runtimeConfig,
    assistantRuntimeConfig,
    onTool
  } = {}) {
    if (!plan?.search) return plan;

    const localIntent = plan.intent || 'general_help';
    const localCandidate = this.buildLocalSearchCandidate({
      workspace,
      message,
      draft,
      conversation,
      allowSearch,
      intent: localIntent
    });

    plan.search = {
      ...plan.search,
      ...localCandidate,
      decision_source: localCandidate.decision_source,
      decision_reason: localCandidate.reason
    };

    if (!allowSearch || localCandidate.blocked || !localCandidate.enabled) {
      return plan;
    }

    const decisionStep = {
      kind: 'model_intent',
      label: '判断是否需要联网检索',
      detail: '由助手模型决定是否调用 Web search',
      status: 'running'
    };
    if (onTool) onTool(decisionStep);

    try {
      const decision = await this.judgeSearchWithModel({
        workspace,
        message,
        draft,
        conversation,
        localCandidate,
        runtimeConfig,
        assistantRuntimeConfig
      });

      if (decision) {
        plan.search.enabled = Boolean(decision.should_search);
        plan.search.query = decision.query || localCandidate.query || plan.search.query || '';
        plan.search.includeImages = typeof decision.include_images === 'boolean'
          ? decision.include_images
          : localCandidate.includeImages;
        plan.search.topic = decision.topic || localCandidate.topic || 'general';
        plan.search.maxResults = Number.isFinite(Number(decision.max_results))
          ? Math.max(1, Math.min(8, parseInt(decision.max_results, 10)))
          : localCandidate.maxResults;
        plan.search.decision_source = 'model';
        plan.search.decision_reason = decision.reason || '模型完成搜索工具路由判断';
      }

      if (onTool) {
        onTool({
          ...decisionStep,
          status: 'completed',
          detail: plan.search.enabled
            ? `需要检索：${plan.search.query}`
            : `不需要检索：${plan.search.decision_reason || '模型判断可基于当前上下文回答'}`
        });
      }
    } catch (error) {
      plan.search.enabled = false;
      plan.search.decision_source = 'model_failed';
      plan.search.decision_reason = `搜索路由判断失败，默认不联网：${this.trimText(error.message, 120)}`;
      if (onTool) {
        onTool({
          ...decisionStep,
          status: 'completed',
          detail: plan.search.decision_reason
        });
      }
    }

    return plan;
  }

  static async judgeSearchWithModel({
    workspace,
    message,
    draft = '',
    conversation = [],
    localCandidate = {},
    runtimeConfig,
    assistantRuntimeConfig
  }) {
    const prompt = [
      '你是 AI Designer 的工具路由器，负责判断本轮是否需要调用 Web search。',
      '这一步只做工具决策，不回答用户。',
      '参考 Copilot Chat 的工具调用原则：search 是可选工具，由模型按任务需要选择；不要因为出现“资料/参考/案例”等词就自动调用。',
      '如果用户要求基于上传文件、PDF、当前 PPT、已有草稿或本地材料处理，通常不需要 Web search。',
      '如果用户明确要求联网、搜索、查最新资料，或问题需要实时/外部事实，才需要 Web search。',
      '如果只是修改、总结、改写、润色、整理当前材料，不要 Web search。',
      '只返回合法 JSON，不要 Markdown。',
      '返回字段：should_search, query, reason, include_images, topic, max_results。'
    ].join('\n');

    const payload = {
      workspace,
      user_message: message,
      current_draft: this.trimText(draft, 2400),
      recent_conversation: this.normalizeConversation(conversation).slice(-6),
      local_candidate: localCandidate,
      return_schema: {
        should_search: false,
        query: '',
        reason: '一句话说明为什么需要或不需要搜索',
        include_images: false,
        topic: 'general',
        max_results: 5
      }
    };

    const response = await AiService.chat({
      userId: 'assistant-search-router',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(payload, null, 2) }
      ],
      model: assistantRuntimeConfig?.model,
      params: {
        route: assistantRuntimeConfig?.route || (workspace === 'image' ? 'image_assistant' : 'assistant'),
        temperature: 0.05,
        max_tokens: 450,
        timeout_ms: Math.min(Math.max(parseInt(assistantRuntimeConfig?.timeoutMs, 10) || 30000, 15000), 45000)
      },
      runtimeConfig: assistantRuntimeConfig?.runtimeConfig || runtimeConfig,
      allowConfigOverride: true
    });

    const raw = response.choices?.[0]?.message?.content || '';
    return this.extractJsonObject(raw);
  }

  static buildLocalSearchCandidate({ workspace, message, draft, conversation = [], allowSearch = true, intent = '' }) {
    const userText = String(message || '').trim();
    const fullText = `${userText}\n${draft || ''}`.trim();
    const noSearchRequested = /不要联网|不联网|不用搜索|不要搜索|无需检索|只基于/.test(fullText);
    const uploadedMaterialOnly = workspace === 'ppt' && this.isUploadedMaterialOnlyPptRequest(userText, draft);
    const blocked = !allowSearch || noSearchRequested || uploadedMaterialOnly;

    const isImageWorkspace = workspace === 'image';
    const isPptWorkspace = workspace === 'ppt';
    const shouldSearchVisualReferences = isImageWorkspace && this.shouldSearchVisualReferences(fullText);
    const shouldSearchPptImages = isPptWorkspace && this.shouldSearchVisualReferences(userText);
    const explicitSearch = this.isExplicitSearchRequest(userText);
    const needsFreshContext = !blocked && this.hasFreshExternalFactNeed(workspace, userText);
    const query = this.buildSearchQuery({ workspace, message, draft, intent, conversation });
    const enabled = !blocked && (
      explicitSearch
      || needsFreshContext
      || shouldSearchVisualReferences
    );

    return {
      enabled,
      blocked,
      query,
      includeImages: isImageWorkspace || shouldSearchPptImages,
      topic: needsFreshContext ? 'news' : 'general',
      maxResults: shouldSearchVisualReferences || needsFreshContext ? 6 : (isImageWorkspace ? 4 : 5),
      decision_source: 'local_candidate',
      reason: blocked
        ? (uploadedMaterialOnly ? '用户要求基于上传资料/当前材料处理，默认不联网' : '用户关闭或否定联网检索')
        : (enabled ? '本地判断可能需要联网，等待模型确认' : '本地判断不需要联网')
    };
  }

  static buildPlan({ workspace, message, draft, conversation = [], allowSearch = true }) {
    const userText = String(message || '').trim();
    const fullText = `${userText}\n${draft || ''}`.trim();
    const intentSignals = {
      copywriting: ['文案', '标题', 'slogan', '卖点', '介绍', '口播'],
      research: ['资料', '数据', '案例', '趋势', '搜索', '检索', '查'],
      prompt: ['提示词', '画面', '风格', '配色', '构图', '关键词'],
      outline: ['大纲', '结构', '目录', '分镜', '脚本']
    };

    const isImageWorkspace = workspace === 'image';
    const isPptWorkspace = workspace === 'ppt';
    const isVideoWorkspace = workspace === 'video';

    let intent = 'general_help';
    if (isImageWorkspace) {
      intent = 'image_prompt';
    } else if (isPptWorkspace) {
      intent = 'ppt_outline';
    } else if (isVideoWorkspace) {
      intent = 'video_script';
    }

    if (!isPptWorkspace && intentSignals.copywriting.some(token => fullText.includes(token))) {
      intent = 'copywriting';
    } else if (!isPptWorkspace && intentSignals.research.some(token => fullText.includes(token))) {
      intent = 'research';
    } else if (isImageWorkspace && intentSignals.prompt.some(token => fullText.includes(token))) {
      intent = 'image_prompt';
    } else if (isVideoWorkspace && intentSignals.outline.some(token => fullText.includes(token))) {
      intent = 'video_script';
    }

    const searchCandidate = this.buildLocalSearchCandidate({ workspace, message, draft, conversation, allowSearch, intent });

    return {
      intent,
      useDraft: true,
      analysisDetail: this.analysisDetail(workspace, intent),
      search: {
        enabled: searchCandidate.enabled,
        query: searchCandidate.query,
        includeImages: searchCandidate.includeImages,
        topic: searchCandidate.topic,
        maxResults: searchCandidate.maxResults,
        decision_source: searchCandidate.decision_source,
        decision_reason: searchCandidate.reason
      }
    };
  }

  static pptDraftHasExistingPlan(draft = '') {
    const text = String(draft || '');
    return /已有PPT方案：\s*(?!无\b)[\s\S]{20,}/.test(text);
  }

  static pptDraftHasTaskContext(draft = '') {
    return /当前PPT任务：/.test(String(draft || ''));
  }

  static stripPptExistingPlanFromDraft(draft = '') {
    const text = String(draft || '');
    if (!text) return '';

    if (/已有PPT方案：/.test(text)) {
      return text.replace(/已有PPT方案：[\s\S]*?(?=\n(?:页数策略|默认页数|默认风格)：|$)/, '已有PPT方案：无');
    }

    return text;
  }

  static isExplicitNewPptTask(text = '') {
    const normalized = String(text || '').trim();
    return /(做|生成|制作|创建|写|出|整理|设计|帮我|我要|我想要|我想做|来一份|做一份|生成一份).{0,18}(PPT|ppt|幻灯片|课件|汇报|路演|简报|演示|方案)/.test(normalized)
      || /(做|生成|制作|创建|写|出|整理|设计|帮我|我要|我想要|我想做|来一份|做一份|生成一份|做个|生成个|制作个).{0,30}(PPT|ppt|幻灯片|课件|汇报|路演|简报|演示|方案)/.test(normalized)
      || /(PPT|ppt|幻灯片|课件|汇报|路演|简报|演示|方案).{0,30}(做|生成|制作|创建|写|出|整理|设计)/.test(normalized)
      || this.isImplicitPptPageRequest(normalized);
  }

  static isImplicitPptPageRequest(text = '') {
    const normalized = String(text || '').replace(/\s+/g, '');
    if (!normalized) return false;

    const creationSignal = /(做|生成|制作|创建|写|出|整理|设计|帮我|我要|我想要|我想做|来一份|做一份|生成一份|做个|生成个|制作个)/.test(normalized);
    const pageSignal = /(?:\d{1,3}|[一二两三四五六七八九十百]+)\s*(?:页|页面|张|屏)/.test(normalized);
    const contentSignal = /(?:公司|集团|品牌|产品|行业|市场|战略|历史|发展|介绍|方案|计划|分析|汇报|复盘|招商|路演|培训|课程|课件)/.test(normalized)
      || normalized.length >= 12;

    return creationSignal && pageSignal && contentSignal;
  }

  static isPptContextFollowUp(text = '') {
    const message = String(text || '').trim();
    const compact = message.replace(/\s+/g, '');
    return /(上一版|上版|刚才|这版|当前|原方案|这个方案|沿用|按这个|就这样|确认|开始生成|生成吧|执行|继续|修改|调整|改成|换成|删掉|删除|增加|减少|补充|页数|总页数|改.*页|风格|受众|标题|主题|目录|大纲|封面|配图|比例|失败|报错|错误|原因|怎么回事|什么情况|为什么|咋了|怎么了|哪里出问题|没成功|没生成|重来|重试|重新生成|重新开始|再试一次|再生成|502|网关)/.test(message)
      || /^(咋了|怎么了|为什么|为啥|啥情况|什么情况|哪里错了|错哪了|失败了吗|没成功吗|报错了吗|原因呢|啥原因|重来|重新来|再来|再来一次|再试|再试一次|重试|重新生成|重新开始|再生成|再生成一次)$/.test(compact);
  }

  static isExplicitPptRequest(text = '') {
    return /(PPT|ppt|幻灯片|课件|汇报|路演|简报|演示)/.test(String(text || ''))
      || this.isExplicitNewPptTask(text);
  }

  static isGreetingOrIntroMessage(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return false;

    return /^(你好|您好|hi|hello|哈喽|嗨|嘿|在吗|早上好|下午好|晚上好)([呀啊哦哈~！!，,\s]*)?$/.test(normalized)
      || /^(你好|您好|hi|hello|哈喽|嗨|嘿)([呀啊哦哈~！!，,\s]*)(我想问|想问|请问|咨询|问一下|问问你|问你)/.test(normalized)
      || /^(我想问|想问|请问|咨询|问一下|问问你|问你)(一下|个问题)?$/.test(normalized);
  }

  static isPptCapabilityQuestion(text = '') {
    const normalized = String(text || '').trim();
    if (!normalized) return false;

    return /(能做什么|可以做什么|会做什么|支持什么|怎么用|如何用|怎么开始|有什么功能|你能帮我什么|你能做什么|怎么生成|怎么做|可不可以|可以吗)/.test(normalized);
  }

  static buildPptClarificationResponse({ message, draft }) {
    const userText = String(message || '').trim();
    const normalizedDraft = this.stripPptExistingPlanFromDraft(draft || '');
    const defaultTail = '如果你暂时没定页数，我会根据内容多少和用途判断适合做几页，确认后再生成。';
    const isGreeting = this.isGreetingOrIntroMessage(userText);
    const isCapabilityQuestion = this.isPptCapabilityQuestion(userText);

    let overview = '先给我一个线索就能继续';
    let label = '你可以这样继续';
    let content = `你不用一次把主题、受众、页数全说完。先给我一个线索也可以，比如主题、用途、现有材料、想做给谁看，或者你想改哪一版；我会先补齐方案，再让你确认生成。${defaultTail}`;
    let suggestions = ['说主题或用途', '发材料或草稿', '告诉我卡在哪'];

    if (isCapabilityQuestion) {
      overview = '可以先问功能，也可以直接开做';
      label = '我能这样帮你';
      content = `可以，PPT 相关的问题也能直接问我。你可以让我帮你定结构、补目录、改路演逻辑，或者直接把主题、用途、现有材料发我；有一个线索我就能先往下整理。${defaultTail}`;
      suggestions = ['问我能怎么帮你', '发主题让我起方案', '上传材料或草稿'];
    } else if (isGreeting) {
      overview = '先聊聊你想做什么';
      label = '你可以先随便开个头';
      content = `可以，先随便说一个线索就行，比如主题、用途、受众、现有材料，或者你现在卡住的地方。我会先帮你理思路，再给你确认方案。${defaultTail}`;
      suggestions = ['先问我能做什么', '说主题或用途', '发材料让我整理'];
    }

    return {
      assistant: {
        assistant_name: ASSISTANT_NAME,
        workspace: 'ppt',
        intent: 'general_help',
        ready_to_generate: false,
        overview,
        trace: [
          {
            kind: 'analysis',
            label: `${ASSISTANT_NAME}正在理解需求`,
            detail: '本轮还没进入明确的 PPT 生成或修改指令'
          },
          {
            kind: 'compose',
            label: `${ASSISTANT_NAME}正在整理回复`,
            detail: '先做轻量引导，不沿用旧方案直接开做'
          }
        ],
        deliverables: [
          {
            id: 'ppt_requirement_prompt',
            type: 'text',
            label,
            content,
            items: [],
            apply_text: ''
          }
        ],
        suggestions,
        sources: [],
        images: [],
        apply_text: '',
        search_query: '',
        search_used: false
      }
    };
  }

  static shouldSearchPptContext(text) {
    if (!text || /不要联网|不联网|不用搜索|不要搜索|无需检索|只基于/.test(text)) {
      return false;
    }

    const normalized = text.replace(/\s+/g, '');
    const scenarioSignals = [
      '公司', '行业', '市场', '战略', '投资', '融资', '招商', '竞品', '政策', '趋势',
      '案例', '数据', '报告', '复盘', '路演', '商业计划', '发展分析', '年度', '季度'
    ];
    const entitySignals = [
      /[\u4e00-\u9fa5]{2,}(公司|集团|股份|科技|银行|大学|医院|品牌|产品|行业|市场|产业)/,
      /[A-Za-z][A-Za-z0-9&.\-]{2,}/,
      /\d{4}年|\d+%|\d+亿|\d+万/
    ];

    return scenarioSignals.some(token => normalized.includes(token))
      || entitySignals.some(pattern => pattern.test(text))
      || text.length >= 18;
  }

  static isExplicitSearchRequest(text = '') {
    return /(联网|上网|web\s*search|搜索|搜一下|检索|查一下|查找|查最新|最新|实时|今天|现在|当前|官网|新闻|价格|政策|报告|数据来源|引用来源)/i.test(String(text || ''));
  }

  static hasFreshExternalFactNeed(workspace = 'general', text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    if (workspace === 'ppt' && /(基于|根据|按照).{0,12}(上传|pdf|PDF|文档|资料|文件|当前|已有|这份|这个)/.test(value)) {
      return false;
    }
    return /(最新|实时|今天|现在|当前|近[一二三四五六七八九十0-9]+年|[12]\d{3}年|政策|新闻|价格|财报|融资|市场规模|行业数据|竞品数据|官网资料|引用来源|参考来源)/.test(value)
      && this.isExplicitSearchRequest(value);
  }

  static isUploadedMaterialOnlyPptRequest(message = '', draft = '') {
    const text = String(message || '').trim();
    if (!text) return false;
    const hasUploadedAssets = /上传资料：|PPT模板：|参考图：/.test(String(draft || ''));
    if (!hasUploadedAssets) return false;

    const materialRef = /(根据|基于|按照|参考|用|就按|从).{0,16}(上传|pdf|PDF|文档|资料|文件|附件|当前|已有|这个|这份|左侧|工作台)/.test(text)
      || /(修改|改|调整|润色|优化|整理|总结|提炼|汇报大纲|大纲|内容).{0,20}(ppt|PPT|课件|汇报|方案)/.test(text);
    const explicitSearch = this.isExplicitSearchRequest(text);
    return materialRef && !explicitSearch;
  }

  static buildSearchQuery({ workspace, message, draft, intent, conversation = [] }) {
    const seed = workspace === 'ppt' ? message : (draft ? `${message} ${draft}` : message);
    const trimmed = seed.replace(/\s+/g, ' ').trim();

    if (workspace === 'image') {
      const referenceSubject = this.extractReferenceSubject(trimmed);

      if (this.isExplicitReferenceRequest(trimmed) && referenceSubject) {
        return this.buildSpecificSubjectQuery(referenceSubject, trimmed);
      }

      if (this.shouldSearchVisualReferences(trimmed)) {
        if (referenceSubject && this.isSpecificSubject(referenceSubject, trimmed)) {
          return this.buildSpecificSubjectQuery(referenceSubject, trimmed);
        }
        return `${trimmed} 视觉参考 图片`;
      }
      return `${trimmed} 视觉参考 海报 风格 图片`;
    }
    if (workspace === 'ppt') {
      const cleaned = this.cleanSearchQueryText(message);
      const query = this.isGenericPptSearchRequest(message, cleaned)
        ? (this.extractPptSearchSubjectFromConversation(conversation) || cleaned || trimmed)
        : (cleaned || trimmed);
      const technicalHint = /(串联腿|并联腿|轮腿|轮足|机器腿|足式|四足|双足|机器人腿)/.test(query)
        ? ' 机器人 机械结构'
        : '';
      return `${query}${technicalHint} 资料 关键要点 案例 数据`;
    }
    if (workspace === 'video') {
      return `${trimmed} 短视频 脚本 分镜 视觉参考`;
    }
    if (intent === 'copywriting') {
      return `${trimmed} 品牌文案 标题 卖点 参考`;
    }

    return trimmed;
  }

  static isGenericPptSearchRequest(message = '', cleaned = '') {
    const compact = String(message || '').replace(/\s+/g, '');
    const query = String(cleaned || '').trim();
    if (!query) return true;
    if (/^(一下|更多|相关|资料|内容|素材|信息)$/.test(query)) return true;
    if (query.length > 8) return false;
    return /^(检索|搜索|搜|查|找|联网|资料|相关|更多|一下)+$/.test(compact)
      || /^(检索|搜索|搜|查|找|资料|相关|更多|一下)$/.test(query);
  }

  static extractPptSearchSubjectFromConversation(conversation = []) {
    if (!Array.isArray(conversation)) return '';
    const entries = conversation
      .filter(item => item && typeof item.content === 'string')
      .slice(-6)
      .reverse();

    for (const item of entries) {
      const subject = this.extractPptSearchSubject(item.content);
      if (subject) return subject;
    }
    return '';
  }

  static extractPptSearchSubject(text = '') {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';

    const patterns = [
      /(?:关于|围绕|有关|搜索|检索|查找|找|整理|补充|生成|做|制作|主题[：:]?)\s*([A-Za-z0-9\u4e00-\u9fa5·\-_/（）()]{2,30}?)(?:相关|的)?(?:内容|资料|素材|信息|主题|方向|PPT|ppt|方案|要点|案例|数据|$)/,
      /([A-Za-z0-9\u4e00-\u9fa5·\-_/（）()]{2,30}?)(?:相关|的)?(?:内容|资料|素材|信息|主题|方向|PPT|ppt|方案|要点|案例|数据)/
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        const subject = this.cleanSearchQueryText(match[1])
          .replace(/^(我想|我要|帮我|请|可以|继续|如果|后续|可以按|可用于|方向)$/g, '')
          .trim();
        if (this.isMeaningfulSearchSubject(subject)) return subject;
      }
    }

    const candidates = raw
      .split(/[。！？!?；;\n]/)
      .map(line => this.cleanSearchQueryText(line))
      .filter(item => this.isMeaningfulSearchSubject(item))
      .sort((a, b) => a.length - b.length);
    return candidates[0] || '';
  }

  static isMeaningfulSearchSubject(value = '') {
    const text = String(value || '').trim();
    if (text.length < 2 || text.length > 32) return false;
    if (/^(可以|直接|如果|后续|相关|内容|资料|主题|方向|方案|要点|案例|数据|搜索|检索|查找|更多|一下|PPT|ppt)$/.test(text)) return false;
    if (/默认页数|页数策略|默认风格|联网搜索|AI生图|当前工作台/.test(text)) return false;
    return /[\u4e00-\u9fa5A-Za-z0-9]/.test(text);
  }

  static cleanSearchQueryText(text = '') {
    return String(text || '')
      .replace(/(?:帮我|请|麻烦|给我|你帮我|可以)?(?:搜索一下|搜一下|搜索|检索|查一下|查找一下|查找|找一下|找找|找)/g, ' ')
      .replace(/(?:相关)?(?:资料|信息|内容|要点|案例|数据|介绍|参考)/g, ' ')
      .replace(/(?:一下|更多|相关)/g, ' ')
      .replace(/的(?=\s|$)/g, ' ')
      .replace(/[“”"'‘’吧呢呀吗？?！!，,。.；;：:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static isExplicitReferenceRequest(text) {
    return /(参考图|找图|搜图|配图|灵感图|参考一下|看图)/.test(text);
  }

  static extractReferenceSubject(text) {
    return text
      .replace(/(给我个|给我一张|给我|来一张|来个|帮我做|做个|做一张|做张|想做|想要|我要|我想做|我想要|给我找|帮我找|帮我搜|给我搜)/g, ' ')
      .replace(/(参考图|找图|搜图|配图|灵感图|看图|图片|照片|海报|封面|主视觉|宣传图|头图|背景图|头像|头像图|头像框|人设图|角色图|图标|icon|ICON|PPT|ppt)/g, ' ')
      .replace(/[“”"'‘’的吧呢呀吗？?！!，,。.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static buildSpecificSubjectQuery(subject, fullText = '') {
    if (/(大学|学校|校园|学院|校徽|教学楼|图书馆|体育馆|实验楼)/.test(subject)) {
      if (this.isAvatarTask(fullText)) {
        return `${subject} 校徽 logo 官方 图片`;
      }
      return `${subject} 校园 建筑 校徽 官方 图片`;
    }
    if (/(城市|地标|景点|景区|博物馆|展馆|海边|海滨|建筑|公园|广场|大桥|机场|车站)/.test(subject)) {
      return `${subject} 城市 地标 建筑 风景 图片`;
    }
    if (/(品牌|产品|公司|logo|LOGO|门店|包装|商场|酒店|餐厅|汽车|手机|手表|球鞋|饮料)/.test(subject)) {
      return `${subject} 品牌 产品 官方 图片`;
    }
    if (this.isLikelyProductSubject(subject, fullText)) {
      return `${subject} 产品 官方 图片`;
    }
    if (this.isLikelyPersonSubject(subject, fullText)) {
      return `${subject} 写真 近照 造型 高清 图片`;
    }
    if (this.isLikelyCharacterSubject(subject, fullText)) {
      return `${subject} 角色 形象 头像 参考 图片`;
    }
    return `${subject} 参考 图片`;
  }

  static isLikelyPersonSubject(subject, originalText = '') {
    if (!subject) {
      return false;
    }

    if (this.isLikelyProductSubject(subject, originalText)) {
      return false;
    }

    if (/\d/.test(subject)) {
      return false;
    }

    if (/(明星|演员|歌手|模特|博主|爱豆|人物|人像|头像|妆容|发型)/.test(originalText)) {
      return true;
    }

    const chineseNameLike = /^[\u4e00-\u9fa5]{2,4}$/.test(subject);
    const englishNameLike = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(subject);

    return chineseNameLike || englishNameLike;
  }

  static isLikelyProductSubject(subject, originalText = '') {
    const text = `${subject} ${originalText}`.toLowerCase();
    const productSignals = [
      '产品', '品牌', 'logo', '包装', '手机', '汽车', '手表', '球鞋', '耳机', '相机', '电脑', '平板',
      'watch', 'iphone', 'ipad', 'macbook', 'camera', 'car', 'phone', 'bag', 'shoe', 'sneaker',
      'headphone', 'earbud', 'laptop', 'ultra', 'pro', 'max', 'plus', 'mini', 'air'
    ];

    return productSignals.some(token => text.includes(token));
  }

  static isLikelyCharacterSubject(subject, originalText = '') {
    if (!subject) {
      return false;
    }

    if (this.isLikelyProductSubject(subject, originalText) || this.isLikelyPersonSubject(subject, originalText)) {
      return false;
    }

    const text = `${subject} ${originalText}`;
    const characterSignals = ['角色', '人设', '头像', '昵称', '代号', '战队', '机甲', '兽人', '二次元', '虚拟'];
    const hasDigitsOrMixedCode = /[\u4e00-\u9fa5A-Za-z]+\d+[A-Za-z0-9\u4e00-\u9fa5]*/.test(subject);
    const quotedSubject = this.extractQuotedSubject(originalText);

    return hasDigitsOrMixedCode
      || characterSignals.some(token => text.includes(token))
      || (quotedSubject && quotedSubject === subject);
  }

  static isAvatarTask(text) {
    return /(头像|头像图|头像框|人设图|角色头像|社交头像|图标|icon|ICON)/.test(text);
  }

  static extractQuotedSubject(text) {
    const match = text.match(/[“"'‘’]([^“”"'‘’]{2,24})[”"'‘’]/);
    return match ? match[1].trim() : '';
  }

  static isSpecificSubject(subject, originalText = '') {
    if (!subject) {
      return false;
    }

    const genericSubjects = new Set([
      '美女', '帅哥', '女生', '男生', '女孩', '男孩', '女人', '男人',
      '猫', '狗', '小猫', '小狗', '狼', '狐狸', '机甲', '机器人', '风景', '海边'
    ]);

    if (genericSubjects.has(subject)) {
      return false;
    }

    if (this.extractQuotedSubject(originalText) === subject) {
      return true;
    }

    if (this.isLikelyProductSubject(subject, originalText)
      || this.isLikelyPersonSubject(subject, originalText)
      || this.isLikelyCharacterSubject(subject, originalText)) {
      return true;
    }

    return /[\u4e00-\u9fa5A-Za-z]+\d+[A-Za-z0-9\u4e00-\u9fa5]*/.test(subject);
  }

  static shouldSearchVisualReferences(text) {
    if (!text) {
      return false;
    }

    const normalized = text.replace(/\s+/g, '');
    const visualTaskSignals = [
      '封面', '海报', '主视觉', 'KV', '宣传图', '配图', '头图', '插图', '背景', 'ppt', '头像', '人设', '图标', 'icon'
    ];
    const referenceSubject = this.extractReferenceSubject(text);
    const concreteEntityPatterns = [
      /[\u4e00-\u9fa5]{2,}(大学|学校|学院|医院|银行|酒店|餐厅|商场|博物馆|展馆|公司|品牌|集团|景区|景点|公园|广场|大桥|大厦|机场|车站|校园|校徽|图书馆|体育馆|实验楼|建筑|产品|手机|汽车|车型|手表|球鞋|饮料|门店|包装)/,
      /[\u4e00-\u9fa5]{2,}(市|区|县|镇|村|岛|山|湖|河|湾|滩|港)/,
      /[“"'‘’][^“”"'‘’]{2,24}[”"'‘’]/,
      /[\u4e00-\u9fa5A-Za-z]+\d+[A-Za-z0-9\u4e00-\u9fa5]*/,
      /\b[A-Z][A-Za-z0-9&.\-]{2,}\b/,
      /\b[A-Za-z]{1,}\d{1,}[A-Za-z0-9-]*\b/
    ];

    const hasVisualTask = visualTaskSignals.some(token => normalized.toLowerCase().includes(token.toLowerCase()));
    const hasConcreteEntity = concreteEntityPatterns.some(pattern => pattern.test(text))
      || this.isSpecificSubject(referenceSubject, text);

    return hasVisualTask && hasConcreteEntity;
  }

  static analysisDetail(workspace, intent) {
    const mapping = {
      image: '判断是否需要生成方案，整理关键信息',
      ppt: '拆解主题、受众、结构层级和表达重点',
      video: '拆解受众、节奏、镜头感和文案节拍',
      general: '拆解任务类型、交付格式和下一步动作'
    };

    if (intent === 'copywriting') {
      return '提炼目标受众、语气、卖点和传播场景';
    }

    return mapping[workspace] || mapping.general;
  }

  static composeDetail(workspace, intent) {
    if (intent === 'research') {
      return '把检索结果压缩成可直接使用的创作结论';
    }
    if (workspace === 'image') {
      return '整理回复、追问或可确认的提示词';
    }
    if (workspace === 'ppt') {
      return '输出标题、内容骨架和页面表达建议';
    }
    if (workspace === 'video') {
      return '输出脚本、分镜思路和画面提示';
    }
    return '输出最贴近当前任务的可执行内容';
  }

  static buildResearchToolResult(research = {}) {
    if (research.error) {
      return {
        detail: research.query || '联网检索',
        summary: `检索失败：${this.trimText(research.error, 120)}`,
        output: {
          query: research.query || '',
          result_count: 0,
          reason: research.error
        }
      };
    }

    if (research.configured === false) {
      return {
        detail: research.query || '联网检索',
        summary: 'Web search 未配置，已基于现有上下文回答',
        output: {
          query: research.query || '',
          result_count: 0,
          reason: 'search_not_configured'
        }
      };
    }

    const results = Array.isArray(research.results) ? research.results.slice(0, 3) : [];
    const resultCount = Array.isArray(research.results) ? research.results.length : 0;
    const topTitles = results
      .map(item => item.title || item.url)
      .filter(Boolean)
      .slice(0, 2)
      .join('、');

    return {
      detail: research.query || '联网检索',
      summary: resultCount
        ? `已找到 ${resultCount} 条资料${topTitles ? `：${topTitles}` : ''}`
        : '没有找到可用资料，已基于现有上下文回答',
      output: {
        query: research.query || '',
        answer: this.trimText(research.answer || '', 180),
        result_count: resultCount,
        results: results.map(item => ({
          title: item.title || item.url || '',
          url: item.url || '',
          snippet: this.trimText(item.content || item.snippet || '', 120)
        }))
      }
    };
  }

  static normalizeConversation(conversation) {
    if (!Array.isArray(conversation)) {
      return [];
    }

    return conversation
      .filter(item => item && typeof item.content === 'string')
      .map(item => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: item.content
      }));
  }

  static defaultAssistantFallbackText(workspace = 'general') {
    if (workspace === 'ppt') {
      return '我可以帮你把主题、资料和要求整理成可生成的 PPT 方案。你可以告诉我主题、用途、页数，或让我参考已上传的资料。';
    }
    if (workspace === 'image') {
      return '我可以帮你整理图片提示词、风格和构图方向。你可以直接描述想要的画面，或上传参考图。';
    }
    if (workspace === 'video') {
      return '我可以帮你整理视频脚本、分镜和画面提示。你可以告诉我主题、时长和风格。';
    }
    return '我可以帮你整理创作需求、生成内容方案，也可以根据资料继续细化。你可以直接告诉我想做什么。';
  }

  static sanitizeAssistantFallbackText(rawContent = '', workspace = 'general') {
    const text = String(rawContent || '')
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    if (!text) return this.defaultAssistantFallbackText(workspace);
    if (this.extractJsonObject(text)) return this.defaultAssistantFallbackText(workspace);
    if (this.looksLikeLeakedAssistantContext(text)) return this.defaultAssistantFallbackText(workspace);
    return text;
  }

  static parseAssistantPayload(rawContent, fallback) {
    const parsed = this.extractJsonObject(rawContent) || this.safeParseJsonQuiet(rawContent);
    const normalized = parsed && typeof parsed === 'object' ? parsed : {};

    let deliverables = Array.isArray(normalized.deliverables)
      ? normalized.deliverables
        .map((item, index) => this.normalizeDeliverable(item, index, fallback.workspace))
        .filter(item => item.content || item.items.length || item.apply_text)
      : [];

    if (deliverables.length === 0 && !parsed && rawContent) {
      const fallbackText = this.sanitizeAssistantFallbackText(rawContent, fallback.workspace);
      deliverables = [
        {
          id: 'fallback_text',
          type: 'text',
          label: '整理结果',
          content: fallbackText,
          items: [],
          apply_text: ''
        }
      ];
    } else if (deliverables.length === 0 && parsed) {
      const overview = this.isAssistantVisibleText(normalized.overview)
        ? String(normalized.overview).trim()
        : '我已经整理好当前需求，可以继续补充或确认下一步。';
      deliverables = [
        {
          id: 'fallback_text',
          type: 'text',
          label: '整理结果',
          content: overview,
          items: [],
          apply_text: ''
        }
      ];
    }

    const explicitReadyToGenerate = normalized.ready_to_generate === true || normalized.ready_to_generate === 'true';
    const promptDeliverable = deliverables.find(item => item.type === 'prompt' && item.content);
    const primaryApplyText = deliverables.find(item => item.apply_text)?.apply_text
      || (fallback.workspace === 'image' && explicitReadyToGenerate
        ? (promptDeliverable?.content || '')
        : (deliverables.find(item => item.content)?.content || ''))
      || '';
    const pptReadyToGenerate = fallback.workspace === 'ppt'
      ? Boolean(explicitReadyToGenerate && this.hasMeaningfulPptPlan(normalized.apply_text || primaryApplyText, deliverables))
      : false;
    const readyToGenerate = fallback.workspace === 'image'
      ? explicitReadyToGenerate
      : fallback.workspace === 'ppt'
        ? pptReadyToGenerate
        : Boolean(normalized.ready_to_generate);

    const sources = Array.isArray(normalized.sources)
      ? normalized.sources
        .filter(item => item && item.url)
        .slice(0, 5)
        .map(item => ({
          title: item.title || item.url,
          url: item.url,
          snippet: this.trimText(item.snippet || '', 180)
        }))
      : fallback.research.results.slice(0, 5).map(item => ({
        title: item.title || item.url,
        url: item.url,
        snippet: this.trimText(item.content || item.snippet || '', 180)
      }));

    const images = this.normalizeAssistantImages(
      Array.isArray(normalized.images)
        ? normalized.images
        : (fallback.research.images || [])
    );

    return {
      assistant_name: ASSISTANT_NAME,
      workspace: fallback.workspace,
      intent: normalized.intent || fallback.intent,
      ready_to_generate: readyToGenerate,
      overview: normalized.overview || '我已经按你的创作任务整理好了可直接用的内容。',
      trace: fallback.trace,
      deliverables,
      suggestions: Array.isArray(normalized.suggestions) ? normalized.suggestions.slice(0, 4) : [],
      sources,
      images,
      ppt_style: normalized.ppt_style || normalized.pptStyle || normalized.style || '',
      ppt_style_label: normalized.ppt_style_label || normalized.style_label || '',
      ppt_master_template: normalized.ppt_master_template || normalized.pptMasterTemplate || normalized.template || '',
      apply_text: (fallback.workspace === 'image' || fallback.workspace === 'ppt') && !readyToGenerate
        ? ''
        : (normalized.apply_text || primaryApplyText),
      search_query: normalized.search_query || fallback.research.query || '',
      search_used: Boolean(fallback.research.query)
    };
  }

  static hasMeaningfulPptPlan(text, deliverables = []) {
    const planText = [
      text,
      ...deliverables.map(item => [item.label, item.content, ...(item.items || [])].filter(Boolean).join('\n'))
    ].filter(Boolean).join('\n');

    if (planText.trim().length < 80) {
      return false;
    }
    if (this.isIncompletePptPlan(planText)) {
      return false;
    }

    const hasPlanSignals = /(主题|标题|受众|页数|画幅|风格|逐页|页面|封面|目录|P0?1|第\s*1\s*页)/.test(planText);
    const hasPptSignal = /(PPT|ppt|幻灯片|演示|汇报|课件|路演|简报|页面|页数|逐页)/.test(planText);
    const pageMarkers = planText.match(/(?:^|\n)\s*[-*]?\s*(?:P0?\d+|第\s*\d+\s*页|第\s*\d+\s*张)/g) || [];
    const hasPageSequence = pageMarkers.length >= 3
      || /P0?1[\s\S]*P0?2[\s\S]*P0?3/.test(planText)
      || /第\s*1\s*页[\s\S]*第\s*2\s*页[\s\S]*第\s*3\s*页/.test(planText);
    const hasConcreteTopic = this.hasConcretePptTopic(planText);
    return hasPlanSignals && hasPptSignal && hasPageSequence && hasConcreteTopic;
  }

  static isIncompletePptPlan(planText) {
    const text = String(planText || '').trim();
    if (!text) return true;

    const incompletePatterns = [
      /(?:主题|标题|方向|内容|信息|线索|方案)\s*(?:待定|未定|待补充|需要补充)/,
      /(?:待定|未定)(?:主题|标题|方向|内容|方案)/,
      /(?:需要|还需|还要|请|建议你|可以先|先)\s*(?:补充|明确|提供|选择|指定|说明).{0,12}(?:主题|标题|方向|线索|用途|受众)/,
      /(?:还差|缺少|缺失|不足|不够|无法|不能|暂时不能|需要一个|差一个)\s*(?:一个)?(?:明确|具体)?(?:的)?(?:PPT)?(?:主题|标题|方向|线索|关键信息|生成线索|可生成主题)/,
      /(?:通用结构|通用框架).{0,80}(?:补充|明确|主题|标题|方向|用途|受众)/,
      /(?:可继续的方向|补一个方向|选一个方向|需要明确AI主题方向|补充科普主题)/,
      /(?:当前没有可沿用|没有可沿用|没有可生成|缺少可生成|缺少生成主题|缺少可生成主题)/,
      /(?:请先|先发|发送).{0,12}(?:主题|用途|受众|材料|方向|线索)/
    ];

    return incompletePatterns.some(pattern => pattern.test(text));
  }

  static hasConcretePptTopic(planText) {
    const text = String(planText || '').trim();
    const candidates = [];
    [
      /(?:PPT主题|主题定位|主题|标题)\s*[:：]\s*([^\n。；;]+)/i,
      /(?:主题|标题)(?:为|是)\s*[《“"]?([^》”"\n。；;，,]+)/i,
      /P0?1\s*[：:\-\s]+([^\n]+)/i,
      /第\s*1\s*页\s*[：:\-\s]+([^\n]+)/i
    ].forEach(pattern => {
      const match = text.match(pattern);
      if (match?.[1]) candidates.push(match[1]);
    });

    const firstMeaningfulLine = text
      .split('\n')
      .map(item => item.trim())
      .find(item => item
        && !/^#+\s*(?:生成确认方案|逐页内容计划|需要确认|参考资料|内容建议|页面计划)/.test(item)
        && !/^(?:[-*]\s*)?(?:建议页数|页数|页数要求|总页数|页面数量|PPT页数|风格|比例|画幅|联网|AI生图|受众)\s*[:：]/i.test(item));
    if (firstMeaningfulLine) candidates.push(firstMeaningfulLine);

    return candidates.some(candidate => {
      const cleaned = String(candidate || '')
        .replace(/[《》“”"]/g, '')
        .replace(/^方案摘要\s*[:：]\s*/, '')
        .replace(/^\s*[-*\d.Pp第页：:\s]+/, '')
        .trim();
      if (cleaned.length < 2) return false;
      if (/^(?:PPT|ppt|幻灯片|演示|汇报|课件|路演|简报|方案|方案摘要|主题|标题|目录|封面|课堂科普框架|项目汇报通用结构)$/.test(cleaned)) return false;
      return !this.isIncompletePptPlan(cleaned);
    });
  }

  static normalizeDeliverable(item, index, workspace = 'general') {
    const rawContent = typeof item.content === 'string' ? item.content.trim() : '';
    const content = this.isAssistantVisibleText(rawContent) ? rawContent : '';
    const type = item.type || 'text';
    const itemLimit = workspace === 'ppt' ? 15 : 8;
    const items = Array.isArray(item.items)
      ? item.items.map(entry => String(entry).trim()).filter(entry => this.isAssistantVisibleText(entry)).slice(0, itemLimit)
      : [];
    const hasApplyText = Object.prototype.hasOwnProperty.call(item, 'apply_text');

    return {
      id: item.id || `deliverable_${index + 1}`,
      type,
      label: item.label || `交付内容 ${index + 1}`,
      content,
      items,
      apply_text: hasApplyText
        ? String(item.apply_text || '').trim()
        : (workspace === 'image' && type !== 'prompt' ? '' : content)
    };
  }

  static normalizeAssistantImages(images = []) {
    const seen = new Set();
    return images
      .map(item => typeof item === 'string' ? { url: item, description: '' } : item)
      .filter(item => item && item.url)
      .map(item => {
        const originalUrl = item.original_url || item.url;
        const displayUrl = this.proxyReferenceImageUrl(item.url);
        return {
          url: displayUrl,
          original_url: originalUrl,
          title: item.title || '',
          description: item.description || item.title || '参考图片'
        };
      })
      .filter(item => {
        const key = item.original_url || item.url;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);
  }

  static proxyReferenceImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (value.startsWith('/api/ai/reference-image?')) return value;
    if (/^https?:\/\//i.test(value)) return TavilyService.buildProxyUrl(value);
    return value;
  }

  static safeParseJson(rawContent) {
    if (!rawContent) {
      return null;
    }

    const cleaned = rawContent
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      console.error('Assistant JSON parse failed:', error.message);
      return null;
    }
  }

  static trimText(text, maxLength) {
    if (!text) {
      return '';
    }

    return text.length > maxLength
      ? `${text.slice(0, maxLength - 1)}...`
      : text;
  }
}

module.exports = AssistantService;
