const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AiService = require('./aiService');
const PptEditService = require('./pptEditService');
const PptImportEditService = require('./pptImportEditService');
const RuntimeConfigService = require('./runtimeConfigService');
const AgentCustomizationService = require('./agentCustomizationService');
const User = require('../models/User');
const appConfig = require('../config/appConfig');

class PptCopilotAgentService {
  static async handleMessage({
    task,
    userId,
    message,
    pageIndex,
    sessionId,
    session: incomingSession,
    context: requestContext = {},
    proposalId,
    baseProposalId,
    autoCreateProposal = true,
    beforeApplyProposal,
    afterApplyProposal,
    onAction,
    onPhase,
    onDelta
  }) {
    const userMessage = String(message || '').trim();
    if (!userMessage) {
      throw new Error('请输入要发送给 PPT助手乐米的内容');
    }

    const actions = [];
    const emitAction = action => {
      if (onAction) onAction(this.publicAction(action));
    };
    const startTrackedAction = (type, label, input = {}) => {
      const action = this.startAction(actions, type, label, input);
      emitAction(action);
      return action;
    };
    const finishTrackedAction = (action, output = {}) => {
      this.finishAction(action, output);
      emitAction(action);
    };
    const failTrackedAction = (action, error) => {
      this.failAction(action, error);
      emitAction(action);
    };

    const snapshotAction = startTrackedAction('workspace_snapshot', '读取 PPT 工作区快照', {
      task_id: task?.id
    });
    const snapshot = this.createWorkspaceSnapshot(task, null, requestContext);
    finishTrackedAction(snapshotAction, {
      page_count: snapshot.page_count,
      current_page: this.normalizePageIndex(pageIndex, snapshot.page_count) + 1,
      pending_proposals: snapshot.pending_proposals.length
    });

    const session = this.loadSession({
      projectPath: snapshot.projectPath,
      task,
      userId,
      sessionId,
      incomingSession
    });
    this.appendSessionMessage(session, {
      role: 'user',
      content: userMessage
    });

    const intentAction = startTrackedAction('model_intent', '理解修改需求', {
      message: this.trimText(userMessage, 240),
      page_index: pageIndex
    });
    const intent = await this.judgeIntentWithModel({
      userId,
      message: userMessage,
      pageIndex,
      snapshot,
      proposalId,
      session
    });
    finishTrackedAction(intentAction, {
      intent: intent.type,
      confidence: intent.confidence,
      target_pages: intent.target_pages,
      reason: intent.reason,
      model_used: intent.model_used !== false,
      fallback_used: Boolean(intent.fallback_used)
    });

    let proposal = null;
    let applyResult = null;
    let updatedTask = null;
    let fallbackResponseMessage = '';
    let checkpointForTurn = null;

    if (intent.type === 'apply_proposal') {
      const applyProposalId = proposalId || intent.proposal_id || session.pending_proposal_id || session.last_proposal_id;
      if (!applyProposalId) {
        fallbackResponseMessage = '我还没有找到可应用的修改提案。你可以先告诉我要改哪里，我会先生成一个可预览的提案。';
      } else {
        const applyAction = startTrackedAction('apply_proposal', '应用修改提案', {
          proposal_id: applyProposalId
        });
        try {
          const billingContext = beforeApplyProposal
            ? await beforeApplyProposal({ proposalId: applyProposalId, intent, session })
            : null;
          checkpointForTurn = this.createCheckpoint({
            task,
            snapshot,
            session,
            proposalId: applyProposalId,
            label: '应用前',
            reason: 'before_apply'
          });
          applyResult = await PptEditService.applyProposal({
            task,
            proposalId: applyProposalId
          });
          updatedTask = afterApplyProposal
            ? await afterApplyProposal({ applyResult, proposalId: applyProposalId, billingContext, intent, session })
            : null;
          proposal = {
            id: applyProposalId,
            status: 'applied',
            pages: applyResult.pages || [],
            summary: applyResult.message || '修改提案已应用'
          };
          session.pending_proposal_id = '';
          session.last_proposal_id = applyProposalId;
          this.appendSessionCheckpoint(session, {
            ...checkpointForTurn,
            label: `应用提案 ${applyProposalId} 前`,
            reason: 'apply_proposal',
            proposal_id: applyProposalId
          });
          fallbackResponseMessage = applyResult.message || '已应用修改提案。';
          finishTrackedAction(applyAction, {
            proposal_id: applyProposalId,
            pages: applyResult.pages || []
          });
        } catch (error) {
          failTrackedAction(applyAction, error);
          throw error;
        }
      }
    } else if (intent.type === 'create_proposal') {
      if (autoCreateProposal === false) {
        fallbackResponseMessage = this.describePlannedEdit(intent);
        actions.push({
          id: this.newActionId(),
          type: 'create_proposal',
          label: '生成修改提案',
          status: 'skipped',
          input: {
            instruction: intent.instruction,
            target_pages: intent.target_pages
          },
          output: {
            reason: 'autoCreateProposal=false'
          },
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString()
        });
      } else {
        const effectiveBaseProposalId = this.resolveBaseProposalId({
          baseProposalId,
          session,
          message: userMessage
        });
        const proposalAction = startTrackedAction('create_proposal', '生成修改提案', {
          instruction: intent.instruction,
          target_pages: intent.target_pages,
          base_proposal_id: effectiveBaseProposalId || ''
        });
        try {
          checkpointForTurn = this.createCheckpoint({
            task,
            snapshot,
            session,
            label: '生成提案前',
            reason: 'before_create_proposal'
          });
          proposal = await PptEditService.createProposal({
            task,
            instruction: intent.instruction,
            pageIndex,
            baseProposalId: effectiveBaseProposalId
          });
          session.pending_proposal_id = proposal.id;
          session.last_proposal_id = proposal.id;
          this.appendSessionCheckpoint(session, {
            ...checkpointForTurn,
            label: `生成提案 ${proposal.id} 前`,
            reason: 'create_proposal',
            proposal_id: proposal.id
          });
          fallbackResponseMessage = proposal.summary || '已生成修改提案，你可以预览后再决定是否应用。';
          finishTrackedAction(proposalAction, {
            proposal_id: proposal.id,
            pages: proposal.pages || [],
            preview_count: Array.isArray(proposal.preview_svgs) ? proposal.preview_svgs.length : 0
          });
        } catch (error) {
          failTrackedAction(proposalAction, error);
          throw error;
        }
      }
    } else if (intent.type === 'inspect_workspace') {
      fallbackResponseMessage = this.buildWorkspaceAnswer({ snapshot, intent });
    } else if (intent.type === 'clarify_edit') {
      fallbackResponseMessage = this.buildClarifyingQuestion({ snapshot, intent });
    } else {
      fallbackResponseMessage = this.buildConversationalAnswer({ snapshot, session, intent });
    }

    const finalSnapshot = (proposal || applyResult)
      ? this.createWorkspaceSnapshot(task, applyResult?.resultData, requestContext)
      : snapshot;
    const workingSet = this.buildWorkingSet({
      snapshot: finalSnapshot,
      pageIndex,
      intent
    });
    const responseResult = await this.composeResponseWithModel({
      userId,
      message: userMessage,
      snapshot: finalSnapshot,
      session,
      intent,
      proposal,
      applyResult,
      fallbackMessage: fallbackResponseMessage,
      workingSet,
      onPhase,
      onDelta
    });
    const responseMessage = responseResult.message || fallbackResponseMessage;

    this.appendSessionMessage(session, {
      role: 'assistant',
      content: responseMessage
    });
    this.updateSessionSummary({
      session,
      intent,
      snapshot,
      proposal,
      applyResult,
      responseMessage
    });
    this.trimSessionCheckpoints(session);
    this.saveSession(snapshot.projectPath, session);
    this.pruneCheckpointDirs(
      snapshot.projectPath,
      Array.isArray(session.checkpoints) ? session.checkpoints.map(item => item.id) : []
    );

    return {
      message: responseMessage,
      actions,
      proposal,
      session: this.publicSession(session),
      checkpoint: this.publicCheckpoint(this.getLastSessionCheckpoint(session)),
      working_set: workingSet,
      apply_result: applyResult ? this.publicApplyResult(applyResult) : null,
      task: updatedTask || null,
      _streamed_text: responseResult.streamedText || ''
    };
  }

  static async judgeIntentWithModel({ userId, message, pageIndex, snapshot, proposalId, session }) {
    const fallback = this.judgeIntent({
      message,
      pageIndex,
      pageCount: snapshot.page_count,
      proposalId,
      session
    });
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const model = runtimeConfig.pptModel || runtimeConfig.assistantModel || runtimeConfig.chatModel || 'claude-opus-4-7';
    const outline = snapshot.pages.map(page => ({
      page: page.page,
      title: page.note_title || '',
      excerpt: page.note_excerpt || ''
    })).slice(0, 40);
    const pendingProposals = snapshot.pending_proposals.slice(0, 8).map(item => ({
      id: item.id,
      status: item.status,
      pages: item.pages,
      summary: item.summary
    }));

    const systemPrompt = this.buildCopilotSystemPrompt({
      mode: 'intent_router',
      message,
      intent: fallback.type,
      importedPpt: Boolean(snapshot?.result_data?.imported_ppt || snapshot?.result_data?.edit_mode === 'imported_ppt'),
      extraInstructions: [
        '你是 PPT助手乐米 的意图路由器，必须根据用户本轮消息和当前 PPT 工作区判断下一步动作。',
        '只返回合法 JSON，不要输出 Markdown。',
        'intent 只能是：apply_proposal、create_proposal、inspect_workspace、clarify_edit、chat。',
        '当用户明确要求改文字、样式、布局、图片、图表、页面内容时，用 create_proposal。',
        '当用户确认应用已有提案时，用 apply_proposal。',
        '当用户只是询问当前 PPT 内容、页数、结构或页面信息时，用 inspect_workspace。',
        '当用户想改但目标太模糊，无法安全落到页面和内容时，用 clarify_edit。',
        '普通沟通用 chat。',
        'target_pages 用 1-based 页码；如果无法判断，默认当前页。'
      ]
    });
    const userPayload = {
      user_message: message,
      current_page: this.normalizePageIndex(pageIndex, snapshot.page_count) + 1,
      page_count: snapshot.page_count,
      title: snapshot.title,
      pending_proposal_id: proposalId || session?.pending_proposal_id || '',
      last_proposal_id: session?.last_proposal_id || '',
      session_summary: session?.summary || '',
      outline,
      pending_proposals: pendingProposals,
      return_schema: {
        intent: 'apply_proposal | create_proposal | inspect_workspace | clarify_edit | chat',
        confidence: 0.0,
        target_pages: [1],
        proposal_id: '',
        instruction: '面向执行工具的简短中文指令',
        reason: '一句话说明判断依据'
      }
    };

    try {
      const response = await AiService.chat({
        userId: userId || snapshot.user_id || 'ppt-copilot',
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(userPayload, null, 2) }
        ],
        params: {
          route: 'ppt',
          temperature: 0.12,
          max_tokens: 900,
          timeout_ms: Math.max(parseInt(runtimeConfig.pptTimeoutMs, 10) || parseInt(runtimeConfig.assistantTimeoutMs, 10) || 60000, 45000)
        },
        runtimeConfig,
        allowConfigOverride: true
      });
      const raw = response.choices?.[0]?.message?.content || '';
      this.billPptAssistantTokenUsage({
        userId: userId || snapshot.user_id,
        usage: response.usage,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(userPayload, null, 2) }
        ],
        content: raw,
        notePrefix: 'PPT助手乐米意图判断 token 计费'
      });
      const parsed = this.extractJsonObject(raw);
      return this.normalizeModelIntent(parsed, fallback, {
        message,
        pageIndex,
        pageCount: snapshot.page_count,
        proposalId,
        session
      });
    } catch (error) {
      console.warn('[PptCopilotAgentService] 大模型意图判断失败，使用本地兜底:', error.message);
      return {
        ...fallback,
        model_used: false,
        fallback_used: true,
        reason: `${fallback.reason || '本地规则兜底'}；模型暂不可用：${this.trimText(error.message, 120)}`
      };
    }
  }

  static normalizeModelIntent(parsed, fallback, context) {
    if (!parsed || typeof parsed !== 'object') {
      return {
        ...fallback,
        model_used: false,
        fallback_used: true
      };
    }

    const validTypes = new Set(['apply_proposal', 'create_proposal', 'inspect_workspace', 'clarify_edit', 'chat']);
    let type = validTypes.has(parsed.intent) ? parsed.intent : fallback.type;
    const explicitProposalApplyRequest = this.looksLikeProposalApplyRequest(context.message);
    const explicitEditRequest = (this.looksLikePageEditRequest(context.message) && !explicitProposalApplyRequest)
      || (this.looksLikeEditRequest(context.message) && !this.looksLikeApplyRequest(context.message));
    if (type === 'apply_proposal' && explicitEditRequest && fallback.type !== 'apply_proposal') {
      type = fallback.type;
    }
    const pageCount = Math.max(1, parseInt(context.pageCount, 10) || 1);
    const currentPage = this.normalizePageIndex(context.pageIndex, pageCount) + 1;
    const rawPages = Array.isArray(parsed.target_pages) ? parsed.target_pages : [];
    const targetPages = rawPages
      .map(item => parseInt(item, 10))
      .filter(item => Number.isFinite(item) && item >= 1 && item <= pageCount);
    const confidence = Number(parsed.confidence);
    const pendingProposalId = type === 'apply_proposal'
      ? (context.proposalId || context.session?.pending_proposal_id || context.session?.last_proposal_id || '')
      : '';

    return {
      type,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : fallback.confidence,
      target_pages: targetPages.length ? Array.from(new Set(targetPages)) : (fallback.target_pages?.length ? fallback.target_pages : [currentPage]),
      proposal_id: type === 'apply_proposal'
        ? this.trimText(parsed.proposal_id || pendingProposalId || fallback.proposal_id || '', 120)
        : '',
      reason: this.trimText(parsed.reason || fallback.reason || '已完成需求判断', 260),
      instruction: this.trimText(parsed.instruction || fallback.instruction || context.message || '', 1000),
      model_used: true,
      fallback_used: false
    };
  }

  static async composeResponseWithModel({
    userId,
    message,
    snapshot,
    session,
    intent,
    proposal,
    applyResult,
    fallbackMessage,
    workingSet,
    onPhase,
    onDelta
  }) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const model = runtimeConfig.pptModel || runtimeConfig.assistantModel || runtimeConfig.chatModel || 'claude-opus-4-7';
    const systemPrompt = this.buildCopilotSystemPrompt({
      mode: 'response_composer',
      message,
      intent: intent?.type || '',
      importedPpt: Boolean(snapshot?.result_data?.imported_ppt || snapshot?.result_data?.edit_mode === 'imported_ppt'),
      extraInstructions: [
        '你是 PPT助手乐米，一个正在协助用户修改当前打开 PPT 的编辑器代理。',
        '你必须用简体中文，直接、简洁、像编辑器里的协作助手。',
        '不要编造已经完成的动作；只有传入 apply_result 时才说已应用，只有传入 proposal 时才说已生成可预览提案。',
        '如果还需要用户补充，直接说需要补哪一项。',
        '不要输出 JSON，不要输出 Markdown 代码块。'
      ]
    });
    const payload = {
      user_message: message,
      deck: {
        title: snapshot.title,
        page_count: snapshot.page_count,
        current_page: workingSet.current_page?.page || 1,
        target_pages: workingSet.target_pages || []
      },
      intent,
      session_summary: session?.summary || '',
      proposal: proposal ? {
        id: proposal.id,
        status: proposal.status,
        pages: proposal.pages,
        summary: proposal.summary,
        preview_count: Array.isArray(proposal.preview_svgs) ? proposal.preview_svgs.length : 0
      } : null,
      apply_result: applyResult ? this.publicApplyResult(applyResult) : null,
      fallback_message: fallbackMessage,
      page_outline: (workingSet.outline || []).slice(0, 20)
    };

    if (onPhase) {
      onPhase({
        phase: 'model_stream',
        title: '正在整理回复',
        treeTitle: '整理回复',
        message: '根据当前 PPT 状态组织回复'
      });
    }

    try {
      if (onDelta) {
        let streamedText = '';
        const response = await AiService.chatStream({
          userId: userId || snapshot.user_id || 'ppt-copilot',
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload, null, 2) }
          ],
          params: {
            route: 'ppt',
            temperature: 0.28,
            max_tokens: 900,
            timeout_ms: Math.max(parseInt(runtimeConfig.pptTimeoutMs, 10) || parseInt(runtimeConfig.assistantTimeoutMs, 10) || 60000, 45000)
          },
          runtimeConfig,
          allowConfigOverride: true,
          onDelta: delta => {
            const text = String(delta || '');
            streamedText += text;
            onDelta(text);
          }
        });
        this.billPptAssistantTokenUsage({
          userId: userId || snapshot.user_id,
          usage: response.usage,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload, null, 2) }
          ],
          content: response.choices?.[0]?.message?.content || streamedText || '',
          notePrefix: 'PPT助手乐米回复 token 计费'
        });
        return {
          message: (response.choices?.[0]?.message?.content || streamedText || fallbackMessage || '').trim(),
          streamedText: streamedText.trim()
        };
      }

      const response = await AiService.chat({
        userId: userId || snapshot.user_id || 'ppt-copilot',
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(payload, null, 2) }
        ],
        params: {
          route: 'ppt',
          temperature: 0.28,
          max_tokens: 900,
          timeout_ms: Math.max(parseInt(runtimeConfig.pptTimeoutMs, 10) || parseInt(runtimeConfig.assistantTimeoutMs, 10) || 60000, 45000)
        },
        runtimeConfig,
        allowConfigOverride: true
      });
      this.billPptAssistantTokenUsage({
        userId: userId || snapshot.user_id,
        usage: response.usage,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(payload, null, 2) }
        ],
        content: response.choices?.[0]?.message?.content || '',
        notePrefix: 'PPT助手乐米回复 token 计费'
      });
      return {
        message: (response.choices?.[0]?.message?.content || fallbackMessage || '').trim(),
        streamedText: ''
      };
    } catch (error) {
      console.warn('[PptCopilotAgentService] 大模型回复生成失败，使用本地兜底:', error.message);
      return {
        message: fallbackMessage,
        streamedText: ''
      };
    }
  }

  static billPptAssistantTokenUsage({
    userId,
    usage,
    messages = [],
    content = '',
    notePrefix = 'PPT助手乐米 token 计费'
  } = {}) {
    const safeUserId = parseInt(userId, 10);
    if (!safeUserId) return null;
    return User.billTokenUsage(safeUserId, usage, {
      source: 'ppt',
      legacyType: 'ppt',
      notePrefix,
      fallback: { messages, content }
    });
  }

  static buildCopilotSystemPrompt({
    mode = 'response_composer',
    message = '',
    intent = '',
    importedPpt = false,
    extraInstructions = []
  } = {}) {
    const bundle = AgentCustomizationService.buildPromptBundle({
      workspace: 'ppt',
      intent: intent || mode,
      agent: 'ppt-copilot',
      skillNames: [
        'ppt-copilot-edit',
        importedPpt ? 'ppt-import-edit' : ''
      ].filter(Boolean),
      context: { message }
    });

    return [
      bundle.prompt,
      '## Runtime Mode',
      `mode: ${mode}`,
      ...extraInstructions
    ].filter(Boolean).join('\n');
  }

  static createWorkspaceSnapshot(task, resultDataOverride = null, requestContext = {}) {
    if (PptImportEditService.isImportedTask(task)) {
      return PptImportEditService.createWorkspaceSnapshot(task, resultDataOverride, requestContext);
    }
    const context = PptEditService.getTaskContext(task);
    const { params, projectPath, pageCount } = context;
    const resultData = resultDataOverride && typeof resultDataOverride === 'object'
      ? { ...context.resultData, ...resultDataOverride }
      : context.resultData;
    const title = resultData.title || params.title || task.prompt || '未命名 PPT';
    const outputFiles = new Set(PptEditService.listSvgFiles(projectPath, 'svg_output'));
    const finalFiles = new Set(PptEditService.listSvgFiles(projectPath, 'svg_final'));
    const pages = [];

    for (let page = 1; page <= pageCount; page += 1) {
      const filename = PptEditService.pageFilename(page);
      const note = this.readPageNote(projectPath, filename);
      const outputPath = path.join(projectPath, 'svg_output', filename);
      const finalPath = path.join(projectPath, 'svg_final', filename);
      pages.push({
        index: page - 1,
        page,
        filename,
        has_output_svg: outputFiles.has(filename),
        has_final_svg: finalFiles.has(filename),
        output_url: fs.existsSync(outputPath) ? appConfig.pathToUploadUrl(outputPath) : '',
        preview_url: fs.existsSync(finalPath)
          ? appConfig.pathToUploadUrl(finalPath)
          : (fs.existsSync(outputPath) ? appConfig.pathToUploadUrl(outputPath) : ''),
        note_title: note.title,
        note_excerpt: note.excerpt
      });
    }

    return {
      task_id: task.id,
      user_id: task.user_id,
      status: task.status,
      title,
      prompt: task.prompt || '',
      params,
      result_data: resultData,
      projectPath,
      project_dir: this.safeUploadUrl(projectPath),
      page_count: pageCount,
      pages,
      assets: {
        ...this.listAssets(projectPath),
        uploaded: this.normalizeUploadedAssets(requestContext.workspaceFiles || requestContext.assets || [])
      },
      pending_proposals: this.listProposals(projectPath),
      edit_history: Array.isArray(resultData.edit_history) ? resultData.edit_history.slice(-10) : [],
      design_spec_excerpt: PptEditService.readOptional(path.join(projectPath, 'design_spec.md'), 1800),
      spec_lock_excerpt: PptEditService.readOptional(path.join(projectPath, 'spec_lock.md'), 1400)
    };
  }

  static judgeIntent({ message, pageIndex, pageCount, proposalId, session }) {
    const text = String(message || '').trim();
    const targetPages = PptEditService.resolveTargetPages({
      instruction: text,
      pageIndex,
      pageCount
    });
    const explicitProposalId = proposalId || this.extractProposalId(text);
    const hasPendingProposal = Boolean(explicitProposalId || session?.pending_proposal_id || session?.last_proposal_id);
    const explicitProposalApplyRequest = this.looksLikeProposalApplyRequest(text);
    const explicitPageEditRequest = this.looksLikePageEditRequest(text) && !explicitProposalApplyRequest;

    if (this.looksLikeApplyRequest(text) && hasPendingProposal && !explicitPageEditRequest) {
      return {
        type: 'apply_proposal',
        confidence: 0.88,
        target_pages: targetPages,
        proposal_id: explicitProposalId,
        reason: '用户要求确认、应用或保存已有修改提案',
        instruction: text
      };
    }

    if (this.looksLikeInspectionRequest(text)) {
      return {
        type: 'inspect_workspace',
        confidence: 0.74,
        target_pages: targetPages,
        reason: '用户在询问页面、结构或当前 PPT 信息',
        instruction: text
      };
    }

    if (this.looksLikeVagueEdit(text, pageIndex)) {
      return {
        type: 'clarify_edit',
        confidence: 0.68,
        target_pages: targetPages,
        reason: '修改意图存在，但缺少足够的编辑目标或内容',
        instruction: text
      };
    }

    if (explicitPageEditRequest || this.looksLikeEditRequest(text)) {
      return {
        type: 'create_proposal',
        confidence: 0.82,
        target_pages: targetPages,
        reason: '用户提出了可落到 PPT 页面的编辑要求',
        instruction: text
      };
    }

    return {
      type: 'chat',
      confidence: 0.55,
      target_pages: targetPages,
      reason: '普通对话或编辑前沟通',
      instruction: text
    };
  }

  static buildWorkingSet({ snapshot, pageIndex, intent }) {
    const currentIndex = this.normalizePageIndex(pageIndex, snapshot.page_count);
    const targetPages = Array.isArray(intent?.target_pages) && intent.target_pages.length > 0
      ? intent.target_pages
      : [currentIndex + 1];
    const targetSet = new Set(targetPages);
    const selectedPages = snapshot.pages.filter(page => targetSet.has(page.page));
    const pages = selectedPages.length > 0 ? selectedPages : [snapshot.pages[currentIndex]].filter(Boolean);

    return {
      task_id: snapshot.task_id,
      title: snapshot.title,
      status: snapshot.status,
      deck: {
        page_count: snapshot.page_count,
        canvas_format: snapshot.params.canvasFormat || snapshot.params.canvas_format || '',
        download_url: snapshot.result_data.download_url || snapshot.result_data.pptx_url || '',
        project_dir: snapshot.project_dir
      },
      current_page: snapshot.pages[currentIndex] || null,
      target_pages: targetPages,
      pages,
      outline: snapshot.pages.map(page => ({
        index: page.index,
        page: page.page,
        title: page.note_title,
        excerpt: page.note_excerpt
      })).slice(0, 60),
      assets: snapshot.assets,
      uploaded_assets: Array.isArray(snapshot.assets?.uploaded) ? snapshot.assets.uploaded : [],
      pending_proposals: snapshot.pending_proposals.slice(0, 8),
      edit_history: snapshot.edit_history
    };
  }

  static normalizeUploadedAssets(assets = []) {
    if (!Array.isArray(assets)) return [];
    return assets
      .filter(item => item && item.url)
      .slice(-12)
      .map(item => ({
        kind: this.trimText(item.kind || item.type || 'file', 40),
        name: this.trimText(item.name || item.filename || '上传文件', 160),
        url: this.trimText(item.url || '', 600),
        mimeType: this.trimText(item.mimeType || item.mime_type || '', 120),
        size: Number(item.size) || 0
      }));
  }

  static buildWorkspaceAnswer({ snapshot, intent }) {
    const targetPages = intent.target_pages || [];
    const pages = targetPages
      .map(pageNum => snapshot.pages[pageNum - 1])
      .filter(Boolean);

    if (pages.length === 1) {
      const page = pages[0];
      const title = page.note_title ? `「${page.note_title}」` : `第 ${page.page} 页`;
      const excerpt = page.note_excerpt ? `主要内容：${page.note_excerpt}` : '我暂时没有读到这一页的备注摘要。';
      return `${title} ${excerpt}`;
    }

    const outline = snapshot.pages
      .slice(0, 12)
      .map(page => `第 ${page.page} 页${page.note_title ? `：${page.note_title}` : ''}`)
      .join('；');
    const pending = snapshot.pending_proposals.length > 0
      ? ` 当前还有 ${snapshot.pending_proposals.length} 个历史修改提案。`
      : '';
    return `这份 PPT 共有 ${snapshot.page_count} 页，主题是「${snapshot.title}」。${outline ? `页面概览：${outline}。` : ''}${pending}`;
  }

  static buildClarifyingQuestion({ snapshot, intent }) {
    const currentPage = Array.isArray(intent.target_pages) && intent.target_pages.length > 0
      ? intent.target_pages[0]
      : 1;
    const page = snapshot.pages[currentPage - 1];
    const pageLabel = page?.note_title ? `第 ${currentPage} 页「${page.note_title}」` : `第 ${currentPage} 页`;
    return `我可以改，但还需要一个更具体的目标。你想在 ${pageLabel} 调整文案、配色、布局，还是增删某个模块？`;
  }

  static buildConversationalAnswer({ snapshot, session }) {
    const pending = session.pending_proposal_id
      ? `我这里还有一个待应用提案：${session.pending_proposal_id}。`
      : '你可以直接告诉我要改哪一页、改成什么样，我会先生成可预览的修改提案。';
    return `我正在看「${snapshot.title}」这份 ${snapshot.page_count} 页 PPT。${pending}`;
  }

  static createCheckpoint({ task, snapshot, session, label = '检查点', reason = 'manual', proposalId = '' }) {
    if (PptImportEditService.isImportedTask(task)) {
      return PptImportEditService.createCheckpoint({
        task,
        snapshot,
        session,
        label,
        reason,
        proposalId
      });
    }
    try {
      if (!task?.id || !snapshot?.projectPath) return null;
      const checkpointId = this.newCheckpointId();
      const checkpointDir = path.join(snapshot.projectPath, 'ppt_copilot_checkpoints', checkpointId);
      fs.mkdirSync(checkpointDir, { recursive: true });

      const sourceDirs = ['svg_output', 'svg_final'];
      const files = {};
      sourceDirs.forEach(dirName => {
        const sourceDir = path.join(snapshot.projectPath, dirName);
        if (!fs.existsSync(sourceDir)) return;
        const targetDir = path.join(checkpointDir, dirName);
        fs.mkdirSync(targetDir, { recursive: true });
        files[dirName] = [];
        fs.readdirSync(sourceDir)
          .filter(name => name.endsWith('.svg'))
          .forEach(name => {
            fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
            files[dirName].push(name);
          });
      });

      const resultData = snapshot.result_data && typeof snapshot.result_data === 'object'
        ? snapshot.result_data
        : {};
      const params = snapshot.params && typeof snapshot.params === 'object'
        ? snapshot.params
        : {};
      const checkpoint = {
        id: checkpointId,
        task_id: task.id,
        user_id: task.user_id,
        session_id: session?.session_id || '',
        label,
        reason,
        proposal_id: proposalId || '',
        title: snapshot.title || '',
        page_count: snapshot.page_count || 0,
        result_data: resultData,
        params,
        files,
        project_dir: this.safeUploadUrl(snapshot.projectPath),
        created_at: new Date().toISOString()
      };
      fs.writeFileSync(path.join(checkpointDir, 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf-8');
      return checkpoint;
    } catch (error) {
      console.warn('[PptCopilotAgentService] 创建检查点失败:', error.message);
      return null;
    }
  }

  static appendSessionCheckpoint(session, checkpoint) {
    if (!checkpoint?.id) return null;
    session.checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : [];
    const publicCheckpoint = this.publicCheckpoint(checkpoint);
    session.checkpoints = session.checkpoints.filter(item => item?.id !== publicCheckpoint.id);
    session.checkpoints.push(publicCheckpoint);
    this.trimSessionCheckpoints(session);
    return publicCheckpoint;
  }

  static trimSessionCheckpoints(session, maxCount = 8) {
    if (!session || !Array.isArray(session.checkpoints)) {
      if (session) session.checkpoints = [];
      return [];
    }
    session.checkpoints = session.checkpoints
      .filter(item => item?.id)
      .slice(-maxCount);
    return session.checkpoints;
  }

  static pruneCheckpointDirs(projectPath, keepIds = [], maxCount = 12) {
    try {
      const checkpointRoot = path.join(projectPath, 'ppt_copilot_checkpoints');
      if (!fs.existsSync(checkpointRoot)) return;
      const keep = new Set(keepIds.filter(Boolean).map(String));
      const items = fs.readdirSync(checkpointRoot)
        .map(name => {
          const dir = path.join(checkpointRoot, name);
          const metaPath = path.join(dir, 'checkpoint.json');
          const meta = fs.existsSync(metaPath)
            ? this.safeParseJson(fs.readFileSync(metaPath, 'utf-8'), {})
            : {};
          return {
            id: meta.id || name,
            dir,
            created_at: meta.created_at || ''
          };
        })
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      items.slice(maxCount).forEach(item => {
        if (keep.has(String(item.id))) return;
        fs.rmSync(item.dir, { recursive: true, force: true });
      });
    } catch (error) {
      console.warn('[PptCopilotAgentService] 清理检查点失败:', error.message);
    }
  }

  static getLastSessionCheckpoint(session) {
    const checkpoints = Array.isArray(session?.checkpoints) ? session.checkpoints : [];
    return checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
  }

  static publicCheckpoint(checkpoint) {
    if (!checkpoint?.id) return null;
    return {
      id: checkpoint.id,
      task_id: checkpoint.task_id,
      session_id: checkpoint.session_id || '',
      label: checkpoint.label || '检查点',
      reason: checkpoint.reason || '',
      proposal_id: checkpoint.proposal_id || '',
      title: checkpoint.title || '',
      page_count: checkpoint.page_count || 0,
      created_at: checkpoint.created_at || ''
    };
  }

  static listCheckpoints(projectPath, sessionId = '') {
    const checkpointRoot = path.join(projectPath, 'ppt_copilot_checkpoints');
    if (!fs.existsSync(checkpointRoot)) return [];
    const safeSessionId = String(sessionId || '').trim();
    return fs.readdirSync(checkpointRoot)
      .map(name => {
        const checkpointPath = path.join(checkpointRoot, name, 'checkpoint.json');
        if (!fs.existsSync(checkpointPath)) return null;
        const checkpoint = this.safeParseJson(fs.readFileSync(checkpointPath, 'utf-8'), null);
        if (!checkpoint?.id) return null;
        if (safeSessionId && checkpoint.session_id && checkpoint.session_id !== safeSessionId) return null;
        return this.publicCheckpoint(checkpoint);
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  static readCheckpoint(projectPath, checkpointId) {
    const safeId = this.safeCheckpointId(checkpointId);
    if (!safeId) throw new Error('检查点不存在');
    const checkpointPath = path.join(projectPath, 'ppt_copilot_checkpoints', safeId, 'checkpoint.json');
    if (!fs.existsSync(checkpointPath)) throw new Error('检查点不存在或已过期');
    const checkpoint = this.safeParseJson(fs.readFileSync(checkpointPath, 'utf-8'), null);
    if (!checkpoint?.id) throw new Error('检查点数据无效');
    return checkpoint;
  }

  static async restoreCheckpoint({ task, checkpointId, sessionId = '' }) {
    if (PptImportEditService.isImportedTask(task)) {
      return PptImportEditService.restoreCheckpoint({ task, checkpointId, sessionId });
    }
    const snapshot = this.createWorkspaceSnapshot(task);
    const checkpoints = this.listCheckpoints(snapshot.projectPath, sessionId);
    const targetId = checkpointId || checkpoints[0]?.id || '';
    const checkpoint = this.readCheckpoint(snapshot.projectPath, targetId);

    if (String(checkpoint.task_id || '') !== String(task.id || '')) {
      throw new Error('检查点不属于当前 PPT');
    }
    if (sessionId && checkpoint.session_id && checkpoint.session_id !== sessionId) {
      throw new Error('检查点不属于当前会话');
    }

    const redoCheckpoint = this.createCheckpoint({
      task,
      snapshot,
      session: {
        session_id: sessionId || checkpoint.session_id || ''
      },
      label: '回退前',
      reason: 'before_restore'
    });

    ['svg_output', 'svg_final'].forEach(dirName => {
      const checkpointDir = path.join(snapshot.projectPath, 'ppt_copilot_checkpoints', checkpoint.id, dirName);
      const targetDir = path.join(snapshot.projectPath, dirName);
      if (!fs.existsSync(checkpointDir)) return;
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.readdirSync(checkpointDir)
        .filter(name => name.endsWith('.svg'))
        .forEach(name => {
          fs.copyFileSync(path.join(checkpointDir, name), path.join(targetDir, name));
        });
    });

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const params = checkpoint.params || snapshot.params || {};
    await PptEditService.runQualityCheck(snapshot.projectPath, runtimeConfig, params.canvasFormat || params.canvas_format || 'ppt169');
    await PptEditService.runPptMasterScript('finalize_svg.py', [snapshot.projectPath], {
      runtimeConfig,
      timeoutMs: 300000
    });
    await PptEditService.runPptMasterScript('svg_to_pptx.py', [snapshot.projectPath, '-s', 'final'], {
      runtimeConfig,
      timeoutMs: 360000
    });
    const pptxPath = PptEditService.findGeneratedPptx(snapshot.projectPath);
    if (!pptxPath) {
      throw new Error('回退后导出失败，没有生成 PPTX');
    }

    const restoredResultData = {
      ...(checkpoint.result_data || {}),
      status: 'completed',
      stage: 'done',
      progress: 100,
      message: '已回退到上一版',
      download_url: appConfig.pathToUploadUrl(pptxPath),
      pptx_url: appConfig.pathToUploadUrl(pptxPath),
      file_id: PptEditService.createFileRecord({
        task,
        pptxPath,
        title: checkpoint.title || snapshot.title || task.prompt || 'ai-ppt'
      })?.id || checkpoint.result_data?.file_id,
      preview_svgs: PptEditService.listPreviewSvgUrls(snapshot.projectPath),
      project_dir: this.safeUploadUrl(snapshot.projectPath),
      edited_at: new Date().toISOString(),
      checkpoint_restore: {
        checkpoint_id: checkpoint.id,
        restored_at: new Date().toISOString(),
        redo_checkpoint_id: redoCheckpoint?.id || ''
      }
    };

    return {
      checkpoint: this.publicCheckpoint(checkpoint),
      redo_checkpoint: this.publicCheckpoint(redoCheckpoint),
      resultData: restoredResultData,
      message: checkpoint.label
        ? `已回退到「${checkpoint.label}」。`
        : '已回退到上一版。'
    };
  }

  static describePlannedEdit(intent) {
    const pageLabel = intent.target_pages.length === 1
      ? `第 ${intent.target_pages[0]} 页`
      : `${intent.target_pages.length} 页`;
    return `我已理解为准备修改 ${pageLabel}：${this.trimText(intent.instruction, 120)}。当前请求关闭了自动生成提案，所以我先只记录计划。`;
  }

  static resolveBaseProposalId({ baseProposalId, session, message }) {
    if (baseProposalId) return baseProposalId;
    const pendingProposalId = session?.pending_proposal_id || '';
    if (!pendingProposalId) return '';
    const text = String(message || '');
    if (/(重新|从原稿|从当前版本|不要上一版|不用上一版|取消上一版)/.test(text)) return '';
    if (/(再|继续|顺便|另外|也|基于|在此基础|上一版|这个提案|当前提案|also|again|continue|based on)/i.test(text)) {
      return pendingProposalId;
    }
    return '';
  }

  static loadSession({ projectPath, task, userId, sessionId, incomingSession }) {
    const incoming = this.normalizeIncomingSession(incomingSession);
    const id = this.safeSessionId(sessionId || incoming.session_id || incoming.id || '');
    const fromDisk = this.readSession(projectPath, id);
    const now = new Date().toISOString();
    const session = {
      session_id: id,
      task_id: task.id,
      user_id: userId || task.user_id,
      summary: `PPT助手乐米会话已开始，当前任务是「${task.prompt || '未命名 PPT'}」。`,
      turn_count: 0,
      messages: [],
      last_intent: '',
      last_page_index: 0,
      last_proposal_id: '',
      pending_proposal_id: '',
      created_at: now,
      updated_at: now,
      ...fromDisk
    };

    if (!fromDisk && incoming.summary) session.summary = incoming.summary;
    if (!fromDisk && Array.isArray(incoming.messages)) {
      session.messages = incoming.messages.slice(-12);
    }
    if (!session.pending_proposal_id && incoming.pending_proposal_id) {
      session.pending_proposal_id = incoming.pending_proposal_id;
    }
    if (!session.last_proposal_id && incoming.last_proposal_id) {
      session.last_proposal_id = incoming.last_proposal_id;
    }

    session.session_id = id;
    session.task_id = task.id;
    session.user_id = userId || task.user_id;
    return session;
  }

  static updateSessionSummary({ session, intent, snapshot, proposal, applyResult }) {
    session.turn_count = (parseInt(session.turn_count, 10) || 0) + 1;
    session.last_intent = intent.type;
    session.last_page_index = Array.isArray(intent.target_pages) && intent.target_pages.length > 0
      ? Math.max(intent.target_pages[0] - 1, 0)
      : session.last_page_index;
    session.updated_at = new Date().toISOString();

    const pageLabel = Array.isArray(intent.target_pages) && intent.target_pages.length > 0
      ? (intent.target_pages.length === 1 ? `第 ${intent.target_pages[0]} 页` : `${intent.target_pages.length} 页`)
      : '当前 PPT';

    if (applyResult) {
      session.summary = `正在编辑「${snapshot.title}」，最近已应用 ${pageLabel} 的修改并重新导出 PPTX。`;
    } else if (proposal?.id) {
      session.summary = `正在编辑「${snapshot.title}」，最近为 ${pageLabel} 生成了修改提案 ${proposal.id}。`;
    } else if (intent.type === 'inspect_workspace') {
      session.summary = `正在查看「${snapshot.title}」的结构和页面内容，最近关注 ${pageLabel}。`;
    } else {
      session.summary = `正在围绕「${snapshot.title}」沟通修改方向，最近关注 ${pageLabel}。`;
    }
  }

  static publicSession(session) {
    return {
      session_id: session.session_id,
      task_id: session.task_id,
      summary: session.summary,
      turn_count: session.turn_count,
      last_intent: session.last_intent,
      last_page_index: session.last_page_index,
      last_proposal_id: session.last_proposal_id,
      pending_proposal_id: session.pending_proposal_id,
      latest_checkpoint: this.publicCheckpoint(this.getLastSessionCheckpoint(session)),
      checkpoints: Array.isArray(session.checkpoints) ? session.checkpoints.slice(-6) : [],
      updated_at: session.updated_at,
      messages: Array.isArray(session.messages) ? session.messages.slice(-8) : []
    };
  }

  static publicApplyResult(applyResult) {
    return {
      message: applyResult.message,
      pages: applyResult.pages || [],
      editLog: applyResult.editLog || []
    };
  }

  static publicAction(action) {
    if (!action || typeof action !== 'object') return action;
    return {
      ...action,
      input: action.input || {},
      output: action.output || null
    };
  }

  static readSession(projectPath, sessionId) {
    try {
      const sessionPath = this.sessionPath(projectPath, sessionId);
      if (!fs.existsSync(sessionPath)) return null;
      const parsed = this.safeParseJson(fs.readFileSync(sessionPath, 'utf-8'), null);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  static saveSession(projectPath, session) {
    try {
      const dir = path.join(projectPath, 'ppt_copilot_sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${this.safeSessionId(session.session_id)}.json`),
        `${JSON.stringify({
          ...session,
          messages: Array.isArray(session.messages) ? session.messages.slice(-16) : []
        }, null, 2)}\n`,
        'utf-8'
      );
    } catch (error) {
      console.warn('[PptCopilotAgentService] 会话保存失败:', error.message);
    }
  }

  static sessionPath(projectPath, sessionId) {
    return path.join(projectPath, 'ppt_copilot_sessions', `${this.safeSessionId(sessionId)}.json`);
  }

  static appendSessionMessage(session, message) {
    const entry = {
      role: message.role,
      content: this.trimText(message.content, 1600),
      at: new Date().toISOString()
    };
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    session.messages.push(entry);
    session.messages = session.messages.slice(-16);
  }

  static readPageNote(projectPath, filename) {
    const notePath = path.join(projectPath, 'notes', filename.replace(/\.svg$/i, '.md'));
    const content = PptEditService.readOptional(notePath, 1600);
    if (!content) return { title: '', excerpt: '' };
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const heading = lines.find(line => /^#{1,6}\s+/.test(line));
    const title = (heading || lines[0] || '').replace(/^#{1,6}\s+/, '').replace(/^\d+[.、]\s*/, '').trim();
    const body = lines
      .filter(line => line !== heading)
      .join(' ')
      .replace(/[#*_`>|-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      title: this.trimText(title, 80),
      excerpt: this.trimText(body, 260)
    };
  }

  static listAssets(projectPath) {
    const imageDir = path.join(projectPath, 'images');
    if (!fs.existsSync(imageDir)) return { images: [] };
    const images = fs.readdirSync(imageDir)
      .filter(name => /\.(png|jpe?g|webp|gif|svg)$/i.test(name))
      .sort()
      .slice(0, 40)
      .map(name => {
        const filePath = path.join(imageDir, name);
        return {
          name,
          url: appConfig.pathToUploadUrl(filePath)
        };
      });
    return { images };
  }

  static listProposals(projectPath) {
    if (!fs.existsSync(projectPath)) return [];
    return fs.readdirSync(projectPath)
      .filter(name => /^edit_proposal_/.test(name))
      .map(name => {
        const proposalPath = path.join(projectPath, name, 'proposal.json');
        if (!fs.existsSync(proposalPath)) return null;
        const proposal = this.safeParseJson(fs.readFileSync(proposalPath, 'utf-8'), null);
        if (!proposal?.id) return null;
        return {
          id: proposal.id,
          status: proposal.status || 'pending',
          pages: Array.isArray(proposal.pages) ? proposal.pages : [],
          summary: proposal.summary || '',
          created_at: proposal.created_at || '',
          updated_at: proposal.updated_at || '',
          preview_svgs: Array.isArray(proposal.preview_svgs) ? proposal.preview_svgs : []
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  static looksLikeApplyRequest(text) {
    const normalized = String(text || '').trim();
    const compact = normalized.replace(/\s+/g, '');
    if (!compact) return false;
    if (/^(应用|确认|可以|没问题|就这样|按这个|采用|套用|执行|保存|通过|接受|ok|OK|apply|accept|confirm)$/i.test(compact)) {
      return true;
    }
    const mentionsExistingProposal = /(提案|修改提案|改动方案|这版|这个提案|当前提案|预览|proposal)/i.test(normalized);
    const hasApplyVerb = /(应用|采用|确认|执行|保存|落地|通过|接受|套用|apply|accept|confirm)/i.test(normalized);
    if (!hasApplyVerb) return false;
    if (mentionsExistingProposal) return true;
    if (this.looksLikeNewEditInstruction(normalized) || this.looksLikePageEditRequest(normalized) || this.looksLikeEditRequest(normalized)) {
      return false;
    }
    return true;
  }

  static looksLikeProposalApplyRequest(text) {
    const normalized = String(text || '').trim();
    if (!/(提案|修改提案|改动方案|这个提案|当前提案|proposal)/i.test(normalized)) return false;
    return /(应用|采用|确认|执行|保存|落地|通过|接受|套用|apply|accept|confirm)/i.test(normalized);
  }

  static looksLikeInspectionRequest(text) {
    const lower = String(text || '').toLowerCase();
    if (this.looksLikeEditRequest(text)) return false;
    return /(看看|看一下|说明|介绍|总结|概览|有哪些|是什么|什么内容|当前页|这页|第\s*\d+\s*页).*(吗|呢|？|\?)?$/.test(text)
      || /^(what|show|summari[sz]e|describe)\b/.test(lower);
  }

  static looksLikeVagueEdit(text, pageIndex) {
    const trimmed = String(text || '').trim();
    if (!/(改|修改|调整|优化|美化|润色|处理)/.test(trimmed)) return false;
    if (/(第\s*\d+\s*页|当前页|这一页|这页|p\s*\d+|slide\s*\d+)/i.test(trimmed)) return false;
    if (Number.isFinite(parseInt(pageIndex, 10)) && trimmed.length >= 8) return false;
    return trimmed.length <= 10;
  }

  static looksLikeEditRequest(text) {
    return /(修改|改成|改为|换成|替换|调整|优化|美化|润色|删除|删掉|增加|添加|加上|插入|移动|对齐|放大|缩小|加粗|改色|颜色|字号|字体|标题|副标题|文案|图片|图标|布局|模块|页脚|页眉|背景|配色|highlight|replace|change|remove|add|make|update)/i.test(text);
  }

  static looksLikePageEditRequest(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return false;
    const pageRef = /(第\s*(?:\d{1,3}|[一二两三四五六七八九十百零〇]{1,6})\s*页|p\s*0?\d{1,3}\b|slide\s*0?\d{1,3}\b|当前页|这一页|这页|本页|封面|最后一页|末页|整份|全部|所有页|全局|整体|当前PPT|当前ppt|这份PPT|这份ppt|这个PPT|这个ppt)/i.test(normalized);
    if (!pageRef) return false;
    return /(改|修改|调整|换|替换|删除|删掉|去掉|增加|添加|加上|插入|移动|对齐|放大|缩小|加粗|改色|优化|美化|润色|统一|重做|标题|副标题|文案|图片|图标|布局|模块|页脚|页眉|背景|配色|颜色|字号|字体|风格|内容|结论|摘要|目录|检查|看看|看一下|评价|建议|问题|总结|讲了什么|内容是什么|哪里不|怎么改|更(?:科技|商务|简洁|高级|清晰|活泼|正式)|replace|change|remove|add|make|update)/i.test(normalized);
  }

  static looksLikeNewEditInstruction(text) {
    return /(把.+(改|换|删|删除|去掉|加|添加|移动|放大|缩小)|将.+(改|换|替换|删除|调整)|改成|改为|换成|替换成|调整为|变成|删除|删掉|去掉|加上|添加|插入)/i.test(String(text || ''));
  }

  static extractProposalId(text) {
    const match = String(text || '').match(/(?:proposal|提案)[^\w-]*([a-zA-Z0-9_-]{6,})/i);
    return match ? match[1] : '';
  }

  static normalizeIncomingSession(session) {
    if (!session) return {};
    if (typeof session === 'string') return { session_id: session };
    if (typeof session !== 'object' || Array.isArray(session)) return {};
    return session;
  }

  static normalizePageIndex(pageIndex, pageCount) {
    const parsed = parseInt(pageIndex, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < pageCount) return parsed;
    return 0;
  }

  static safeSessionId(value) {
    const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (cleaned) return cleaned;
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
  }

  static safeCheckpointId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  }

  static newCheckpointId() {
    return `cp_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  }

  static newActionId() {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  static startAction(actions, type, label, input = {}) {
    const action = {
      id: this.newActionId(),
      type,
      label,
      status: 'running',
      input,
      output: null,
      started_at: new Date().toISOString()
    };
    actions.push(action);
    return action;
  }

  static finishAction(action, output = {}) {
    action.status = 'completed';
    action.output = output;
    action.finished_at = new Date().toISOString();
  }

  static failAction(action, error) {
    action.status = 'failed';
    action.error = error?.message || String(error || 'unknown error');
    action.finished_at = new Date().toISOString();
  }

  static safeUploadUrl(filePath) {
    try {
      return appConfig.pathToUploadUrl(filePath);
    } catch (error) {
      return '';
    }
  }

  static trimText(value = '', max = 1000) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
  }

  static safeParseJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  static extractJsonObject(value) {
    const text = String(value || '').trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const direct = this.safeParseJson(text, null);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const parsed = this.safeParseJson(text.slice(start, end + 1), null);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
    return null;
  }
}

module.exports = PptCopilotAgentService;
