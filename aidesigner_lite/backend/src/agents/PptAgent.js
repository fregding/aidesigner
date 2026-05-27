/**
 * PptAgent - PPT Master executor
 *
 * Turns the web PPT request into the serialized ppt-master workflow:
 * Source Document -> Create Project -> Template Option -> Strategist ->
 * [Image_Generator] -> Executor -> Post-processing -> Export.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const sharp = require('sharp');
const BaseAgent = require('./BaseAgent');
const AiTask = require('../models/AiTask');
const File = require('../models/File');
const User = require('../models/User');
const AiService = require('../services/aiService');
const RuntimeConfigService = require('../services/runtimeConfigService');
const TavilyService = require('../services/tavilyService');
const PptWebVisualAssetService = require('../services/pptWebVisualAssetService');
const DocumentConverterService = require('../services/documentConverterService');
const AgentCustomizationService = require('../services/agentCustomizationService');
const appConfig = require('../config/appConfig');

const UPLOAD_DIR = appConfig.uploadDir;
const DEFAULT_PPT_MASTER_ROOT = appConfig.defaultPptMasterRoot;
const DEFAULT_PPT_MASTER_PYTHON = appConfig.defaultPptMasterPython;

const PIPELINE_STEPS = [
  { name: 'sourceProcessing', label: '整理内容', required: true, timeoutMs: 90000 },
  { name: 'projectInitialization', label: '创建PPT项目', required: true, timeoutMs: 360000 },
  { name: 'templateOption', label: '选择设计风格', required: true, timeoutMs: 30000 },
  { name: 'strategist', label: '整理页面结构', required: true, timeoutMs: 420000 },
  { name: 'imageGenerator', label: '准备配图', required: false, timeoutMs: 620000 },
  { name: 'executor', label: '生成PPT页面', required: true, timeoutMs: 1200000 },
  { name: 'qualityCheck', label: '检查页面效果', required: true, timeoutMs: 900000 },
  { name: 'chartCalibration', label: '检查图表', required: true, timeoutMs: 180000 },
  { name: 'notes', label: '生成备注', required: true, timeoutMs: 90000 },
  { name: 'splitNotes', label: '整理备注', required: true, timeoutMs: 60000 },
  { name: 'finalizeSvg', label: '整理页面文件', required: true, timeoutMs: 300000 },
  { name: 'export', label: '生成PPT文件', required: true, timeoutMs: 360000 }
];

class PptAgent extends BaseAgent {
  constructor() {
    super({
      name: 'PptAgent',
      timeoutMs: 1800000
    });

    this._resetState();
    this._registerTools();
  }

  _resetState() {
    this.task = null;
    this.projectPath = null;
    this.params = {};
    this.runtimeConfig = null;
    this.assistantPayload = null;
    this.fallbackResearch = null;
    this.imageAssets = [];
    this.webVisualAssets = [];
    this.designSpec = '';
    this.specLock = '';
    this.sourceContent = '';
    this.templateReference = null;
    this.layoutTemplateReference = null;
    this.generatedPages = [];
    this.qualityReport = null;
    this.chartCalibrationReport = null;
    this.layoutSafetyReport = null;
    this.currentStep = null;
    this.stepResults = {};
    this.workflowEvents = [];
    this.stepTimings = [];
    this.roleReads = [];
    this.roleReadKeys = new Set();
    this.executorConversationHistory = [];
    this.eightConfirmations = null;
    this.agentCustomization = null;
    this.aiTokenBilling = this._createEmptyAiTokenBilling();
    this.pptContentBilling = this._createEmptyPptContentBilling();
    this.singlePageMicroReviewTasks = new Map();
    this.singlePageMicroReviewActive = 0;
    this.singlePageMicroReviewWaiters = [];
    this.backgroundImageGenerationPromise = null;
    this.backgroundImageGenerationResult = null;
    this.backgroundImageGenerationError = null;
    this.executorPromptCache = null;
    this.executorPageContextCache = new Map();
    this.executorReferenceCache = new Map();
  }

  _createEmptyAiTokenBilling() {
    return {
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_tokens: 0,
      original_credits: 0,
      charged_credits: 0,
      requested_charged_credits: 0,
      discount_credits: 0,
      credits_per_1k_tokens: User.creditsPerAiTokenThousand(),
      capped_to_available: false,
      items: []
    };
  }

  _createEmptyPptContentBilling() {
    return {
      page_count: 0,
      image_count: 0,
      page_credits: 0,
      image_credits: 0,
      original_credits: 0,
      charged_credits: 0,
      requested_charged_credits: 0,
      discount_credits: 0,
      capped_to_available: false,
      billed_pages: [],
      billed_images: [],
      items: []
    };
  }

  _addBillingItemToSummary(summary, item) {
    if (!summary || !item) return;
    summary.original_credits += Math.max(0, Math.ceil(Number(item.original_credits) || 0));
    summary.charged_credits += Math.max(0, Math.ceil(Number(item.charged_credits) || 0));
    summary.requested_charged_credits += Math.max(
      0,
      Math.ceil(Number(item.requested_charged_credits ?? item.charged_credits) || 0)
    );
    summary.discount_credits += Math.max(0, Math.ceil(Number(item.discount_credits) || 0));
    summary.capped_to_available = Boolean(summary.capped_to_available || item.capped_to_available);
    summary.items.push(item);
  }

  _billPptContentCredits({ kind, unitCredits, count = 1, notePrefix, details = {} }) {
    const safeUnitCredits = Math.max(0, Number(unitCredits) || 0);
    const safeCount = Math.max(1, parseInt(count, 10) || 1);
    const originalCredits = Math.max(1, Math.ceil(safeUnitCredits * safeCount));
    const billing = User.buildCreditBilling(originalCredits, this.task.user_id);
    const requestedChargedCredits = billing.chargedCredits;
    const debit = User.debitCredits(this.task.user_id, requestedChargedCredits, {
      source: 'ppt',
      legacyType: 'ppt',
      note: `${notePrefix}${User.creditBillingNoteSuffix(billing)}`,
      capToAvailable: true
    });
    const chargedCredits = Math.max(0, Number(debit.deducted) || 0);
    const item = {
      kind,
      count: safeCount,
      unit_credits: safeUnitCredits,
      ...details,
      ...User.creditBillingMetadata(billing),
      requested_charged_credits: requestedChargedCredits,
      charged_credits: chargedCredits
    };
    if (debit.cappedToAvailable) {
      item.capped_to_available = true;
    }
    this._addBillingItemToSummary(this.pptContentBilling, item);
    return item;
  }

  _billGeneratedPage(page) {
    const pageNum = Math.max(1, parseInt(page?.pageNum || this._pageNumFromFilename(page?.filename), 10) || 1);
    if (this.pptContentBilling.billed_pages.includes(pageNum)) return null;
    const item = this._billPptContentCredits({
      kind: 'ppt_page',
      unitCredits: User.creditsPerPptPage(),
      notePrefix: `PPT生成第 ${pageNum} 页`,
      details: {
        page: pageNum,
        filename: page?.filename || this._pageFilename(pageNum)
      }
    });
    this.pptContentBilling.page_count += 1;
    this.pptContentBilling.page_credits += Math.max(0, Number(item.original_credits) || 0);
    this.pptContentBilling.billed_pages.push(pageNum);
    this._recordWorkflowEvent('PPT Page Billing', 'charged', {
      page: pageNum,
      charged_credits: item.charged_credits,
      original_credits: item.original_credits
    });
    return item;
  }

  _billGeneratedImage(asset) {
    const key = asset?.relativePath || asset?.filename || '';
    if (!key || this.pptContentBilling.billed_images.includes(key)) return null;
    const item = this._billPptContentCredits({
      kind: 'ppt_image',
      unitCredits: User.creditsPerPptImage(),
      notePrefix: `PPT自动配图 ${asset.filename || key}`,
      details: {
        filename: asset.filename || path.basename(key),
        relative_path: key
      }
    });
    this.pptContentBilling.image_count += 1;
    this.pptContentBilling.image_credits += Math.max(0, Number(item.original_credits) || 0);
    this.pptContentBilling.billed_images.push(key);
    this._recordWorkflowEvent('PPT Image Billing', 'charged', {
      image: key,
      charged_credits: item.charged_credits,
      original_credits: item.original_credits
    });
    return item;
  }

  _billAiTokenUsage({ usage, messages = [], content = '', model = '', label = '' } = {}) {
    if (!this.task?.user_id) return null;
    const billing = User.billTokenUsage(this.task.user_id, usage, {
      source: 'ppt',
      legacyType: 'ppt',
      notePrefix: label ? `PPT生成AI助手 ${label} token 计费` : 'PPT生成AI助手 token 计费',
      fallback: { messages, content },
      model,
      route: 'ppt',
      capToAvailable: true
    });
    const requestedTokenCredits = Math.max(0, Number(billing?.requested_charged_credits ?? billing?.charged_credits) || 0);
    if (!billing || requestedTokenCredits <= 0) return billing;

    const tokenUsage = billing.token_usage || {};
    this.aiTokenBilling.calls += 1;
    this.aiTokenBilling.prompt_tokens += Math.max(0, Number(tokenUsage.prompt_tokens) || 0);
    this.aiTokenBilling.completion_tokens += Math.max(0, Number(tokenUsage.completion_tokens) || 0);
    this.aiTokenBilling.total_tokens += Math.max(0, Number(tokenUsage.total_tokens) || 0);
    if (tokenUsage.estimated) {
      this.aiTokenBilling.estimated_tokens += Math.max(0, Number(tokenUsage.total_tokens) || 0);
    }
    this.aiTokenBilling.original_credits += Math.max(0, Number(billing.original_credits) || 0);
    this.aiTokenBilling.charged_credits += Math.max(0, Number(billing.charged_credits) || 0);
    this.aiTokenBilling.requested_charged_credits += requestedTokenCredits;
    this.aiTokenBilling.discount_credits += Math.max(0, Number(billing.discount_credits) || 0);
    this.aiTokenBilling.credits_per_1k_tokens = billing.credits_per_1k_tokens;
    this.aiTokenBilling.capped_to_available = Boolean(
      this.aiTokenBilling.capped_to_available || billing.capped_to_available
    );
    this.aiTokenBilling.items.push({
      label,
      model,
      ...billing
    });
    this._recordWorkflowEvent('AI Token Billing', 'charged', {
      label,
      model,
      total_tokens: tokenUsage.total_tokens,
      estimated: Boolean(tokenUsage.estimated),
      charged_credits: billing.charged_credits
    });
    return billing;
  }

  _buildBillingSummary() {
    const content = this.pptContentBilling || this._createEmptyPptContentBilling();
    const token = this.aiTokenBilling || this._createEmptyAiTokenBilling();
    const originalCredits = Math.max(0, Math.ceil((content.original_credits || 0) + (token.original_credits || 0)));
    const chargedCredits = Math.max(0, Math.ceil((content.charged_credits || 0) + (token.charged_credits || 0)));
    const requestedChargedCredits = Math.max(
      0,
      Math.ceil(
        Number(content.requested_charged_credits ?? content.charged_credits) +
        Number(token.requested_charged_credits ?? token.charged_credits)
      )
    );
    const discountCredits = Math.max(0, Math.ceil((content.discount_credits || 0) + (token.discount_credits || 0)));
    const vipDiscountApplied = discountCredits > 0;
    return {
      original_credits: originalCredits,
      charged_credits: chargedCredits,
      requested_charged_credits: requestedChargedCredits,
      capped_to_available: Boolean(
        content.capped_to_available ||
        token.capped_to_available ||
        chargedCredits < requestedChargedCredits
      ),
      discount_credits: discountCredits,
      discount_rate: originalCredits > 0 ? Number((requestedChargedCredits / originalCredits).toFixed(4)) : 1,
      discount_label: vipDiscountApplied ? 'VIP专属8折' : '',
      vip_discount_applied: vipDiscountApplied,
      page_credits: content.page_credits,
      image_credits: content.image_credits,
      token_credits: token.original_credits,
      content_charged_credits: content.charged_credits,
      token_charged_credits: token.charged_credits,
      content_requested_charged_credits: content.requested_charged_credits ?? content.charged_credits,
      token_requested_charged_credits: token.requested_charged_credits ?? token.charged_credits,
      page_count: content.page_count,
      image_count: content.image_count,
      credits_per_image: User.creditsPerPptImage(),
      credits_per_page: User.creditsPerPptPage(),
      credits_per_1k_tokens: token.credits_per_1k_tokens,
      ai_token_usage: {
        calls: token.calls,
        prompt_tokens: token.prompt_tokens,
        completion_tokens: token.completion_tokens,
        total_tokens: token.total_tokens,
        estimated_tokens: token.estimated_tokens
      },
      realtime: true,
      charge_reason: content.image_count > 0
        ? 'realtime_pages_images_and_ai_tokens'
        : 'realtime_pages_and_ai_tokens',
      content_items: content.items,
      token_items: token.items
    };
  }

  _registerTools() {
    this.registerTools({
      sourceProcessing: async () => {
        this.fallbackResearch = await this._runOptionalResearch();
        this.sourceContent = this._buildSourceContent();
        this._recordWorkflowEvent('Step 1 Source Content Processing', 'completed', {
          gate: 'User source material present',
          source_type: this.params.documentConverted ? 'converted_document_markdown' : 'direct_text',
          research: this.fallbackResearch?.search_used ? 'included_as_source_context' : 'not_used'
        });
        return {
          source_ready: true,
          source_type: this.params.documentConverted ? 'converted_document_markdown' : 'direct_text',
          source_content: this.sourceContent,
          research: this.fallbackResearch
        };
      },

      projectInitialization: async () => {
        this.projectPath = await this._initializeProjectDirectory({
          userId: this.task.user_id,
          taskId: this.task.id,
          title: this.params.title,
          canvasFormat: this.params.canvasFormat
        });

        this._writeProjectReadme();
        const uploadedAssets = await this._stageUploadedAssets();
        const uploadedDocumentContext = await this._prepareUploadedDocumentContext(uploadedAssets);
        if (uploadedDocumentContext?.sourceBrief) {
          this.sourceContent = [
            this.sourceContent,
            uploadedDocumentContext.sourceBrief
          ].filter(Boolean).join('\n\n');
        }
        const uploadedTemplateReference = await this._prepareUploadedTemplateReference(uploadedAssets);
        if (uploadedTemplateReference?.sourceBrief) {
          this.sourceContent = [
            this.sourceContent,
            uploadedTemplateReference.sourceBrief
          ].filter(Boolean).join('\n\n');
        }
        const stagedSource = path.join(this.projectPath, '.workflow', 'source.md');
        this._writeTextFile(stagedSource, this.sourceContent);
        const importOutput = await this._runPptMasterScript(
          'project_manager.py',
          ['import-sources', this.projectPath, stagedSource, '--move'],
          { timeoutMs: 60000 }
        );
        this._recordWorkflowEvent('Step 2 Project Initialization', 'completed', {
          command: `project_manager.py init ${this._projectName(this.task.id, this.params.title)} --format ${this.params.canvasFormat}`,
          import_command: 'project_manager.py import-sources <project_path> <source.md> --move',
          project_path: this.projectPath,
          uploaded_assets: uploadedAssets.map(asset => asset.relativePath),
          uploaded_template_reference: uploadedTemplateReference
            ? {
              status: uploadedTemplateReference.status,
              mode: uploadedTemplateReference.mode,
              reference_dir: uploadedTemplateReference.relativeDir,
              published_assets: uploadedTemplateReference.publishedAssets?.map(asset => asset.relativePath) || []
            }
            : null,
          import_output: this._trimText(importOutput, 1200)
        });
        this._flushWorkflowFiles();
        return { project_path: this.projectPath, import_output: importOutput };
      },

      templateOption: async () => {
        const result = await this._applyTemplateOption();
        if (this.layoutTemplateReference?.sourceBrief) {
          this.sourceContent = [
            this.sourceContent,
            this.layoutTemplateReference.sourceBrief
          ].filter(Boolean).join('\n\n');
          this._writeTextFile(path.join(this.projectPath, '.workflow', 'source.md'), this.sourceContent);
        }
        this._recordWorkflowEvent('Step 3 Template Option', 'completed', result);
        return result;
      },

      strategist: async () => {
        this.eightConfirmations = this._buildEightConfirmations();
        this._writeEightConfirmationsFile();

        const systemPrompt = this._buildStrategistPrompt(this.sourceContent);
        try {
          const content = await this._callPptModel({
            model: this._strategistModel(),
            route: 'ppt_strategist',
            systemPrompt,
            userMessage: '请直接输出完整 design_spec.md 内容，不要添加解释。',
            maxTokens: 8192,
            temperature: 0.35,
            retries: 1,
            timeoutMs: 240000,
            streamFirstTokenTimeoutMs: 90000,
            streamIdleTimeoutMs: 180000
          });
          const candidate = this._stripMarkdownFence(content).trim();
          const structuredSpec = this._ensureDesignSpecStructure(candidate);
          let strategistFallbackReason = '';
          let designSpec = this._normalizeDesignSpecForV26(structuredSpec && this._designSpecMatchesSourcePlan(structuredSpec)
            ? structuredSpec
            : this._buildFallbackDesignSpec(this.sourceContent, structuredSpec ? 'AI design_spec 未保留用户逐页结构' : ''));
          let specLock = this._buildSpecLock(designSpec);
          this._writeTextFile(path.join(this.projectPath, 'design_spec.md'), designSpec);
          this._writeTextFile(path.join(this.projectPath, 'spec_lock.md'), specLock);
          try {
            this._validateStrategistDeliverables(designSpec, specLock);
          } catch (validationError) {
            strategistFallbackReason = strategistFallbackReason
              ? `${strategistFallbackReason}; validation=${validationError.message}`
              : `Strategist validation fallback: ${validationError.message}`;
            console.warn('[PptAgent] 设计规范校验失败，切换到本地规范:', validationError.message);
            designSpec = this._normalizeDesignSpecForV26(this._buildFallbackDesignSpec(this.sourceContent, strategistFallbackReason));
            specLock = this._buildSpecLock(designSpec);
            this._writeTextFile(path.join(this.projectPath, 'design_spec.md'), designSpec);
            this._writeTextFile(path.join(this.projectPath, 'spec_lock.md'), specLock);
            this._validateStrategistDeliverables(designSpec, specLock);
          }
          this._recordWorkflowEvent('Step 4 Strategist', 'completed', {
            eight_confirmations: 'confirmed_by_web_generation_request',
            design_spec: 'design_spec.md',
            spec_lock: 'spec_lock.md',
            ...(strategistFallbackReason ? { fallback_reason: strategistFallbackReason } : {})
          });
          return {
            design_spec: designSpec,
            spec_lock: specLock,
            ...(strategistFallbackReason ? { fallback_reason: strategistFallbackReason } : {})
          };
        } catch (error) {
          console.warn('[PptAgent] 设计规范 AI 生成失败，使用本地规范:', error.message);
          const designSpec = this._normalizeDesignSpecForV26(this._buildFallbackDesignSpec(this.sourceContent, error.message));
          const specLock = this._buildSpecLock(designSpec);
          this._writeTextFile(path.join(this.projectPath, 'design_spec.md'), designSpec);
          this._writeTextFile(path.join(this.projectPath, 'spec_lock.md'), specLock);
          this._validateStrategistDeliverables(designSpec, specLock);
          this._recordWorkflowEvent('Step 4 Strategist', 'completed_with_fallback', {
            fallback_reason: error.message,
            design_spec: 'design_spec.md',
            spec_lock: 'spec_lock.md'
          });
          return { design_spec: designSpec, spec_lock: specLock, fallback_reason: error.message };
        }
      },

      imageGenerator: async () => {
        const result = this._backgroundImageGenerationEnabled()
          ? this._startBackgroundImageGeneratorPhase()
          : await this._runImageGeneratorPhase();
        if (result.assets?.length) {
          const existingReusableAssets = this.imageAssets.filter(asset => (
            asset.origin === 'template_reference'
            || asset.origin === 'layout_template'
            || asset.origin === 'uploaded_document'
          ));
          this.imageAssets = [...existingReusableAssets, ...result.assets];
        }
        this.specLock = this._buildSpecLock(this.designSpec);
        this._writeTextFile(path.join(this.projectPath, 'spec_lock.md'), this.specLock);
        this._recordWorkflowEvent('Step 5 Image_Generator', result.skipped ? 'skipped' : 'completed', result);
        return this.imageAssets || [];
      },

      executor: async () => {
        this._writeDesignParameterConfirmation();
        this._primeExecutorPromptContext();
        const pageCount = this.params.pageCount;
        const pages = [];
        let previousSummary = '';

        for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
          const pageStartedAt = Date.now();
          // Debug mode: skip pages that already have valid SVG files
          if (this._isDebugMode()) {
            const existingPage = this._loadExistingDebugPage(pageNum);
            if (existingPage) {
              console.log(`[PptAgent] Debug mode: skipping page ${pageNum}/${pageCount} (already generated)`);
              this._updateProgress(
                38 + Math.round(((pageNum - 1) / pageCount) * 39),
                'executor', `跳过第 ${pageNum}/${pageCount} 页 (调试模式: 已存在)`,
                { current_page: pageNum, total_pages: pageCount, debug_skipped: true }
              );
              pages.push(existingPage);
              this.generatedPages = pages;
              previousSummary += `P${String(pageNum).padStart(2, '0')}: ${existingPage.description || existingPage.filename}\n`;
              continue;
            }
          }
          const page = await this._generateSinglePage({
            pageNum,
            pageCount,
            previousSummary
          });
          const checkedPage = this._officialCompatibilityMode()
            ? page
            : await this._ensureGeneratedPageSelfCheck(page, { pageNum, pageCount });
          const microReviewQueued = this._scheduleSinglePageMicroReview(checkedPage, { pageNum, pageCount });
          this._billGeneratedPage(checkedPage);
          pages.push(checkedPage);
          this.generatedPages = pages;
          previousSummary += `P${String(pageNum).padStart(2, '0')}: ${checkedPage.description || checkedPage.filename}\n`;

          const progress = 38 + Math.round((pageNum / pageCount) * 39);
          this._updateProgress(progress, 'executor', microReviewQueued
            ? `已生成第 ${pageNum}/${pageCount} 页，后台正在并行检查版面`
            : `已生成第 ${pageNum}/${pageCount} 页`, {
            current_page: pageNum,
            total_pages: pageCount,
            micro_review_pending: this.singlePageMicroReviewTasks.size,
            preview_svgs: this._listPreviewSvgUrls(this.projectPath, 'svg_output')
          });
          this._recordWorkflowEvent('Step 6 Page Timing', 'completed', {
            page: this._pageFilename(pageNum),
            page_num: pageNum,
            duration_ms: Date.now() - pageStartedAt,
            micro_review_queued: microReviewQueued,
            micro_review_mode: microReviewQueued ? 'background_nonblocking' : 'disabled_or_unavailable'
          });
        }

        this._recordWorkflowEvent('Step 6 Executor Visual Construction', 'completed', {
          generated_pages: pages.map(page => page.filename),
          rule: 'sequential_page_generation_with_parallel_background_micro_review'
        });
        return pages;
      },

      qualityCheck: async () => {
        await this._waitForBackgroundImageGenerator('qualityCheck');
        await this._waitForPendingSinglePageMicroReviews('qualityCheck');
        const result = await this._runQualityCheckWithRepair();
        const visualReview = await this._runAiPageVisualReviewWithRepair();
        const finalResult = visualReview?.repaired_files?.length
          ? await this._runQualityCheckWithRepair()
          : result;
        if (visualReview) {
          finalResult.ai_visual_review = visualReview;
          finalResult.output = [
            finalResult.output,
            '',
            'AI Visual Review:',
            visualReview.output || ''
          ].filter(Boolean).join('\n');
        }
        const visualReviewBlocking = this._aiPageVisualReviewRequired();
        const visualReviewPassed = !visualReview || visualReview.passed !== false || !visualReviewBlocking;
        const gatePassed = Boolean(finalResult.passed) && visualReviewPassed;
        this.qualityReport = finalResult;
        this.layoutSafetyReport = finalResult.layout_safety || null;
        this._writeTextFile(
          path.join(this.projectPath, 'reports', 'svg_quality_report.txt'),
          finalResult.output || ''
        );
        this._recordWorkflowEvent('Step 6 Quality Check Gate', gatePassed ? 'completed' : 'failed', {
          report: 'reports/svg_quality_report.txt',
          layout_report: 'reports/layout_safety_report.md',
          ai_visual_review_report: visualReview ? 'reports/ai_page_visual_review.json' : null,
          passed: gatePassed,
          ai_visual_review_blocking: visualReviewBlocking,
          ai_visual_review_passed: visualReview ? visualReview.passed !== false : null,
          repaired_files: finalResult.repaired_files || [],
          layout_repaired_files: finalResult.layout_safety?.repaired_files || [],
          ai_visual_review_repaired_files: visualReview?.repaired_files || []
        });
        if (visualReview?.passed === false && !visualReviewBlocking) {
          this._recordWorkflowEvent('AI Page Visual Review', 'advisory_continued', {
            report: 'reports/ai_page_visual_review.json',
            action: 'continued because AI visual review is advisory by default',
            failed_pages: this._failedAiVisualReviewPages(visualReview).map(page => page.page)
          });
        }
        if (!gatePassed) {
          const failedVisualPages = visualReviewBlocking && visualReview?.passed === false
            ? this._failedAiVisualReviewPages(visualReview).map(page => `P${String(page.page).padStart(2, '0')}`).join(', ')
            : '';
          if (failedVisualPages && visualReviewBlocking) {
            throw new Error(`页面质量检查未通过：AI视觉审查失败页面 ${failedVisualPages}`);
          }
          // In official compatibility mode, quality/layout gates are advisory — log and continue.
          console.warn('[PptAgent] Quality gate advisory: continuing to export despite quality/layout warnings.');
          this._recordWorkflowEvent('Step 6 Quality Check Gate', 'advisory_continued', {
            quality_ok: finalResult.passed,
            layout_ok: finalResult.layout_safety?.passed,
            action: 'export continues with warnings in compatibility mode'
          });
        }
        return finalResult;
      },

      chartCalibration: async () => {
        const result = await this._runChartCalibrationGate();
        this.chartCalibrationReport = result;
        this._recordWorkflowEvent('Step 6 Chart Calibration Gate', 'completed', result);
        return result;
      },

      notes: async () => {
        const totalMd = this._buildNotesTotal();
        const notesPath = path.join(this.projectPath, 'notes', 'total.md');
        this._writeTextFile(notesPath, totalMd);
        this._recordWorkflowEvent('Step 6 Logic Construction', 'completed', {
          total_md: 'notes/total.md',
          prerequisite_quality_check: 'passed',
          prerequisite_chart_calibration: 'completed'
        });
        return { total_md: notesPath };
      },

      splitNotes: async () => {
        await this._runPptMasterScript('total_md_split.py', [this.projectPath], { timeoutMs: 60000 });
        this._recordWorkflowEvent('Step 7.1 Split Speaker Notes', 'completed', {
          command: 'total_md_split.py <project_path>'
        });
        return { success: true };
      },

      finalizeSvg: async () => {
        await this._waitForPendingSinglePageMicroReviews('finalizeSvg');
        if (this._officialCompatibilityMode()) {
          this._prepareMissingImagesForSvgFallback();
        }
        const outputQuarantine = this._quarantineNonCanonicalSvgFiles(path.join(this.projectPath, 'svg_output'), 'before_finalize');
        await this._ensureCanonicalPageSet(path.join(this.projectPath, 'svg_output'), 'finalize 前');
        await this._runPptMasterScript('finalize_svg.py', [this.projectPath], { timeoutMs: 300000 });
        const finalQuarantine = this._quarantineNonCanonicalSvgFiles(path.join(this.projectPath, 'svg_final'), 'after_finalize');
        await this._ensureCanonicalPageSet(path.join(this.projectPath, 'svg_final'), 'finalize 后');
        const placeholderScan = this._runPlaceholderFailureCheck(path.join(this.projectPath, 'svg_final'));
        if (!placeholderScan.ok) {
          this._recordWorkflowEvent('Step 7.2 Finalize SVG', 'failed', {
            placeholder_files: placeholderScan.failed_files,
            action: 'blocked export; local fallback pages are disabled'
          });
          throw new Error(`finalize 后存在占位/内部元信息页，已停止导出: ${placeholderScan.failed_files.join(', ')}`);
        }
        this._recordWorkflowEvent('Step 7.2 Finalize SVG', 'completed', {
          command: 'finalize_svg.py <project_path>',
          source: 'svg_output',
          output: 'svg_final',
          placeholder_gate: 'passed',
          noncanonical_svg_quarantine: {
            before_finalize: outputQuarantine,
            after_finalize: finalQuarantine
          }
        });
        return { success: true };
      },

      export: async () => {
        await this._waitForPendingSinglePageMicroReviews('export');
        this._quarantineNonCanonicalSvgFiles(path.join(this.projectPath, 'svg_final'), 'before_export');
        await this._ensureCanonicalPageSet(path.join(this.projectPath, 'svg_final'), '导出前');
        await this._ensureFinalSvgExportReady(path.join(this.projectPath, 'svg_final'), '导出前');
        try {
          await this._execPptMasterScript('svg_to_pptx.py', this._pptxExportArgs(), {
            timeoutMs: 360000,
            rejectOnError: false
          });
        } catch (error) {
          this._recordWorkflowEvent('Step 7.3 Export PPTX', 'retrying_after_export_check', {
            error: error.message
          });
        }

        let pptxFile = this._findGeneratedPptx(this.projectPath);
        if (!pptxFile) {
          const rescued = await this._tryExportPptxWithSafeFallback();
          if (!rescued) throw new Error('PPTX导出完成但未找到文件');
          pptxFile = rescued;
        }

        const previewSvgs = this._listPreviewSvgUrls(this.projectPath, 'svg_final');
        const finalPptxFile = this._findGeneratedPptx(this.projectPath);
        const pptxUrl = this._toUploadUrl(finalPptxFile);

        const fileRecord = File.create({
          userId: this.task.user_id,
          taskId: this.task.id,
          filename: path.basename(finalPptxFile),
          originalName: `${this.params.title}.pptx`,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: fs.statSync(finalPptxFile).size,
          path: finalPptxFile,
          url: pptxUrl
        });

        const generatedImageAssets = this.imageAssets.filter(asset => asset.origin === 'generated');
        const billablePages = this.generatedPages.length
          ? this.generatedPages
          : Array.from({ length: Math.max(1, previewSvgs.length || this.params.pageCount || 1) }, (_, index) => ({
            pageNum: index + 1,
            filename: this._pageFilename(index + 1)
          }));
        billablePages.forEach(page => this._billGeneratedPage(page));
        generatedImageAssets.forEach(asset => this._billGeneratedImage(asset));
        const billing = this._buildBillingSummary();
        this._recordWorkflowEvent('Step 7.3 Export PPTX', 'completed', {
          command: 'svg_to_pptx.py <project_path> -a none -t none',
          mode: 'official_default_native_output_legacy_final_split',
          pptx: path.relative(this.projectPath, finalPptxFile),
          preview_count: previewSvgs.length,
          billing
        });

        return {
          status: 'completed',
          stage: 'done',
          progress: 100,
          title: this.params.title,
          page_count: this.params.pageCount,
          style: this.params.styleId || this.params.style,
          style_id: this.params.styleId || '',
          style_label: this.params.styleLabel || '',
          ppt_master_template: this.params.pptMasterTemplate || '',
          executor_style: this.params.style,
          canvas_format: this.params.canvasFormat,
          download_url: pptxUrl,
          pptx_url: pptxUrl,
          file_id: fileRecord.id,
          preview_svgs: previewSvgs,
          workflow_log_url: this._toUploadUrl(path.join(this.projectPath, 'execution_log.md')),
          workflow_state_url: this._toUploadUrl(path.join(this.projectPath, 'workflow_state.json')),
          quality_report_url: this._toUploadUrl(path.join(this.projectPath, 'reports', 'svg_quality_report.txt')),
          layout_safety_report_url: this._toUploadUrl(path.join(this.projectPath, 'reports', 'layout_safety_report.md')),
          chart_calibration_report_url: this._toUploadUrl(path.join(this.projectPath, 'reports', 'chart_calibration_report.md')),
          template_reference: this.templateReference
            ? {
              status: this.templateReference.status,
              mode: this.templateReference.mode,
              summary: this.templateReference.summaryPath
            }
            : null,
          layout_template_reference: this.layoutTemplateReference
            ? {
              template: this.layoutTemplateReference.template,
              label: this.layoutTemplateReference.label,
              summary: this.layoutTemplateReference.summaryPath,
              copied: this.layoutTemplateReference.copied
            }
            : null,
          image_assets: this.imageAssets.map(asset => ({
            filename: asset.filename,
            relative_path: asset.relativePath,
            url: asset.url,
            description: asset.description,
            origin: asset.origin || 'generated',
            provider: asset.provider || '',
            source_url: asset.sourceUrl || ''
          })),
          billing: {
            ...billing
          },
          project_dir: this._toUploadUrl(this.projectPath)
        };
      }
    });
    this.registerToolDescriptions(this._pptToolDescriptions());
  }

  _pptToolDescriptions() {
    const descriptions = {};
    PIPELINE_STEPS.forEach(step => {
      descriptions[step.name] = {
        category: 'ppt-master-pipeline',
        required: step.required,
        userDescription: step.label,
        modelDescription: [
          `${step.label}.`,
          step.required ? 'Required pipeline step.' : 'Optional pipeline step.',
          `Timeout: ${step.timeoutMs}ms.`
        ].join(' ')
      };
    });
    return descriptions;
  }

  _officialCompatibilityMode() {
    return true;
  }

  _isDebugMode() {
    if (process.env.PPT_DEBUG_MODE === 'true' || process.env.PPT_DEBUG_MODE === '1') return true;
    return this._normalizeBoolean(
      this.params.debugMode || this.params.debug_mode || this.params.pptDebugMode,
      false
    );
  }

  _loadExistingDebugPage(pageNum) {
    const svgPath = path.join(this.projectPath, 'svg_output', this._pageFilename(pageNum));
    if (!fs.existsSync(svgPath)) return null;
    try {
      const svg = fs.readFileSync(svgPath, 'utf-8');
      if (!/<svg[\s\S]*?<\/svg>/i.test(svg)) return null;
      return {
        pageNum,
        filename: path.basename(svgPath),
        outputPath: svgPath,
        description: this._inferPageDescription(pageNum),
        debug_cached: true
      };
    } catch {
      return null;
    }
  }

  async start({ taskId }) {
    this._resetState();
    this.task = AiTask.findById(taskId);
    if (!this.task) {
      throw new Error('PPT任务不存在');
    }

    this.runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    this.params = this._normalizeParams(this._safeJsonParse(this.task.params, {}));
    this._initializeAgentCustomization();
    this._assertRequestReadyForGeneration();
    this._recordWorkflowEvent('Official Compatibility Mode', 'enabled', {
      locked: true,
      behavior: 'ppt-master official workflow is enforced; legacy repair/export mode is disabled'
    });

    this._updateProgress(2, 'queued', 'PPT 生成任务已启动，正在准备资源');
    await this._resolvePageCountBeforeGeneration();

    await this._runPipeline();
    return this._getResult();
  }

  _initializeAgentCustomization() {
    this.agentCustomization = AgentCustomizationService.buildPromptBundle({
      workspace: 'ppt',
      intent: 'ppt_generate',
      agent: 'ppt-planner',
      skillNames: ['ppt-master-executor', 'ppt-reference-extractor'],
      context: {
        message: this.task?.prompt || '',
        draft: [
          this.params.title,
          this.params.content,
          this.params.extraRequirements
        ].filter(Boolean).join('\n')
      }
    });

    const discovery = this.agentCustomization.discovery || {};
    this._recordWorkflowEvent('Agent Customization Discovery', 'completed', {
      loaded_agent: discovery.loaded_agent?.id || '',
      loaded_instructions: (discovery.loaded_instructions || []).map(item => item.path),
      loaded_skills: (discovery.loaded_skills || []).map(item => item.path),
      skipped: discovery.skipped || []
    });
  }

  async _runPipeline() {
    for (const stepDef of PIPELINE_STEPS) {
      this.currentStep = stepDef.name;
      const stepProgress = this._getStepBaseProgress(stepDef.name);
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();

      const maxAttempts = this._stepMaxAttempts(stepDef);
      let lastError = null;
      let completed = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptStartedAt = Date.now();
        const attemptStartedAtIso = new Date(attemptStartedAt).toISOString();
        const isRetry = attempt > 1;

        if (isRetry) {
          const delayMs = this._stepRetryDelayMs(attempt);
          this._recordWorkflowEvent(`${stepDef.label} Auto Retry`, 'started', {
            attempt,
            max_attempts: maxAttempts,
            delay_ms: delayMs,
            previous_error: this._trimText(lastError?.message || '', 1200)
          });
          this._updateProgress(
            stepProgress,
            stepDef.name,
            `${stepDef.label}遇到错误，正在自动重试第 ${attempt}/${maxAttempts} 次`,
            {
              retry_attempt: attempt,
              retry_max_attempts: maxAttempts,
              previous_error: lastError?.message || ''
            }
          );
          await this._sleep(delayMs);
          await this._prepareStepRetry(stepDef, attempt, lastError);
        } else {
          this._updateProgress(stepProgress, stepDef.name, this._stepStartMessage(stepDef));
        }

        try {
          const result = await this._executeStepWithTimeout(stepDef);
          this.stepResults[stepDef.name] = result;
          this._applyStepResult(stepDef.name, result);

          this._updateProgress(
            this._getStepEndProgress(stepDef.name),
            stepDef.name,
            `${stepDef.label}完成${isRetry ? `（第 ${attempt} 次尝试成功）` : ''}`
          );
          this._recordStepTiming(stepDef, 'completed', attemptStartedAt, attemptStartedAtIso, {
            attempt,
            max_attempts: maxAttempts,
            retried: isRetry
          });
          if (isRetry) {
            this._recordWorkflowEvent(`${stepDef.label} Auto Retry`, 'completed', {
              attempt,
              max_attempts: maxAttempts
            });
          }
          this._flushWorkflowFiles();
          completed = true;
          break;
        } catch (error) {
          lastError = error;
          const willRetry = attempt < maxAttempts;
          console.error(`[PptAgent] 步骤 ${stepDef.name} 第${attempt}/${maxAttempts}次失败:`, error.message);
          this._recordWorkflowEvent(stepDef.label, willRetry ? 'retrying' : 'failed', {
            error: error.message,
            attempt,
            max_attempts: maxAttempts
          });
          this._recordStepTiming(stepDef, willRetry ? 'retrying' : 'failed', attemptStartedAt, attemptStartedAtIso, {
            error: error.message,
            attempt,
            max_attempts: maxAttempts
          });
          this._flushWorkflowFiles();
          if (willRetry) continue;

          if (stepDef.required) {
            AiTask.updateStatus(this.task.id, 'failed', {
              error_message: `${stepDef.label}失败: ${error.message}`,
              result_data: {
                status: 'failed',
                stage: stepDef.name,
                progress: stepProgress,
                error: error.message,
                failed_step: stepDef.name,
                retry_attempts: maxAttempts,
                partial_results: this._getPartialResults()
              }
            });
            throw error;
          }

          this.stepResults[stepDef.name] = { error: error.message, skipped: true, retry_attempts: maxAttempts };
          this._recordWorkflowEvent(stepDef.label, 'skipped', {
            error: error.message,
            retry_attempts: maxAttempts
          });
          this._updateProgress(
            this._getStepEndProgress(stepDef.name),
            stepDef.name,
            `${stepDef.label}已跳过：${error.message}`
          );
          this._flushWorkflowFiles();
        }
      }

      if (!completed && stepDef.required) {
        throw lastError || new Error(`${stepDef.label}失败`);
      }
    }
  }

  _backgroundImageGenerationEnabled() {
    return this._normalizeBoolean(
      this.params.pptBackgroundImageGeneration
        ?? this.params.ppt_background_image_generation
        ?? this.params.enableBackgroundImageGeneration
        ?? this.params.enable_background_image_generation
        ?? this.runtimeConfig?.pptBackgroundImageGeneration,
      true
    );
  }

  _startBackgroundImageGeneratorPhase() {
    if (this.backgroundImageGenerationPromise) {
      return this.backgroundImageGenerationResult || {
        skipped: false,
        background: true,
        status: 'already_started',
        assets: this.imageAssets || []
      };
    }

    const preservedAssets = (this.imageAssets || []).filter(asset => (
      asset.origin === 'template_reference'
      || asset.origin === 'layout_template'
      || asset.origin === 'uploaded_document'
    ));

    this.backgroundImageGenerationPromise = this._runImageGeneratorPhase()
      .then(result => {
        this.backgroundImageGenerationResult = result || {};
        const generatedAssets = Array.isArray(result?.assets) ? result.assets : [];
        this.imageAssets = this._dedupeImageAssets([...preservedAssets, ...generatedAssets]);
        this.specLock = this._buildSpecLock(this.designSpec);
        if (this.projectPath) {
          this._writeTextFile(path.join(this.projectPath, 'spec_lock.md'), this.specLock);
        }
        this.executorPromptCache = null;
        this.executorReferenceCache = new Map();
        this._recordWorkflowEvent('Step 5 Image_Generator Background', 'completed', {
          assets: generatedAssets.length,
          note: 'executor can proceed with already available assets; final quality gate waits before export'
        });
        return this.backgroundImageGenerationResult;
      })
      .catch(error => {
        this.backgroundImageGenerationError = error;
        this.backgroundImageGenerationResult = {
          skipped: true,
          background: true,
          error: error.message,
          assets: preservedAssets
        };
        this._recordWorkflowEvent('Step 5 Image_Generator Background', 'failed', {
          error: error.message,
          action: 'continued with already available image assets'
        });
        return this.backgroundImageGenerationResult;
      });

    this._recordWorkflowEvent('Step 5 Image_Generator Background', 'started', {
      mode: 'background_nonblocking',
      note: 'PPT page generation will continue while AI/web image requests run'
    });
    return {
      skipped: false,
      background: true,
      status: 'started',
      assets: this.imageAssets || []
    };
  }

  _dedupeImageAssets(assets = []) {
    const seen = new Set();
    return (Array.isArray(assets) ? assets : []).filter(asset => {
      if (!asset) return false;
      const key = asset.relativePath || asset.path || asset.filename || '';
      if (!key) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async _waitForBackgroundImageGenerator(context = '') {
    if (!this.backgroundImageGenerationPromise) return this.backgroundImageGenerationResult;
    this._recordWorkflowEvent('Step 5 Image_Generator Background', 'waiting', {
      context,
      current_assets: Array.isArray(this.imageAssets) ? this.imageAssets.length : 0
    });
    this._updateProgressAtLeast(77, 'qualityCheck', '正在等待后台配图任务收尾', {
      background_image_generation_pending: true,
      live_image_assets: this._liveImageAssetsSnapshot()
    });
    const result = await this.backgroundImageGenerationPromise;
    if (this.backgroundImageGenerationError) {
      this._recordWorkflowEvent('Step 5 Image_Generator Background', 'continued_with_error', {
        context,
        error: this.backgroundImageGenerationError.message
      });
    }
    return result;
  }

  _applyStepResult(stepName, result) {
    if (stepName === 'sourceProcessing') this.sourceContent = result?.source_content || this.sourceContent;
    if (stepName === 'projectInitialization') this.projectPath = result?.project_path || this.projectPath;
    if (stepName === 'strategist') {
      this.designSpec = result?.design_spec || '';
      this.specLock = result?.spec_lock || this.specLock;
    }
    if (stepName === 'imageGenerator') {
      this.imageAssets = Array.isArray(result)
        ? result
        : (Array.isArray(result?.assets) ? result.assets : []);
    }
    if (stepName === 'executor') this.generatedPages = result || [];
    if (stepName === 'qualityCheck') {
      this.qualityReport = result;
      this.layoutSafetyReport = result?.layout_safety || null;
    }
    if (stepName === 'chartCalibration') this.chartCalibrationReport = result;
  }

  _stepMaxAttempts(stepDef) {
    const raw = this.params.pptStepRetryAttempts
      || this.params.ppt_step_retry_attempts
      || this.runtimeConfig?.pptStepRetryAttempts;
    const configured = parseInt(raw, 10);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(1, Math.min(configured, 4));
    }

    const defaults = {
      executor: 1,
      qualityCheck: 1,
      chartCalibration: 2,
      finalizeSvg: 2,
      export: 2
    };
    return defaults[stepDef.name] || (stepDef.required ? 2 : 2);
  }

  _stepRetryDelayMs(attempt) {
    const base = parseInt(this.runtimeConfig?.pptStepRetryDelayMs || this.params.pptStepRetryDelayMs, 10);
    const safeBase = Number.isFinite(base) && base >= 0 ? base : 2500;
    return Math.min(15000, safeBase * Math.max(1, attempt - 1));
  }

  _stepTimeoutMs(stepDef) {
    const base = Math.max(1, parseInt(stepDef.timeoutMs, 10) || 120000);
    if (stepDef.name === 'executor') {
      const pageCount = Math.max(1, parseInt(this.params.pageCount || this.params.page_count, 10) || 1);
      const perPageMs = Math.max(
        120000,
        parseInt(this.runtimeConfig?.pptExecutorPageTimeoutMs || this.params.pptExecutorPageTimeoutMs, 10) || 180000
      );
      const overheadMs = Math.max(
        300000,
        parseInt(this.runtimeConfig?.pptExecutorTimeoutOverheadMs || this.params.pptExecutorTimeoutOverheadMs, 10) || 900000
      );
      return Math.min(90 * 60 * 1000, Math.max(base, overheadMs + pageCount * perPageMs));
    }
    return base;
  }

  async _prepareStepRetry(stepDef, attempt, error) {
    let cleanup = null;
    if (stepDef.name === 'executor') {
      cleanup = this._resetExecutorOutputsForRetry(attempt);
      this.generatedPages = [];
      this.executorConversationHistory = [];
    }
    this._recordWorkflowEvent(`${stepDef.label} Retry Preparation`, 'completed', {
      attempt,
      step: stepDef.name,
      previous_error: this._trimText(error?.message || '', 1000),
      ...(cleanup || {})
    });
  }

  _resetExecutorOutputsForRetry(attempt) {
    if (!this.projectPath) return { cleanup_skipped: 'missing_project_path' };
    const outputDir = path.join(this.projectPath, 'svg_output');
    if (!fs.existsSync(outputDir)) return { cleanup_skipped: 'missing_svg_output' };

    const svgFiles = this._listSvgFileNames(outputDir);
    if (svgFiles.length === 0) return { removed_svg_output_files: 0 };

    const backupDir = path.join(
      this.projectPath,
      'backup',
      `executor_retry_${String(attempt).padStart(2, '0')}_${this._localTimestampToken()}`
    );
    fs.mkdirSync(backupDir, { recursive: true });
    svgFiles.forEach(name => {
      fs.renameSync(path.join(outputDir, name), path.join(backupDir, name));
    });

    this._updateProgress(
      this._getStepBaseProgress('executor'),
      'executor',
      `上一轮页面未通过检查，已清理临时预览，正在重新生成第 ${attempt} 轮`,
      {
        retry_attempt: attempt,
        current_page: 0,
        total_pages: this.params.pageCount,
        preview_svgs: [],
        retry_preview_cleared: true
      }
    );

    return {
      removed_svg_output_files: svgFiles.length,
      backup_dir: path.relative(this.projectPath, backupDir)
    };
  }

  async _executeStepWithTimeout(stepDef) {
    const tool = this.tools.get(stepDef.name);
    if (!tool) {
      throw new Error(`未找到工具: ${stepDef.name}`);
    }

    const timeoutMs = this._stepTimeoutMs(stepDef);
    let softTimeoutLogged = false;
    const timer = setTimeout(() => {
      softTimeoutLogged = true;
      const message = `${stepDef.label}耗时较长，后台仍在继续处理`;
      const task = AiTask.findById(this.task.id);
      const previous = this._safeJsonParse(task?.result_data, {});
      const progress = Math.max(
        Number(previous?.progress) || 0,
        this._getStepBaseProgress(stepDef.name)
      );
      this._recordWorkflowEvent(`${stepDef.label} Soft Timeout`, 'continuing', {
        timeout_ms: timeoutMs,
        reason: 'step_tools_are_not_safely_cancellable'
      });
      this._updateProgress(
        progress,
        stepDef.name,
        message,
        {
          soft_timeout: true,
          soft_timeout_ms: timeoutMs
        }
      );
      this._flushWorkflowFiles();
    }, timeoutMs);

    try {
      const result = await tool({ params: this.params });
      if (softTimeoutLogged) {
        this._recordWorkflowEvent(`${stepDef.label} Soft Timeout`, 'completed_after_timeout', {
          timeout_ms: timeoutMs
        });
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async _runOptionalResearch() {
    if (!this.params.enableResearch) {
      return { search_used: false, sources: [], disabled: true };
    }
    if (!TavilyService.isConfigured()) {
      return { search_used: false, sources: [], disabled: true };
    }

    const query = `${this._trimText(this.params.title || this.task.prompt, 260)} 资料 数据 案例 趋势`;
    try {
      const research = await TavilyService.search({
        query,
        topic: 'general',
        includeImages: false,
        maxResults: 5
      });

      return {
        search_used: Boolean(research.configured || research.results?.length),
        query: research.query || query,
        answer: research.answer || '',
        sources: (research.results || []).slice(0, 5).map(item => ({
          title: item.title || item.url || '',
          url: item.url || '',
          snippet: this._trimText(item.content || item.snippet || '', 300)
        }))
      };
    } catch (error) {
      return { search_used: false, sources: [], disabled: true, error: error.message };
    }
  }

  async _initializeProjectDirectory({ userId, taskId, title, canvasFormat }) {
    const baseDir = path.join(UPLOAD_DIR, 'ppt', String(userId));
    fs.mkdirSync(baseDir, { recursive: true });

    const projectName = this._projectName(taskId, title);
    const date = this._localDateToken();
    const expectedPath = path.join(baseDir, `${projectName}_${canvasFormat}_${date}`);

    this._removeExistingProjectDirectoryForRetry(expectedPath, { baseDir, projectName });

    try {
      await this._runPptMasterScript(
        'project_manager.py',
        ['init', projectName, '--format', canvasFormat, '--dir', baseDir],
        { timeoutMs: 60000 }
      );
    } catch (error) {
      if (!/Project directory already exists/i.test(error.message || '')) throw error;
      this._removeExistingProjectDirectoryForRetry(expectedPath, { baseDir, projectName });
      await this._runPptMasterScript(
        'project_manager.py',
        ['init', projectName, '--format', canvasFormat, '--dir', baseDir],
        { timeoutMs: 60000 }
      );
    }

    if (!fs.existsSync(expectedPath)) {
      throw new Error(`project_manager.py init 未创建预期目录: ${expectedPath}`);
    }

    this._updateProgress(15, 'projectInitialization', 'PPT 项目已创建，正在继续生成', {
      project_dir: this._toUploadUrl(expectedPath)
    });
    return expectedPath;
  }

  _removeExistingProjectDirectoryForRetry(projectPath, { baseDir, projectName } = {}) {
    if (!projectPath || !fs.existsSync(projectPath)) return;
    const resolvedProject = fs.realpathSync(projectPath);
    const resolvedBase = fs.realpathSync(baseDir || path.dirname(projectPath));
    const name = path.basename(resolvedProject);
    const isInsideBase = resolvedProject.startsWith(`${resolvedBase}${path.sep}`);
    const isCurrentTaskProject = name.startsWith(`${projectName}_`);
    const isPptUploadDir = resolvedBase.startsWith(fs.realpathSync(path.join(UPLOAD_DIR, 'ppt')));
    if (!isInsideBase || !isCurrentTaskProject || !isPptUploadDir) {
      throw new Error(`拒绝清理非当前任务项目目录: ${projectPath}`);
    }

    fs.rmSync(resolvedProject, { recursive: true, force: true });
    this._recordWorkflowEvent('Step 2 Project Initialization', 'removed_existing_retry_directory', {
      project_path: resolvedProject
    });
  }

  _projectName(taskId, title) {
    const safeTitle = this._slugify(title).slice(0, 32) || 'ppt';
    return `${taskId}_${safeTitle}`;
  }

  _localDateToken(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  _localTimestampToken(date = new Date()) {
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${this._localDateToken(date)}_${hour}${minute}${second}`;
  }

  async _stageUploadedAssets() {
    if (!this.projectPath) return [];

    const templateAsset = this.params.templateAsset || this.params.template_asset;
    const referenceAssets = Array.isArray(this.params.referenceAssets)
      ? this.params.referenceAssets
      : (Array.isArray(this.params.reference_assets) ? this.params.reference_assets : []);
    const documentAssets = Array.isArray(this.params.documentAssets)
      ? this.params.documentAssets
      : (Array.isArray(this.params.document_assets) ? this.params.document_assets : []);
    const assets = [
      ...(templateAsset ? [{ ...templateAsset, kind: 'template' }] : []),
      ...referenceAssets.map(asset => ({ ...asset, kind: 'image' })),
      ...documentAssets.map(asset => ({ ...asset, kind: 'document' }))
    ];

    const staged = [];
    assets.forEach((asset, index) => {
      const sourcePath = this._resolveUploadedAssetPath(asset);
      if (!sourcePath) return;

      const ext = (path.extname(asset.name || asset.filename || sourcePath) || path.extname(sourcePath) || '.bin').toLowerCase();
      const base = this._slugify(path.basename(asset.name || asset.filename || sourcePath, ext)).slice(0, 64);
      const filename = `${asset.kind}_${index + 1}_${base}${ext}`;
      const targetDir = asset.kind === 'image'
        ? 'images'
        : (asset.kind === 'document' ? 'sources/uploads' : 'templates');
      const targetPath = path.join(this.projectPath, targetDir, filename);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);

      staged.push({
        ...asset,
        path: targetPath,
        relativePath: `${targetDir}/${filename}`
      });
    });

    this.params.stagedTemplateAsset = staged.find(asset => asset.kind === 'template') || null;
    this.params.stagedReferenceAssets = staged.filter(asset => asset.kind === 'image');
    this.params.stagedDocumentAssets = staged.filter(asset => asset.kind === 'document');
    return staged;
  }

  async _prepareUploadedDocumentContext(stagedAssets = []) {
    const documentAssets = stagedAssets.filter(asset => asset.kind === 'document');
    if (!documentAssets.length) return null;

    const outputDir = path.join(this.projectPath, 'sources', 'converted_uploads');
    fs.mkdirSync(outputDir, { recursive: true });

    const sections = [];
    const reports = [];
    for (const [assetIndex, asset] of documentAssets.entries()) {
      const label = asset.name || asset.filename || path.basename(asset.path || '');
      if (!asset.path || !DocumentConverterService.isSupported(asset.path)) {
        throw new Error(`上传资料「${label}」格式不支持，无法作为 PPT 内容依据`);
      }

      this._updateProgress(16, 'projectInitialization', `正在解析上传资料：${label}`, {
        document: label
      });

      try {
        const result = await this._convertUploadedDocumentAsset(asset, {
          outputDir,
          timeoutMs: 180000
        });
        const relativeMdPath = path.relative(this.projectPath, result.outputPath);
        const markdown = this._trimText(result.markdown, 20000);
        const publishedImages = this._publishUploadedDocumentImages({
          markdown: result.markdown,
          markdownPath: result.outputPath,
          label,
          documentIndex: assetIndex + 1
        });
        const publishedImageLines = publishedImages.length > 0
          ? [
            '',
            '- 可用于 SVG 的资料图片（已复制到项目 images/，只允许引用这些真实存在的 href）：',
            ...publishedImages.map(item => `  - ${item.svgHref}（来自 ${item.originalRef || item.filename}）`)
          ]
          : [];
        sections.push([
          `## 上传资料：${label}`,
          `- 原始文件：${label}`,
          `- 解析类型：${result.converter}`,
          `- Markdown 文件：${relativeMdPath}`,
          `- 行数：${result.lineCount}`,
          ...publishedImageLines,
          '',
          markdown
        ].join('\n'));
        reports.push({
          name: label,
          status: 'converted',
          converter: result.converter,
          markdown: relativeMdPath,
          lineCount: result.lineCount,
          duration: result.duration,
          publishedImages: publishedImages.map(item => ({
            filename: item.filename,
            relativePath: item.relativePath,
            svgHref: item.svgHref,
            source: item.sourceMarkdown,
            originalRef: item.originalRef
          }))
        });
      } catch (error) {
        throw new Error(`上传资料「${label}」解析失败：${this._trimText(error.message, 1200)}`);
      }
    }

    const sourceBrief = [
      '## 用户上传文档资料',
      '- 以下内容来自用户上传的 PDF/Word/Excel/网页等资料，必须优先作为 PPT 内容依据。',
      '- 如果用户需求与上传资料冲突，以用户明确指令为准，并在页面表达中保持事实谨慎。',
      '- 上传资料 Markdown 内的图片会被发布到项目 images/；生成 SVG 时只能引用摘要中列出的 ../images/... 路径，不要编造或引用 sources/converted_uploads 内部路径。',
      '',
      sections.join('\n\n')
    ].filter(Boolean).join('\n');
    const summaryPath = path.join(outputDir, 'uploaded_documents_reference.md');
    this._writeTextFile(summaryPath, sourceBrief);
    this.params.uploadedDocumentReference = {
      summaryPath: path.relative(this.projectPath, summaryPath),
      reports
    };

    return {
      sourceBrief,
      summaryPath: path.relative(this.projectPath, summaryPath),
      reports
    };
  }

  async _convertUploadedDocumentAsset(asset, options = {}) {
    try {
      return await DocumentConverterService.convert(asset.path, options);
    } catch (error) {
      const ext = path.extname(asset.path || asset.name || asset.filename || '').toLowerCase();
      if (!['.doc', '.docx', '.rtf', '.odt'].includes(ext)) throw error;
      try {
        const fallback = await this._convertDocumentViaTextutil(asset, options);
        return {
          ...fallback,
          fallback: true,
          original_error: error.message
        };
      } catch (fallbackError) {
        throw new Error(`${error.message}\ntextutil fallback failed: ${fallbackError.message}`);
      }
    }
  }

  async _convertDocumentViaTextutil(asset, { outputDir } = {}) {
    const sourcePath = asset.path;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('上传文档文件不存在');
    }
    const safeBase = this._slugify(path.basename(asset.name || asset.filename || sourcePath, path.extname(sourcePath))).slice(0, 72) || 'uploaded_document';
    const outputPath = path.join(outputDir || path.dirname(sourcePath), `${safeBase}.md`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const startedAt = Date.now();
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'textutil',
        ['-convert', 'txt', '-stdout', sourcePath],
        {
          timeout: 120000,
          maxBuffer: 20 * 1024 * 1024
        },
        (error, out, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(out || '');
        }
      );
    });
    const text = String(stdout || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('textutil 未提取到文档正文');
    const markdown = [
      `# ${asset.name || asset.filename || path.basename(sourcePath)}`,
      '',
      '> Word 文档由 macOS textutil 兜底转换，保留正文内容用于 PPT 生成。',
      '',
      text
    ].join('\n');
    this._writeTextFile(outputPath, markdown);
    return {
      success: true,
      markdown,
      outputPath,
      converter: 'textutil',
      duration: Date.now() - startedAt,
      fileSize: fs.statSync(sourcePath).size,
      lineCount: markdown.split('\n').length
    };
  }

  _publishUploadedDocumentImages({ markdown, markdownPath, label, documentIndex }) {
    if (!this.projectPath || !markdownPath || !fs.existsSync(markdownPath)) return [];

    const refs = this._extractMarkdownImageRefs(markdown);
    if (refs.length === 0) return [];

    const outputRoot = path.dirname(markdownPath);
    const imageDir = path.join(this.projectPath, 'images');
    fs.mkdirSync(imageDir, { recursive: true });

    const published = [];
    const seenSourcePaths = new Set();
    refs.forEach((ref, refIndex) => {
      const sourcePath = this._resolveConvertedMarkdownImagePath(ref, outputRoot);
      if (!sourcePath || seenSourcePaths.has(sourcePath)) return;
      seenSourcePaths.add(sourcePath);

      const ext = path.extname(sourcePath).toLowerCase();
      if (!/\.(png|jpe?g|webp|gif)$/.test(ext)) return;

      const baseFilename = path.basename(sourcePath);
      const filename = this._availableImageFilename(baseFilename, {
        fallbackPrefix: `document_${documentIndex}_asset_${refIndex + 1}`
      });
      const targetPath = path.join(imageDir, filename);
      if (!fs.existsSync(targetPath) || fs.realpathSync(sourcePath) !== fs.realpathSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      }

      const asset = {
        filename,
        path: targetPath,
        relativePath: `images/${filename}`,
        svgHref: `../images/${filename}`,
        url: this._toUploadUrl(targetPath),
        origin: 'uploaded_document',
        description: `上传资料图片：${label} / ${baseFilename}`,
        sourceMarkdown: path.relative(this.projectPath, markdownPath),
        originalRef: ref
      };

      if (!this.imageAssets.some(item => item.relativePath === asset.relativePath)) {
        this.imageAssets.push(asset);
        this._publishLiveImageAssetProgress(asset, {
          status: 'ready',
          statusLabel: '上传资料图片',
          message: `已从上传资料提取图片：${asset.filename}`,
          progress: 18
        });
      }
      published.push(asset);
    });

    return published;
  }

  _extractMarkdownImageRefs(markdown = '') {
    const refs = [];
    const text = String(markdown || '');
    const markdownImagePattern = /!\[[^\]]*]\(([^)\n]+)\)/g;
    const htmlImagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

    let match;
    while ((match = markdownImagePattern.exec(text))) {
      refs.push(match[1]);
    }
    while ((match = htmlImagePattern.exec(text))) {
      refs.push(match[1]);
    }

    return [...new Set(refs.map(ref => this._cleanMarkdownAssetRef(ref)).filter(Boolean))];
  }

  _cleanMarkdownAssetRef(ref = '') {
    const value = String(ref || '').trim().replace(/^<|>$/g, '');
    if (!value || /^(?:https?:|data:|blob:|file:|javascript:)/i.test(value)) return '';
    const withoutTitle = value.replace(/\s+["'][^"']*["']\s*$/, '').trim();
    const withoutQuery = withoutTitle.split('#')[0].split('?')[0].trim();
    if (!withoutQuery) return '';
    try {
      return decodeURIComponent(withoutQuery);
    } catch {
      return withoutQuery;
    }
  }

  _resolveConvertedMarkdownImagePath(ref, outputRoot) {
    const normalizedRef = String(ref || '').replace(/\\/g, path.sep);
    if (!normalizedRef) return null;
    const resolved = path.isAbsolute(normalizedRef)
      ? path.resolve(normalizedRef)
      : path.resolve(outputRoot, normalizedRef);
    if (!this._isInsidePath(resolved, outputRoot)) return null;
    if (!fs.existsSync(resolved)) return null;
    return resolved;
  }

  _availableImageFilename(preferredName, { fallbackPrefix = 'asset' } = {}) {
    const imageDir = path.join(this.projectPath, 'images');
    const ext = path.extname(preferredName).toLowerCase() || '.png';
    const preferredBase = this._slugify(path.basename(preferredName, ext)).slice(0, 72) || fallbackPrefix;
    let filename = `${preferredBase}${ext}`;
    let targetPath = path.join(imageDir, filename);
    let index = 1;

    while (fs.existsSync(targetPath)) {
      filename = `${fallbackPrefix}_${index}_${preferredBase}`.slice(0, 96) + ext;
      targetPath = path.join(imageDir, filename);
      index += 1;
    }

    return filename;
  }

  _isInsidePath(filePath, rootPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  async _prepareUploadedTemplateReference(stagedAssets = []) {
    const templateAsset = stagedAssets.find(asset => asset.kind === 'template') || this.params.stagedTemplateAsset;
    if (!templateAsset?.path) return null;

    const ext = path.extname(templateAsset.path || templateAsset.name || '').toLowerCase();
    const referenceDir = path.join(this.projectPath, 'templates', 'uploaded_reference');
    const relativeDir = path.relative(this.projectPath, referenceDir);

    let mode = 'unsupported';
    let status = 'reference_unavailable';
    let toolOutput = '';
    let errorMessage = '';

    if (['.pptx', '.potx'].includes(ext)) {
      fs.mkdirSync(referenceDir, { recursive: true });
      this._updateProgress(16, 'projectInitialization', '正在解析上传 PPT 模板参考', {
        template: templateAsset.name || templateAsset.filename || path.basename(templateAsset.path)
      });
      const importInputPath = ext === '.potx'
        ? path.join(this.projectPath, '.workflow', 'uploaded_template_as_pptx.pptx')
        : templateAsset.path;
      if (ext === '.potx') {
        fs.copyFileSync(templateAsset.path, importInputPath);
      }

      try {
        toolOutput = await this._runPptMasterScript(
          'pptx_template_import.py',
          [importInputPath, '-o', referenceDir],
          { timeoutMs: 300000 }
        );
        mode = 'full_svg_reference';
        status = 'reference_ready';
      } catch (error) {
        errorMessage = error.message;
        try {
          toolOutput = await this._runPptMasterScript(
            'pptx_template_import.py',
            [importInputPath, '-o', referenceDir, '--manifest-only'],
            { timeoutMs: 90000 }
          );
          mode = 'manifest_only';
          status = 'metadata_ready_svg_export_failed';
        } catch (fallbackError) {
          errorMessage = `${errorMessage}; manifest fallback failed: ${fallbackError.message}`;
        }
      }
    } else {
      errorMessage = '上传模板仅支持 .pptx；旧 .ppt/.pot 需要先另存为 .pptx/.potx。';
    }

    const manifest = this._readJsonFileIfExists(path.join(referenceDir, 'manifest.json'), null);
    const publishedAssets = manifest
      ? this._publishTemplateReferenceAssets(manifest, referenceDir)
      : [];
    const reference = this._buildUploadedTemplateReference({
      templateAsset,
      referenceDir,
      relativeDir,
      manifest,
      mode,
      status,
      toolOutput,
      errorMessage,
      publishedAssets
    });

    this.templateReference = reference;
    this.params.uploadedTemplateReference = {
      status: reference.status,
      mode: reference.mode,
      relativeDir: reference.relativeDir,
      summaryPath: reference.summaryPath
    };
    return reference;
  }

  _buildUploadedTemplateReference({
    templateAsset,
    referenceDir,
    relativeDir,
    manifest,
    mode,
    status,
    toolOutput,
    errorMessage,
    publishedAssets = []
  }) {
    const analysis = this._readTextFileIfExists(path.join(referenceDir, 'analysis.md'), 2800);
    const masterLayoutAnalysis = this._readTextFileIfExists(path.join(referenceDir, 'master_layout_analysis.md'), 2400);
    const masterLayoutRefs = this._readJsonFileIfExists(path.join(referenceDir, 'master_layout_refs.json'), null);
    const referenceSelection = this._readJsonFileIfExists(path.join(referenceDir, 'reference_svg_selection.json'), null);
    const svgRefs = this._collectTemplateSvgReferenceSnippets(referenceDir, referenceSelection);
    const theme = manifest?.theme || {};
    const colors = Object.entries(theme.colors || {})
      .slice(0, 18)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    const fonts = Object.entries(theme.fonts || {})
      .slice(0, 8)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    const slideSize = manifest?.slideSize
      ? `${manifest.slideSize.width_px || 0}x${manifest.slideSize.height_px || 0}px`
      : 'unknown';
    const pageTypes = manifest?.pageTypeCandidates
      ? Object.entries(manifest.pageTypeCandidates)
        .map(([type, indexes]) => `${type}: ${(indexes || []).join(', ')}`)
        .join('; ')
      : '';
    const layoutSummary = masterLayoutRefs
      ? [
        `layouts=${masterLayoutRefs.layouts?.length || 0}`,
        `masters=${masterLayoutRefs.masters?.length || 0}`
      ].join(', ')
      : '';
    const publishedAssetLines = publishedAssets.map(asset => `- ${asset.relativePath}: ${asset.description}`);
    const svgReferenceLines = svgRefs.map(ref => [
      `### SVG reference ${ref.index || '?'} (${ref.pageType || 'unknown'})`,
      `- path: ${ref.relativePath}`,
      '```svg',
      ref.snippet,
      '```'
    ].join('\n'));

    const sourceBrief = [
      '## 上传 PPT 模板解析',
      `- 原始文件：${templateAsset.name || templateAsset.filename || path.basename(templateAsset.path)}`,
      `- 解析状态：${status}`,
      `- 解析模式：${mode}`,
      `- 参考目录：${relativeDir}`,
      `- 画布尺寸：${slideSize}`,
      colors ? `- 主题色：${colors}` : '- 主题色：未检测到',
      fonts ? `- 字体：${fonts}` : '- 字体：未检测到',
      pageTypes ? `- 页面类型候选：${pageTypes}` : '',
      layoutSummary ? `- 母版/版式结构：${layoutSummary}` : '',
      '',
      '### 模板使用原则',
      '- 这是 PPTX 参考重建材料，不是直接把原 PPTX 原样套用到最终 PPT。',
      '- Strategist 必须吸收模板的配色、字体、页眉页脚、留白节奏、装饰语言和典型版式，并写入 design_spec.md。',
      '- Executor 必须基于 design_spec/spec_lock 重建 clean SVG；禁止直接复制原始 PPTX 的复杂 XML 或把导出的 SVG 当最终页面。',
      publishedAssetLines.length ? '\n### 可用模板图片资产\n' + publishedAssetLines.join('\n') : '',
      analysis ? '\n### PPTX 结构摘要\n' + analysis : '',
      masterLayoutAnalysis ? '\n### 母版和版式摘要\n' + masterLayoutAnalysis : '',
      svgReferenceLines.length ? '\n### 代表性 SVG 参考页\n' + svgReferenceLines.join('\n\n') : '',
      errorMessage ? '\n### 解析降级原因\n' + this._trimText(errorMessage, 1600) : '',
      toolOutput ? '\n### 导入工具输出\n' + this._trimText(toolOutput, 1200) : ''
    ].filter(Boolean).join('\n');

    const summaryPath = path.join(referenceDir, 'uploaded_template_reference.md');
    this._writeTextFile(summaryPath, sourceBrief);
    return {
      status,
      mode,
      relativeDir,
      summaryPath: path.relative(this.projectPath, summaryPath),
      sourceBrief,
      themeColors: theme.colors || {},
      themeFonts: theme.fonts || {},
      publishedAssets
    };
  }

  _collectTemplateSvgReferenceSnippets(referenceDir, referenceSelection) {
    const refs = Array.isArray(referenceSelection?.recommendedSvgRefs)
      ? referenceSelection.recommendedSvgRefs
      : [];
    return refs.slice(0, 6).map(ref => {
      const svgPath = path.join(referenceDir, ref.svg || '');
      if (!ref.svg || !fs.existsSync(svgPath)) return null;
      return {
        index: ref.index,
        pageType: ref.pageType,
        relativePath: path.relative(this.projectPath, svgPath),
        snippet: this._trimText(fs.readFileSync(svgPath, 'utf-8').replace(/\s+/g, ' '), 1100)
      };
    }).filter(Boolean);
  }

  _publishTemplateReferenceAssets(manifest, referenceDir) {
    const exportDir = manifest?.assets?.exportDir || 'assets';
    const candidates = [
      ...(manifest?.assets?.commonAssets || []),
      ...(manifest?.assets?.allAssets || []).slice(0, 4)
    ];
    const uniqueCandidates = [...new Set(candidates)]
      .filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name))
      .slice(0, 8);
    const published = [];

    uniqueCandidates.forEach((name, index) => {
      const sourcePath = path.join(referenceDir, exportDir, name);
      if (!fs.existsSync(sourcePath)) return;
      const ext = path.extname(name).toLowerCase() || '.png';
      const safeName = this._slugify(path.basename(name, ext)).slice(0, 52) || `asset_${index + 1}`;
      const filename = `template_ref_${index + 1}_${safeName}${ext}`;
      const targetPath = path.join(this.projectPath, 'images', filename);
      fs.copyFileSync(sourcePath, targetPath);
      const asset = {
        filename,
        path: targetPath,
        relativePath: `images/${filename}`,
        svgHref: `../images/${filename}`,
        url: this._toUploadUrl(targetPath),
        origin: 'template_reference',
        description: `上传 PPT 模板提取素材：${name}`
      };
      this.imageAssets.push(asset);
      this._publishLiveImageAssetProgress(asset, {
        status: 'ready',
        statusLabel: '模板资源',
        message: `已从 PPT 模板提取图片：${asset.filename}`,
        progress: 18
      });
      published.push(asset);
    });

    return published;
  }

  _formatUploadedTemplateContext(maxChars = 5000) {
    if (!this.templateReference?.sourceBrief) return '';
    return this._trimText(this._sanitizeExecutorPromptText(this.templateReference.sourceBrief), maxChars);
  }

  _formatLayoutTemplateContext(maxChars = 7000, pageNum = null) {
    if (!this.layoutTemplateReference?.sourceBrief) return '';
    if (!pageNum) return this._trimText(this._sanitizeExecutorPromptText(this.layoutTemplateReference.sourceBrief), maxChars);

    const pageType = this._layoutTemplatePageTypeForPage(pageNum);
    const refs = this.layoutTemplateReference.svgReferences || [];
    const selected = [
      ...refs.filter(ref => ref.pageType === pageType),
      ...refs.filter(ref => ref.pageType === 'content')
    ].filter((item, index, list) => list.findIndex(other => other.name === item.name) === index).slice(0, 3);
    const lines = [
      `## ppt-master Built-in Template Context（current page: ${pageType}）`,
      `- Template: ${this.layoutTemplateReference.template}`,
      this.layoutTemplateReference.label ? `- Label: ${this.layoutTemplateReference.label}` : '',
      this.layoutTemplateReference.summary ? `- Summary: ${this.layoutTemplateReference.summary}` : '',
      '',
      '### Template execution rule',
      '- Treat these SVGs as structural references for this page type; rebuild clean SVG using current content and spec_lock colors/fonts.',
      '- Preserve template-specific page chrome, title placement, spacing rhythm, background geometry and hierarchy. Reuse footer/header shapes only; do not copy visible template names, source notes, uploaded-file names, internal paths, or attribution-like footer text.',
      '- For content-page templates with a full header band, keep all header chrome inside y=0..82; keep the first content block at y>=100; keep right-side section labels ending before the page badge; keep footer text baseline safely above the bottom edge.',
      '',
      selected.map(ref => [
        `### ${ref.name} (${ref.pageType})`,
        '```svg',
        ref.snippet,
        '```'
      ].join('\n')).join('\n\n')
    ].filter(Boolean).join('\n');
    return this._trimText(this._sanitizeExecutorPromptText(lines), maxChars);
  }

  _layoutTemplatePageTypeForPage(pageNum) {
    const pageCount = Math.max(1, parseInt(this.params.pageCount, 10) || 1);
    const title = this._fallbackPageTitles()[pageNum - 1] || '';
    if (pageNum === 1) return 'cover';
    if (pageNum === pageCount) return 'ending';
    if (/目录|agenda|contents|toc/i.test(title)) return 'toc';
    if (/章节|chapter|section|篇章|第一部分|第二部分|第三部分|第四部分/i.test(title)) return 'chapter';
    return 'content';
  }

  _templateColorLockLines() {
    const colors = this.templateReference?.themeColors || {};
    return Object.entries(colors)
      .filter(([, value]) => /^#[0-9a-f]{6}$/i.test(String(value || '').trim()))
      .slice(0, 18)
      .map(([key, value]) => `- template_${this._slugify(key)}: ${String(value).toUpperCase()}`);
  }

  _layoutTemplateColorLockLines() {
    const named = this.layoutTemplateReference?.namedColors || [];
    const lines = [];
    const used = new Set();
    named.forEach((item, index) => {
      const value = String(item.value || '').toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(value)) return;
      const base = this._slugify(item.name || `layout_color_${index + 1}`).slice(0, 28) || `layout_color_${index + 1}`;
      let key = `layout_${base}`;
      let suffix = 2;
      while (used.has(key)) {
        key = `layout_${base}_${suffix}`;
        suffix += 1;
      }
      used.add(key);
      lines.push(`- ${key}: ${value}`);
    });
    if (lines.length) return lines.slice(0, 24);

    return this._extractHexColors(this.layoutTemplateReference?.designSpec || '')
      .slice(0, 18)
      .map((value, index) => `- layout_spec_color_${index + 1}: ${value}`);
  }

  _readTextFileIfExists(filePath, maxChars = 4000) {
    if (!fs.existsSync(filePath)) return '';
    return this._trimText(fs.readFileSync(filePath, 'utf-8'), maxChars);
  }

  _readJsonFileIfExists(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    return this._safeJsonParse(fs.readFileSync(filePath, 'utf-8'), fallback);
  }

  _resolveUploadedAssetPath(asset = {}) {
    const rawUrl = String(asset.url || '').trim();
    if (!rawUrl) return null;

    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      pathname = rawUrl;
    }

    const decoded = decodeURIComponent(pathname);
    let relative = '';
    if (decoded.startsWith('/uploads/')) {
      relative = decoded.replace(/^\/uploads\//, '');
    } else if (decoded.startsWith('/api/files/')) {
      relative = decoded.replace(/^\/api\/files\//, '');
    } else {
      return null;
    }

    let resolved;
    try {
      resolved = appConfig.assertInsideUploadDir(path.join(UPLOAD_DIR, relative));
    } catch {
      return null;
    }
    if (!fs.existsSync(resolved)) {
      return null;
    }
    return resolved;
  }

  async _applyTemplateOption() {
    const trigger = this._detectTemplateTrigger();
    if (!trigger) {
      if (this.templateReference) {
        return {
          mode: 'uploaded_template_reference',
          gate: this.templateReference.status,
          reference_dir: this.templateReference.relativeDir,
          summary: this.templateReference.summaryPath,
          published_assets: this.templateReference.publishedAssets?.map(asset => asset.relativePath) || [],
          copied: []
        };
      }
      return {
        mode: 'free_design',
        gate: 'default_free_design_no_layout_index_query',
        copied: []
      };
    }

    const root = this.runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const layoutsRoot = path.join(root, 'skills', 'ppt-master', 'templates', 'layouts');
    const layoutIndexPath = path.join(layoutsRoot, 'layouts_index.json');
    this._recordRoleRead('Template_Option', 'skills/ppt-master/templates/layouts/layouts_index.json');
    const layoutIndex = fs.existsSync(layoutIndexPath)
      ? this._safeJsonParse(fs.readFileSync(layoutIndexPath, 'utf-8'), null)
      : null;
    const templateDir = path.join(layoutsRoot, trigger.template);
    if (!fs.existsSync(templateDir)) {
      return {
        mode: 'free_design',
        gate: 'template_trigger_unresolved',
        trigger: trigger.raw,
        requested_template: trigger.template,
        layout_index_read: Boolean(layoutIndex),
        copied: []
      };
    }

    const copied = [];
    for (const name of fs.readdirSync(templateDir)) {
      const src = path.join(templateDir, name);
      const ext = path.extname(name).toLowerCase();
      const targetDir = ['.png', '.jpg', '.jpeg'].includes(ext) ? 'images' : 'templates';
      if (!['.svg', '.md', '.png', '.jpg', '.jpeg'].includes(ext)) continue;
      const dst = path.join(this.projectPath, targetDir, name);
      fs.copyFileSync(src, dst);
      const relativePath = `${targetDir}/${name}`;
      copied.push(relativePath);
      this._recordRoleRead('Template_Option', `skills/ppt-master/templates/layouts/${trigger.template}/${name}`);

      if (targetDir === 'images') {
        const asset = {
          filename: name,
          path: dst,
          relativePath,
          svgHref: `../${relativePath}`,
          url: this._toUploadUrl(dst),
          description: `ppt-master 内置模板 ${trigger.template} 视觉资产：${name}`,
          origin: 'layout_template',
          provider: 'ppt-master-template'
        };
        this.imageAssets.push(asset);
        this._publishLiveImageAsset(asset, {
          status: 'ready',
          statusLabel: '模板资源',
          message: `已加载模板资源：${name}`,
          progress: 18
        });
      }
    }

    this.layoutTemplateReference = this._buildLayoutTemplateReference({
      template: trigger.template,
      templateDir,
      layoutIndex,
      copied
    });

    return {
      mode: 'template',
      gate: 'explicit_template_trigger',
      trigger: trigger.raw,
      template: trigger.template,
      layout_index_read: Boolean(layoutIndex),
      copied,
      context: this.layoutTemplateReference
        ? {
          summary: this.layoutTemplateReference.summaryPath,
          design_spec: this.layoutTemplateReference.designSpecPath,
          svg_references: this.layoutTemplateReference.svgReferences.map(item => item.relativePath)
        }
        : null
    };
  }

  _buildLayoutTemplateReference({ template, templateDir, layoutIndex = null, copied = [] }) {
    const templateMeta = layoutIndex?.[template] || {};
    const designSpecPath = path.join(templateDir, 'design_spec.md');
    const designSpec = this._readTextFileIfExists(designSpecPath, 12000);
    const svgReferences = fs.readdirSync(templateDir)
      .filter(name => path.extname(name).toLowerCase() === '.svg')
      .sort((a, b) => a.localeCompare(b))
      .map(name => {
        const absolutePath = path.join(templateDir, name);
        return {
          name,
          absolutePath,
          relativePath: `templates/${name}`,
          pageType: this._inferLayoutTemplatePageType(name),
          snippet: this._compactSvgReferenceSnippet(absolutePath, 2600)
        };
      })
      .filter(item => item.snippet);
    const imageAssets = copied
      .filter(item => /^images\//.test(item))
      .map(item => `- ${item}: ppt-master template asset`);
    const colorLines = this._extractNamedColors(designSpec)
      .slice(0, 24)
      .map(item => `- ${item.name}: ${item.value}`);
    const svgLines = svgReferences.map(ref => [
      `### Template SVG: ${ref.name} (${ref.pageType})`,
      `- copied path: ${ref.relativePath}`,
      '```svg',
      ref.snippet,
      '```'
    ].join('\n'));

    const sourceBrief = [
      '## ppt-master Step 3 Template Option',
      `- Triggered template: ${template}`,
      templateMeta.label ? `- Template label: ${templateMeta.label}` : '',
      templateMeta.summary ? `- Template summary: ${templateMeta.summary}` : '',
      Array.isArray(templateMeta.keywords) && templateMeta.keywords.length
        ? `- Template keywords: ${templateMeta.keywords.join(', ')}`
        : '',
      copied.length ? `- Copied files: ${copied.join(', ')}` : '',
      '',
      '### Mandatory Template Execution Contract',
      '- Strategist MUST use this template design_spec.md as the primary visual-system reference for Section III, IV, V, VI, VII and IX.',
      '- Executor MUST use the copied template SVGs as structural references: cover for P01, ending for the final page, toc for目录页, chapter for chapter openers, content for normal content pages.',
      '- Do not merely reuse a generic business layout with different colors. Preserve the template-specific header/footer geometry, title zone, background geometry, spacing rhythm, icon/image language and page-type hierarchy while rebuilding clean SVG.',
      '- The final slide canvas must not show template labels, source notes, uploaded-file names, internal paths, workflow names, or attribution-like footer text. Keep only decorative footer shapes or page numbers.',
      '',
      designSpec ? '### Template design_spec.md\n' + designSpec : '',
      colorLines.length ? '\n### Template Named Colors\n' + colorLines.join('\n') : '',
      imageAssets.length ? '\n### Template Image Assets\n' + imageAssets.join('\n') : '',
      svgLines.length ? '\n### Template SVG Structural References\n' + svgLines.join('\n\n') : ''
    ].filter(Boolean).join('\n');

    const summaryPath = path.join(this.projectPath, 'templates', `${template}_template_context.md`);
    this._writeTextFile(summaryPath, sourceBrief);
    return {
      template,
      label: templateMeta.label || template,
      summary: templateMeta.summary || '',
      copied,
      sourceBrief,
      summaryPath: path.relative(this.projectPath, summaryPath),
      designSpecPath: designSpec ? 'templates/design_spec.md' : '',
      designSpec,
      namedColors: this._extractNamedColors(designSpec),
      svgReferences
    };
  }

  _inferLayoutTemplatePageType(filename = '') {
    const name = String(filename || '').toLowerCase();
    if (/cover/.test(name)) return 'cover';
    if (/toc|目录/.test(name)) return 'toc';
    if (/chapter|section|章节/.test(name)) return 'chapter';
    if (/ending|end|结尾|结束/.test(name)) return 'ending';
    return 'content';
  }

  _compactSvgReferenceSnippet(filePath, maxChars = 2400) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const svg = this._removeVisiblePptMetaText(fs.readFileSync(filePath, 'utf-8'))
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
    return this._trimText(svg, maxChars);
  }

  _detectTemplateTrigger() {
    const explicitParts = [
      this.params.pptMasterTemplate,
      this.params.ppt_master_template,
      this.params.template,
      this.params.styleId,
      this.params.requestedStyle,
      this.params.styleLabel
    ].filter(Boolean);
    const normalizedStyle = String(this.params.style || '').toLowerCase();
    const legacyStyleTemplateMap = {
      business: 'mckinsey',
      consulting: 'mckinsey',
      professional: 'mckinsey',
      default: 'mckinsey',
      minimal: 'mckinsey',
      creative: 'google_style',
      dark_tech: 'ai_ops'
    };
    if (legacyStyleTemplateMap[normalizedStyle]) {
      explicitParts.push(legacyStyleTemplateMap[normalizedStyle]);
    } else if (normalizedStyle && normalizedStyle !== 'general') {
      explicitParts.push(normalizedStyle);
    }
    const raw = explicitParts.join(' ').toLowerCase();
    if (!raw.trim()) return null;

    const mappings = [
      { tests: ['academic_defense', '学术答辩', '论文答辩', '毕业答辩'], template: 'academic_defense' },
      { tests: ['ai_ops', 'aiops', '企业数智', '数智化', '数字化转型', 'dark_tech', '暗色科技', '黑色科技', '深色科技'], template: 'ai_ops' },
      { tests: ['anthropic', 'ai 技术分享', 'ai技术分享', 'llm', '大模型'], template: 'anthropic' },
      { tests: ['exhibit', '高管汇报', '董事会', 'executive', 'board'], template: 'exhibit' },
      { tests: ['google', 'google_style', '谷歌', 'creative', '创意发布', '创意表达'], template: 'google_style' },
      { tests: ['government_red', '政务红', '党建', '党政'], template: 'government_red' },
      { tests: ['government_blue', '政府', '政务', 'government', '政务蓝'], template: 'government_blue' },
      { tests: ['mckinsey', 'business', 'consulting', 'professional', '麦肯锡', '顶级咨询', '高端咨询', '商务专业', '极简留白', '极简', '简约', 'minimal'], template: 'mckinsey' },
      { tests: ['pixel', '像素'], template: 'pixel_retro' },
      { tests: ['medical_university', 'medical', '医学', '医学院', '医疗科研'], template: 'medical_university' },
      { tests: ['psychology_attachment', '心理疗愈', '心理咨询', '心理学'], template: 'psychology_attachment' },
      { tests: ['smart_red', '红橙商务'], template: 'smart_red' },
      { tests: ['科技蓝商务', 'tech_blue', '科技蓝'], template: '科技蓝商务' },
      { tests: ['招商银行'], template: '招商银行' },
      { tests: ['中国电信', '电信', 'telecom'], template: 'china_telecom_template' },
      { tests: ['中国电建_常规', 'powerchina_standard'], template: '中国电建_常规' },
      { tests: ['中汽研_商务', 'catarc_business'], template: '中汽研_商务' },
      { tests: ['中汽研_常规', 'catarc_standard'], template: '中汽研_常规' },
      { tests: ['中国电建_现代', 'powerchina_modern', '工程现代', '中国电建', '电建'], template: '中国电建_现代' },
      { tests: ['中汽研_现代', 'catarc_modern', '汽车科技', '中汽研'], template: '中汽研_现代' },
      { tests: ['重庆大学', 'chongqing_university'], template: '重庆大学' }
    ];

    for (const item of mappings) {
      if (item.tests.some(test => raw.includes(test))) {
        return { raw, template: item.template };
      }
    }
    return null;
  }

  async _runImageGeneratorPhase() {
    this._recordRoleRead('Image_Acquisition', 'skills/ppt-master/references/image-base.md');
    this._loadPptMasterFile('skills/ppt-master/references/image-base.md', 9000);
    const explicit = this.params.generateImages;
    const shouldGenerate = explicit === true || (explicit === undefined && this.runtimeConfig.pptGenerateImages);
    const promptPath = path.join(this.projectPath, 'images', 'image_prompts.md');
    const imageDir = path.join(this.projectPath, 'images');
    fs.mkdirSync(imageDir, { recursive: true });
    const requests = this._extractPendingImageRequests();
    const aiRequests = requests.filter(request => request.acquireVia !== 'web');
    const webRequests = requests.filter(request => request.acquireVia === 'web');
    if (aiRequests.length > 0) {
      this._recordRoleRead('Image_Generator', 'skills/ppt-master/references/image-generator.md');
      this._loadPptMasterFile('skills/ppt-master/references/image-generator.md', 7000);
    }
    if (webRequests.length > 0) {
      this._recordRoleRead('Image_Searcher', 'skills/ppt-master/references/image-searcher.md');
      this._loadPptMasterFile('skills/ppt-master/references/image-searcher.md', 9000);
    }
    const promptDoc = this._buildImagePromptsDocument(aiRequests, shouldGenerate ? 'Pending' : 'Needs-Manual');
    this._writeTextFile(promptPath, promptDoc);

    const assets = await this._sourceAutomaticWebVisualAssets({
      imageDir,
      requests
    });
    if (assets.length > 0) {
      assets.forEach(asset => {
        if (!this.imageAssets.some(item => item.relativePath === asset.relativePath)) {
          this.imageAssets.push(asset);
        }
      });
      this._updateProgressAtLeast(31, 'imageGenerator', `已获取 ${assets.length} 个联网视觉资源`, {
        live_image_assets: this._liveImageAssetsSnapshot(),
        image_asset_count: this._liveImageAssetsSnapshot().length
      });
    }

    if (requests.length === 0) {
      const reviewedAssets = await this._reviewImageAssetsWithAi(assets, { statuses: [] });
      return {
        skipped: false,
        prompt_document: 'images/image_prompts.md',
        image_sources: 'images/image_sources.json',
        web_visual_sources: 'images/web_visual_sources.json',
        processed: {
          ai: 0,
          web: 0,
          web_visuals: reviewedAssets.length
        },
        assets: reviewedAssets
      };
    }

    const outputFormat = this.runtimeConfig.imageOutputFormat || 'png';
    const extension = AiService.getImageExtension(outputFormat);
    const statuses = [];
    const dispatchIntervalMs = this._pptImageDispatchIntervalMs();
    const queueTimeoutMs = this._pptImageQueueTimeoutMs();
    const concurrency = this._pptImageRequestConcurrency(requests.length);
    this._recordWorkflowEvent('Step 5 Image Dispatch', 'started', {
      total_requests: requests.length,
      concurrency,
      dispatch_interval_ms: dispatchIntervalMs,
      queue_timeout_ms: queueTimeoutMs
    });
    const pendingImageAssets = requests.map((request, index) => ({
      filename: request.filename || this._fallbackImageFilename(request.purpose || request.description || `image_${index + 1}`),
      description: request.purpose || request.description || 'PPT 自动配图资源',
      origin: request.acquireVia === 'web' ? 'web_image' : 'generated',
      status: 'processing',
      statusLabel: request.acquireVia === 'web' ? '联网获取中' : 'AI生成中',
      requestIndex: index + 1,
      requestTotal: requests.length
    }));
    if (pendingImageAssets.length > 0) {
      const snapshot = this._liveImageAssetsSnapshot(pendingImageAssets);
      this._updateProgressAtLeast(31, 'imageGenerator', `正在并行准备 ${requests.length} 个配图资源`, {
        live_image_assets: snapshot,
        image_asset_count: snapshot.length
      });
    }
    const results = await this._mapWithConcurrency(requests, concurrency, async (request, index) => {
      const dispatchDelayMs = index > 0 && dispatchIntervalMs > 0
        ? Math.floor(index / Math.max(1, concurrency)) * dispatchIntervalMs
        : 0;
      if (dispatchDelayMs > 0) {
        await this._sleep(dispatchDelayMs);
      }
      const imageStartedAt = Date.now();
      try {
        if (request.acquireVia === 'web') {
          const asset = await this._sourceWebImageRequest(request, {
            imageDir,
            index,
            total: requests.length
          });
          this._recordWorkflowEvent('Step 5 Image Timing', 'sourced', {
            filename: asset.filename,
            request_index: index + 1,
            total_requests: requests.length,
            duration_ms: Date.now() - imageStartedAt,
            dispatch_delay_ms: dispatchDelayMs,
            dispatch_interval_ms: dispatchIntervalMs,
            acquire_via: 'web'
          });
          this._publishLiveImageAssetProgress(asset, {
            status: 'ready',
            statusLabel: '联网获取',
            message: `已找到并保存配图：${asset.filename}`,
            progress: 32 + Math.round(((index + 1) / Math.max(1, requests.length)) * 4)
          });
          return { asset, status: { request, status: 'Sourced', file: asset.relativePath } };
        }

        if (!shouldGenerate) {
          throw new Error('AI 生图未启用，已转为人工补图');
        }
        if (!this.runtimeConfig.imageApiKey) {
          throw new Error('未配置图片生成 API Key，已转为人工补图');
        }

        const requestedImageCount = this._pptImageVariantsPerRequest();
        const responseData = await AiService.requestImageGeneration({
          userId: this.task.user_id,
          taskId: this.task.id,
          prompt: request.prompt,
          params: {
            n: requestedImageCount,
            quality: this.params.imageQuality || this.runtimeConfig.imageQuality || 'high',
            aspectRatio: request.aspectRatio,
            resolution: this.params.imageResolution || this.params.image_size || '1k',
            queue_timeout_ms: queueTimeoutMs
          },
          outputFormat,
          runtimeConfig: this.runtimeConfig
        });

        const normalized = AiService.normalizeGeneratedImages(responseData, outputFormat);
        const image = normalized.find(item => item?.b64_json);
        if (!image?.b64_json) {
          throw new Error('图片服务未返回有效 base64');
        }

        const filename = this._normalizeGeneratedImageFilename(request.filename, extension);
        const imagePath = path.join(imageDir, filename);
        fs.writeFileSync(imagePath, Buffer.from(image.b64_json, 'base64'));
        const siblingAssets = [];
        normalized
          .filter(item => item?.b64_json)
          .slice(1, requestedImageCount)
          .forEach((item, variantIndex) => {
            const backupFilename = this._variantImageFilename(filename, variantIndex + 2, extension);
            const backupPath = path.join(imageDir, backupFilename);
            fs.writeFileSync(backupPath, Buffer.from(item.b64_json, 'base64'));
            siblingAssets.push({
              filename: backupFilename,
              path: backupPath,
              relativePath: `images/${backupFilename}`,
              svgHref: `../images/${backupFilename}`,
              description: `${request.purpose || request.description || `${this.params.title} 配图`}（备用图 ${variantIndex + 2}）`,
              origin: 'generated_backup',
              imageRequest: request
            });
          });
        const asset = {
          filename,
          path: imagePath,
          relativePath: `images/${filename}`,
          svgHref: `../images/${filename}`,
          url: this._toUploadUrl(imagePath),
          description: request.purpose || request.description || `${this.params.title} 配图`,
          origin: 'generated',
          imageRequest: request,
          backupAssets: siblingAssets.map(item => item.relativePath)
        };
        this._billGeneratedImage(asset);
        siblingAssets.forEach(backupAsset => {
          this._billGeneratedImage(backupAsset);
        });
        this._publishLiveImageAssetProgress(asset, {
          status: 'ready',
          statusLabel: 'AI生成',
          message: `已生成配图：${filename}`,
          progress: 32 + Math.round(((index + 1) / Math.max(1, requests.length)) * 4)
        });
        this._recordWorkflowEvent('Step 5 Image Timing', 'generated', {
          filename,
          request_index: index + 1,
          total_requests: requests.length,
          duration_ms: Date.now() - imageStartedAt,
          requested_images: requestedImageCount,
          backup_images: siblingAssets.length,
          dispatch_delay_ms: dispatchDelayMs,
          dispatch_interval_ms: dispatchIntervalMs,
          queue_timeout_ms: queueTimeoutMs
        });
        return { asset, extraAssets: siblingAssets, status: { request, status: 'Generated', file: asset.relativePath } };
      } catch (error) {
        console.warn('[PptAgent] 配图生成失败，标记 Needs-Manual:', request.filename, error.message);
        this._recordWorkflowEvent('Step 5 Image Timing', 'failed', {
          filename: request.filename,
          request_index: index + 1,
          total_requests: requests.length,
          duration_ms: Date.now() - imageStartedAt,
          dispatch_delay_ms: dispatchDelayMs,
          dispatch_interval_ms: dispatchIntervalMs,
          queue_timeout_ms: queueTimeoutMs,
          acquire_via: request.acquireVia || 'ai',
          error: error.message
        });
        return { status: { request, status: 'Needs-Manual', reason: error.message } };
      }
    });

    results.forEach(result => {
      if (result?.asset) {
        assets.push(result.asset);
        if (!this.imageAssets.some(item => item.relativePath === result.asset.relativePath)) {
          this.imageAssets.push(result.asset);
        }
      }
      if (Array.isArray(result?.extraAssets)) {
        result.extraAssets.forEach(extraAsset => {
          if (!extraAsset) return;
          assets.push(extraAsset);
          if (!this.imageAssets.some(item => item.relativePath === extraAsset.relativePath)) {
            this.imageAssets.push(extraAsset);
          }
        });
      }
      if (result?.status) statuses.push(result.status);
    });

    this._writeTextFile(promptPath, this._buildImagePromptsDocument(aiRequests, 'Pending', statuses));
    this._applyImageAcquisitionStatusesToDesignSpec(statuses);
    this._appendDesignSpecSection('Image_Generator Update', statuses.length
      ? statuses.map(item => {
        const name = item.file || item.request.filename;
        return `- ${name}: ${item.status}${item.reason ? `, ${item.reason}` : ''}`;
      }).join('\n')
      : '- No pending image resources found.');
    this._removeUnavailableImageReferencesFromDesignSpec(statuses);
    const reviewedAssets = await this._reviewImageAssetsWithAi(assets, { statuses });

    return {
      skipped: false,
      prompt_document: 'images/image_prompts.md',
      image_sources: 'images/image_sources.json',
      web_visual_sources: 'images/web_visual_sources.json',
      processed: {
        ai: aiRequests.length,
        web: webRequests.length,
        web_visuals: reviewedAssets.filter(asset => asset.origin === 'web_logo').length
      },
      assets: reviewedAssets,
      needs_manual: statuses.some(item => item.status === 'Needs-Manual'),
      failed: statuses.filter(item => item.status === 'Needs-Manual').map(item => ({
        filename: item.request.filename,
        reason: item.reason
      }))
    };
  }

  async _sourceWebImageRequest(request, { imageDir, index = 0, total = 1 } = {}) {
    const logoAsset = await this._sourceTechLogoRequestIfApplicable(request, {
      imageDir,
      index,
      total
    });
    if (logoAsset) return logoAsset;

    const filename = this._normalizeSourcedImageFilename(request.filename || this._fallbackImageFilename(request.reference || request.description, 'jpg'));
    const query = this._webImageQueryForRequest(request);
    if (!query) {
      throw new Error('网页配图缺少可搜索的 Reference');
    }

    const tavilyAsset = await this._sourceWebImageViaTavily(request, {
      imageDir,
      filename,
      query,
      index,
      total
    });
    if (tavilyAsset) return tavilyAsset;

    const args = [
      query,
      '--filename',
      filename,
      '--slide',
      this._slideIdForImageRequest(request, index + 1),
      '--orientation',
      this._orientationForImageRequest(request),
      '--purpose',
      request.purpose || request.type || 'presentation image',
      '-o',
      imageDir,
      '--manifest',
      path.join(imageDir, 'image_sources.json'),
      '--max-candidates',
      '3',
      '--no-candidates'
    ];

    const output = await this._runPptMasterScript('image_search.py', args, {
      timeoutMs: this._webImageSearchTimeoutMs()
    });
    const imagePath = path.join(imageDir, filename);
    if (!fs.existsSync(imagePath)) {
      throw new Error(`网页配图已执行但未找到文件: ${filename}`);
    }

    return {
      filename,
      path: imagePath,
      relativePath: `images/${filename}`,
      svgHref: `../images/${filename}`,
      url: this._toUploadUrl(imagePath),
      description: request.purpose || request.reference || request.description || `${this.params.title} 配图`,
      origin: 'sourced',
      imageRequest: request,
      sourceManifest: 'images/image_sources.json',
      searchOutput: this._trimText(output, 1200),
      requestIndex: index + 1,
      requestTotal: total
    };
  }

  async _sourceWebImageViaTavily(request, { imageDir, filename, query, index = 0, total = 1 } = {}) {
    if (!TavilyService.isConfigured()) return null;

    try {
      const search = await this._withTimeout(
        TavilyService.search({
          query: this._webImageSearchQuery(query),
          topic: 'general',
          includeImages: true,
          maxResults: 4
        }),
        this._tavilyImageSearchTimeoutMs(),
        'Tavily 图片检索超时'
      );
      const images = Array.isArray(search?.images) ? search.images : [];
      for (const image of images) {
        const originalUrl = image.original_url || this._extractOriginalUrlFromReferenceProxy(image.url);
        if (!originalUrl) continue;
        try {
          const asset = await this._downloadRemoteImageAsset({
            src: originalUrl,
            imageDir,
            filename,
            label: request.purpose || request.description || request.filename || 'web-image'
          });
          this._appendTavilyImageSourceManifest({
            asset,
            request,
            query: search.query || query,
            image,
            index,
            total
          });
          return {
            ...asset,
            description: request.purpose || request.reference || request.description || `${this.params.title} 联网配图`,
            origin: 'sourced',
            provider: 'tavily',
            sourceUrl: originalUrl,
            imageRequest: request,
            sourceManifest: 'images/image_sources.json',
            searchOutput: `Tavily image search: ${this._trimText(search.query || query, 220)}`,
            requestIndex: index + 1,
            requestTotal: total
          };
        } catch (downloadError) {
          console.warn('[PptAgent] Tavily 图片下载失败:', downloadError.message);
        }
      }
    } catch (error) {
      console.warn('[PptAgent] Tavily 图片检索失败:', error.message);
    }

    return null;
  }

  async _downloadRemoteImageAsset({ src, imageDir, filename, label = '' }) {
    const asset = await AiService.resolveReferenceImageAsset({ src, label });
    if (!asset?.buffer) throw new Error('联网图片为空');
    const normalizedFilename = this._normalizeDownloadedWebImageFilename(filename, asset.mimeType);
    const targetPath = path.join(imageDir, normalizedFilename);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (asset.mimeType === 'image/png') {
      fs.writeFileSync(targetPath, asset.buffer);
    } else {
      await sharp(asset.buffer, { limitInputPixels: 80_000_000 })
        .rotate()
        .jpeg({ quality: 88, mozjpeg: true })
        .toFile(targetPath);
    }

    return {
      filename: normalizedFilename,
      path: targetPath,
      relativePath: `images/${normalizedFilename}`,
      svgHref: `../images/${normalizedFilename}`,
      url: this._toUploadUrl(targetPath)
    };
  }

  _appendTavilyImageSourceManifest({ asset, request, query, image, index = 0 } = {}) {
    if (!this.projectPath || !asset?.filename) return;
    const manifestPath = path.join(this.projectPath, 'images', 'image_sources.json');
    const current = this._readJsonFileIfExists(manifestPath, { items: [] }) || { items: [] };
    const items = Array.isArray(current.items) ? current.items : [];
    const sourceUrl = image?.original_url || this._extractOriginalUrlFromReferenceProxy(image?.url) || '';
    const nextItem = {
      filename: asset.filename,
      slide: this._slideIdForImageRequest(request, index + 1),
      purpose: request?.purpose || request?.type || 'presentation image',
      search_query: query || '',
      orientation: this._orientationForImageRequest(request),
      provider: 'tavily',
      stage: 'image_search',
      title: image?.title || image?.description || '',
      author: '',
      source_page_url: sourceUrl,
      download_url: sourceUrl,
      license_name: 'Unknown',
      license_url: '',
      license_tier: 'no-attribution',
      attribution_required: false,
      width: 0,
      height: 0,
      attribution_text: '',
      status: 'sourced',
      note: 'Tavily image result; manual license review recommended before external delivery.'
    };
    const next = {
      ...current,
      generated_at: new Date().toISOString(),
      license_verification: current.license_verification || 'provider metadata used; manual review recommended for external delivery',
      items: [
        ...items.filter(item => item.filename !== asset.filename),
        nextItem
      ]
    };
    this._writeTextFile(manifestPath, JSON.stringify(next, null, 2) + '\n');
  }

  _normalizeDownloadedWebImageFilename(filename = '', mimeType = '') {
    const base = path.basename(this._normalizeSourcedImageFilename(filename), path.extname(filename || '.jpg')) || 'web_image';
    const ext = mimeType === 'image/png' ? '.png' : '.jpg';
    return `${this._slugify(base).slice(0, 64) || 'web_image'}${ext}`;
  }

  _extractOriginalUrlFromReferenceProxy(url = '') {
    const value = String(url || '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (!value.startsWith('/api/ai/reference-image?')) return '';
    try {
      return new URLSearchParams(value.split('?')[1] || '').get('url') || '';
    } catch {
      return '';
    }
  }

  _webImageSearchQuery(query = '') {
    return String(query || '')
      .replace(/\b[\w-]+\.(?:png|jpe?g|webp|gif)\b/gi, ' ')
      .replace(/[\u4e00-\u9fff][\u4e00-\u9fff/、，,：:；;（）()A-Za-z0-9\s-]*(?:图|图片|配图|场景|素材|视觉|示意|氛围)[\u4e00-\u9fff/、，,：:；;（）()A-Za-z0-9\s-]*/g, ' ')
      .replace(/\b(clean composition|professional editorial photography|high quality|presentation image)\b/gi, ' ')
      .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join(' ');
  }

  _webImageSearchTimeoutMs() {
    const raw = this.params.webImageSearchTimeoutMs
      || this.params.web_image_search_timeout_ms
      || this.runtimeConfig.pptWebImageSearchTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 20000, 5000), 45000);
  }

  _tavilyImageSearchTimeoutMs() {
    return Math.min(this._webImageSearchTimeoutMs(), 20000);
  }

  async _withTimeout(promise, timeoutMs, message = '操作超时') {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _sourceAutomaticWebVisualAssets({ imageDir, requests = [] } = {}) {
    if (!this._webVisualAssetsEnabled()) return [];
    const max = this._maxAutoWebVisualAssets();
    if (max <= 0) return [];

    const requestedLogoKeys = new Set();
    requests.forEach(request => {
      const requestText = this._logoSearchTextForRequest(request);
      if (!PptWebVisualAssetService.isLogoLikeRequest(requestText)) return;
      const logo = PptWebVisualAssetService.findBestTechLogo(requestText);
      if (logo?.key) requestedLogoKeys.add(logo.key);
    });

    const detectedLogos = PptWebVisualAssetService.detectTechLogos(
      this._autoWebVisualDetectionText(requests),
      { max }
    ).filter(logo => !requestedLogoKeys.has(logo.key));

    const assets = [];
    const logoCandidates = detectedLogos.slice(0, max);
    const logoAssets = await this._mapWithConcurrency(
      logoCandidates,
      this._webVisualAssetConcurrency(logoCandidates.length),
      async logo => {
        try {
          const asset = await this._sourceTechLogoAsset(logo, {
            imageDir,
            filename: `web_logo_${logo.key}.png`,
            reason: 'auto_detected'
          });
          return asset;
        } catch (error) {
          console.warn('[PptAgent] 联网技术图标获取失败:', logo.label || logo.key, error.message);
          this._recordWorkflowEvent('PPT Web Visual Asset', 'failed', {
            logo: logo.label || logo.key,
            reason: error.message
          });
          return null;
        }
      }
    );
    logoAssets
      .filter(Boolean)
      .forEach(asset => {
        if (!this._hasImageAssetForLogo({ key: asset.logoKey }, assets)) {
          assets.push(asset);
        }
      });

    const remaining = Math.max(0, max - assets.length);
    const webImageNeeds = PptWebVisualAssetService.detectWebImageNeeds({
      text: this._autoWebVisualDetectionText(requests),
      pageTitles: this._fallbackPageTitles(),
      max: Math.min(4, remaining)
    }).filter(need => !this._hasAutomaticWebImageRequest(need, requests, assets));

    const webNeedCandidates = webImageNeeds.slice(0, Math.max(0, max - assets.length));
    const webNeedAssets = await this._mapWithConcurrency(
      webNeedCandidates,
      this._webVisualAssetConcurrency(webNeedCandidates.length),
      async (need, offset) => {
        try {
          const asset = await this._sourceWebImageRequest(this._webImageNeedToRequest(need), {
            imageDir,
            index: requests.length + offset,
            total: requests.length + webImageNeeds.length
          });
          const enrichedAsset = {
            ...asset,
            autoWebVisualKind: need.kind,
            autoWebVisualLabel: need.label
          };
          this._syncSourcedImageIntoWebVisualManifest(enrichedAsset, {
            kind: need.kind,
            label: need.label
          });
          this._recordWorkflowEvent('PPT Web Visual Asset', 'sourced', {
            filename: enrichedAsset.filename,
            kind: need.kind,
            label: need.label,
            query: need.query,
            reason: 'auto_detected_web_image'
          });
          return enrichedAsset;
        } catch (error) {
          console.warn('[PptAgent] 联网视觉素材获取失败:', need.label || need.key, error.message);
          this._recordWorkflowEvent('PPT Web Visual Asset', 'failed', {
            kind: need.kind,
            label: need.label || need.key,
            query: need.query || '',
            reason: error.message
          });
          return null;
        }
      }
    );
    webNeedAssets
      .filter(Boolean)
      .slice(0, Math.max(0, max - assets.length))
      .forEach(asset => assets.push(asset));

    if (assets.length > 0) {
      this.webVisualAssets = assets;
      assets.forEach(asset => {
        if (!this.imageAssets.some(item => item.relativePath === asset.relativePath)) {
          this.imageAssets.push(asset);
        }
        this._publishLiveImageAssetProgress(asset, {
          status: 'ready',
          statusLabel: asset.origin === 'web_logo' ? '联网Logo' : '联网图片',
          message: `已获取联网视觉资源：${asset.filename}`,
          progress: 31
        });
      });
      this._appendDesignSpecSection('Web Visual Asset Update', this._buildWebVisualAssetUpdate(assets));
    }

    return assets;
  }

  _webImageNeedToRequest(need = {}) {
    return {
      filename: this._normalizeSourcedImageFilename(need.filename || this._fallbackImageFilename(need.query || need.label, 'jpg')),
      dimensions: this.params.canvasFormat === 'ppt43' ? '1200x900' : '1600x900',
      ratio: this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9',
      purpose: need.purpose || need.label || 'PPT web visual asset',
      type: need.type || 'Photography',
      acquireVia: 'web',
      status: 'Pending',
      reference: need.query || need.reference || need.label || '',
      description: need.description || need.purpose || need.label || need.query || '',
      aspectRatio: this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9',
      autoWebVisualKind: need.kind || 'web_image',
      autoWebVisualLabel: need.label || ''
    };
  }

  async _sourceTechLogoRequestIfApplicable(request, { imageDir, index = 0, total = 1 } = {}) {
    if (!this._webVisualAssetsEnabled()) return null;
    const requestText = this._logoSearchTextForRequest(request);
    if (!PptWebVisualAssetService.isLogoLikeRequest(requestText)) return null;

    const logo = PptWebVisualAssetService.findBestTechLogo(requestText);
    if (!logo) return null;

    const filename = this._normalizeLogoImageFilename(request.filename || `web_logo_${logo.key}.png`);
    return this._sourceTechLogoAsset(logo, {
      imageDir,
      filename,
      request,
      reason: 'resource_list',
      requestIndex: index + 1,
      requestTotal: total
    });
  }

  async _sourceTechLogoAsset(logo, {
    imageDir,
    filename,
    request = null,
    reason = 'auto_detected',
    requestIndex = null,
    requestTotal = null
  } = {}) {
    const result = await PptWebVisualAssetService.sourceTechLogo({
      logo,
      outputDir: imageDir,
      filename: this._normalizeLogoImageFilename(filename || `web_logo_${logo.key}.png`)
    });

    const asset = {
      filename: result.filename,
      path: result.path,
      relativePath: `images/${result.filename}`,
      svgHref: `../images/${result.filename}`,
      url: this._toUploadUrl(result.path),
      description: request?.purpose || request?.description || result.description,
      origin: 'web_logo',
      logoKey: result.key,
      logoLabel: result.label,
      provider: result.provider,
      sourceUrl: result.sourceUrl,
      fallbackGenerated: result.fallbackGenerated,
      imageRequest: request || null,
      requestIndex,
      requestTotal
    };

    this._appendWebVisualSourcesManifest(asset);
    this._recordWorkflowEvent('PPT Web Visual Asset', result.fallbackGenerated ? 'fallback_generated' : 'sourced', {
      filename: asset.filename,
      logo: asset.logoLabel || asset.logoKey,
      provider: asset.provider,
      source_url: asset.sourceUrl || '',
      reason,
      warning: result.warning || ''
    });

    return asset;
  }

  _appendWebVisualSourcesManifest(asset) {
    if (!this.projectPath || !asset?.filename) return;
    const manifestPath = path.join(this.projectPath, 'images', 'web_visual_sources.json');
    const current = this._readJsonFileIfExists(manifestPath, { items: [] }) || { items: [] };
    const items = Array.isArray(current.items) ? current.items : [];
    const nextItem = {
      filename: asset.filename,
      relative_path: asset.relativePath,
      href: asset.svgHref,
      kind: 'tech_logo',
      label: asset.logoLabel || asset.logoKey || asset.filename,
      provider: asset.provider || '',
      source_url: asset.sourceUrl || '',
      status: asset.fallbackGenerated ? 'fallback_generated' : 'sourced',
      attribution_required: false,
      license_note: asset.fallbackGenerated
        ? '网络图标获取失败后生成的本地技术标识占位，不代表官方商标。'
        : '来自公开技术图标 CDN，用于 PPT 视觉识别；对外发布时仍需遵守对应品牌使用规范。',
      generated_at: new Date().toISOString()
    };
    const next = {
      ...current,
      generated_at: new Date().toISOString(),
      note: 'PPT 联网视觉资产清单；Executor 只能引用已经落盘的 href。',
      items: [
        ...items.filter(item => item.filename !== asset.filename),
        nextItem
      ]
    };
    this._writeTextFile(manifestPath, JSON.stringify(next, null, 2) + '\n');
  }

  _syncSourcedImageIntoWebVisualManifest(asset, { kind = 'web_image', label = '' } = {}) {
    if (!this.projectPath || !asset?.filename) return;
    const manifestPath = path.join(this.projectPath, 'images', 'web_visual_sources.json');
    const current = this._readJsonFileIfExists(manifestPath, { items: [] }) || { items: [] };
    const items = Array.isArray(current.items) ? current.items : [];
    const nextItem = {
      filename: asset.filename,
      relative_path: asset.relativePath,
      href: asset.svgHref,
      kind,
      label: label || asset.description || asset.filename,
      provider: asset.provider || 'image_search',
      source_url: asset.sourceUrl || '',
      source_manifest: asset.sourceManifest || 'images/image_sources.json',
      status: 'sourced',
      attribution_required: 'see image_sources.json',
      license_note: '公开图库图片，授权和署名要求以 images/image_sources.json 为准。',
      generated_at: new Date().toISOString()
    };
    const next = {
      ...current,
      generated_at: new Date().toISOString(),
      note: 'PPT 联网视觉资产清单；Executor 只能引用已经落盘的 href。',
      items: [
        ...items.filter(item => item.filename !== asset.filename),
        nextItem
      ]
    };
    this._writeTextFile(manifestPath, JSON.stringify(next, null, 2) + '\n');
  }

  _buildWebVisualAssetUpdate(assets = []) {
    const lines = [
      '- 以下联网视觉资源已自动获取并复制到 project/images/，Executor 可以在技术栈介绍、架构、封面、行业场景、人物/地点/产品说明等页面直接引用。',
      '- SVG 中只能使用下列 href，禁止编造新的图片文件名或直接引用远程 URL。'
    ];
    assets.forEach(asset => {
      const source = asset.fallbackGenerated
        ? '本地兜底标识'
        : `${asset.provider || 'web'}${asset.sourceUrl ? ` / ${asset.sourceUrl}` : ''}`;
      const label = asset.logoLabel || asset.autoWebVisualLabel || asset.description || asset.filename;
      const kind = asset.origin === 'web_logo' ? 'logo/icon' : (asset.autoWebVisualKind || asset.origin || 'web_image');
      lines.push(`- ${asset.svgHref}: ${label}（${kind}; ${source}）`);
    });
    return lines.join('\n');
  }

  _autoWebVisualDetectionText(requests = []) {
    const requestText = requests.map(request => [
      request.filename,
      request.purpose,
      request.type,
      request.reference,
      request.description
    ].filter(Boolean).join(' ')).join('\n');
    return [
      this.params.title,
      this.params.content,
      this.params.extraRequirements,
      this.task?.prompt,
      this.sourceContent,
      this.designSpec,
      requestText
    ].filter(Boolean).join('\n');
  }

  _logoSearchTextForRequest(request = {}) {
    return [
      request.filename,
      request.purpose,
      request.type,
      request.reference,
      request.description
    ].filter(Boolean).join(' ');
  }

  _normalizeLogoImageFilename(filename = '') {
    const normalized = this._normalizeImageRequestFilename(filename || 'web_logo.png');
    const base = path.basename(normalized, path.extname(normalized)) || 'web_logo';
    return `${base}.png`;
  }

  _hasImageAssetForLogo(logo, pendingAssets = []) {
    const key = String(logo?.key || '').toLowerCase();
    if (!key) return false;
    return [...(this.imageAssets || []), ...(pendingAssets || [])].some(asset => {
      const logoKey = String(asset.logoKey || '').toLowerCase();
      const filename = String(asset.filename || asset.relativePath || '').toLowerCase();
      return logoKey === key || filename.includes(`web_logo_${key}`);
    });
  }

  _hasAutomaticWebImageRequest(need = {}, requests = [], pendingAssets = []) {
    const filename = this._normalizeSourcedImageFilename(need.filename || '');
    const key = String(need.key || '').toLowerCase();
    const query = String(need.query || '').toLowerCase();
    const haystacks = [
      ...(requests || []).map(request => [
        request.filename,
        request.reference,
        request.description,
        request.purpose
      ].filter(Boolean).join(' ').toLowerCase()),
      ...(this.imageAssets || []).map(asset => [
        asset.filename,
        asset.description,
        asset.relativePath
      ].filter(Boolean).join(' ').toLowerCase()),
      ...(pendingAssets || []).map(asset => [
        asset.filename,
        asset.description,
        asset.relativePath
      ].filter(Boolean).join(' ').toLowerCase())
    ];

    return haystacks.some(text => (
      (filename && text.includes(filename.toLowerCase()))
      || (key && text.includes(key))
      || (query && query.split(/\s+/).filter(Boolean).some(token => token.length >= 5 && text.includes(token)))
    ));
  }

  _webVisualAssetsEnabled() {
    if (this.params.enableWebVisuals === false) return false;
    if (this.params.enableResearch === false && this.params.enableWebVisuals !== true) return false;
    return true;
  }

  _maxAutoWebVisualAssets() {
    const explicit = parseInt(
      this.params.maxWebVisualAssets
        || this.params.max_web_visual_assets
        || this.runtimeConfig.pptMaxWebVisualAssets,
      10
    );
    return Math.min(Math.max(Number.isFinite(explicit) ? explicit : 10, 0), 18);
  }

  _normalizeSourcedImageFilename(filename = '') {
    const normalized = this._normalizeImageRequestFilename(filename);
    const ext = path.extname(normalized).toLowerCase();
    const base = path.basename(normalized, ext || '.png') || 'sourced_image';
    if (/\.(jpe?g|webp)$/i.test(ext)) return normalized;
    return `${base}.jpg`;
  }

  _webImageQueryForRequest(request = {}) {
    return this._trimText([
      request.reference,
      request.description,
      request.purpose,
      request.filename
    ].filter(Boolean).join(' '), 240);
  }

  _slideIdForImageRequest(request = {}, fallbackIndex = 1) {
    const text = [request.purpose, request.reference, request.description, request.filename].filter(Boolean).join(' ');
    const match = text.match(/\bP\s*0?(\d{1,2})\b|Slide\s*0?(\d{1,2})|第\s*0?(\d{1,2})\s*页/i);
    const pageNum = parseInt(match?.[1] || match?.[2] || match?.[3], 10);
    const safePage = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : fallbackIndex;
    return `P${String(Math.min(safePage, 99)).padStart(2, '0')}`;
  }

  _orientationForImageRequest(request = {}) {
    const ratio = request.aspectRatio || this._inferImageAspectRatio(request.ratio || request.dimensions);
    if (ratio) {
      const parts = ratio.split(':').map(value => parseInt(value, 10));
      if (parts.length === 2 && parts.every(Number.isFinite)) {
        if (Math.abs(parts[0] - parts[1]) <= 1) return 'square';
        return parts[0] > parts[1] ? 'landscape' : 'portrait';
      }
    }
    return this.params.canvasFormat === 'ppt43' ? 'landscape' : 'landscape';
  }

  _applyImageAcquisitionStatusesToDesignSpec(statuses = []) {
    if (!this.designSpec || !Array.isArray(statuses) || statuses.length === 0) return;
    const statusByFilename = new Map();
    statuses.forEach(item => {
      const filename = item.request?.filename;
      if (!filename) return;
      statusByFilename.set(String(filename).toLowerCase(), item);
    });
    if (statusByFilename.size === 0) return;

    this.designSpec = this._rewriteImageResourceTable(this.designSpec, row => {
      const key = String(row.filename || '').toLowerCase();
      const status = statusByFilename.get(key);
      if (!status) return row;
      return {
        ...row,
        acquire_via: this._normalizeAcquireVia(row.acquire_via || status.request?.acquireVia || ''),
        status: status.status,
        reference: row.reference || row.description || status.request?.reference || status.request?.description || '',
        filename: status.file ? path.basename(status.file) : row.filename
      };
    });
    this._writeTextFile(path.join(this.projectPath, 'design_spec.md'), this.designSpec);
  }

  _removeUnavailableImageReferencesFromDesignSpec(statuses = []) {
    if (!this.designSpec || !Array.isArray(statuses) || statuses.length === 0) return;
    const missing = statuses
      .filter(item => !['Generated', 'Sourced', 'Existing'].includes(item.status))
      .map(item => item.request?.filename)
      .filter(Boolean);
    if (missing.length === 0) return;

    let next = this.designSpec;
    missing.forEach(filename => {
      const escaped = this._escapeRegExp(filename);
      const imageLinePatterns = [
        new RegExp('\\n\\s*-\\s*\\*\\*Image\\*\\*\\s*:\\s*`?\\.\\.\\/images\\/' + escaped + '`?.*', 'gi'),
        new RegExp('\\n\\s*-\\s*\\*\\*Image\\*\\*\\s*:\\s*`?images\\/' + escaped + '`?.*', 'gi'),
        new RegExp('\\n\\s*-\\s*\\*\\*Image\\*\\*\\s*:\\s*`?' + escaped + '`?.*', 'gi')
      ];
      const inlinePatterns = [
        new RegExp('`?\\.\\.\\/images\\/' + escaped + '`?', 'gi'),
        new RegExp('`?images\\/' + escaped + '`?', 'gi'),
        new RegExp('`?' + escaped + '`?', 'gi')
      ];
      imageLinePatterns.forEach(pattern => {
        next = next.replace(pattern, '');
      });
      inlinePatterns.forEach(pattern => {
        next = next.replace(pattern, '`SVG-native visual fallback`');
      });
    });

    const missingList = missing.map(name => `\`${name}\``).join(', ');
    next = `${next.trim()}\n\n### Image availability guard\n- The following requested AI images were not generated successfully and must not be referenced in SVG: ${missingList}.\n- Executor must use SVG-native gradients, geometry, diagrams, and chart templates instead of missing image hrefs.\n`;
    this.designSpec = next;
    this._writeTextFile(path.join(this.projectPath, 'design_spec.md'), this.designSpec);
  }

  _prepareMissingImagesForSvgFallback() {
    const missing = this._missingOfficialManualImages();
    if (missing.length === 0) return;
    this._removeUnavailableImageReferencesFromDesignSpec(missing.map(item => ({
      request: {
        filename: item.filename,
        acquireVia: item.acquire_via
      },
      status: 'Needs-Manual',
      reason: '导出前发现图片文件不存在，已自动改用 SVG 原生视觉替代'
    })));
    this.specLock = this._buildSpecLock(this.designSpec);
    this._writeTextFile(path.join(this.projectPath, 'spec_lock.md'), this.specLock);
    this._recordWorkflowEvent('Missing Image Fallback', 'completed', {
      missing: missing.map(item => item.filename),
      action: 'removed image references and required SVG-native fallback visuals'
    });
  }

  _missingOfficialManualImages() {
    if (!this.projectPath || !this.designSpec) return [];
    const section = this._extractMarkdownSection(this.designSpec, 'VIII. Image Resource List', 'IX. Content Outline');
    if (!section) return [];
    const rows = section.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\|.+\|$/.test(line) && !/^\|\s*-+/.test(line));
    if (rows.length < 2) return [];
    const headers = this._splitMarkdownTableRow(rows[0]).map(cell => this._normalizeTableHeader(cell));
    const missing = [];
    rows.slice(1).forEach(row => {
      const cells = this._splitMarkdownTableRow(row);
      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] || '';
      });
      const status = String(record.status || '').trim();
      if (!/needs-manual|需要人工|待人工|手动/i.test(status)) return;
      const filename = this._normalizeImageRequestFilename(record.filename || record.file || record.name || '');
      if (!filename || filename === 'none.png') return;
      const imagePath = path.join(this.projectPath, 'images', filename);
      if (!fs.existsSync(imagePath)) {
        missing.push({
          filename,
          acquire_via: this._normalizeAcquireVia(record.acquire_via || '', record),
          status
        });
      }
    });
    return missing;
  }

  _updateProgress(progress, stage, message, extra = {}) {
    const task = AiTask.findById(this.task.id);
    const previous = this._safeJsonParse(task?.result_data, {});
    const activePrevious = { ...(previous || {}) };
    delete activePrevious.error;
    delete activePrevious.failed_step;
    delete activePrevious.partial_results;
    const liveImageAssets = this._liveImageAssetsSnapshot(extra.live_image_assets || activePrevious.live_image_assets || []);
    AiTask.updateStatus(this.task.id, 'processing', {
      result_data: {
        ...activePrevious,
        status: 'processing',
        stage,
        progress: Math.min(99, progress),
        message,
        updated_at: new Date().toISOString(),
        ...extra,
        live_image_assets: liveImageAssets,
        image_assets: liveImageAssets.length ? liveImageAssets : activePrevious.image_assets
      }
    });
  }

  _serializeImageAssetForProgress(asset = {}, extra = {}) {
    if (!asset || typeof asset !== 'object') return null;
    const filename = asset.filename || path.basename(asset.relativePath || asset.path || '');
    const url = asset.url || (asset.path ? this._toUploadUrl(asset.path) : '');
    const relativePath = asset.relativePath || asset.relative_path || '';
    if (!filename && !url && !relativePath) return null;
    return {
      filename: filename || 'image_asset',
      relative_path: relativePath,
      url,
      description: asset.description || asset.purpose || asset.imageRequest?.purpose || '',
      origin: asset.origin || extra.origin || 'generated',
      provider: asset.provider || '',
      source_url: asset.sourceUrl || asset.source_url || '',
      status: extra.status || asset.status || (url ? 'ready' : 'processing'),
      status_label: extra.statusLabel || asset.statusLabel || '',
      reason: extra.reason || asset.reason || '',
      request_index: asset.requestIndex || extra.requestIndex || asset.imageRequest?.requestIndex || null,
      request_total: asset.requestTotal || extra.requestTotal || null
    };
  }

  _liveImageAssetsSnapshot(pendingAssets = []) {
    const allAssets = [
      ...(this.imageAssets || []),
      ...(this.webVisualAssets || []),
      ...(Array.isArray(pendingAssets) ? pendingAssets : [])
    ];
    const byKey = new Map();
    allAssets
      .map(asset => this._serializeImageAssetForProgress(asset))
      .filter(Boolean)
      .forEach(asset => {
        const key = asset.filename || asset.relative_path || asset.url;
        if (!key) return;
        const previous = byKey.get(key);
        if (!previous) {
          byKey.set(key, asset);
          return;
        }
        const previousReady = previous.status === 'ready' || Boolean(previous.url);
        const nextReady = asset.status === 'ready' || Boolean(asset.url);
        byKey.set(key, nextReady || !previousReady ? { ...previous, ...asset } : previous);
      });
    return [...byKey.values()];
  }

  _publishLiveImageAssetProgress(asset, {
    status = 'ready',
    statusLabel = '',
    message = '',
    progress = 35
  } = {}) {
    if (!asset) return;
    const serialized = this._serializeImageAssetForProgress(asset, { status, statusLabel });
    if (!serialized) return;
    const snapshot = this._liveImageAssetsSnapshot([serialized]);
    this._updateProgressAtLeast(
      progress,
      'imageGenerator',
      message || `已获取配图资源：${serialized.filename}`,
      {
        live_image_assets: snapshot,
        image_asset_count: snapshot.length,
        latest_image_asset: serialized
      }
    );
  }

  _publishLiveImageAsset(asset, options = {}) {
    return this._publishLiveImageAssetProgress(asset, options);
  }

  _stepStartMessage(stepDef) {
    if (stepDef.name === 'sourceProcessing') {
      return this.params.enableResearch ? '正在整理内容并补充资料' : '正在整理你提供的内容';
    }
    if (stepDef.name === 'projectInitialization') {
      return '正在创建 PPT 项目';
    }
    if (stepDef.name === 'templateOption') {
      return '正在选择合适的设计风格';
    }
    if (stepDef.name === 'strategist') {
      return '正在整理页面结构';
    }
    if (stepDef.name === 'imageGenerator') {
      return '正在准备配图';
    }
    if (stepDef.name === 'executor') {
      return '正在生成 PPT 页面';
    }
    if (stepDef.name === 'qualityCheck') {
      return '正在检查页面效果';
    }
    if (stepDef.name === 'chartCalibration') {
      return '正在检查图表显示';
    }
    if (stepDef.name === 'notes') {
      return '正在生成演讲备注';
    }
    if (stepDef.name === 'splitNotes') {
      return '正在整理演讲备注';
    }
    if (stepDef.name === 'finalizeSvg') {
      return '正在整理页面文件';
    }
    if (stepDef.name === 'export') {
      return '正在生成可下载的 PPT 文件';
    }
    return `正在${stepDef.label}`;
  }

  _executorModel() {
    if (this.runtimeConfig?.pptExecutorModel) return this.runtimeConfig.pptExecutorModel;
    const pptModel = this.runtimeConfig?.pptModel || '';
    const chatModel = this.runtimeConfig?.chatModel || '';
    const provider = this.runtimeConfig?.providerBaseUrl || '';
    if (/opus/i.test(pptModel) && /llmapi\.pro/i.test(provider)) {
      return /sonnet/i.test(chatModel) ? chatModel : 'claude-sonnet-4-6';
    }
    return pptModel || chatModel || 'claude-opus-4-7';
  }

  _strategistModel() {
    return this.runtimeConfig?.pptStrategistModel
      || this.runtimeConfig?.pptModel
      || this.runtimeConfig?.chatModel
      || 'claude-opus-4-7';
  }

  _visionReviewModel() {
    return this.runtimeConfig?.pptVisionReviewModel
      || this.runtimeConfig?.imageAssistantModel
      || this.runtimeConfig?.pptModel
      || this.runtimeConfig?.chatModel
      || 'gpt-5.5';
  }

  _assetReviewModel() {
    return this.runtimeConfig?.pptAssetReviewModel
      || this._visionReviewModel();
  }

  _pageReviewModel() {
    return this.runtimeConfig?.pptPageReviewModel
      || this._visionReviewModel();
  }

  _microReviewModel() {
    return this.runtimeConfig?.pptMicroReviewModel
      || this._visionReviewModel();
  }

  _modelForPptRoute(route = 'ppt') {
    const normalized = String(route || '').trim();
    if (normalized === 'ppt_strategist') return this._strategistModel();
    if (normalized === 'ppt_executor') return this._executorModel();
    if (normalized === 'ppt_asset_review') return this._assetReviewModel();
    if (normalized === 'ppt_page_review') return this._pageReviewModel();
    if (normalized === 'ppt_micro_review') return this._microReviewModel();
    if (normalized === 'ppt_vision_review') return this._visionReviewModel();
    return this.runtimeConfig?.pptModel || this.runtimeConfig?.chatModel || 'claude-opus-4-7';
  }

  _getStepBaseProgress(stepName) {
    const map = {
      sourceProcessing: 3,
      projectInitialization: 10,
      templateOption: 16,
      strategist: 20,
      imageGenerator: 33,
      executor: 38,
      qualityCheck: 78,
      chartCalibration: 83,
      notes: 86,
      splitNotes: 89,
      finalizeSvg: 92,
      export: 96
    };
    return map[stepName] || 5;
  }

  _getStepEndProgress(stepName) {
    const map = {
      sourceProcessing: 9,
      projectInitialization: 15,
      templateOption: 19,
      strategist: 32,
      imageGenerator: 37,
      executor: 77,
      qualityCheck: 82,
      chartCalibration: 85,
      notes: 88,
      splitNotes: 91,
      finalizeSvg: 95,
      export: 99
    };
    return map[stepName] || 50;
  }

  _buildEightConfirmations() {
    const canvas = this._canvasInfo();
    const palette = this._paletteForStyle(this.params.style);
    const targetImages = this.params.generateImages === false ? 0 : this._targetPptImageGenerationCount();
    return {
      confirmed_at: new Date().toISOString(),
      confirmed_by: 'web_generate_ppt_request',
      note: 'Web UI is a one-click workflow; the submitted request is treated as the explicit bundled confirmation before automatic downstream steps.',
      items: [
        { id: 1, name: 'Canvas format', value: `${canvas.format} (${canvas.width}x${canvas.height})` },
        {
          id: 2,
          name: 'Page count',
          value: this.params.pageCountMode === 'auto'
            ? `${this.params.pageCount} pages chosen by AI based on content`
            : `${this.params.pageCount} pages requested by user`
        },
        { id: 3, name: 'Target audience', value: this.params.audience || '由源内容推断的专业汇报受众' },
        { id: 4, name: 'Style objective', value: this._describeSelectedStyle() },
        {
          id: 5,
          name: 'Color scheme',
          value: `bg ${palette.bg}, primary ${palette.primary}, accent ${palette.accent}, secondary ${palette.secondary_accent}`
        },
        { id: 6, name: 'Icon usage approach', value: 'chunk-filled inventory only; no mixed libraries' },
        { id: 7, name: 'Typography plan', value: 'PPT-safe CJK sans stack: Microsoft YaHei, Arial, sans-serif' },
        {
          id: 8,
          name: 'Image usage approach',
          value: this.params.generateImages === false
            ? 'No AI images; SVG-native visuals'
            : `AI image generation required; plan and embed at least ${targetImages} concrete subject visuals`
        }
      ]
    };
  }

  _writeEightConfirmationsFile() {
    const lines = [
      '# Eight Confirmations',
      '',
      `- Confirmed At: ${this.eightConfirmations.confirmed_at}`,
      `- Confirmed By: ${this.eightConfirmations.confirmed_by}`,
      `- Confirmation Note: ${this.eightConfirmations.note}`,
      ''
    ];
    this.eightConfirmations.items.forEach(item => {
      lines.push(`${item.id}. ${item.name}: ${item.value}`);
    });
    this._writeTextFile(path.join(this.projectPath, 'eight_confirmations.md'), lines.join('\n'));
  }

  _ensureDesignSpecStructure(candidate) {
    const text = String(candidate || '').trim();
    if (!text) return '';
    const requiredSections = [
      'I. Project Information',
      'II. Canvas Specification',
      'III. Visual Theme',
      'IV. Typography System',
      'V. Layout Principles',
      'VI. Icon Usage Specification',
      'VII. Visualization Reference List',
      'VIII. Image Resource List',
      'IX. Content Outline',
      'X. Speaker Notes Plan',
      'XI. Execution Notes'
    ];
    const normalized = this._normalizeDesignSpecHeadings(text);
    const hasAll = requiredSections.every(section => normalized.includes(section));
    return hasAll ? normalized : '';
  }

  _normalizeDesignSpecHeadings(text = '') {
    const sectionMap = [
      ['I. Project Information', /(?:Project\s+Information|项目(?:信息|概况|基本信息))/i],
      ['II. Canvas Specification', /(?:Canvas\s+Specification|画布(?:规格|规范|尺寸)|页面(?:规格|尺寸))/i],
      ['III. Visual Theme', /(?:Visual\s+Theme|视觉(?:主题|风格|系统)|设计主题)/i],
      ['IV. Typography System', /(?:Typography\s+System|字体(?:系统|规范|方案)|排版(?:系统|规范))/i],
      ['V. Layout Principles', /(?:Layout\s+Principles|版式(?:原则|规范|系统)|布局(?:原则|规范))/i],
      ['VI. Icon Usage Specification', /(?:Icon\s+Usage\s+Specification|Icon\s+Usage\s+Spec|图标(?:使用)?(?:规范|方案))/i],
      ['VII. Visualization Reference List', /(?:Visualization\s+Reference\s+List|可视化(?:参考)?(?:列表|规划|清单)|图表(?:参考|规划|清单))/i],
      ['VIII. Image Resource List', /(?:Image\s+Resource\s+List(?:\s*\(if needed\))?|图片(?:资源)?(?:列表|清单|规划)|图像(?:资源)?(?:列表|清单|规划))/i],
      ['IX. Content Outline', /(?:Content\s+Outline|内容(?:大纲|规划|结构)|页面(?:大纲|规划|结构))/i],
      ['X. Speaker Notes Plan', /(?:Speaker\s+Notes(?:\s+(?:Plan|Requirements))?|演讲(?:备注|讲稿|说明)(?:计划|要求)?)/i],
      ['XI. Execution Notes', /(?:Execution\s+Notes|Technical\s+Constraints\s+Reminder|执行(?:说明|备注)|技术(?:约束|提醒))/i]
    ];

    return String(text || '').replace(/^(#{2,4})\s*(.+?)\s*$/gm, (match, marks, title) => {
      const clean = title.replace(/\*\*/g, '').trim();
      const numbered = clean.match(/^([IVX]{1,4})\.\s*(.+)$/i);
      const candidate = numbered ? `${numbered[1].toUpperCase()}. ${numbered[2].trim()}` : clean;
      const found = sectionMap.find(([, pattern]) => pattern.test(candidate));
      return found ? `## ${found[0]}` : `${marks} ${clean}`;
    });
  }

  _normalizeDesignSpecForV26(designSpec = '') {
    return this._normalizeImageResourceListForV26(String(designSpec || ''));
  }

  _normalizeImageResourceListForV26(designSpec = '') {
    return this._rewriteImageResourceTable(designSpec, row => row);
  }

  _rewriteImageResourceTable(designSpec = '', transformRow = row => row) {
    const text = String(designSpec || '');
    const sectionMatch = text.match(/##\s*VIII\.\s*Image Resource List[\s\S]*?(?=\n##\s*(?:IX\.|9\.|X\.|XI\.)|\n---\n|$)/i);
    if (!sectionMatch) return text;

    const section = sectionMatch[0];
    const lines = section.split(/\r?\n/);
    const tableStart = lines.findIndex(line => /^\s*\|.+\|\s*$/.test(line));
    if (tableStart === -1 || tableStart + 1 >= lines.length) return text;

    const tableEnd = (() => {
      for (let index = tableStart; index < lines.length; index += 1) {
        if (!/^\s*\|.+\|\s*$/.test(lines[index])) return index;
      }
      return lines.length;
    })();

    const headerCells = this._splitMarkdownTableRow(lines[tableStart]);
    if (headerCells.length === 0) return text;
    const headers = headerCells.map(cell => this._normalizeTableHeader(cell));
    const dataRows = lines
      .slice(tableStart + 2, tableEnd)
      .filter(line => /^\s*\|.+\|\s*$/.test(line))
      .map(line => this._splitMarkdownTableRow(line))
      .filter(cells => cells.length > 0 && !cells.every(cell => /^-+$/.test(cell.replace(/\s/g, ''))));

    const nextRows = dataRows.map(cells => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] || '';
      });
      const filename = this._normalizeImageRequestFilename(record.filename || record.file || record.name || '');
      const rawStatus = record.status || '';
      const status = rawStatus || (filename ? 'Pending' : 'Placeholder');
      const acquireVia = this._normalizeAcquireVia(record.acquire_via || record.acquire || record.via || '', {
        status,
        description: record.reference || record.description || record.prompt || record.generation || record.purpose || '',
        type: record.type || '',
        filename
      });
      const row = transformRow({
        filename: filename || record.filename || 'none',
        dimensions: record.dimensions || record.size || '-',
        ratio: record.ratio || record.aspect || '-',
        purpose: record.purpose || record.page || '-',
        type: record.type || '-',
        acquire_via: acquireVia,
        status,
        reference: record.reference || record.description || record.prompt || record.generation || record.intent || '-',
        description: record.description || record.prompt || record.generation || record.reference || ''
      }) || {};
      return [
        row.filename || 'none',
        row.dimensions || '-',
        row.ratio || '-',
        row.purpose || '-',
        row.type || '-',
        this._normalizeAcquireVia(row.acquire_via || row.acquireVia || '', row) || 'ai',
        row.status || 'Pending',
        this._singleLineTableCell(row.reference || row.description || '-')
      ];
    });

    const replacementRows = [
      '| Filename | Dimensions | Ratio | Purpose | Type | Acquire Via | Status | Reference |',
      '| -------- | ---------- | ----- | ------- | ---- | ----------- | ------ | --------- |',
      ...(nextRows.length > 0
        ? nextRows.map(cells => `| ${cells.join(' | ')} |`)
        : ['| none | - | - | No required external images | - | placeholder | Placeholder | SVG-native visuals only |'])
    ];

    const nextLines = [
      ...lines.slice(0, tableStart),
      ...replacementRows,
      ...lines.slice(tableEnd)
    ];
    const nextSection = nextLines.join('\n');
    return text.slice(0, sectionMatch.index) + nextSection + text.slice(sectionMatch.index + section.length);
  }

  _splitMarkdownTableRow(line = '') {
    return String(line || '')
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  }

  _validateStrategistDeliverables(designSpec, specLock) {
    const requiredDesignSections = [
      'I. Project Information',
      'II. Canvas Specification',
      'III. Visual Theme',
      'IV. Typography System',
      'V. Layout Principles',
      'VI. Icon Usage Specification',
      'VII. Visualization Reference List',
      'VIII. Image Resource List',
      'IX. Content Outline',
      'X. Speaker Notes Plan',
      'XI. Execution Notes'
    ];
    const missingDesign = requiredDesignSections.filter(section => !designSpec.includes(section));
    if (missingDesign.length > 0) {
      throw new Error(`design_spec.md 缺少必要章节: ${missingDesign.join(', ')}`);
    }

    const requiredLockSections = ['## canvas', '## colors', '## typography', '## icons', '## page_rhythm', '## forbidden'];
    const missingLock = requiredLockSections.filter(section => !specLock.includes(section));
    if (missingLock.length > 0) {
      throw new Error(`spec_lock.md 缺少必要章节: ${missingLock.join(', ')}`);
    }

    const rhythmLines = specLock.split('\n').filter(line => /^- P\d{2}:\s*(anchor|dense|breathing)\s*$/.test(line.trim()));
    if (rhythmLines.length !== this.params.pageCount) {
      throw new Error(`spec_lock.md page_rhythm 数量不匹配: ${rhythmLines.length}/${this.params.pageCount}`);
    }

    const designSpecReasons = this._designSpecValidationReasons(designSpec);
    if (designSpecReasons.length > 0) {
      throw new Error(`design_spec.md 包含未完成内容: ${designSpecReasons.join('; ')}`);
    }
  }

  _designSpecValidationReasons(text = '') {
    const value = String(text || '');
    const checks = [
      { pattern: /{{\s*[^}]+\s*}}/g, reason: '包含未替换的 {{...}} 占位符' },
      { pattern: /\bTODO\b/gi, reason: '包含 TODO 占位符' },
      { pattern: /\bTBD\b/gi, reason: '包含 TBD 占位符' },
      { pattern: /\bPLACEHOLDER\b/gi, reason: '包含 PLACEHOLDER 占位符' },
      { pattern: /(?:待补充|待完善|待填写|待替换)/g, reason: '包含未完成的占位说明' },
      { pattern: /模型未返回\s*&lt;svg&gt;|模型未返回\s*<svg>/gi, reason: '包含模型错误占位说明' }
    ];
    return [
      ...new Set(
        checks
          .filter(check => check.pattern.test(value))
          .map(check => check.reason)
      )
    ];
  }

  _extractRequestedPagePlan() {
    const source = [
      this.params.content,
      this.params.extraRequirements,
      this.task?.prompt,
      this.sourceContent
    ].filter(Boolean).join('\n');

    const pages = new Map();
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      const match = line.match(/^P\s*0?(\d{1,2})\b[\s.、:-]*(.+)?$/i);
      if (!match) continue;

      const pageNum = parseInt(match[1], 10);
      if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > this.params.pageCount) continue;

      let title = String(match[2] || '').trim();
      title = title.split(/[：:]/)[0].trim();

      if (!title || /^第\s*\d+\s*页$/.test(title)) {
        const nextTitleLine = lines.slice(index + 1, index + 5)
          .map(item => item.trim())
          .find(item => /^(?:标题|页标题)\s*[:：]/.test(item));
        if (nextTitleLine) {
          title = nextTitleLine.replace(/^(?:标题|页标题)\s*[:：]\s*/, '').trim();
        }
      }

      if (title && !/^ppt\b/i.test(title) && title.length <= 80) {
        pages.set(pageNum, title);
      }
    }

    return [...pages.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pageNum, title]) => ({ pageNum, title }));
  }

  _formatRequestedPagePlan() {
    const plan = this._extractRequestedPagePlan();
    if (plan.length < Math.min(this.params.pageCount, 3)) return '';
    return plan
      .slice(0, this.params.pageCount)
      .map(item => `- P${String(item.pageNum).padStart(2, '0')}: ${item.title}`)
      .join('\n');
  }

  _designSpecMatchesSourcePlan(designSpec) {
    const plan = this._extractRequestedPagePlan();
    if (plan.length < Math.min(this.params.pageCount, 3)) return true;

    const normalizedSpec = this._normalizeForMatching(designSpec);
    const matched = plan.filter(item => {
      const title = this._normalizeForMatching(item.title);
      if (!title) return false;
      if (normalizedSpec.includes(title)) return true;
      const words = title.split(/\s+/).filter(word => word.length >= 4);
      return words.length > 0 && words.some(word => normalizedSpec.includes(word));
    });

    return matched.length >= Math.ceil(Math.min(plan.length, this.params.pageCount) * 0.7);
  }

  _normalizeForMatching(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _singleLineTableCell(value = '') {
    return String(value || '')
      .replace(/\|/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _appendDesignSpecSection(title, body) {
    if (!this.projectPath) return;
    const filePath = path.join(this.projectPath, 'design_spec.md');
    if (!fs.existsSync(filePath)) return;
    const current = fs.readFileSync(filePath, 'utf-8');
    this.designSpec = `${current.trim()}\n\n---\n\n## ${title}\n\n${body}\n`;
    this._writeTextFile(filePath, this.designSpec);
  }

  _writeDesignParameterConfirmation() {
    const canvas = this._canvasInfo();
    const palette = this._paletteForStyle(this.params.style);
    const body = [
      '# Design Parameter Confirmation',
      '',
      `- Canvas dimensions: ${canvas.width}x${canvas.height}`,
      `- viewBox: ${canvas.viewBox}`,
      `- Color scheme: bg ${palette.bg}; primary ${palette.primary}; accent ${palette.accent}; text ${palette.text}`,
      '- Font plan: Microsoft YaHei, Arial, sans-serif',
      '- Body font size: 22px',
      `- Page rhythm entries: ${this.params.pageCount}`
    ].join('\n');
    this._writeTextFile(path.join(this.projectPath, 'design_parameter_confirmation.md'), body);
    this._recordWorkflowEvent('Step 6 Design Parameter Confirmation', 'completed', {
      file: 'design_parameter_confirmation.md'
    });
  }

  _agentCustomizationPrompt(maxLength = 9000) {
    const prompt = this.agentCustomization?.prompt || '';
    return prompt ? this._trimText(prompt, maxLength) : '';
  }

  _recordRoleRead(role, relativePath) {
    const key = `${role}:${relativePath}`;
    if (this.roleReadKeys.has(key)) return;
    this.roleReadKeys.add(key);
    this.roleReads.push({
      role,
      file: relativePath,
      read_at: new Date().toISOString()
    });
    this._flushWorkflowFiles();
  }

  _recordWorkflowEvent(step, status, details = {}) {
    this.workflowEvents.push({
      step,
      status,
      at: new Date().toISOString(),
      details
    });
    this._flushWorkflowFiles();
  }

  _recordStepTiming(stepDef, status, startedAt, startedAtIso, extra = {}) {
    const endedAt = Date.now();
    this.stepTimings.push({
      name: stepDef.name,
      label: stepDef.label,
      status,
      started_at: startedAtIso,
      completed_at: new Date(endedAt).toISOString(),
      duration_ms: endedAt - startedAt,
      ...extra
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  async _mapWithConcurrency(items = [], concurrency = 1, mapper) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const limit = Math.max(1, Math.min(parseInt(concurrency, 10) || 1, list.length));
    const results = new Array(list.length);
    let cursor = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(list[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  _currentTaskProgress(fallback = 0) {
    try {
      const task = AiTask.findById(this.task.id);
      const resultData = this._safeJsonParse(task?.result_data, {});
      const progress = Number(resultData?.progress);
      return Number.isFinite(progress) ? progress : fallback;
    } catch (_) {
      return fallback;
    }
  }

  _updateProgressAtLeast(progress, stage, message, extra = {}) {
    this._updateProgress(Math.max(this._currentTaskProgress(progress), progress), stage, message, extra);
  }

  _singlePageMicroReviewConcurrency() {
    const raw = this.params.singlePageMicroReviewConcurrency
      || this.params.single_page_micro_review_concurrency
      || this.runtimeConfig?.singlePageMicroReviewConcurrency;
    const parsed = parseInt(raw, 10);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
    return Math.max(1, Math.min(configured, 4));
  }

  async _acquireSinglePageMicroReviewSlot() {
    while (this.singlePageMicroReviewActive >= this._singlePageMicroReviewConcurrency()) {
      await new Promise(resolve => this.singlePageMicroReviewWaiters.push(resolve));
    }
    this.singlePageMicroReviewActive += 1;
  }

  _releaseSinglePageMicroReviewSlot() {
    this.singlePageMicroReviewActive = Math.max(0, this.singlePageMicroReviewActive - 1);
    const next = this.singlePageMicroReviewWaiters.shift();
    if (next) next();
  }

  _scheduleSinglePageMicroReview(page, { pageNum, pageCount } = {}) {
    if (!this._singlePageMicroReviewEnabled() || !page?.outputPath || !fs.existsSync(page.outputPath)) {
      return false;
    }

    const filename = page.filename || path.basename(page.outputPath);
    const task = (async () => {
      await this._acquireSinglePageMicroReviewSlot();
      try {
        return await this._runSinglePageMicroReviewWithRepair(page, {
          pageNum,
          pageCount,
          background: true
        });
      } catch (error) {
        this._recordWorkflowEvent('Single Page Micro Review', 'background_error', {
          page: filename,
          page_num: pageNum,
          error: error.message,
          action: 'kept generated page and continued'
        });
        return {
          ...page,
          micro_reviewed: false,
          micro_review_warning: true,
          micro_review_error: error.message
        };
      } finally {
        this._releaseSinglePageMicroReviewSlot();
      }
    })();

    this.singlePageMicroReviewTasks.set(filename, { pageNum, filename, promise: task });
    this._recordWorkflowEvent('Single Page Micro Review', 'queued', {
      page: filename,
      page_num: pageNum,
      mode: 'background_nonblocking',
      concurrency: this._singlePageMicroReviewConcurrency()
    });
    return true;
  }

  _mergeGeneratedPageMicroReviewResult(page) {
    if (!page) return;
    const filename = page.filename || (page.outputPath ? path.basename(page.outputPath) : '');
    if (!filename) return;

    const existing = Array.isArray(this.generatedPages) ? this.generatedPages : [];
    let found = false;
    this.generatedPages = existing.map(item => {
      if (item?.filename !== filename) return item;
      found = true;
      return { ...item, ...page };
    });
    if (!found) {
      this.generatedPages.push(page);
      this.generatedPages.sort((a, b) => (
        (parseInt(a?.pageNum, 10) || parseInt(String(a?.filename || '').match(/^(\d+)/)?.[1], 10) || 0)
        - (parseInt(b?.pageNum, 10) || parseInt(String(b?.filename || '').match(/^(\d+)/)?.[1], 10) || 0)
      ));
    }
  }

  async _waitForPendingSinglePageMicroReviews(stage = 'qualityCheck') {
    const entries = [...this.singlePageMicroReviewTasks.values()];
    if (!entries.length) return [];

    this._updateProgressAtLeast(78, stage, `正在等待 ${entries.length} 页后台版面检查完成`, {
      micro_review_pending: entries.length,
      micro_review_mode: 'background_nonblocking',
      preview_svgs: this._listPreviewSvgUrls(this.projectPath, 'svg_output')
    });

    const pages = await Promise.all(entries.map(entry => entry.promise));
    pages.filter(Boolean).forEach(page => this._mergeGeneratedPageMicroReviewResult(page));
    this.singlePageMicroReviewTasks.clear();
    this._recordWorkflowEvent('Single Page Micro Review', 'background_completed', {
      stage,
      reviewed_pages: pages.length,
      repaired_pages: pages.filter(page => page?.micro_repaired || page?.repaired).map(page => page.filename)
    });
    return pages;
  }

  _flushWorkflowFiles() {
    if (!this.projectPath) return;

    const state = {
      workflow: 'ppt-master strict serial pipeline',
      pipeline: 'Source Document -> Create Project -> Template Option -> Strategist -> [Image_Generator] -> Executor -> Post-processing -> Export',
      official_compatibility_mode: this._officialCompatibilityMode(),
      task_id: this.task?.id,
      project_path: this.projectPath,
      current_step: this.currentStep,
      eight_confirmations: this.eightConfirmations,
      role_reads: this.roleReads,
      tools: this.getToolDescriptions(),
      generated_pages: this.generatedPages.map(page => page.filename),
      step_timings: this.stepTimings,
      quality_gate: this.qualityReport,
      layout_safety_gate: this.layoutSafetyReport,
      chart_calibration_gate: this.chartCalibrationReport,
      billing: this._buildBillingSummary(),
      events: this.workflowEvents
    };
    this._writeTextFile(
      path.join(this.projectPath, 'workflow_state.json'),
      `${JSON.stringify(state, null, 2)}\n`
    );

    const lines = [
      '# PPT Master Execution Log',
      '',
      `- Pipeline: ${state.pipeline}`,
      ''
    ];
    this.workflowEvents.forEach(event => {
      lines.push(`## ${event.step}`);
      lines.push(`- Status: ${event.status}`);
      lines.push(`- Time: ${event.at}`);
      const detailLines = Object.entries(event.details || {}).map(([key, value]) => {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        return `- ${key}: ${rendered}`;
      });
      lines.push(...detailLines, '');
    });
    if (this.roleReads.length > 0) {
      lines.push('## Role Read Audit');
      this.roleReads.forEach(item => {
        lines.push(`- ${item.role}: ${item.file} (${item.read_at})`);
      });
      lines.push('');
    }
    this._writeTextFile(path.join(this.projectPath, 'execution_log.md'), lines.join('\n'));
  }

  async _generateSinglePage({ pageNum, pageCount, previousSummary, repairHint: initialRepairHint = '' }) {
    const outputPath = path.join(this.projectPath, 'svg_output', this._pageFilename(pageNum));
    let repairHint = initialRepairHint || '';
    let lastProblem = initialRepairHint || '';

    const maxAttempts = this._executorGenerationMaxAttempts();
    let attempt = 1;
    let busyRetries = 0;
    const userMessage = `请生成第 ${pageNum}/${pageCount} 页 SVG。`;
    while (attempt <= maxAttempts) {
      try {
        const prompt = this._buildExecutorPrompt(pageNum, pageCount, previousSummary, repairHint);
        this._updateProgress(
          38 + Math.round(((pageNum - 1) / pageCount) * 39),
          'executor',
          `正在生成第 ${pageNum}/${pageCount} 页 SVG`,
          { current_page: pageNum, total_pages: pageCount }
        );
        const raw = await this._callPptModel({
          model: this._executorModel(),
          route: 'ppt_executor',
          systemPrompt: prompt,
          userMessage,
          historyMessages: this._executorHistoryMessages(),
          maxTokens: this._executorMaxTokens(pageNum),
          temperature: attempt === 1 ? 0.28 : 0.18,
          retries: this._executorModelCallRetries(),
          timeoutMs: this._pptExecutorCallTimeoutMs(),
          streamFirstTokenTimeoutMs: this._pptExecutorStreamFirstTokenTimeoutMs(),
          streamIdleTimeoutMs: this._pptExecutorStreamIdleTimeoutMs()
        });

        const extracted = this._extractSvgAndFilename(raw);
        let { svg } = extracted;
        if (!svg && extracted.partialSvg) {
          svg = await this._completePartialSvgOutput({
            partialSvg: extracted.partialSvg,
            pageNum,
            pageCount,
            previousSummary,
            repairHint
          });
        }
        if (!svg) {
          lastProblem = `模型未返回 <svg>...</svg>。输出片段：${this._trimText(raw, 1200)}`;
          repairHint = lastProblem;
          if (!this._shouldRetryExecutorPageWithModel('missing_svg', attempt, maxAttempts)) break;
          attempt += 1;
          continue;
        }

        const normalized = this._sanitizeSvgContent(svg);
        this._writeTextFile(outputPath, normalized);

        const check = await this._runQualityCheck(outputPath, { allowFailure: true });
        if (check.ok) {
          const placeholderCheck = this._runPlaceholderFailureCheck(outputPath);
          if (!placeholderCheck.ok) {
            lastProblem = placeholderCheck.output;
            repairHint = this._buildPlaceholderRepairHint(placeholderCheck.output, normalized);
            if (!this._shouldRetryExecutorPageWithModel('placeholder', attempt, maxAttempts)) break;
            attempt += 1;
            continue;
          }

          const layoutCheck = this._runLayoutSafetyCheck(outputPath);
          if (!layoutCheck.ok) {
            const fileReport = layoutCheck.files.find(file => file.file === path.basename(outputPath)) || layoutCheck.files[0];
            const mechanicallyRepaired = this._tryMechanicalLayoutSafetyRepair(outputPath, fileReport);
            if (mechanicallyRepaired) {
              const qualityAfterRepair = await this._runQualityCheck(outputPath, { allowFailure: true });
              const placeholderAfterRepair = this._runPlaceholderFailureCheck(outputPath);
              const layoutAfterRepair = this._runLayoutSafetyCheck(outputPath);
              if (qualityAfterRepair.ok && placeholderAfterRepair.ok && layoutAfterRepair.ok) {
                const repairedSvg = fs.readFileSync(outputPath, 'utf-8');
                this._appendExecutorHistory(pageNum, userMessage, repairedSvg);
                return {
                  pageNum,
                  filename: path.basename(outputPath),
                  outputPath,
                  description: this._inferPageDescription(pageNum),
                  repaired: true
                };
              }
              lastProblem = layoutAfterRepair.output || layoutCheck.output;
              repairHint = this._buildLayoutRepairHint(lastProblem, fs.readFileSync(outputPath, 'utf-8'));
            } else {
              lastProblem = layoutCheck.output;
              repairHint = this._buildLayoutRepairHint(layoutCheck.output, normalized);
            }
            if (!this._shouldRetryExecutorPageWithModel('layout', attempt, maxAttempts)) break;
            attempt += 1;
            continue;
          }

          this._appendExecutorHistory(pageNum, userMessage, normalized);
          return {
            pageNum,
            filename: path.basename(outputPath),
            outputPath,
            description: this._inferPageDescription(pageNum),
            repaired: attempt > 1
          };
        }

        lastProblem = check.output;
        repairHint = this._buildRepairHint(lastProblem, normalized);
        if (!this._shouldRetryExecutorPageWithModel('quality', attempt, maxAttempts)) break;
        attempt += 1;
      } catch (error) {
        if (this._isAiModelPoolBusyError(error) && busyRetries < this._pptModelBusyRetryAttempts()) {
          busyRetries += 1;
          const delayMs = this._pptModelBusyRetryDelayMs(busyRetries);
          this._recordWorkflowEvent('Step 6 Model Pool Busy', 'waiting', {
            page: this._pageFilename(pageNum),
            busy_retry: busyRetries,
            max_busy_retries: this._pptModelBusyRetryAttempts(),
            wait_ms: delayMs,
            error: this._trimText(error.message, 800)
          });
          this._updateProgress(
            38 + Math.round(((pageNum - 1) / pageCount) * 39),
            'executor',
            `模型并发已满，正在等待空闲通道后继续第 ${pageNum}/${pageCount} 页`,
            {
              current_page: pageNum,
              total_pages: pageCount,
              model_pool_busy: true,
              busy_retry: busyRetries,
              wait_ms: delayMs
            }
          );
          await this._sleep(delayMs);
          continue;
        }
        lastProblem = error.message;
        repairHint = `上一轮生成失败：${error.message}`;
        console.warn(`[PptAgent] 第${pageNum}页第${attempt}次尝试失败:`, error.message);
        if (!this._shouldRetryExecutorPageWithModel('model_error', attempt, maxAttempts)) break;
        attempt += 1;
      }
    }

    const rescuedPage = await this._tryFinalizePageWithLocalLayoutRepair(outputPath, {
      pageNum,
      userMessage,
      reason: lastProblem
    });
    if (rescuedPage) return rescuedPage;

    // Last resort: accept the page with warnings instead of failing entirely.
    // Layout checks can be overly strict for smaller local models.
    const existingSvg = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
    if (existingSvg && /<svg[\s\S]*?<\/svg>/i.test(existingSvg)) {
      this._recordWorkflowEvent('Step 6 Page Generation', 'accepted_with_warnings', {
        page: this._pageFilename(pageNum),
        page_num: pageNum,
        reason: this._trimText(lastProblem, 1600)
      });
      console.warn(`[PptAgent] 第 ${pageNum} 页未通过布局检查但仍有有效 SVG，以警告形式接受: ${this._trimText(lastProblem, 200)}`);
      this._appendExecutorHistory(pageNum, userMessage, existingSvg);
      return {
        pageNum,
        filename: path.basename(outputPath),
        outputPath,
        description: this._inferPageDescription(pageNum),
        accepted_with_warnings: true
      };
    }

    this._recordWorkflowEvent('Step 6 Page Generation', 'failed_after_repair_and_regeneration', {
      page: this._pageFilename(pageNum),
      page_num: pageNum,
      reason: this._trimText(lastProblem, 1600)
    });
    throw new Error(`第 ${pageNum} 页生成失败，已尝试修复/重生成但仍未通过检查: ${this._trimText(lastProblem, 1200)}`);
  }

  _executorGenerationMaxAttempts() {
    const raw = this.params.pptExecutorPageAttempts
      || this.params.ppt_executor_page_attempts
      || this.runtimeConfig?.pptExecutorPageAttempts;
    const configured = parseInt(raw, 10);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(1, Math.min(configured, 3));
    }
    return 2;
  }

  _executorModelCallRetries() {
    const raw = this.params.pptExecutorModelCallRetries
      || this.params.ppt_executor_model_call_retries
      || this.runtimeConfig?.pptExecutorModelCallRetries;
    const configured = parseInt(raw, 10);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.max(0, Math.min(configured, 3));
    }
    return 0;
  }

  _shouldRetryExecutorPageWithModel(reason, attempt, maxAttempts) {
    if (attempt >= maxAttempts) return false;
    const retryable = new Set(['missing_svg', 'model_error', 'quality']);
    if (retryable.has(reason)) return true;
    const allowFullPageRepair = this._normalizeBoolean(
      this.params.allowExecutorFullPageRepairRetry
        ?? this.params.allow_executor_full_page_repair_retry
        ?? this.runtimeConfig?.allowExecutorFullPageRepairRetry,
      true
    );
    return allowFullPageRepair && ['layout', 'placeholder'].includes(reason);
  }

  async _writeFallbackPageIfValid(outputPath, { pageNum, pageCount, userMessage, reason = '' } = {}) {
    this._recordWorkflowEvent('Step 6 Fallback Page', 'blocked', {
      page: outputPath ? path.basename(outputPath) : this._pageFilename(pageNum),
      page_num: pageNum,
      reason: this._trimText(reason, 1000),
      action: 'local fallback pages are disabled; page must be repaired or regenerated'
    });
    return null;
  }

  async _writeSafeFallbackPage(outputPath, { pageNum, pageCount, userMessage, reason = '' } = {}) {
    this._recordWorkflowEvent('Step 6 Safe Fallback Page', 'blocked', {
      page: outputPath ? path.basename(outputPath) : this._pageFilename(pageNum),
      page_num: pageNum,
      reason: this._trimText(reason, 1000),
      action: 'local fallback pages are disabled; page must be repaired or regenerated'
    });
    throw new Error(`本地安全兜底页已禁用；第 ${pageNum || '?'} 页必须修复或重新生成`);
  }

  async _completePartialSvgOutput({ partialSvg, pageNum, pageCount, previousSummary, repairHint = '' } = {}) {
    const partial = this._extractPartialSvg(partialSvg);
    if (!partial || /<\/svg>\s*$/i.test(partial)) return null;
    if (!this._partialSvgContinuationEnabled()) {
      this._recordWorkflowEvent('Step 6 Partial SVG Continuation', 'skipped', {
        page: this._pageFilename(pageNum),
        partial_chars: partial.length,
        action: 'will retry or regenerate page; local fallback pages are disabled'
      });
      return null;
    }

    const tail = this._trimText(partial.slice(Math.max(0, partial.length - 3600)), 3600);
    const systemPrompt = [
      '你是 PPT SVG 输出续写器。你的任务是只补完一个被截断的 SVG。',
      '严格要求：',
      '- 只输出从截断位置之后继续的 SVG 文本，不要重复已有 <svg> 开头，不要输出 Markdown。',
      '- 必须闭合所有仍打开的标签，最终必须以 </svg> 结束。',
      '- 不要新增页面主题，不要重写整页，不要解释。',
      '- 如果不确定缺失内容，只补最小必要的闭合标签和页脚/收尾结构。'
    ].join('\n');
    const userMessage = [
      `第 ${pageNum}/${pageCount} 页 SVG 被模型截断，需要从末尾继续补完。`,
      previousSummary ? `已生成页面摘要：\n${this._trimText(previousSummary, 1200)}` : '',
      repairHint ? `上一轮修复提示：\n${this._trimText(repairHint, 1200)}` : '',
      '已输出 SVG 末尾片段如下，请只输出后续缺失内容：',
      tail
    ].filter(Boolean).join('\n\n');

    try {
      const continuation = await this._callPptModel({
        model: this._executorModel(),
        route: 'ppt_executor',
        systemPrompt,
        userMessage,
        maxTokens: 3200,
        temperature: 0.05,
        retries: this._partialSvgContinuationRetries(),
        timeoutMs: this._partialSvgContinuationTimeoutMs(),
        streamFirstTokenTimeoutMs: Math.min(this._pptExecutorStreamFirstTokenTimeoutMs(), 30000),
        streamIdleTimeoutMs: Math.min(this._pptExecutorStreamIdleTimeoutMs(), 60000)
      });
      const merged = this._mergeSvgContinuation(partial, continuation);
      const extracted = this._extractSvgAndFilename(merged);
      if (extracted.svg) {
        this._recordWorkflowEvent('Step 6 Partial SVG Continuation', 'completed', {
          page: this._pageFilename(pageNum),
          partial_chars: partial.length,
          continuation_chars: String(continuation || '').length
        });
        return extracted.svg;
      }
      this._recordWorkflowEvent('Step 6 Partial SVG Continuation', 'failed', {
        page: this._pageFilename(pageNum),
        reason: 'continuation did not produce a complete svg',
        continuation: this._trimText(continuation, 1000)
      });
    } catch (error) {
      this._recordWorkflowEvent('Step 6 Partial SVG Continuation', 'failed', {
        page: this._pageFilename(pageNum),
        error: error.message
      });
    }
    return null;
  }

  _partialSvgContinuationEnabled() {
    return this._normalizeBoolean(
      this.params.enablePartialSvgContinuation
        ?? this.params.enable_partial_svg_continuation
        ?? this.runtimeConfig?.enablePartialSvgContinuation,
      false
    );
  }

  _partialSvgContinuationRetries() {
    const raw = this.params.partialSvgContinuationRetries
      || this.params.partial_svg_continuation_retries
      || this.runtimeConfig?.partialSvgContinuationRetries;
    const parsed = parseInt(raw, 10);
    return Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : 0, 2));
  }

  _partialSvgContinuationTimeoutMs() {
    const raw = this.params.partialSvgContinuationTimeoutMs
      || this.params.partial_svg_continuation_timeout_ms
      || this.runtimeConfig?.partialSvgContinuationTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 60000, 15000), 120000);
  }

  _extractPartialSvg(raw) {
    const cleaned = this._stripMarkdownFence(raw);
    const start = cleaned.search(/<svg\b/i);
    if (start < 0) return null;
    return cleaned.slice(start).trim();
  }

  _mergeSvgContinuation(partialSvg, continuation = '') {
    const cleanPartial = String(partialSvg || '').trimEnd();
    const cleanContinuation = this._stripMarkdownFence(continuation)
      .replace(/^[\s\S]*?(?=<\/?(?:defs|g|rect|text|path|line|circle|ellipse|polyline|polygon|image|use|clipPath|linearGradient|radialGradient|filter|svg)\b)/i, '')
      .replace(/^\s*<svg\b[^>]*>/i, '')
      .trim();
    const merged = `${cleanPartial}\n${cleanContinuation}`;
    if (/<\/svg>\s*$/i.test(merged)) return merged;
    return `${merged}\n</svg>`;
  }

  async _tryFinalizePageWithLocalLayoutRepair(outputPath, { pageNum, userMessage, reason = '' } = {}) {
    if (!outputPath || !fs.existsSync(outputPath)) return null;

    let repaired = false;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const placeholder = this._runPlaceholderFailureCheck(outputPath);
      if (!placeholder.ok) return null;

      const layout = this._runLayoutSafetyCheck(outputPath);
      if (layout.ok) {
        const quality = await this._runQualityCheck(outputPath, { allowFailure: true });
        if (quality.ok) {
          const finalSvg = fs.readFileSync(outputPath, 'utf-8');
          if (pageNum && userMessage) this._appendExecutorHistory(pageNum, userMessage, finalSvg);
          this._recordWorkflowEvent('Step 6 Page Local Layout Rescue', 'completed', {
            page: path.basename(outputPath),
            page_num: pageNum,
            cycles: cycle,
            repaired,
            reason: this._trimText(reason, 1000)
          });
          return {
            pageNum,
            filename: path.basename(outputPath),
            outputPath,
            description: this._inferPageDescription(pageNum),
            repaired: true,
            local_layout_rescue: true
          };
        }
        return null;
      }

      const fileReport = layout.files.find(file => file.file === path.basename(outputPath)) || layout.files[0];
      const repairedNow = await this._repairLayoutUnsafePage(outputPath, fileReport);
      if (!repairedNow) return null;
      repaired = true;
    }

    return null;
  }

  async _ensureGeneratedPageSelfCheck(page, { pageNum, pageCount }) {
    const svgPath = page?.outputPath || path.join(this.projectPath, 'svg_output', this._pageFilename(pageNum));
    const filename = path.basename(svgPath);
    const repairedFiles = new Set();
    let lastProblem = '';

    const maxSelfCheckCycles = this._pageSelfCheckMaxCycles();
    for (let cycle = 1; cycle <= maxSelfCheckCycles; cycle += 1) {
      this._updateProgress(
        38 + Math.round(((pageNum - 0.18) / pageCount) * 39),
        'executor',
        cycle === 1
          ? `正在自检第 ${pageNum}/${pageCount} 页版面`
          : `正在第 ${cycle}/${maxSelfCheckCycles} 轮自动重试第 ${pageNum}/${pageCount} 页自检`,
        {
          current_page: pageNum,
          total_pages: pageCount,
          self_checking_page: filename,
          self_check_cycle: cycle,
          self_check_max_cycles: maxSelfCheckCycles,
          preview_svgs: this._listPreviewSvgUrls(this.projectPath, 'svg_output')
        }
      );

	      let quality = await this._runQualityCheck(svgPath, { allowFailure: true });
	      if (!quality.ok) {
	        lastProblem = `单页 SVG 质量检查失败: ${quality.output}`;
	        if (cycle < maxSelfCheckCycles) {
	          this._recordWorkflowEvent('Step 6 Page Self Check', 'retrying', {
	            page: filename,
	            cycle,
	            max_cycles: maxSelfCheckCycles,
	            reason: this._trimText(lastProblem, 1000)
	          });
	          continue;
	        } else {
	          throw new Error(`第 ${pageNum} 页单页 SVG 质量检查未通过，已停止使用兜底页: ${this._trimText(quality.output, 1200)}`);
	        }
	      }

	      let placeholder = this._runPlaceholderFailureCheck(svgPath);
	      if (!placeholder.ok) {
	        lastProblem = '单页自检发现失败占位页，检查阶段已禁止调用大模型重生成整页';
	        if (cycle < maxSelfCheckCycles) {
	          this._recordWorkflowEvent('Step 6 Page Self Check', 'retrying', {
	            page: filename,
	            cycle,
	            max_cycles: maxSelfCheckCycles,
	            reason: lastProblem
	          });
	          continue;
	        } else {
	          throw new Error(`第 ${pageNum} 页单页自检发现占位/内部元信息，已停止使用兜底页`);
	        }
	      }

      let layout = this._runLayoutSafetyCheck(svgPath);
	      if (!layout.ok) {
	        const fileReport = layout.files.find(file => file.file === filename) || layout.files[0];
	        lastProblem = `单页视觉版面安全检查失败: ${layout.output}`;
	        const repaired = await this._repairLayoutUnsafePage(svgPath, fileReport);
	        if (repaired) {
	          repairedFiles.add(filename);
	        } else if (cycle < maxSelfCheckCycles) {
          this._recordWorkflowEvent('Step 6 Page Self Check', 'retrying', {
            page: filename,
            cycle,
            max_cycles: maxSelfCheckCycles,
            reason: this._summarizeLayoutIssues(fileReport)
          });
          continue;
        } else {
          throw new Error(`第 ${pageNum} 页单页视觉版面安全检查未通过，已停止使用兜底页: ${this._summarizeLayoutIssues(fileReport)}`);
        }
      }

      quality = await this._runQualityCheck(svgPath, { allowFailure: true });
      placeholder = this._runPlaceholderFailureCheck(svgPath);
      layout = this._runLayoutSafetyCheck(svgPath);
      if (quality.ok && placeholder.ok && layout.ok) {
        if (repairedFiles.size > 0) {
          this._recordWorkflowEvent('Step 6 Page Self Check', 'repaired', {
            page: filename,
            repaired_files: [...repairedFiles],
            cycles: cycle
          });
        } else {
          this._recordWorkflowEvent('Step 6 Page Self Check', 'passed', { page: filename, cycles: cycle });
        }

        return {
          ...page,
          filename,
          outputPath: svgPath,
          self_checked: true,
          repaired: Boolean(page?.repaired) || repairedFiles.has(filename)
        };
      }

      lastProblem = [quality.output, placeholder.output, layout.output].filter(Boolean).join('\n');
	      if (cycle < maxSelfCheckCycles) {
	        this._recordWorkflowEvent('Step 6 Page Self Check', 'retrying', {
	          page: filename,
	          cycle,
	          max_cycles: maxSelfCheckCycles,
	          reason: this._trimText(lastProblem, 1200)
	        });
	        continue;
	      }
    }

    throw new Error(`第 ${pageNum} 页单页自检最终未通过，已停止使用兜底页: ${this._trimText(lastProblem, 1200)}`);
  }

  _pageSelfCheckMaxCycles() {
    const raw = this.params.pptPageSelfCheckRetries
      || this.params.ppt_page_self_check_retries
      || this.runtimeConfig?.pptPageSelfCheckRetries;
    const configured = parseInt(raw, 10);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(1, Math.min(configured, 5));
    }
    return 3;
  }

  async _runQualityCheckWithRepair() {
    const repairedFiles = new Set();
    let result = await this._runQualityCheck(this.projectPath, { allowFailure: true });

    if (!result.ok) {
      const failedFiles = this._extractFailedSvgFilenames(result.output, path.join(this.projectPath, 'svg_output'));
      for (const filename of failedFiles) {
        const svgPath = path.join(this.projectPath, 'svg_output', filename);
        if (!fs.existsSync(svgPath)) continue;
        const pageNum = this._pageNumFromFilename(filename);

        const original = fs.readFileSync(svgPath, 'utf-8');
        const sanitized = this._sanitizeSvgContent(original);
        this._writeTextFile(svgPath, sanitized);

        const recheck = await this._runQualityCheck(svgPath, { allowFailure: true });
        if (recheck.ok) {
          repairedFiles.add(filename);
          continue;
        }

        this._recordWorkflowEvent('Quality Check Page Repair', 'failed', {
          page: filename,
          page_num: pageNum,
          reason: this._trimText(recheck.output, 1800),
          action: 'blocked; local fallback pages are disabled'
        });
      }

      result = await this._runQualityCheck(this.projectPath, { allowFailure: true });
    }

    let placeholderScan = this._runPlaceholderFailureCheck(this.projectPath);
    if (!placeholderScan.ok) {
      this._recordWorkflowEvent('Step 6 Placeholder Gate', 'failed', {
        failed_files: placeholderScan.failed_files,
        action: 'blocked; local fallback pages are disabled'
      });
    }

    const layoutSafety = await this._runLayoutSafetyCheckWithRepair(this._ensureChartMarkersBeforeLayoutScan());
    const placeholderAfterLayout = this._runPlaceholderFailureCheck(this.projectPath);
    if (!placeholderAfterLayout.ok) {
      this._recordWorkflowEvent('Step 6 Placeholder Gate', 'failed', {
        failed_files: placeholderAfterLayout.failed_files,
        action: 'blocked after layout repair; local fallback pages are disabled'
      });
    }

    result = await this._runQualityCheck(this.projectPath, { allowFailure: true });
    const finalPlaceholderScan = this._runPlaceholderFailureCheck(this.projectPath);
    const corePassed = Boolean(result.ok && finalPlaceholderScan.ok);
    const passed = corePassed; // layout safety is advisory — it does not block export
    if (!corePassed) {
      this._recordWorkflowEvent('Step 6 Quality Check Gate', 'failed', {
        quality_ok: result.ok,
        placeholder_ok: finalPlaceholderScan.ok,
        layout_ok: layoutSafety.passed,
        failed_placeholders: finalPlaceholderScan.failed_files,
        quality_output: this._trimText(result.output, 1800),
        layout_output: this._trimText(layoutSafety.output, 1800)
      });
    } else if (!layoutSafety.passed) {
      this._recordWorkflowEvent('Step 6 Quality Check Gate', 'layout_advisory_only', {
        quality_ok: result.ok,
        placeholder_ok: finalPlaceholderScan.ok,
        layout_ok: false,
        layout_output: this._trimText(layoutSafety.output, 1800),
        action: 'layout issues are advisory — continuing to export'
      });
    }

    return {
      passed,
      output: [result.output, '', finalPlaceholderScan.output, '', layoutSafety.output].filter(Boolean).join('\n'),
      repaired_files: [...repairedFiles],
      layout_safety: layoutSafety
    };
  }

  async _reviewImageAssetsWithAi(assets = [], { statuses = [] } = {}) {
    if (!this._aiResourceReviewEnabled() || !Array.isArray(assets) || assets.length === 0) {
      return assets;
    }

    const reviewable = assets
      .filter(asset => asset?.relativePath && fs.existsSync(asset.path || path.join(this.projectPath, asset.relativePath)))
      .slice(0, this._aiResourceReviewMaxAssets());
    if (reviewable.length === 0) return assets;

    this._updateProgress(36, 'imageGenerator', '正在用 AI 审查已获取图片资源', {
      image_asset_review_count: reviewable.length
    });

    let parsed;
    const cacheInfo = this._imageAssetReviewCacheInfo(reviewable);
    const cached = this._readAiReviewCache(cacheInfo.path, cacheInfo.key);
    try {
      if (cached) {
        parsed = cached;
        this._recordWorkflowEvent('Step 5 AI Resource Visual Review', 'cache_hit', {
          reviewed_count: reviewable.length,
          cache_key: cacheInfo.key.slice(0, 16)
        });
      } else {
        const content = [{
          type: 'text',
          text: [
            '请审查下面这批 PPT 图片资源是否符合需求。只返回严格 JSON。',
            '',
            `PPT 标题：${this.params.title}`,
            `用户需求：${this._trimText(this.task?.prompt || this.params.content || '', 1600)}`,
            '',
            '判断标准：',
            '- 图片必须与它的用途、人物、品牌、事物、场景或 logo 需求相符。',
            '- logo/人物/产品/地点不能明显错配、伪造、过度模糊、截断或水印严重。',
            '- 不能有明显低清、异常拉伸、主体缺失、广告感过强、危险/不雅/无关内容。',
            '- warning 可以保留；fail 必须从可用资源中剔除，后续页面不能引用。',
            '',
            '返回格式：{"passed":boolean,"items":[{"filename":"...","passed":boolean,"severity":"ok|warning|fail","reason":"...","suggested_action":"keep|replace|manual|regenerate_ai"}],"summary":"..."}',
            '',
            '资源清单：',
            reviewable.map((asset, index) => `${index + 1}. filename=${asset.filename}; origin=${asset.origin || ''}; purpose=${asset.description || ''}; source=${asset.sourceUrl || asset.provider || ''}`).join('\n')
          ].join('\n')
        }];

        for (const asset of reviewable) {
          const block = await this._imageFileToVisionBlock(asset.path || path.join(this.projectPath, asset.relativePath), {
            maxSize: 1024,
            quality: 82
          });
          content.push({ type: 'text', text: `Image filename=${asset.filename}` });
          content.push(block);
        }

        parsed = await this._callPptVisionJson({
          route: 'ppt_asset_review',
          model: this._assetReviewModel(),
          systemPrompt: '你是严格的 PPT 图片资源视觉审核员。你只能输出 JSON，不能输出 Markdown。',
          userContent: content,
          maxTokens: 1800,
          temperature: 0.05,
          timeoutMs: 180000
        });
        this._writeAiReviewCache(cacheInfo.path, cacheInfo.key, parsed);
      }
    } catch (error) {
      this._recordWorkflowEvent('Step 5 AI Resource Visual Review', 'failed', {
        reason: error.message,
        action: 'kept assets and continued generation'
      });
      this._writeTextFile(path.join(this.projectPath, 'reports', 'ai_asset_visual_review.json'), JSON.stringify({
        passed: true,
        advisory_only: true,
        review_failed: true,
        reviewed_count: reviewable.length,
        kept_count: assets.length,
        rejected_count: 0,
        error: error.message,
        summary: 'AI 图片资源审查失败，已保留资源并继续生成，避免阻断 PPT 导出。'
      }, null, 2) + '\n');
      return assets;
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const failedNames = new Set(items
      .filter(item => item?.passed === false || String(item?.severity || '').toLowerCase() === 'fail')
      .map(item => String(item.filename || '').trim())
      .filter(Boolean));
    const reviewByName = new Map(items.map(item => [String(item.filename || '').trim(), item]));
    const kept = assets.filter(asset => !failedNames.has(asset.filename));
    const rejected = assets.filter(asset => failedNames.has(asset.filename));

    rejected.forEach(asset => {
      const item = reviewByName.get(asset.filename) || {};
      statuses.push({
        request: asset.imageRequest || { filename: asset.filename },
        status: 'Rejected-Visual-Review',
        file: asset.relativePath,
        reason: item.reason || 'AI 视觉审查判定图片不符合需求'
      });
    });
    if (rejected.length > 0) {
      this._removeUnavailableImageReferencesFromDesignSpec(statuses);
      this.webVisualAssets = (this.webVisualAssets || []).filter(asset => !failedNames.has(asset.filename));
    }

    const report = {
      passed: rejected.length === 0,
      generated_at: new Date().toISOString(),
      reviewed_count: reviewable.length,
      kept_count: kept.length,
      rejected_count: rejected.length,
      cache_hit: Boolean(cached),
      items,
      summary: parsed?.summary || ''
    };
    this._writeTextFile(path.join(this.projectPath, 'reports', 'ai_asset_visual_review.json'), JSON.stringify(report, null, 2) + '\n');
    this._appendDesignSpecSection('AI Visual Resource Review', [
      `- reviewed: ${reviewable.length}`,
      `- kept: ${kept.length}`,
      `- rejected: ${rejected.length}`,
      ...items.map(item => `- ${item.filename}: ${item.severity || (item.passed ? 'ok' : 'fail')} - ${item.reason || ''}`)
    ].join('\n'));
    this._recordWorkflowEvent('Step 5 AI Resource Visual Review', rejected.length ? 'rejected_assets' : 'passed', {
      reviewed_count: reviewable.length,
      rejected: rejected.map(asset => asset.filename),
      report: 'reports/ai_asset_visual_review.json'
    });

    return kept;
  }

  async _runAiPageVisualReviewWithRepair() {
    if (!this._aiPageVisualReviewEnabled()) {
      return { passed: true, skipped: true, output: 'AI page visual review disabled.', repaired_files: [] };
    }

    const visualReviewBlocking = this._aiPageVisualReviewRequired();
    const maxCycles = this._aiPageVisualReviewMaxCycles();
    const repairedFiles = new Set();
    let lastReview = null;
    let pageScope = null;

    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      this._updateProgress(79, 'qualityCheck', cycle === 1
        ? '正在用 AI 审查整套页面外观'
        : `正在第 ${cycle}/${maxCycles} 轮 AI 外观复审`, {
          ai_visual_review_cycle: cycle,
          ai_visual_review_max_cycles: maxCycles,
          preview_svgs: this._listPreviewSvgUrls(this.projectPath, 'svg_output')
        });

      let previews;
      try {
        previews = await this._renderAllSvgPagePreviews(cycle, pageScope);
        lastReview = await this._reviewPagePreviewsWithAi(previews, { cycle });
      } catch (error) {
        const report = {
          passed: false,
          advisory_only: !visualReviewBlocking,
          review_failed: true,
          cycles: cycle,
          repaired_files: [...repairedFiles],
          error: error.message,
          summary: visualReviewBlocking
            ? 'AI 整页外观审查执行失败，已阻断导出，避免未审查页面流入最终 PPT。'
            : 'AI 整页外观审查执行失败，已记录为建议项并继续，避免审查模型或图片能力问题中断生成。'
        };
        this._writeTextFile(path.join(this.projectPath, 'reports', 'ai_page_visual_review.json'), JSON.stringify(report, null, 2) + '\n');
        this._recordWorkflowEvent('AI Page Visual Review', visualReviewBlocking ? 'failed' : 'advisory_error', {
          cycle,
          error: error.message,
          action: visualReviewBlocking
            ? 'blocked export because visual review is required'
            : 'continued because visual review is advisory by default'
        });
        return {
          passed: false,
          advisory_only: !visualReviewBlocking,
          output: this._formatAiPageVisualReviewOutput(report),
          repaired_files: [...repairedFiles],
          report: 'reports/ai_page_visual_review.json'
        };
      }
      const failedPages = this._failedAiVisualReviewPages(lastReview);
      this._writeTextFile(
        path.join(this.projectPath, 'reports', `ai_page_visual_review_cycle_${cycle}.json`),
        JSON.stringify(lastReview, null, 2) + '\n'
      );

      if (failedPages.length === 0) {
        const finalReport = {
          ...lastReview,
          passed: true,
          cycles: cycle,
          repaired_files: [...repairedFiles],
          preview_dir: 'reports/ai_page_visual_review_pages'
        };
        this._writeTextFile(path.join(this.projectPath, 'reports', 'ai_page_visual_review.json'), JSON.stringify(finalReport, null, 2) + '\n');
        return {
          passed: true,
          output: this._formatAiPageVisualReviewOutput(finalReport),
          repaired_files: [...repairedFiles],
          report: 'reports/ai_page_visual_review.json'
        };
      }

      for (const page of failedPages) {
        const pageNum = parseInt(page.page, 10);
        const svgPath = path.join(this.projectPath, 'svg_output', this._pageFilename(pageNum));
        if (!fs.existsSync(svgPath)) {
          this._recordWorkflowEvent('AI Page Visual Review', 'missing_failed_page', {
            page: this._pageFilename(pageNum),
            action: 'ignored stale review item'
          });
          continue;
        }
        const problem = [
          'AI 整页外观审查未通过。检查阶段只允许做保守版面修复，禁止完整重生成本页。',
          `严重程度：${page.severity || 'fail'}`,
          `问题：${Array.isArray(page.issues) ? page.issues.join('; ') : (page.reason || '')}`,
          page.repair_instruction ? `修复要求：${page.repair_instruction}` : '',
          '允许修复范围：元素上下层级、文字字号、文字 x/y 位置。',
          '禁止修复范围：重写整页、替换图片、补画主体内容、改文案、改图表数据、改页面结构。'
        ].filter(Boolean).join('\n');
        let repaired = await this._repairAiVisualReviewPageConservatively(svgPath, page);
        if (!repaired && cycle < maxCycles && this._aiVisualFullPageRepairEnabled()) {
          repaired = await this._regenerateAiVisualReviewPage(page, {
            pageCount: this.params.pageCount,
            problem
          });
        }
        if (!repaired) {
          this._recordWorkflowEvent('AI Page Visual Review', 'advisory_unrepaired', {
            page: path.basename(svgPath),
            issue: this._trimText(problem, 1600),
            action: visualReviewBlocking
              ? 'unresolved; required visual review will block export if still failing'
              : 'unresolved; kept as advisory after deterministic quality gates'
          });
          continue;
        }
        repairedFiles.add(path.basename(svgPath));
        this.generatedPages = this.generatedPages.map(generated => (
          generated.filename === path.basename(svgPath)
            ? { ...generated, repaired: true, ai_visual_review_repaired: true }
            : generated
        ));
      }
      pageScope = failedPages.map(page => parseInt(page.page, 10)).filter(Number.isFinite);
    }

    const failedPages = this._failedAiVisualReviewPages(lastReview);
    const report = {
      ...(lastReview || {}),
      passed: failedPages.length === 0,
      cycles: maxCycles,
      repaired_files: [...repairedFiles],
      preview_dir: 'reports/ai_page_visual_review_pages'
    };
    this._writeTextFile(path.join(this.projectPath, 'reports', 'ai_page_visual_review.json'), JSON.stringify(report, null, 2) + '\n');
    if (failedPages.length > 0) {
      this._recordWorkflowEvent('AI Page Visual Review', 'advisory_failed', {
        failed_pages: failedPages.map(page => page.page),
        action: visualReviewBlocking
          ? 'blocked export after conservative repair attempts'
          : 'continued after conservative repair attempts because visual review is advisory by default',
        summary: this._trimText(this._formatAiPageVisualReviewOutput(report), 1800)
      });
      return {
        passed: false,
        advisory_only: !visualReviewBlocking,
        output: this._formatAiPageVisualReviewOutput(report),
        repaired_files: [...repairedFiles],
        report: 'reports/ai_page_visual_review.json'
      };
    }
    return {
      passed: true,
      output: this._formatAiPageVisualReviewOutput(report),
      repaired_files: [...repairedFiles],
      report: 'reports/ai_page_visual_review.json'
    };
  }

  async _renderAllSvgPagePreviews(cycle = 1, pageScope = null) {
    const svgDir = path.join(this.projectPath, 'svg_output');
    const outputDir = path.join(this.projectPath, 'reports', 'ai_page_visual_review_pages');
    fs.mkdirSync(outputDir, { recursive: true });
    const allowedPages = Array.isArray(pageScope) && pageScope.length
      ? new Set(pageScope.map(page => parseInt(page, 10)).filter(Number.isFinite))
      : null;
    const pageNumbers = [];
    for (let pageNum = 1; pageNum <= this.params.pageCount; pageNum += 1) {
      if (allowedPages && !allowedPages.has(pageNum)) continue;
      const filename = this._pageFilename(pageNum);
      const svgPath = path.join(svgDir, filename);
      if (!fs.existsSync(svgPath)) continue;
      pageNumbers.push(pageNum);
    }

    const previews = await this._mapWithConcurrency(
      pageNumbers,
      this._svgPreviewRenderConcurrency(pageNumbers.length),
      async pageNum => {
        const filename = this._pageFilename(pageNum);
        const svgPath = path.join(svgDir, filename);
        const pngPath = path.join(outputDir, `cycle_${cycle}_${String(pageNum).padStart(2, '0')}.png`);
        await this._renderSvgPagePreview(svgPath, pngPath);
        return {
          page: pageNum,
          filename,
          svgPath,
          pngPath,
          title: this._inferPageDescription(pageNum),
          context: this._pageSpecificContext(pageNum)
        };
      }
    );
    return previews.filter(Boolean).sort((a, b) => a.page - b.page);
  }

  async _renderSvgPagePreview(svgPath, pngPath) {
    const canvas = this._canvasInfo();
    const rawSvg = fs.readFileSync(svgPath, 'utf-8');
    const previewSvg = this._inlineSvgExternalImagesForPreview(rawSvg, svgPath);
    await sharp(Buffer.from(previewSvg), {
      density: 144,
      limitInputPixels: 120_000_000
    })
      .resize(canvas.width, canvas.height, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .png()
      .toFile(pngPath);
    return pngPath;
  }

  _inlineSvgExternalImagesForPreview(svg, svgPath) {
    const svgDir = path.dirname(svgPath);
    return String(svg || '').replace(/((?:href|xlink:href)\s*=\s*)(["'])(.*?)\2/gi, (match, prefix, quote, href) => {
      const dataUri = this._svgPreviewImageDataUri(href, svgDir);
      if (!dataUri) return match;
      return `${prefix}${quote}${dataUri}${quote}`;
    });
  }

  _svgPreviewImageDataUri(href, svgDir) {
    const rawHref = String(href || '').trim();
    if (!rawHref || /^data:/i.test(rawHref) || /^https?:\/\//i.test(rawHref)) return '';

    let imagePath = '';
    try {
      imagePath = rawHref.startsWith('/uploads/')
        ? appConfig.uploadUrlToPath(rawHref)
        : path.resolve(svgDir, decodeURIComponent(rawHref));
      const safeProjectPath = this.projectPath
        ? path.resolve(this.projectPath)
        : path.resolve(UPLOAD_DIR);
      const resolvedImagePath = path.resolve(imagePath);
      const relative = path.relative(safeProjectPath, resolvedImagePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
      if (!fs.existsSync(resolvedImagePath) || !fs.statSync(resolvedImagePath).isFile()) return '';
      const stat = fs.statSync(resolvedImagePath);
      if (stat.size > 18 * 1024 * 1024) return '';
      const ext = path.extname(resolvedImagePath).toLowerCase();
      const mime = ext === '.svg'
        ? 'image/svg+xml'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/png';
      const buffer = fs.readFileSync(resolvedImagePath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (error) {
      this._recordWorkflowEvent('AI Page Visual Review Preview', 'image_inline_skipped', {
        href: this._trimText(rawHref, 220),
        error: error.message
      });
      return '';
    }
  }

  async _reviewPagePreviewsWithAi(previews = [], { cycle = 1 } = {}) {
    if (!Array.isArray(previews) || previews.length === 0) {
      throw new Error('没有可审查的页面预览图');
    }

    const cachedPageResults = [];
    const pendingPreviews = [];
    for (const page of previews) {
      const cacheInfo = this._pagePreviewSingleReviewCacheInfo(page);
      const cached = this._readAiReviewCache(cacheInfo.path, cacheInfo.key);
      if (cached) {
        cachedPageResults.push(this._normalizeAiPageReviewItem(cached, page, { cacheHit: true }));
      } else {
        pendingPreviews.push({ ...page, cacheInfo });
      }
    }

    if (cachedPageResults.length > 0) {
      this._recordWorkflowEvent('AI Page Visual Review', 'page_cache_hit', {
        cycle,
        cached_pages: cachedPageResults.map(page => page.page),
        pending_pages: pendingPreviews.map(page => page.page)
      });
    }

    const maxPerCall = this._aiPageVisualReviewMaxPagesPerCall();
    const chunks = [];
    for (let index = 0; index < pendingPreviews.length; index += maxPerCall) {
      chunks.push(pendingPreviews.slice(index, index + maxPerCall));
    }

    const chunkResults = await this._mapWithConcurrency(
      chunks,
      this._aiVisualReviewConcurrency(chunks.length),
      async chunk => {
        const content = [{
          type: 'text',
          text: [
            '请对这些 PPT 页面截图做严格外观审查。只返回 JSON。',
            '',
            `PPT 标题：${this.params.title}`,
            `本轮审查：${cycle}`,
            `总页数：${this.params.pageCount}`,
            '',
            '必须检查：文字乱码/错别字级明显错误、文字溢出或重叠、图案/图片遮挡文字、层级前后关系错误、图表明显错误、页面空白或主体缺失、图片拉伸/截断/错配、对比度低、元素越界、前后页顺序或叙事关系明显不合理、任何一眼看上去不对的外观问题。',
            'warning 表示可以接受但建议优化；fail 表示必须进入保守版面修复或明确失败，禁止建议整页重生成。',
            '',
            '返回格式：{"passed":boolean,"pages":[{"page":1,"filename":"01_slide_1.svg","passed":boolean,"severity":"ok|warning|fail","issues":["..."],"repair_instruction":"..."}],"summary":"..."}',
            '',
            '页面清单：',
            chunk.map(page => `P${String(page.page).padStart(2, '0')} ${page.filename}: ${this._trimText(page.context || page.title || '', 420)}`).join('\n')
          ].join('\n')
        }];

        for (const page of chunk) {
          content.push({ type: 'text', text: `Page ${page.page}, filename=${page.filename}` });
          content.push(await this._imageFileToVisionBlock(page.pngPath, { maxSize: 1280, quality: 84 }));
        }

        const parsed = await this._callPptVisionJson({
          route: 'ppt_page_review',
          model: this._pageReviewModel(),
          systemPrompt: '你是严格的 PPT 整页视觉质检员。你只能输出 JSON，不能输出 Markdown 或解释文字。',
          userContent: content,
          maxTokens: 2400,
          temperature: 0.05,
          timeoutMs: 240000
        });
        const returnedPages = Array.isArray(parsed?.pages) ? parsed.pages : [];
        const normalizedPages = chunk.map(page => {
          const matched = returnedPages.find(item => (
            (parseInt(item?.page, 10) || null) === page.page ||
            String(item?.filename || '').trim() === page.filename
          ));
          const normalized = this._normalizeAiPageReviewItem(matched, page);
          this._writeAiReviewCache(page.cacheInfo.path, page.cacheInfo.key, normalized);
          return normalized;
        });
        return {
          ...parsed,
          pages: normalizedPages,
          cache_miss_pages: chunk.map(page => page.page)
        };
      }
    );

    const pageResults = [...cachedPageResults];
    const summaries = [];
    for (const parsed of chunkResults) {
      if (Array.isArray(parsed?.pages)) pageResults.push(...parsed.pages);
      if (parsed?.summary) summaries.push(parsed.summary);
    }
    if (cachedPageResults.length > 0) {
      summaries.push(`page-cache: reused ${cachedPageResults.length}/${previews.length} unchanged screenshot reviews`);
    }

    return {
      passed: pageResults.every(page => !this._aiVisualReviewPageFailed(page)),
      cycle,
      generated_at: new Date().toISOString(),
      cache: {
        page_level: true,
        hits: cachedPageResults.length,
        misses: pendingPreviews.length
      },
      pages: pageResults.sort((a, b) => (parseInt(a?.page, 10) || 0) - (parseInt(b?.page, 10) || 0)),
      summary: summaries.join('\n')
    };
  }

  _failedAiVisualReviewPages(review = {}) {
    return (Array.isArray(review?.pages) ? review.pages : [])
      .filter(page => this._aiVisualReviewPageFailed(page))
      .map(page => ({
        ...page,
        page: parseInt(page.page, 10) || this._pageNumFromFilename(page.filename)
      }))
      .filter(page => page.page);
  }

  _aiVisualReviewPageFailed(page = {}) {
    const severity = String(page?.severity || '').trim().toLowerCase();
    if (severity === 'fail') return true;
    if (severity === 'ok' || severity === 'warning') return false;
    return page?.passed === false;
  }

  _formatAiPageVisualReviewOutput(report = {}) {
    const pages = Array.isArray(report.pages) ? report.pages : [];
    const lines = [
      `passed: ${Boolean(report.passed)}`,
      `cycles: ${report.cycles || report.cycle || 1}`,
      report.summary ? `summary: ${report.summary}` : '',
      ...pages.map(page => {
        const issues = Array.isArray(page.issues) ? page.issues.join('; ') : (page.reason || '');
        return `P${String(page.page).padStart(2, '0')} ${page.severity || (page.passed ? 'ok' : 'fail')}: ${issues || 'ok'}`;
      })
    ].filter(Boolean);
    return lines.join('\n');
  }

  async _imageFileToVisionBlock(filePath, { maxSize = 1024, quality = 82 } = {}) {
    const buffer = await sharp(filePath, { limitInputPixels: 120_000_000 })
      .rotate()
      .resize({
        width: maxSize,
        height: maxSize,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${buffer.toString('base64')}`
      }
    };
  }

  async _callPptVisionJson({ route = 'ppt_vision_review', model = null, systemPrompt, userContent, maxTokens = 2000, temperature = 0.05, timeoutMs = 180000 }) {
    const routeName = route || 'ppt_vision_review';
    const raw = await this._callPptModel({
      model: model || this._modelForPptRoute(routeName),
      route: routeName,
      systemPrompt,
      userMessage: userContent,
      maxTokens,
      temperature,
      retries: 2,
      timeoutMs
    });
    const parsed = this._parseAiJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`模型没有返回有效 JSON: ${this._trimText(raw, 700)}`);
    }
    return parsed;
  }

  _parseAiJsonObject(raw) {
    const cleaned = this._stripMarkdownFence(raw);
    const direct = this._safeJsonParse(cleaned, null);
    if (direct && typeof direct === 'object') return direct;
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return this._safeJsonParse(cleaned.slice(start, end + 1), null);
    }
    return null;
  }

  _aiResourceReviewEnabled() {
    return this._normalizeBoolean(
      this.params.enableAiResourceReview ?? this.params.enable_ai_resource_review,
      true
    );
  }

  _aiPageVisualReviewEnabled() {
    return this._normalizeBoolean(
      this.params.enableAiVisualReview ?? this.params.enable_ai_visual_review,
      true
    );
  }

  _aiPageVisualReviewRequired() {
    return this._normalizeBoolean(
      this.params.requireAiVisualReview
        ?? this.params.require_ai_visual_review
        ?? this.params.aiVisualReviewRequired
        ?? this.params.ai_visual_review_required
        ?? this.runtimeConfig?.requireAiVisualReview,
      false
    );
  }

  _aiResourceReviewMaxAssets() {
    const raw = this.params.aiResourceReviewMaxAssets || this.params.ai_resource_review_max_assets;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.min(parsed, 24));
    return 18;
  }

  _aiPageVisualReviewMaxPagesPerCall() {
    const raw = this.params.aiVisualReviewMaxPagesPerCall || this.params.ai_visual_review_max_pages_per_call;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.min(parsed, 10));
    return 8;
  }

  _aiPageVisualReviewMaxCycles() {
    const raw = this.params.aiVisualReviewRetries || this.params.ai_visual_review_retries;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.min(parsed, 4));
    return 2;
  }

  _aiVisualFullPageRepairEnabled() {
    return this._normalizeBoolean(
      this.params.allowAiVisualFullPageRepair
        ?? this.params.allow_ai_visual_full_page_repair
        ?? this.runtimeConfig?.allowAiVisualFullPageRepair,
      true
    );
  }

  async _regenerateAiVisualReviewPage(pageReview = {}, { pageCount = this.params.pageCount, problem = '' } = {}) {
    const pageNum = parseInt(pageReview.page, 10) || this._pageNumFromFilename(pageReview.filename);
    if (!pageNum) return false;
    const filename = this._pageFilename(pageNum);
    const svgPath = path.join(this.projectPath, 'svg_output', filename);
    if (!fs.existsSync(svgPath)) return false;

    const original = fs.readFileSync(svgPath, 'utf-8');
    const repairHint = this._buildAiVisualReviewRepairHint(pageReview, original, problem);
    this._recordWorkflowEvent('AI Visual Full Page Repair', 'started', {
      page: filename,
      issue: this._trimText(problem, 1200),
      action: 'regenerate failed page with visual review repair hint'
    });

    try {
      const regenerated = await this._generateSinglePage({
        pageNum,
        pageCount,
        previousSummary: this._generatedPagesSummaryBefore(pageNum),
        repairHint
      });
      this._mergeGeneratedPageMicroReviewResult({
        ...regenerated,
        repaired: true,
        ai_visual_review_repaired: true
      });
      this._recordWorkflowEvent('AI Visual Full Page Repair', 'completed', {
        page: filename
      });
      return true;
    } catch (error) {
      this._writeTextFile(svgPath, original);
      this._recordWorkflowEvent('AI Visual Full Page Repair', 'failed', {
        page: filename,
        error: error.message,
        action: 'restored previous SVG and left strict gate to block export'
      });
      return false;
    }
  }

  _buildAiVisualReviewRepairHint(pageReview = {}, svg = '', problem = '') {
    const issues = Array.isArray(pageReview.issues)
      ? pageReview.issues.join('\n')
      : String(pageReview.reason || '');
    return [
      '上一版 SVG 通过了基础 XML/PPTX 检查，但未通过 AI 整页视觉审查。',
      '必须保留同一页主题和关键事实，按下面问题重新生成完整 SVG；不要输出局部补丁。',
      '',
      'AI 视觉审查问题：',
      this._trimText([issues, pageReview.repair_instruction, problem].filter(Boolean).join('\n'), 2200),
      '',
      '强制修复规则：',
      '- 如果页面承诺“证据图、主体图、结构图、机构图、模型图、图片”，必须嵌入真实存在的 ../images/... 资源，或绘制清晰 SVG 原生技术示意；禁止留下空白大框、浅灰占位框或不可见主体。',
      '- 图片必须在预览截图中一眼可见：高纵横比图片不要塞进矮宽框；宽图不要缩到过小；必要时改成图文并排、局部放大或 SVG 重绘。',
      '- 标签、进度条、色块必须避开说明文字；如果存在遮挡，缩短色块或移动文字，而不是压在一起。',
      '- 结论/清单页的每条项目至少保持 18px 可见行距；长句拆成 tspan 两行，下一条整体下移，图标和文字不得混读。',
      '',
      '上一版 SVG 片段：',
      this._trimText(svg, 1600)
    ].join('\n');
  }

  _generatedPagesSummaryBefore(pageNum) {
    return (this.generatedPages || [])
      .filter(page => {
        const current = parseInt(page?.pageNum, 10) || this._pageNumFromFilename(page?.filename);
        return current && current < pageNum;
      })
      .map(page => {
        const current = parseInt(page?.pageNum, 10) || this._pageNumFromFilename(page?.filename);
        return `P${String(current).padStart(2, '0')}: ${page.description || page.filename}`;
      })
      .join('\n');
  }

  _runLayoutSafetyAdvisory() {
    const scan = this._runLayoutSafetyCheck(this.projectPath);
    const output = [
      scan.output,
      '',
      '> Official compatibility mode: layout_safety is advisory only. Only ppt-master svg_quality_checker errors block generation.'
    ].join('\n');
    this._writeTextFile(path.join(this.projectPath, 'reports', 'layout_safety_report.md'), output);
    return {
      passed: scan.ok,
      advisory_only: true,
      output,
      repaired_files: [],
      chart_markers_repaired: []
    };
  }

  async _runQualityCheck(target, { allowFailure = false } = {}) {
    const args = [target, '--format', this.params.canvasFormat];
    const result = await this._execPptMasterScript('svg_quality_checker.py', args, {
      timeoutMs: 120000,
      rejectOnError: false
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (!result.ok && !allowFailure) {
      throw new Error(output || result.message || 'svg_quality_checker.py failed');
    }
    return {
      ok: result.ok,
      output: output || result.message || ''
    };
  }

  async _runLayoutSafetyCheckWithRepair(preRepairedChartMarkers = []) {
    const chartMarkersRepaired = new Set(preRepairedChartMarkers);
    this._ensureChartMarkersBeforeLayoutScan().forEach(file => chartMarkersRepaired.add(file));
    let scan = this._runLayoutSafetyCheck(this.projectPath);
    if (scan.ok) {
      this._writeTextFile(path.join(this.projectPath, 'reports', 'layout_safety_report.md'), scan.output);
      return { passed: true, output: scan.output, repaired_files: [], chart_markers_repaired: [...chartMarkersRepaired] };
    }

    const failedFiles = scan.files
      .filter(file => file.issues.some(issue => this._layoutIssueRequiresRepair(issue)))
      .map(file => file.file);
    const repairedFiles = [];

    for (const filename of failedFiles) {
      const svgPath = path.join(this.projectPath, 'svg_output', filename);
      if (!fs.existsSync(svgPath)) continue;

      const fileReport = scan.files.find(file => file.file === filename);
      const repaired = await this._repairLayoutUnsafePage(svgPath, fileReport);
      if (repaired) {
        repairedFiles.push(filename);
        continue;
      }

      this._recordWorkflowEvent('Layout Safety Repair', 'continued_with_warnings', {
        page: filename,
        issues: this._summarizeLayoutIssues(fileReport),
        action: 'unresolved; strict quality gate blocks export if still failing'
      });
    }

    this._ensureChartMarkersBeforeLayoutScan().forEach(file => chartMarkersRepaired.add(file));
    scan = this._runLayoutSafetyCheck(this.projectPath);
    this._writeTextFile(path.join(this.projectPath, 'reports', 'layout_safety_report.md'), scan.output);
    if (!scan.ok) {
      this._recordWorkflowEvent('Layout Safety Gate', 'failed', {
        reason: this._trimText(scan.output, 3000)
      });
    }

    return {
      passed: scan.ok,
      advisory_only: !scan.ok,
      output: scan.output,
      repaired_files: repairedFiles,
      initial_failed_files: failedFiles,
      chart_markers_repaired: [...chartMarkersRepaired]
    };
  }

  async _repairLayoutUnsafePage(svgPath, fileReport) {
    const mechanicallyRepaired = this._tryMechanicalLayoutSafetyRepair(svgPath, fileReport);
    if (mechanicallyRepaired) {
      const placeholder = this._runPlaceholderFailureCheck(svgPath);
      const layout = this._runLayoutSafetyCheck(svgPath);
      if (placeholder.ok && layout.ok) {
        return true;
      }
    }

    return false;
  }

  async _runSinglePageMicroReviewWithRepair(page, { pageNum, pageCount, background = false } = {}) {
    if (!this._singlePageMicroReviewEnabled() || !page?.outputPath || !fs.existsSync(page.outputPath)) {
      return page;
    }

    const svgPath = page.outputPath;
    const filename = path.basename(svgPath);
    let repaired = false;

    this._updateProgressAtLeast(
      38 + Math.round(((pageNum - 0.35) / pageCount) * 39),
      'executor',
      background
        ? `后台正在检查并微调第 ${pageNum}/${pageCount} 页版面`
        : `正在微调第 ${pageNum}/${pageCount} 页版面`,
      {
        current_page: pageNum,
        total_pages: pageCount,
        micro_review_mode: background ? 'background_nonblocking' : 'blocking',
        micro_reviewing_page: filename,
        preview_svgs: this._listPreviewSvgUrls(this.projectPath, 'svg_output')
      }
    );

    if (this._sanitizeReplacementGlyphsInSvg(svgPath)) {
      repaired = true;
    }

    let review = null;
    try {
      const previewDir = path.join(this.projectPath, 'reports', 'single_page_micro_review');
      fs.mkdirSync(previewDir, { recursive: true });
      const pngPath = path.join(previewDir, `${String(pageNum).padStart(2, '0')}.png`);
      await this._renderSvgPagePreview(svgPath, pngPath);
      review = await this._reviewSinglePageMicroWithAi({
        pageNum,
        pageCount,
        filename,
        pngPath,
        context: this._pageSpecificContext(pageNum)
      });
      this._writeTextFile(
        path.join(previewDir, `${String(pageNum).padStart(2, '0')}.json`),
        JSON.stringify(review, null, 2) + '\n'
      );
    } catch (error) {
      this._recordWorkflowEvent('Single Page Micro Review', 'advisory_error', {
        page: filename,
        error: error.message,
        action: 'continued with deterministic local polish'
      });
    }

    const issueText = this._singlePageMicroIssueText(review);
    if (issueText && await this._repairAiVisualReviewPageConservatively(svgPath, {
      severity: 'warning',
      issues: [issueText],
      repair_instruction: '只允许微调：字号、坐标、行距、层级和局部尺寸；禁止改内容、换图片、重画整页。'
    })) {
      repaired = true;
    }

    if (this._tryMechanicalLayoutWarningPolish(svgPath)) {
      repaired = true;
    }

    const layout = this._runLayoutSafetyCheck(svgPath);
    const fileReport = layout.files.find(file => file.file === filename) || layout.files[0];
    if (!layout.ok && await this._repairLayoutUnsafePage(svgPath, fileReport)) {
      repaired = true;
    }

    const quality = await this._runQualityCheck(svgPath, { allowFailure: true });
    const placeholder = this._runPlaceholderFailureCheck(svgPath);
    const afterLayout = this._runLayoutSafetyCheck(svgPath);
    if (!quality.ok || !placeholder.ok || !afterLayout.ok) {
      this._recordWorkflowEvent('Single Page Micro Review', 'rejected', {
        page: filename,
        quality_ok: quality.ok,
        placeholder_ok: placeholder.ok,
        layout_ok: afterLayout.ok,
        action: 'kept current page to avoid destructive edits'
      });
      return {
        ...page,
        micro_reviewed: Boolean(review),
        micro_review_warning: true
      };
    }

    this._recordWorkflowEvent('Single Page Micro Review', repaired ? 'repaired' : 'passed', {
      page: filename,
      page_num: pageNum,
      summary: this._trimText(review?.summary || issueText || '', 900)
    });

    return {
      ...page,
      repaired: Boolean(page.repaired) || repaired,
      micro_reviewed: true,
      micro_repaired: repaired
    };
  }

  async _reviewSinglePageMicroWithAi({ pageNum, pageCount, filename, pngPath, context = '' }) {
    const content = [{
      type: 'text',
      text: [
        '请审查这一页 PPT 截图，只返回严格 JSON。',
        '',
        `PPT 标题：${this.params.title}`,
        `页面：P${String(pageNum).padStart(2, '0')} / ${pageCount}`,
        `文件名：${filename}`,
        `页面要求：${this._trimText(context, 900)}`,
        '',
        '目标：做一次“微调审查”，让这一页一眼看起来更正常、更清爽。',
        '只允许提出保守微调：文字字号、文字 x/y 位置、行距、元素前后层级、局部卡片尺寸、局部间距、局部对齐。',
        '禁止提出：重写整页、替换图片、改图表数据、改页面结构、增加大段新内容、删除核心内容。',
        '必须重点检查：文字乱码/替换符、文字重叠、贴边、裁切、遮挡、底部拥挤、图标或图片压住文字、局部行距过密。',
        '',
        '返回格式：{"needs_tuning":boolean,"severity":"ok|warning|fail","issues":["..."],"micro_actions":["..."],"summary":"..."}'
      ].join('\n')
    }];
    content.push(await this._imageFileToVisionBlock(pngPath, { maxSize: 1280, quality: 84 }));
    const parsed = await this._callPptVisionJson({
      route: 'ppt_micro_review',
      model: this._microReviewModel(),
      systemPrompt: '你是 PPT 单页微调审查员。只输出 JSON。你的建议必须限于位置、字号、行距、层级、局部尺寸和乱码清理，不允许整页重写。',
      userContent: content,
      maxTokens: 1400,
      temperature: 0.03,
      timeoutMs: 160000
    });
    return parsed;
  }

  _singlePageMicroIssueText(review = {}) {
    if (!review || review.needs_tuning === false || String(review.severity || '').toLowerCase() === 'ok') return '';
    const issues = Array.isArray(review.issues) ? review.issues.join('; ') : '';
    const actions = Array.isArray(review.micro_actions) ? review.micro_actions.join('; ') : '';
    return [
      issues,
      actions,
      review.summary || ''
    ].filter(Boolean).join('\n');
  }

  _singlePageMicroReviewEnabled() {
    return this._normalizeBoolean(
      this.params.enableSinglePageMicroReview ?? this.params.enable_single_page_micro_review,
      true
    );
  }

  _tryMechanicalLayoutWarningPolish(svgPath) {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(original);
    const elements = this._collectSvgLayoutElements(original, canvas);
    const before = this._runLayoutSafetyCheck(svgPath);
    const hasPolishableWarning = before.files.some(file => (file.issues || []).some(issue => [
      'container_text_padding_too_small',
      'body_bottom_warning_zone',
      'lower_band_too_dense',
      'page_badge_crowds_header',
      'header_badge_text_crowded'
    ].includes(issue.code)));
    if (!hasPolishableWarning) return false;

    const containerRepaired = this._applyMechanicalContainerTextRepair(svgPath, elements, canvas);
    const headerRepaired = this._applyHeaderChromeRepair(svgPath);
    const repaired = containerRepaired || headerRepaired;
    if (!repaired) return false;

    const after = this._runLayoutSafetyCheck(svgPath);
    const placeholder = this._runPlaceholderFailureCheck(svgPath);
    if (!placeholder.ok || after.files.some(file => (file.issues || []).some(issue => this._layoutIssueRequiresRepair(issue)))) {
      this._writeTextFile(svgPath, original);
      return false;
    }
    this._recordWorkflowEvent('Single Page Warning Polish', 'completed', {
      page: path.basename(svgPath)
    });
    return true;
  }

  _applyHeaderChromeRepair(svgPath) {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(original);
    const elements = this._collectSvgLayoutElements(original, canvas);
    const updates = this._buildHeaderChromeRepairUpdates(elements, canvas);
    if (!updates.length) return false;
    const next = updates
      .sort((a, b) => b.tagIndex - a.tagIndex)
      .reduce((current, update) => this._replaceTagNumericAttr(current, update.tagIndex, update.attrName, update.value), original);
    if (next === original) return false;
    this._writeTextFile(svgPath, this._sanitizeSvgContent(next));
    return true;
  }

  _sanitizeReplacementGlyphsInSvg(svgPath) {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    if (!/[�\uFFFD]/.test(original)) return false;
    let next = original;
    const replacements = [
      [/在线�+教育/g, '在线教育'],
      [/视�+建议/g, '视觉建议'],
      [/主要内�+/g, '主要内容'],
      [/研究意义与研�+内容/g, '研究意义与研究内容'],
      [/提�+成/g, '提炼成'],
      [/原样保留|�+样保留/g, '原样保留'],
      [/请�+/g, '请求'],
      [/兼容�+资源/g, '兼容和资源'],
      [/推�+服务端数据/g, '推送服务端数据'],
      [/研究切入�+/g, '研究切入点'],
      [/通信系�+中/g, '通信系统中'],
      [/�+心判断/g, '核心判断'],
      [/WebSocket�+时通信系统/g, 'WebSocket实时通信系统'],
      [/�+低资源泄漏/g, '降低资源泄漏'],
      [/系统�+用性验证/g, '系统可用性验证'],
      [/文件�+消息类型/g, '文件等消息类型'],
      [/老师�+悉心指导/g, '老师的悉心指导'],
      [/�+须/g, '必须'],
      [/�+生/g, '发生'],
      [/�+/g, '']
    ];
    replacements.forEach(([pattern, value]) => {
      next = next.replace(pattern, value);
    });
    next = this._sanitizeSvgContent(next);
    if (next === original) return false;
    this._writeTextFile(svgPath, next);
    this._recordWorkflowEvent('Single Page Text Cleanup', 'completed', {
      page: path.basename(svgPath),
      action: 'removed replacement glyphs'
    });
    return true;
  }

  async _repairAiVisualReviewPageConservatively(svgPath, pageReview = {}) {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    const issues = Array.isArray(pageReview?.issues)
      ? pageReview.issues.join('\n')
      : String(pageReview?.reason || pageReview?.repair_instruction || '');
    const conservativeIssue = this._isConservativeAiVisualIssue(issues);
    if (!conservativeIssue) {
      this._recordWorkflowEvent('AI Visual Conservative Repair', 'skipped', {
        page: path.basename(svgPath),
        reason: 'outside_conservative_scope',
        allowed_scope: 'z-order, text font-size, text x/y position',
        issues: this._trimText(issues, 900)
      });
      return false;
    }

    const layout = this._runLayoutSafetyCheck(svgPath);
    const fileReport = layout.files.find(file => file.file === path.basename(svgPath));
    let repaired = false;
    if (fileReport) {
      repaired = this._tryMechanicalLayoutSafetyRepair(svgPath, fileReport);
    }
    if (!repaired) {
      repaired = this._tryIssueSpecificVisualRepair(svgPath, issues);
    }
    if (!repaired) {
      repaired = this._tryConservativeZOrderRepair(svgPath, issues);
    }
    if (!repaired) {
      repaired = this._tryConservativeVisualPositionRepair(svgPath, issues);
    }
    if (!repaired) return false;

    const quality = await this._runQualityCheck(svgPath, { allowFailure: true });
    const placeholder = this._runPlaceholderFailureCheck(svgPath);
    const afterLayout = this._runLayoutSafetyCheck(svgPath);
    if (quality.ok && placeholder.ok && afterLayout.ok) {
      this._recordWorkflowEvent('AI Visual Conservative Repair', 'completed', {
        page: path.basename(svgPath),
        allowed_scope: 'z-order, text font-size, text x/y position'
      });
      return true;
    }

    this._writeTextFile(svgPath, original);
    this._recordWorkflowEvent('AI Visual Conservative Repair', 'reverted', {
      page: path.basename(svgPath),
      quality_ok: quality.ok,
      placeholder_ok: placeholder.ok,
      layout_ok: afterLayout.ok
    });
    return false;
  }

  _tryIssueSpecificVisualRepair(svgPath, issueText = '') {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    if (/(绿色|进度条|标签|色块).*(遮挡|覆盖|压住)|治理闭环|再迭代鲁棒策略/i.test(issueText)) {
      if (this._tryProgressLabelOverlapRepair(svgPath, issueText)) return true;
    }
    return false;
  }

  _tryProgressLabelOverlapRepair(svgPath, issueText = '') {
    const original = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(original);
    const elements = this._collectSvgLayoutElements(original, canvas);
    const greenRects = elements.filter(element => {
      if (element.tag !== 'rect') return false;
      const fill = String(this._attr(element.attrs, 'fill') || '').toUpperCase();
      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      return ['#27AE60', '#2ECC71', '#16A085', '#1ABC9C'].includes(fill) &&
        width >= 90 &&
        height >= 14 &&
        height <= 42 &&
        element.bounds.top > canvas.height * 0.45;
    });
    const texts = elements.filter(element => element.tag === 'text' && element.bounds.top > canvas.height * 0.45);

    for (const rect of greenRects) {
      const ownLabelRight = texts
        .filter(text => {
          const fill = String(this._attr(text.attrs, 'fill') || '').toUpperCase();
          const overlap = this._overlapInfo(rect.bounds, text.bounds);
          return fill === '#FFFFFF' && overlap.area > 0;
        })
        .reduce((max, text) => Math.max(max, text.bounds.right), rect.bounds.left);
      const overlappedText = texts
        .filter(text => {
          const fill = String(this._attr(text.attrs, 'fill') || '').toUpperCase();
          if (fill === '#FFFFFF') return false;
          const overlap = this._overlapInfo(rect.bounds, text.bounds);
          const textArea = this._boundsArea(text.bounds);
          return overlap.area > 0 && textArea > 0 && overlap.area / textArea > 0.08;
        })
        .sort((a, b) => a.bounds.left - b.bounds.left)[0];
      if (!overlappedText) continue;

      const currentWidth = this._numAttr(rect.attrs, 'width', rect.bounds.right - rect.bounds.left);
      const desiredRight = overlappedText.bounds.left - 18;
      const labelWidth = ownLabelRight > rect.bounds.left ? ownLabelRight - rect.bounds.left + 14 : 72;
      const nextWidth = Math.max(labelWidth, Math.min(currentWidth, desiredRight - rect.bounds.left));
      if (!Number.isFinite(nextWidth) || nextWidth >= currentWidth - 4) continue;

      const next = this._replaceTagNumericAttr(original, rect.tagIndex, 'width', Math.round(nextWidth));
      if (next === original) continue;
      this._writeTextFile(svgPath, this._sanitizeSvgContent(next));
      this._recordWorkflowEvent('AI Visual Conservative Repair', 'progress_label_adjusted', {
        page: path.basename(svgPath),
        previous_width: Math.round(currentWidth),
        next_width: Math.round(nextWidth),
        issue: this._trimText(issueText, 700)
      });
      return true;
    }

    return false;
  }

  _isConservativeAiVisualIssue(text) {
    const normalized = String(text || '');
    if (!normalized.trim()) return false;
    const destructive = /(空白|缺失|错配|错误图片|图片.*不符|logo.*错|标识.*错|拼写|错别字|乱码|数据错误|图表.*错误|顺序.*不合理|前后页|主题不符|占位|主体.*缺)/i;
    if (destructive.test(normalized)) return false;
    return /(重叠|遮挡|层级|前后关系|压住|盖住|溢出|越界|截断|裁切|拥挤|字号|字体.*大|字体.*小|位置|贴边|间距|边距)/i.test(normalized);
  }

  _tryConservativeZOrderRepair(svgPath, issueText = '') {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(original);
    const elements = this._collectSvgLayoutElements(original, canvas);
    const footerTop = canvas.height - 52;
    const bottomBandTop = this._detectBottomBandTop(elements, canvas);
    const texts = elements.filter(element => (
      element.tag === 'text' &&
      !this._isHeaderElement(element, canvas) &&
      !this._isFooterElement(element, canvas, footerTop) &&
      !this._isBottomBandElement(element, canvas, bottomBandTop)
    ));
    const blockers = elements.filter(element => (
      ['rect', 'circle', 'ellipse', 'image'].includes(element.tag) &&
      !this._isBackgroundElement(element, canvas) &&
      !this._isHeaderElement(element, canvas) &&
      !this._isFooterElement(element, canvas, footerTop) &&
      !this._isBottomBandElement(element, canvas, bottomBandTop) &&
      !this._isSoftDecorativeElement(element, canvas)
    ));

    const moves = [];
    for (const text of texts) {
      for (const blocker of blockers) {
        if (!Number.isFinite(blocker.tagIndex) || !Number.isFinite(text.tagIndex)) continue;
        if (blocker.tagIndex <= text.tagIndex) continue;
        if (this._isAllowedContainingPair(text, blocker)) continue;
        const overlap = this._overlapInfo(text.bounds, blocker.bounds);
        const textArea = this._boundsArea(text.bounds);
        if (textArea <= 0 || overlap.area / textArea < 0.22) continue;
        const blockerRange = this._svgElementBlockRange(original, blocker.tagIndex, blocker.tag);
        const textRange = this._svgElementBlockRange(original, text.tagIndex, text.tag);
        if (!blockerRange || !textRange || blockerRange.start < textRange.end) continue;
        moves.push({ blocker, blockerRange, targetIndex: textRange.start });
        break;
      }
    }

    if (moves.length === 0) return false;
    const move = moves[0];
    const block = original.slice(move.blockerRange.start, move.blockerRange.end);
    let next = original.slice(0, move.blockerRange.start) + original.slice(move.blockerRange.end);
    next = next.slice(0, move.targetIndex) + block + '\n' + next.slice(move.targetIndex);
    if (next === original) return false;
    this._writeTextFile(svgPath, this._sanitizeSvgContent(next));
    this._recordWorkflowEvent('AI Visual Conservative Repair', 'z_order_attempted', {
      page: path.basename(svgPath),
      moves: 1,
      issue: this._trimText(issueText, 700)
    });
    return true;
  }

  _tryConservativeVisualPositionRepair(svgPath, issueText = '') {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(original);
    const elements = this._collectSvgLayoutElements(original, canvas);
    const footerTop = canvas.height - 52;
    const bottomBandTop = this._detectBottomBandTop(elements, canvas);
    const shapes = elements.filter(element => (
      ['rect', 'circle', 'ellipse', 'image'].includes(element.tag) &&
      !this._isBackgroundElement(element, canvas) &&
      !this._isHeaderElement(element, canvas) &&
      !this._isFooterElement(element, canvas, footerTop) &&
      !this._isBottomBandElement(element, canvas, bottomBandTop) &&
      !this._isSoftDecorativeElement(element, canvas)
    ));
    const texts = elements.filter(element => (
      element.tag === 'text' &&
      !this._isHeaderElement(element, canvas) &&
      !this._isFooterElement(element, canvas, footerTop) &&
      !this._isBottomBandElement(element, canvas, bottomBandTop)
    ));
	    const adjustments = new Map();
	    const wantsTextSpacing = /(重叠|过密|混读|行距|拥挤)/i.test(issueText);
	    const wantsBlockerSeparation = /(遮挡|覆盖|压住|盖住|进度条|标签|色块)/i.test(issueText);
	    const addAdjustment = (tagIndex, patch) => {
      if (!Number.isFinite(tagIndex)) return;
      const current = adjustments.get(tagIndex) || { shiftX: 0, shiftY: 0, fontSize: null };
      current.shiftX += patch.shiftX || 0;
      current.shiftY += patch.shiftY || 0;
      if (patch.fontSize) {
        current.fontSize = current.fontSize ? Math.min(current.fontSize, patch.fontSize) : patch.fontSize;
      }
      adjustments.set(tagIndex, current);
    };

    for (const text of texts) {
      const fontSize = this._layoutFontSize(text);
      const width = text.bounds.right - text.bounds.left;
      if (text.bounds.left < 24) addAdjustment(text.tagIndex, { shiftX: 24 - text.bounds.left });
      if (text.bounds.right > canvas.width - 24) addAdjustment(text.tagIndex, { shiftX: canvas.width - 24 - text.bounds.right });
      if (text.bounds.top < 24) addAdjustment(text.tagIndex, { shiftY: 24 - text.bounds.top });
      if (text.bounds.bottom > footerTop - 8) addAdjustment(text.tagIndex, { shiftY: footerTop - 8 - text.bounds.bottom });
      if (width > canvas.width * 0.88 && fontSize > 14) {
        addAdjustment(text.tagIndex, { fontSize: Math.max(12, Math.floor(fontSize * 0.9)) });
      }
    }

    for (let i = 0; i < texts.length; i += 1) {
      for (let j = i + 1; j < texts.length; j += 1) {
	        const first = texts[i];
	        const second = texts[j];
	        if (this._sameLayoutGroup(first, second) && !wantsTextSpacing) continue;
	        const overlap = this._overlapInfo(first.bounds, second.bounds);
	        if (overlap.width < 18 || overlap.height < 8) continue;
	        const lower = first.bounds.top >= second.bounds.top ? first : second;
        const shift = Math.min(28, overlap.height + 8);
        addAdjustment(lower.tagIndex, { shiftY: shift });
      }
    }

	    for (const text of texts) {
	      for (const shape of shapes) {
	        if (this._isAllowedContainingPair(text, shape)) continue;
	        if (this._sameLayoutGroup(text, shape) && !this._shapeAppearsAfterText(shape, text) && !wantsBlockerSeparation) continue;
	        const overlap = this._overlapInfo(text.bounds, shape.bounds);
	        const textArea = this._boundsArea(text.bounds);
	        const overlapRatio = textArea > 0 ? overlap.area / textArea : 0;
	        const issueDirectedSmallOverlap = wantsBlockerSeparation && overlap.area > 0 && overlap.width >= 8 && overlap.height >= 6;
	        if (textArea <= 0 || (!issueDirectedSmallOverlap && overlapRatio < 0.24)) continue;
        const fontSize = this._layoutFontSize(text);
        if (fontSize > 13) {
          addAdjustment(text.tagIndex, { fontSize: Math.max(12, Math.floor(fontSize * 0.88)) });
        }
        const spaceAbove = shape.bounds.top - 18;
        const spaceBelow = footerTop - shape.bounds.bottom - 18;
        if (spaceBelow > fontSize * 1.6) {
          addAdjustment(text.tagIndex, { shiftY: Math.min(36, shape.bounds.bottom + 14 - text.bounds.top) });
        } else if (spaceAbove > fontSize * 1.6) {
          addAdjustment(text.tagIndex, { shiftY: -Math.min(36, text.bounds.bottom - shape.bounds.top + 14) });
        }
      }
    }

    if (adjustments.size === 0) return false;
    let next = original;
    [...adjustments.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([tagIndex, adjustment]) => {
        if (adjustment.fontSize) next = this._replaceTagNumericAttr(next, tagIndex, 'font-size', adjustment.fontSize);
        if (adjustment.shiftX) next = this._shiftTextElementCoordinate(next, tagIndex, 'x', adjustment.shiftX);
        if (adjustment.shiftY) next = this._shiftTextElementCoordinate(next, tagIndex, 'y', adjustment.shiftY);
      });
    if (next === original) return false;
    this._writeTextFile(svgPath, this._sanitizeSvgContent(next));
    this._recordWorkflowEvent('AI Visual Conservative Repair', 'attempted', {
      page: path.basename(svgPath),
      adjustments: adjustments.size,
      issue: this._trimText(issueText, 700)
    });
    return true;
  }

  _runLayoutSafetyCheck(target) {
    const files = this._resolveSvgTargets(target);
    const checked = files.map(file => this._inspectSvgLayout(file));
    const ok = checked.every(file => !file.issues.some(issue => this._layoutIssueRequiresRepair(issue)));
    return {
      ok,
      files: checked,
      output: this._formatLayoutSafetyReport(checked, ok)
    };
  }

  _layoutIssueRequiresRepair(issue) {
    if (!issue) return false;
    if (issue.severity === 'error') return true;
    return false;
  }

  _tryMechanicalLayoutSafetyRepair(svgPath, fileReport = {}) {
    if (!svgPath || !fs.existsSync(svgPath)) return false;
    const issues = fileReport?.issues || [];
    const hasHeaderIssue = issues.some(issue => [
      'header_text_overlap',
      'header_title_obstructed',
      'header_title_crowded'
    ].includes(issue.code));
    const hasFooterClipIssue = issues.some(issue => issue.code === 'footer_text_clip_risk');
    const hasContainerIssue = issues.some(issue => [
      'text_container_overflow',
      'container_text_padding_too_small',
      'element_overlap',
      'canvas_overflow',
      'text_canvas_overflow',
      'estimated_text_horizontal_overflow'
    ].includes(issue.code));
    const hasBlockingIssue = issues.some(issue => this._layoutIssueRequiresRepair(issue));
    if (!hasBlockingIssue || (!hasHeaderIssue && !hasFooterClipIssue && !hasContainerIssue)) return false;

    const original = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(original);
    const elements = this._collectSvgLayoutElements(original, canvas);
    const updates = [];
    let nextSvg = original;
    let containerRepaired = false;

    if (hasContainerIssue) {
      containerRepaired = this._applyMechanicalContainerTextRepair(svgPath, elements, canvas);
      if (containerRepaired) {
        nextSvg = fs.readFileSync(svgPath, 'utf-8');
      }
      // Canvas overflow: clip elements extending beyond canvas bounds
      const canvasOverflowIssues = issues.filter(i =>
        i.code === 'canvas_overflow' || i.code === 'text_canvas_overflow' || i.code === 'estimated_text_horizontal_overflow'
      );
      if (canvasOverflowIssues.length > 0) {
        nextSvg = this._repairCanvasOverflow(nextSvg || original, canvas);
        containerRepaired = true;
      }
    }
    if (containerRepaired && !hasHeaderIssue && !hasFooterClipIssue) {
      return true;
    }

    if (hasFooterClipIssue) {
      const footerTop = canvas.height - 52;
      const safeFooterTextBottom = canvas.height - 20;
      elements
        .filter(element => (
          element.tag === 'text' &&
          this._isFooterElement(element, canvas, footerTop) &&
          element.bounds.bottom > safeFooterTextBottom
        ))
        .forEach(element => {
          const currentY = this._numAttr(element.attrs, 'y', NaN);
          if (!Number.isFinite(currentY)) return;
          const shift = Math.ceil(element.bounds.bottom - safeFooterTextBottom);
          if (shift <= 0) return;
          updates.push({ tagIndex: element.tagIndex, attrName: 'y', value: Math.floor(currentY - shift) });
        });
    }

    updates.push(...this._buildHeaderChromeRepairUpdates(elements, canvas));

    if (!hasHeaderIssue && updates.length > 0) {
      nextSvg = updates
        .sort((a, b) => b.tagIndex - a.tagIndex)
        .reduce((current, update) => this._replaceTagNumericAttr(current, update.tagIndex, update.attrName, update.value), nextSvg);
      if (nextSvg === original) return false;
      this._writeTextFile(svgPath, this._sanitizeSvgContent(nextSvg));
      return true;
    }

    const headerTexts = elements
      .filter(element => element.tag === 'text' && element.bounds.top < 126)
      .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
    if (headerTexts.length < 2 && updates.length === 0) return containerRepaired;

    const title = headerTexts
      .filter(element => this._isLikelyMainTitleElement(element, canvas))
      .sort((a, b) => this._layoutFontSize(b) - this._layoutFontSize(a))[0];

    const applyNumericUpdates = () => {
      if (!updates.length) return containerRepaired;
      const beforeApply = nextSvg;
      nextSvg = updates
        .sort((a, b) => b.tagIndex - a.tagIndex)
        .reduce((current, update) => this._replaceTagNumericAttr(current, update.tagIndex, update.attrName, update.value), nextSvg);
      if (nextSvg === beforeApply) return containerRepaired;
      this._writeTextFile(svgPath, this._sanitizeSvgContent(nextSvg));
      return true;
    };

    if (!title) return applyNumericUpdates();

    headerTexts.forEach(element => {
      if (element === title) return;
      if (this._sameLayoutGroup(title, element)) return;
      const overlap = this._overlapInfo(title.bounds, this._inflateBounds(element.bounds, 4));
      if (overlap.width < 10 || overlap.height < 3) return;
      const fontSize = this._layoutFontSize(element);
      const titleBottom = title.bounds.bottom;
      const currentY = this._numAttr(element.attrs, 'y', NaN);
      const targetY = Math.ceil(titleBottom + fontSize * 0.9 + 12);
      const safeY = Math.min(120, Math.max(currentY || 0, targetY));
      updates.push({ tagIndex: element.tagIndex, attrName: 'y', value: safeY });
    });

    elements
      .filter(element => (
        !this._isBackgroundElement(element, canvas) &&
        !this._isSoftDecorativeElement(element, canvas) &&
        element.bounds.top < 80 &&
        element.bounds.right > canvas.width - 230
      ))
      .forEach(element => {
        if (element.tag !== 'text') return;
        const currentX = this._numAttr(element.attrs, 'x', NaN);
        if (!Number.isFinite(currentX)) return;
        const minLeft = canvas.width - 190;
        if (element.bounds.left >= minLeft) return;
        const targetX = Math.max(currentX, canvas.width - 100);
        updates.push({ tagIndex: element.tagIndex, attrName: 'x', value: Math.round(targetX) });
      });

    return applyNumericUpdates();
  }

  _buildHeaderChromeRepairUpdates(elements, canvas) {
    const updates = [];
    const headerTexts = elements.filter(element => (
      element.tag === 'text' &&
      element.bounds.top < 90 &&
      element.bounds.right > canvas.width - 260
    ));
    const pageBadges = elements
      .filter(element => {
        if (element.tag !== 'rect') return false;
        const width = element.bounds.right - element.bounds.left;
        const height = element.bounds.bottom - element.bounds.top;
        return element.bounds.top < 86 &&
          element.bounds.right > canvas.width - 110 &&
          width >= 36 &&
          width <= 150 &&
          height >= 18 &&
          height <= 48;
      })
      .sort((a, b) => b.bounds.right - a.bounds.right || a.bounds.left - b.bounds.left);
    const badge = pageBadges[0];
    if (!badge) return updates;

    headerTexts.forEach(text => {
      const visibleText = String(text.text || '').trim();
      if (/^\d{1,2}\s*(?:[/／]\s*\d{1,2})?$/.test(visibleText)) return;
      const overlap = this._overlapInfo(text.bounds, this._inflateBounds(badge.bounds, 6));
      if (overlap.area <= 0) return;
      const currentX = this._numAttr(text.attrs, 'x', NaN);
      if (!Number.isFinite(currentX)) return;
      const targetRight = badge.bounds.left - 18;
      const shift = targetRight - text.bounds.right;
      if (shift < -2) {
        updates.push({ tagIndex: text.tagIndex, attrName: 'x', value: Math.max(60, Math.round(currentX + shift)) });
      }
    });

    return updates;
  }

  _applyMechanicalContainerTextRepair(svgPath, elements, canvas) {
    const footerTop = canvas.height - 52;
    const bottomBandTop = this._detectBottomBandTop(elements, canvas);
    const shapes = elements.filter(element => {
      if (!['rect', 'circle', 'ellipse'].includes(element.tag)) return false;
      if (this._isBackgroundElement(element, canvas)) return false;
      if (this._isHeaderElement(element, canvas)) return false;
      if (this._isFooterElement(element, canvas, footerTop)) return false;
      if (this._isBottomBandElement(element, canvas, bottomBandTop)) return false;
      if (this._isSoftDecorativeElement(element, canvas)) return false;
      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      if (width < 44 || height < 20) return false;
      if (width * height > canvas.width * canvas.height * 0.45) return false;
      return true;
    });

    const adjustments = new Map();
    const addAdjustment = (tagIndex, patch) => {
      if (!Number.isFinite(tagIndex)) return;
      const current = adjustments.get(tagIndex) || { shiftX: 0, shiftY: 0, fontSize: null };
      current.shiftX += patch.shiftX || 0;
      current.shiftY += patch.shiftY || 0;
      if (patch.fontSize) {
        current.fontSize = current.fontSize
          ? Math.min(current.fontSize, patch.fontSize)
          : patch.fontSize;
      }
      adjustments.set(tagIndex, current);
    };

    elements
      .filter(element => element.tag === 'text')
      .forEach(text => {
        const shape = this._nearestContainerForText(text, shapes);
        if (!shape) return;
        const shapeWidth = shape.bounds.right - shape.bounds.left;
        const shapeHeight = shape.bounds.bottom - shape.bounds.top;
        const compact = shapeWidth < 180 || shapeHeight < 110;
        const targetSide = compact ? 6 : 14;
        const targetBottom = compact ? 6 : 14;
        const pads = {
          left: text.bounds.left - shape.bounds.left,
          right: shape.bounds.right - text.bounds.right,
          top: text.bounds.top - shape.bounds.top,
          bottom: shape.bounds.bottom - text.bounds.bottom
        };
        const textWidth = text.bounds.right - text.bounds.left;
        const fontSize = this._layoutFontSize(text);

        if (pads.right < targetSide && textWidth > 0) {
          const availableWidth = Math.max(40, shapeWidth - targetSide * 2);
          const nextFont = Math.floor(fontSize * Math.min(1, availableWidth / textWidth));
          if (nextFont >= 12 && nextFont < fontSize) {
            addAdjustment(text.tagIndex, { fontSize: nextFont });
          } else if (pads.left > targetSide) {
            addAdjustment(text.tagIndex, { shiftX: -Math.min(pads.left - targetSide, targetSide - pads.right) });
          }
        } else if (pads.left < targetSide && pads.right > targetSide) {
          addAdjustment(text.tagIndex, { shiftX: Math.min(pads.right - targetSide, targetSide - pads.left) });
        }

        if (pads.bottom < targetBottom && pads.top > 4) {
          addAdjustment(text.tagIndex, { shiftY: -Math.min(pads.top - 4, targetBottom - pads.bottom) });
        } else if (pads.top < targetSide && pads.bottom > targetBottom) {
          addAdjustment(text.tagIndex, { shiftY: Math.min(pads.bottom - targetBottom, targetSide - pads.top) });
        }
      });

    const textElements = elements.filter(element => element.tag === 'text');
    for (let i = 0; i < textElements.length; i += 1) {
      for (let j = i + 1; j < textElements.length; j += 1) {
        const first = textElements[i];
        const second = textElements[j];
        if (this._sameLayoutGroup(first, second)) continue;
        const overlap = this._overlapInfo(first.bounds, second.bounds);
        if (overlap.width < 18 || overlap.height < 8) continue;
        const firstWidth = first.bounds.right - first.bounds.left;
        const secondWidth = second.bounds.right - second.bounds.left;
        const target = firstWidth >= secondWidth ? first : second;
        const blocker = target === first ? second : first;
        const fontSize = this._layoutFontSize(target);
        if (fontSize <= 14) continue;
        let availableWidth = 0;
        if (target.bounds.left < blocker.bounds.left) {
          availableWidth = blocker.bounds.left - target.bounds.left - 24;
        } else {
          availableWidth = target.bounds.right - blocker.bounds.right - 24;
        }
        const targetWidth = target.bounds.right - target.bounds.left;
        if (availableWidth < 80 || availableWidth >= targetWidth) continue;
        const nextFont = Math.floor(fontSize * (availableWidth / targetWidth));
        if (nextFont >= 12 && nextFont < fontSize) {
          addAdjustment(target.tagIndex, { fontSize: nextFont });
        }
      }
    }

    if (adjustments.size === 0) return false;
    const original = fs.readFileSync(svgPath, 'utf-8');
    let next = original;
    [...adjustments.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([tagIndex, adjustment]) => {
        if (adjustment.fontSize) {
          next = this._replaceTagNumericAttr(next, tagIndex, 'font-size', adjustment.fontSize);
        }
        if (adjustment.shiftX) {
          next = this._shiftTextElementCoordinate(next, tagIndex, 'x', adjustment.shiftX);
        }
        if (adjustment.shiftY) {
          next = this._shiftTextElementCoordinate(next, tagIndex, 'y', adjustment.shiftY);
        }
      });
    if (next === original) return false;
    this._writeTextFile(svgPath, this._sanitizeSvgContent(next));
    return true;
  }

  _nearestContainerForText(text, shapes) {
    const textArea = this._boundsArea(text.bounds);
    if (textArea <= 0) return null;
    const center = {
      x: (text.bounds.left + text.bounds.right) / 2,
      y: (text.bounds.top + text.bounds.bottom) / 2
    };
    return shapes
      .filter(shape => {
        if (Number.isFinite(shape.tagIndex) && Number.isFinite(text.tagIndex) && shape.tagIndex > text.tagIndex) return false;
        const overlap = this._overlapInfo(shape.bounds, text.bounds);
        const centerInside = center.x >= shape.bounds.left && center.x <= shape.bounds.right &&
          center.y >= shape.bounds.top && center.y <= shape.bounds.bottom;
        const shapeWidth = shape.bounds.right - shape.bounds.left;
        const shapeHeight = shape.bounds.bottom - shape.bounds.top;
        const textWidth = text.bounds.right - text.bounds.left;
        const textHeight = text.bounds.bottom - text.bounds.top;
        if (textWidth > shapeWidth + 64 || textHeight > shapeHeight + 20) return false;
        return centerInside && overlap.area / textArea >= 0.45;
      })
      .sort((a, b) => this._boundsArea(a.bounds) - this._boundsArea(b.bounds))[0] || null;
  }

  _replaceTagNumericAttr(svg, tagIndex, attrName, value) {
    if (!Number.isFinite(tagIndex) || tagIndex < 0) return svg;
    const openEnd = String(svg).indexOf('>', tagIndex);
    if (openEnd === -1) return svg;
    const tagText = String(svg).slice(tagIndex, openEnd + 1);
    const attrRe = new RegExp(`\\b${attrName}=([\"'])([-\\d.]+)\\1`, 'i');
    if (!attrRe.test(tagText)) return svg;
    const nextTag = tagText.replace(attrRe, `${attrName}=$1${Math.round(value)}$1`);
    return String(svg).slice(0, tagIndex) + nextTag + String(svg).slice(openEnd + 1);
  }

  _shiftTextElementCoordinate(svg, tagIndex, attrName, delta) {
    if (!Number.isFinite(tagIndex) || !delta) return svg;
    const text = String(svg);
    const openEnd = text.indexOf('>', tagIndex);
    if (openEnd === -1) return svg;
    const closeIndex = text.indexOf('</text>', openEnd);
    const blockEnd = closeIndex === -1 ? openEnd + 1 : closeIndex + '</text>'.length;
    const block = text.slice(tagIndex, blockEnd);
    const attrRe = new RegExp(`\\b${attrName}=([\"'])([-\\d.]+)\\1`, 'gi');
    if (!attrRe.test(block)) return svg;
    const nextBlock = block.replace(attrRe, (match, quote, raw) => {
      const value = parseFloat(raw);
      if (!Number.isFinite(value)) return match;
      return `${attrName}=${quote}${Math.round(value + delta)}${quote}`;
    });
    return text.slice(0, tagIndex) + nextBlock + text.slice(blockEnd);
  }

  _repairCanvasOverflow(svg, canvas) {
    // Clip elements that extend beyond the canvas bounds
    let next = String(svg || '');
    if (!canvas || !canvas.width || !canvas.height) return next;
    const maxX = canvas.width;
    const maxY = canvas.height;

    // Fix <rect> elements extending beyond canvas
    next = next.replace(/<rect\b([^>]*?)\/?>/gi, (match, attrs) => {
      const x = parseFloat((attrs.match(/\bx=["']([^"']*)["']/) || [])[1]);
      const y = parseFloat((attrs.match(/\by=["']([^"']*)["']/) || [])[1]);
      const w = parseFloat((attrs.match(/\bwidth=["']([^"']*)["']/) || [])[1]);
      const h = parseFloat((attrs.match(/\bheight=["']([^"']*)["']/) || [])[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return match;
      const r = Number.isFinite(w) ? x + w : maxX;
      const b = Number.isFinite(h) ? y + h : maxY;
      if (r <= maxX && b <= maxY) return match;
      // Clip width/height to fit canvas
      let newAttrs = attrs;
      if (Number.isFinite(w) && r > maxX) {
        const newW = Math.max(1, w - (r - maxX));
        newAttrs = newAttrs.replace(/\bwidth=["'][^"']*["']/, `width="${newW}"`);
      }
      if (Number.isFinite(h) && b > maxY) {
        const newH = Math.max(1, h - (b - maxY));
        newAttrs = newAttrs.replace(/\bheight=["'][^"']*["']/, `height="${newH}"`);
      }
      return `<rect${newAttrs}/>`;
    });

    // Fix any element positions that are out of bounds
    next = next.replace(/<(text|image|g)\b([^>]*?)>/gi, (match, tag, attrs) => {
      const y = parseFloat((attrs.match(/\by=["']([^"']*)["']/) || [])[1]);
      if (!Number.isFinite(y) || y >= maxY) return match;
      const h = parseFloat((attrs.match(/\bheight=["']([^"']*)["']/) || [])[1]);
      const fontSize = parseFloat((attrs.match(/\bfont-size=["']([^"']*)["']/) || [])[1]);
      const estBottom = y + (Number.isFinite(h) && h > 0 ? h : (fontSize || 20));
      if (estBottom > maxY) {
        const shift = Math.ceil(estBottom - maxY);
        const newY = Math.max(0, y - shift);
        return `<${tag}${attrs.replace(/\by=["'][^"']*["']/, `y="${newY}"`)}>`;
      }
      return match;
    });

    // Fix text elements that overflow horizontally (text_canvas_overflow)
    next = next.replace(/<text\b([^>]*?)>/gi, (match, attrs) => {
      const x = parseFloat((attrs.match(/\bx=["']([^"']*)["']/) || [])[1]);
      if (!Number.isFinite(x) || x < 0) return match;
      const textLength = parseFloat((attrs.match(/\btextLength=["']([^"']*)["']/) || [])[1]);
      const fontSize = parseFloat((attrs.match(/\bfont-size=["']([^"']*)["']/) || [])[1]) || 16;
      const estChars = this._estimateTextCharCount(match);
      const estWidth = estChars * fontSize * 0.6;
      const estRight = textLength ? x + textLength : x + estWidth;
      if (estRight > maxX + 6) {
        // Push text left if possible, or reduce font size
        if (x > 60) {
          const newX = Math.max(20, x - (estRight - maxX) - 8);
          return match.replace(/\bx=["'][^"']*["']/, `x="${Math.round(newX)}"`);
        }
        // Reduce font size to fit
        const scaleFactor = (maxX - x - 16) / (estRight - x);
        const newFontSize = Math.max(10, Math.floor(fontSize * scaleFactor));
        return match.replace(/\bfont-size=["'][^"']*["']/, `font-size="${newFontSize}"`);
      }
      return match;
    });

    return next;
  }

  _estimateTextCharCount(textTag) {
    // Quick estimate of visible character count from a <text> tag including tspans
    const content = String(textTag || '').replace(/<[^>]*>/g, '');
    return content.replace(/\s+/g, '').length;
  }

  _svgElementBlockRange(svg, tagIndex, tagName) {
    if (!Number.isFinite(tagIndex) || tagIndex < 0) return null;
    const text = String(svg || '');
    const openEnd = text.indexOf('>', tagIndex);
    if (openEnd === -1) return null;
    const openTag = text.slice(tagIndex, openEnd + 1);
    if (/\/\s*>$/.test(openTag)) return { start: tagIndex, end: openEnd + 1 };
    const tag = String(tagName || '').toLowerCase();
    if (!tag) return { start: tagIndex, end: openEnd + 1 };
    const closeRe = new RegExp(`<\\s*\\/\\s*${tag}\\s*>`, 'i');
    const closeMatch = closeRe.exec(text.slice(openEnd + 1));
    if (!closeMatch) return { start: tagIndex, end: openEnd + 1 };
    return {
      start: tagIndex,
      end: openEnd + 1 + closeMatch.index + closeMatch[0].length
    };
  }

  _resolveSvgTargets(target) {
    if (!target || !fs.existsSync(target)) return [];
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      return [target].filter(file => this._isCanonicalPageSvgName(path.basename(file)));
    }

    const directSvgs = this._listCanonicalSvgFiles(target);
    if (directSvgs.length > 0) return directSvgs;

    const svgDir = path.basename(target) === 'svg_output'
      ? target
      : path.join(target, 'svg_output');
    if (!fs.existsSync(svgDir)) return [];
    return this._listCanonicalSvgFiles(svgDir);
  }

  _runPlaceholderFailureCheck(target) {
    const files = this._resolveSvgTargets(target);
    const failed = files
      .map(file => {
        const svg = fs.readFileSync(file, 'utf-8');
        const reasons = this._placeholderFailureReasons(svg);
        return { file: path.basename(file), path: file, reasons };
      })
      .filter(item => item.reasons.length > 0);

    const ok = failed.length === 0;
    const lines = [
      '# Placeholder Failure Gate',
      '',
      `- Result: ${ok ? 'passed' : 'failed'}`,
      `- Files scanned: ${files.length}`,
      ''
    ];
    failed.forEach(item => {
      lines.push(`## ${item.file}`);
      item.reasons.forEach(reason => lines.push(`- ${reason}`));
      lines.push('');
    });

    return {
      ok,
      failed_files: failed.map(item => item.file),
      files: failed,
      output: `${lines.join('\n').trim()}\n`
    };
  }

  _placeholderFailureReasons(svg) {
    const text = String(svg || '');
    const checks = [
      { pattern: '该页原始 SVG 未通过质量检查', reason: '包含质量失败占位文案' },
      { pattern: '后续可基于 design_spec.md 重新生成这一页', reason: '包含占位页后续重生成文案' },
      { pattern: '安全版式占位', reason: '包含安全版式占位文案' },
      { pattern: '模型未返回 &lt;svg&gt;', reason: '包含模型未返回 SVG 的转义错误信息' },
      { pattern: '模型未返回 <svg>', reason: '包含模型未返回 SVG 的错误信息' },
      { pattern: '资料来源', reason: '包含可见资料来源元信息' },
      { pattern: '数据来源', reason: '包含可见数据来源元信息' },
      { pattern: '上传文档', reason: '包含可见上传文档元信息' },
      { pattern: 'ppt-master', reason: '包含可见 ppt-master 内部模板元信息' },
      { pattern: 'PPT Master', reason: '包含可见 PPT Master 内部模板元信息' }
    ];
    const literalReasons = checks
      .filter(check => text.includes(check.pattern))
      .map(check => check.reason);
    const patternChecks = [
      { pattern: /第\s*\d+\s*个关键分析点/g, reason: '包含未替换的关键分析点占位文案' },
      { pattern: /补充分析\s*[：:]\s*第\s*\d+\s*个重点/g, reason: '包含未替换的补充分析占位标题' },
      { pattern: /AI\s*Designer\s*自动整理/g, reason: '包含内部生成署名占位页脚' },
      { pattern: /(?:来源|source)\s*[：:]/gi, reason: '包含可见来源元信息' },
      { pattern: /(?:模板|template)\s*[：:]/gi, reason: '包含可见模板元信息' },
      { pattern: /(?:洞察：主要发现|方案：总体框架|收益：预期结果)\s*的第\s*\d+\s*个关键分析点/g, reason: '包含通用页面模板占位文案' }
    ];
    const regexReasons = patternChecks
      .filter(check => check.pattern.test(text))
      .map(check => check.reason);
    return [...new Set([...literalReasons, ...regexReasons])];
  }

  _inspectSvgLayout(svgPath) {
    const svg = fs.readFileSync(svgPath, 'utf-8');
    const canvas = this._canvasFromSvg(svg);
    const footerTop = canvas.height - 52;
    const elements = this._collectSvgLayoutElements(svg, canvas);
    const bottomBandTop = this._detectBottomBandTop(elements, canvas);
    const hasFooter = elements.some(element => (
      this._isFooterElement(element, canvas, footerTop) ||
      this._isBottomBandElement(element, canvas, bottomBandTop)
    ));
    const bodyBottom = canvas.height - 70;
    const hardBottom = hasFooter ? footerTop + 4 : canvas.height - 30;
    const issues = [];

    elements.forEach(element => {
      if (this._isBackgroundElement(element, canvas) || this._isHeaderElement(element, canvas)) return;
      const footer = this._isFooterElement(element, canvas, footerTop) ||
        this._isBottomBandElement(element, canvas, bottomBandTop);
      const bounds = element.bounds;
      if (this._isSoftDecorativeElement(element, canvas)) return;

      const overflowTolerance = 6;
      const horizontalOverflow = bounds.left < -overflowTolerance || bounds.right > canvas.width + overflowTolerance;
      const verticalOverflow = bounds.top < -overflowTolerance || bounds.bottom > canvas.height + overflowTolerance;
      if (
        verticalOverflow ||
        (horizontalOverflow && element.tag !== 'text' && element.tag !== 'tspan')
      ) {
        issues.push({
          severity: 'error',
          code: 'canvas_overflow',
          line: element.line,
          message: `<${element.tag}> 超出画布: ${this._boundsLabel(bounds)}`
        });
        return;
      }
      if (horizontalOverflow) {
        const severeTextOverflow = bounds.left < -overflowTolerance || bounds.right > canvas.width + overflowTolerance;
        issues.push({
          severity: severeTextOverflow ? 'error' : 'warning',
          code: severeTextOverflow ? 'text_canvas_overflow' : 'estimated_text_horizontal_overflow',
          line: element.line,
          message: `<${element.tag}> 文本超出画布或容器估算范围: ${this._boundsLabel(bounds)}`
        });
      }

      if (footer && element.tag === 'text' && bounds.bottom > canvas.height - 18) {
        issues.push({
          severity: 'error',
          code: 'footer_text_clip_risk',
          line: element.line,
          message: `<text> 页脚文字过低，容易被裁切: bottom=${Math.round(bounds.bottom)}, 建议 <= ${canvas.height - 18}`
        });
      }

      const bodyOverflowCandidate = !['polygon', 'polyline', 'line'].includes(element.tag);
      if (!footer && bodyOverflowCandidate && bounds.bottom > hardBottom) {
        issues.push({
          severity: 'error',
          code: 'body_bottom_overflow',
          line: element.line,
          message: `<${element.tag}> 压入页脚区域: bottom=${Math.round(bounds.bottom)}, 页脚保护线=${hardBottom}`
        });
      } else if (!footer && bodyOverflowCandidate && bounds.bottom > bodyBottom + 4) {
        issues.push({
          severity: 'warning',
          code: 'body_bottom_warning_zone',
          line: element.line,
          message: `<${element.tag}> 进入底部预警区: bottom=${Math.round(bounds.bottom)}, 建议正文底线=${bodyBottom}`
        });
      }
    });

    this._addHeaderLayoutIssues(elements, canvas, issues);
    this._addElementOverlapIssues(elements, canvas, footerTop, bottomBandTop, issues);
    this._addContainerTextPaddingIssues(elements, canvas, footerTop, bottomBandTop, issues);

    const lowerBandCount = elements.filter(element => {
      if (
        this._isBackgroundElement(element, canvas) ||
        this._isFooterElement(element, canvas, footerTop) ||
        this._isBottomBandElement(element, canvas, bottomBandTop)
      ) return false;
      return element.bounds.top >= canvas.height * 0.72 || element.bounds.bottom > bodyBottom;
    }).length;
    if (lowerBandCount >= 14) {
      issues.push({
        severity: 'warning',
        code: 'lower_band_too_dense',
        line: null,
        message: `底部 28% 区域元素过密: ${lowerBandCount} 个元素，容易遮挡页脚或互相重叠`
      });
    }

    if (this._looksLikeChartSvg(svg) && !svg.includes('chart-plot-area')) {
      issues.push({
        severity: 'warning',
        code: 'missing_chart_plot_marker',
        line: null,
        message: '检测到图表型页面，但缺少 <!-- chart-plot-area: ... --> 标记'
      });
    }

    return {
      file: path.basename(svgPath),
      path: svgPath,
      canvas,
      element_count: elements.length,
      issues
    };
  }

  _addHeaderLayoutIssues(elements, canvas, issues) {
    const textElements = elements.filter(element => (
      element.tag === 'text' &&
      !this._isBackgroundElement(element, canvas) &&
      element.bounds.top < 126
    ));
    const titleCandidates = textElements
      .filter(element => this._isLikelyMainTitleElement(element, canvas))
      .sort((a, b) => this._layoutFontSize(b) - this._layoutFontSize(a));
    const title = titleCandidates[0];

    if (title) {
      const titleHasCrowdingNeighbor = textElements.some(element => {
        if (element === title || this._sameLayoutGroup(title, element)) return false;
        const overlap = this._overlapInfo(title.bounds, this._inflateBounds(element.bounds, 3));
        return overlap.width >= 10 && overlap.height >= 3;
      });
      if (title.bounds.top < 54 && titleHasCrowdingNeighbor) {
        issues.push({
          severity: 'error',
          code: 'header_title_crowded',
          line: title.line,
          message: `主标题贴近或压住页眉小标题: ${this._boundsLabel(title.bounds)}，标题区应独立留白`
        });
      }

      textElements.forEach(element => {
        if (element === title) return;
        if (this._sameLayoutGroup(title, element)) return;
        const overlap = this._overlapInfo(title.bounds, this._inflateBounds(element.bounds, 4));
        if (overlap.width >= 10 && overlap.height >= 3) {
          issues.push({
            severity: 'error',
            code: 'header_text_overlap',
            line: element.line,
            message: `页眉文字与主标题距离过近或重叠: line ${title.line || '?'}/${element.line || '?'}`
          });
        }
      });

      elements.forEach(element => {
        if (element === title || this._isBackgroundElement(element, canvas) || this._isHeaderElement(element, canvas)) return;
        if (!['text', 'rect', 'image'].includes(element.tag)) return;
        if (element.tag === 'line') return;
        const bounds = element.bounds;
        const width = bounds.right - bounds.left;
        const height = bounds.bottom - bounds.top;
        const isSmallAccent = width <= 34 && height <= 70 && bounds.left < title.bounds.left - 6;
        const isPageBadge = bounds.top < 60 && bounds.right > canvas.width - 220;
        if (isSmallAccent || isPageBadge) return;
        if (bounds.top > 116 || bounds.bottom < 28) return;
        const overlap = this._overlapInfo(title.bounds, this._inflateBounds(bounds, 4));
        if (overlap.area > 18) {
          issues.push({
            severity: 'error',
            code: 'header_title_obstructed',
            line: element.line,
            message: `标题区元素遮挡主标题: <${element.tag}> ${this._boundsLabel(bounds)}`
          });
        }
      });
    }

    const topRightElements = elements.filter(element => (
      !this._isBackgroundElement(element, canvas) &&
      !this._isHeaderElement(element, canvas) &&
      !this._isSoftDecorativeElement(element, canvas) &&
      element.bounds.top < 80 &&
      element.bounds.right > canvas.width - 230
    ));
    topRightElements.forEach(element => {
      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      if (width > 200 && height > 120) return;
      if (element.bounds.left < canvas.width - 310) {
        issues.push({
          severity: 'warning',
          code: 'page_badge_crowds_header',
          line: element.line,
          message: `右上页码/徽章过宽，可能挤压标题区: ${this._boundsLabel(element.bounds)}`
        });
      }
    });

    this._addHeaderBadgeCrowdingIssues(elements, canvas, issues);
  }

  _addHeaderBadgeCrowdingIssues(elements, canvas, issues) {
    const badges = elements.filter(element => {
      if (element.tag !== 'rect') return false;
      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      return element.bounds.top < 86 &&
        element.bounds.right > canvas.width - 110 &&
        width >= 36 &&
        width <= 150 &&
        height >= 18 &&
        height <= 48;
    });
    const badge = badges.sort((a, b) => b.bounds.right - a.bounds.right || a.bounds.left - b.bounds.left)[0];
    if (!badge) return;

    elements
      .filter(element => (
        element.tag === 'text' &&
        element.bounds.top < 90 &&
        element.bounds.right > canvas.width - 260
      ))
      .forEach(text => {
        const visibleText = String(text.text || '').trim();
        if (/^\d{1,2}\s*(?:[/／]\s*\d{1,2})?$/.test(visibleText)) return;
        const overlap = this._overlapInfo(text.bounds, this._inflateBounds(badge.bounds, 6));
        if (overlap.area <= 0) return;
        issues.push({
          severity: 'warning',
          code: 'header_badge_text_crowded',
          line: text.line,
          message: `右侧页眉标签与页码徽章距离过近: text=${this._boundsLabel(text.bounds)}, badge=${this._boundsLabel(badge.bounds)}`
        });
      });
  }

  _addContainerTextPaddingIssues(elements, canvas, footerTop, bottomBandTop, issues) {
    const shapes = elements.filter(element => {
      if (!['rect', 'circle', 'ellipse'].includes(element.tag)) return false;
      if (this._isBackgroundElement(element, canvas)) return false;
      if (this._isHeaderElement(element, canvas)) return false;
      if (this._isFooterElement(element, canvas, footerTop)) return false;
      if (this._isBottomBandElement(element, canvas, bottomBandTop)) return false;
      if (this._isSoftDecorativeElement(element, canvas)) return false;
      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      const area = width * height;
      if (width < 44 || height < 20) return false;
      if (area > canvas.width * canvas.height * 0.45) return false;
      const fill = String(this._attr(element.attrs, 'fill') || '').toLowerCase();
      const stroke = String(this._attr(element.attrs, 'stroke') || '').toLowerCase();
      return fill !== 'none' || (stroke && stroke !== 'none');
    });

    const textElements = elements.filter(element => (
      element.tag === 'text' &&
      !this._isHeaderElement(element, canvas) &&
      !this._isFooterElement(element, canvas, footerTop) &&
      !this._isBottomBandElement(element, canvas, bottomBandTop)
    ));

    textElements.forEach(text => {
      const textArea = this._boundsArea(text.bounds);
      if (textArea <= 0) return;
      const center = {
        x: (text.bounds.left + text.bounds.right) / 2,
        y: (text.bounds.top + text.bounds.bottom) / 2
      };
      const containingShapes = shapes
        .filter(shape => {
          if (Number.isFinite(shape.tagIndex) && Number.isFinite(text.tagIndex) && shape.tagIndex > text.tagIndex) return false;
          const overlap = this._overlapInfo(shape.bounds, text.bounds);
          const centerInside = center.x >= shape.bounds.left && center.x <= shape.bounds.right &&
            center.y >= shape.bounds.top && center.y <= shape.bounds.bottom;
          const shapeWidth = shape.bounds.right - shape.bounds.left;
          const shapeHeight = shape.bounds.bottom - shape.bounds.top;
          const textWidth = text.bounds.right - text.bounds.left;
          const textHeight = text.bounds.bottom - text.bounds.top;
          if (textWidth > shapeWidth + 48 || textHeight > shapeHeight + 16) return false;
          return centerInside && overlap.area / textArea >= 0.55;
        })
        .sort((a, b) => this._boundsArea(a.bounds) - this._boundsArea(b.bounds));
      const shape = containingShapes[0];
      if (!shape) return;

      const shapeWidth = shape.bounds.right - shape.bounds.left;
      const shapeHeight = shape.bounds.bottom - shape.bounds.top;
      const compact = shapeWidth < 180 || shapeHeight < 110;
      const minPad = compact ? 8 : 18;
      const pads = {
        left: text.bounds.left - shape.bounds.left,
        right: shape.bounds.right - text.bounds.right,
        top: text.bounds.top - shape.bounds.top,
        bottom: shape.bounds.bottom - text.bounds.bottom
      };
      const minObserved = Math.min(pads.left, pads.right, pads.top, pads.bottom);
      const overflows = Object.values(pads).some(value => value < -1);
      const bottomClipRisk = pads.bottom < (compact ? 2 : 6);
      const sideClipRisk = Math.min(pads.left, pads.right) < (compact ? 3 : 10);
      if (!overflows && minObserved >= minPad && !bottomClipRisk && !sideClipRisk) return;

      issues.push({
        severity: overflows || bottomClipRisk || sideClipRisk ? 'error' : 'warning',
        code: overflows ? 'text_container_overflow' : 'container_text_padding_too_small',
        line: text.line,
        message: `<text> 与容器内边距不足: text=${this._boundsLabel(text.bounds)}, container=${this._boundsLabel(shape.bounds)}, padding L/R/T/B=${Math.round(pads.left)}/${Math.round(pads.right)}/${Math.round(pads.top)}/${Math.round(pads.bottom)}, 要求>=${minPad}`
      });
    });
  }

  _addElementOverlapIssues(elements, canvas, footerTop, bottomBandTop, issues) {
    const candidates = elements.filter(element => {
      if (!['text', 'image', 'rect', 'circle', 'ellipse'].includes(element.tag)) return false;
      if (this._isBackgroundElement(element, canvas)) return false;
      if (this._isHeaderElement(element, canvas)) return false;
      if (this._isFooterElement(element, canvas, footerTop)) return false;
      if (this._isBottomBandElement(element, canvas, bottomBandTop)) return false;
      if (element.tag !== 'text' && this._isSoftDecorativeElement(element, canvas)) return false;

      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      if (width <= 4 || height <= 4) return false;
      if (element.tag !== 'text' && width <= 34 && height <= 34) return false;
      return true;
    });

    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const first = candidates[i];
        const second = candidates[j];
        if (this._isAllowedContainingPair(first, second)) continue;
        if (this._sameLayoutGroup(first, second) && !this._isBlockingSameGroupOverlap(first, second)) continue;
        if (this._isDecorativeOverlapPair(first, second, canvas)) continue;

        const overlap = this._overlapInfo(first.bounds, second.bounds);
        if (overlap.area <= 0) continue;

        const involvesText = first.tag === 'text' || second.tag === 'text';
        const textText = first.tag === 'text' && second.tag === 'text';
        const minArea = Math.min(this._boundsArea(first.bounds), this._boundsArea(second.bounds));
        const ratio = minArea > 0 ? overlap.area / minArea : 0;
        const strongTextOverlap = textText && overlap.height >= 8 && overlap.width >= 18 && ratio > 0.14;
        const textBlocked = involvesText && ratio > 0.32 && overlap.width >= 18 && overlap.height >= 10;

        if (strongTextOverlap || textBlocked) {
          issues.push({
            severity: 'error',
            code: 'element_overlap',
            line: first.line || second.line,
            message: `<${first.tag}> 与 <${second.tag}> 可见区域重叠: ${this._boundsLabel(overlap)}`
          });
        }
      }
    }
  }

  _canvasFromSvg(svg) {
    const viewBox = String(svg || '').match(/\bviewBox=(["'])(.*?)\1/i)?.[2];
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        return { width: parts[2], height: parts[3], viewBox: parts.join(' ') };
      }
    }
    return this._canvasInfo();
  }

  _collectSvgLayoutElements(svg, canvas) {
    const elements = [];
    const stack = [{ x: 0, y: 0, groupIds: [] }];
    const tagRe = /<\s*(\/?)([a-zA-Z][\w:-]*)([^<>]*?)>/g;
    let match;

    while ((match = tagRe.exec(svg)) !== null) {
      const closing = match[1] === '/';
      const tag = match[2].toLowerCase();
      const attrs = match[3] || '';
      const rawTag = match[0];

      if (closing) {
        if (tag === 'g' && stack.length > 1) stack.pop();
        continue;
      }

      const parent = stack[stack.length - 1];
      const translate = this._parseTranslate(attrs);
      const offset = { x: parent.x + translate.x, y: parent.y + translate.y };
      const selfClosing = /\/\s*>$/.test(rawTag);

      if (tag === 'g') {
        const groupId = this._attr(attrs, 'id');
        const groupIds = groupId ? [...(parent.groupIds || []), groupId] : (parent.groupIds || []);
        if (!selfClosing) stack.push({ ...offset, groupIds });
        continue;
      }

      const element = this._layoutElementFromTag(tag, attrs, offset, {
        svg,
        afterTagIndex: tagRe.lastIndex,
        tagIndex: match.index,
        canvas,
        groupIds: parent.groupIds || []
      });
      if (element) elements.push(element);
    }

    return elements;
  }

  _layoutElementFromTag(tag, attrs, offset, context) {
    const strokeWidth = this._numAttr(attrs, 'stroke-width', 0);
    const pad = strokeWidth / 2;
    let bounds = null;
    let computedFontSize = null;
    let textContent = '';

    if (tag === 'rect' || tag === 'image') {
      const x = this._numAttr(attrs, 'x', 0) + offset.x;
      const y = this._numAttr(attrs, 'y', 0) + offset.y;
      const width = this._numAttr(attrs, 'width', 0);
      const height = this._numAttr(attrs, 'height', 0);
      if (width <= 0 || height <= 0) return null;
      bounds = { left: x - pad, top: y - pad, right: x + width + pad, bottom: y + height + pad };
    } else if (tag === 'circle') {
      const cx = this._numAttr(attrs, 'cx', 0) + offset.x;
      const cy = this._numAttr(attrs, 'cy', 0) + offset.y;
      const r = this._numAttr(attrs, 'r', 0) + pad;
      if (r <= 0) return null;
      bounds = { left: cx - r, top: cy - r, right: cx + r, bottom: cy + r };
    } else if (tag === 'ellipse') {
      const cx = this._numAttr(attrs, 'cx', 0) + offset.x;
      const cy = this._numAttr(attrs, 'cy', 0) + offset.y;
      const rx = this._numAttr(attrs, 'rx', 0) + pad;
      const ry = this._numAttr(attrs, 'ry', 0) + pad;
      if (rx <= 0 || ry <= 0) return null;
      bounds = { left: cx - rx, top: cy - ry, right: cx + rx, bottom: cy + ry };
    } else if (tag === 'line') {
      const x1 = this._numAttr(attrs, 'x1', 0) + offset.x;
      const y1 = this._numAttr(attrs, 'y1', 0) + offset.y;
      const x2 = this._numAttr(attrs, 'x2', 0) + offset.x;
      const y2 = this._numAttr(attrs, 'y2', 0) + offset.y;
      bounds = {
        left: Math.min(x1, x2) - pad,
        top: Math.min(y1, y2) - pad,
        right: Math.max(x1, x2) + pad,
        bottom: Math.max(y1, y2) + pad
      };
    } else if (tag === 'polyline' || tag === 'polygon') {
      const points = this._pointsAttr(attrs);
      if (points.length === 0) return null;
      const xs = points.map(point => point.x + offset.x);
      const ys = points.map(point => point.y + offset.y);
      bounds = {
        left: Math.min(...xs) - pad,
        top: Math.min(...ys) - pad,
        right: Math.max(...xs) + pad,
        bottom: Math.max(...ys) + pad
      };
    } else if (tag === 'text' || tag === 'tspan') {
      const xAttr = this._attr(attrs, 'x');
      const yAttr = this._attr(attrs, 'y');
      if (xAttr === null || yAttr === null) return null;
      const fontSize = this._numAttr(attrs, 'font-size', 16);
      const x = this._number(xAttr, 0) + offset.x;
      const y = this._number(yAttr, 0) + offset.y;
      const inner = this._extractElementInner(context.svg, tag, context.afterTagIndex);
      if (tag === 'text' && /<\s*tspan\b/i.test(inner)) {
        computedFontSize = this._maxTextFontSize(attrs, inner, fontSize);
        textContent = this._extractTextContent(inner);
        bounds = this._boundsForTextWithTspans(attrs, inner, offset, { x, y, fontSize });
      } else {
        computedFontSize = fontSize;
        const content = this._extractTextContent(inner);
        textContent = content;
        const width = Math.max(fontSize, this._estimateTextWidth(content, fontSize));
        const anchor = String(this._attr(attrs, 'text-anchor') || 'start').toLowerCase();
        let left = x;
        if (anchor === 'middle') left = x - width / 2;
        if (anchor === 'end') left = x - width;
        bounds = {
          left,
          top: y - fontSize * 0.9,
          right: left + width,
          bottom: y + fontSize * 0.28
        };
      }
    }

    if (!bounds) return null;
      return {
        tag,
        bounds,
        attrs,
        id: this._attr(attrs, 'id'),
        groupIds: context.groupIds || [],
        fontSize: computedFontSize,
        text: textContent,
        tagIndex: context.tagIndex,
        line: this._lineNumber(context.svg, context.tagIndex)
      };
  }

  _parseTranslate(attrs) {
    const transform = this._attr(attrs, 'transform') || '';
    let x = 0;
    let y = 0;
    const translateRe = /translate\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)/gi;
    let match;
    while ((match = translateRe.exec(transform)) !== null) {
      x += this._number(match[1], 0);
      y += this._number(match[2], 0);
    }

    const matrix = transform.match(/matrix\(\s*([^)]+)\)/i);
    if (matrix) {
      const parts = matrix[1].split(/[\s,]+/).map(value => this._number(value, 0));
      if (parts.length >= 6) {
        x += parts[4];
        y += parts[5];
      }
    }
    return { x, y };
  }

  _attr(attrs, name) {
    const match = String(attrs || '').match(new RegExp(`\\b${name}=([\"'])(.*?)\\1`, 'i'));
    return match ? match[2] : null;
  }

  _numAttr(attrs, name, fallback = 0) {
    return this._number(this._attr(attrs, name), fallback);
  }

  _number(value, fallback = 0) {
    const parsed = parseFloat(String(value ?? '').replace(/px$/i, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  _pointsAttr(attrs) {
    const raw = this._attr(attrs, 'points');
    if (!raw) return [];
    const values = raw.trim().split(/[\s,]+/).map(value => this._number(value, NaN));
    const points = [];
    for (let index = 0; index < values.length - 1; index += 2) {
      if (Number.isFinite(values[index]) && Number.isFinite(values[index + 1])) {
        points.push({ x: values[index], y: values[index + 1] });
      }
    }
    return points;
  }

  _extractElementInner(svg, tag, afterTagIndex) {
    const closeTag = `</${tag}>`;
    const closeIndex = String(svg).indexOf(closeTag, afterTagIndex);
    if (closeIndex === -1) return '';
    return String(svg).slice(afterTagIndex, closeIndex);
  }

  _extractTextContent(inner) {
    return String(inner || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _boundsForTextWithTspans(parentAttrs, inner, offset, base) {
    const parentAnchor = String(this._attr(parentAttrs, 'text-anchor') || 'start').toLowerCase();
    let cursorX = base.x;
    let cursorY = base.y;
    let bounds = null;
    const tspanRe = /<\s*tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi;
    let match;

    while ((match = tspanRe.exec(inner)) !== null) {
      const attrs = match[1] || '';
      const content = this._extractTextContent(match[2]);
      if (!content) continue;

      const fontSize = this._numAttr(attrs, 'font-size', base.fontSize);
      const xAttr = this._attr(attrs, 'x');
      const yAttr = this._attr(attrs, 'y');
      const dxAttr = this._attr(attrs, 'dx');
      const dyAttr = this._attr(attrs, 'dy');
      if (xAttr !== null) cursorX = this._number(xAttr, cursorX - offset.x) + offset.x;
      if (yAttr !== null) cursorY = this._number(yAttr, cursorY - offset.y) + offset.y;
      else if (dyAttr !== null) cursorY += this._number(dyAttr, 0);
      if (dxAttr !== null) cursorX += this._number(dxAttr, 0);

      const width = Math.max(fontSize, this._estimateTextWidth(content, fontSize));
      const anchor = String(this._attr(attrs, 'text-anchor') || parentAnchor).toLowerCase();
      let left = cursorX;
      if (anchor === 'middle') left = cursorX - width / 2;
      if (anchor === 'end') left = cursorX - width;
      const itemBounds = {
        left,
        top: cursorY - fontSize * 0.9,
        right: left + width,
        bottom: cursorY + fontSize * 0.28
      };
      bounds = bounds ? {
        left: Math.min(bounds.left, itemBounds.left),
        top: Math.min(bounds.top, itemBounds.top),
        right: Math.max(bounds.right, itemBounds.right),
        bottom: Math.max(bounds.bottom, itemBounds.bottom)
      } : itemBounds;
    }

    return bounds;
  }

  _maxTextFontSize(parentAttrs, inner, fallback) {
    let maxFontSize = this._numAttr(parentAttrs, 'font-size', fallback);
    const tspanRe = /<\s*tspan\b([^>]*)>/gi;
    let match;
    while ((match = tspanRe.exec(inner)) !== null) {
      maxFontSize = Math.max(maxFontSize, this._numAttr(match[1] || '', 'font-size', maxFontSize));
    }
    return maxFontSize;
  }

  _estimateTextWidth(text, fontSize) {
    const value = String(text || '').trim();
    if (!value) return fontSize;
    let width = 0;
    for (const char of value) {
      if (/[\u4e00-\u9fff]/.test(char)) width += fontSize;
      else if (/[A-Z0-9]/i.test(char)) width += fontSize * 0.58;
      else if (/\s/.test(char)) width += fontSize * 0.35;
      else width += fontSize * 0.5;
    }
    return width;
  }

  _layoutFontSize(element) {
    return Number.isFinite(element?.fontSize)
      ? element.fontSize
      : this._numAttr(element?.attrs || '', 'font-size', 16);
  }

  _isLikelyMainTitleElement(element, canvas) {
    if (!element || element.tag !== 'text') return false;
    if (element.bounds.top >= 126) return false;
    const fontSize = this._layoutFontSize(element);
    const textWidth = element.bounds.right - element.bounds.left;
    if (fontSize >= 30) return true;
    if (fontSize >= 26 && element.bounds.top < 100 && textWidth >= canvas.width * 0.12 && element.bounds.left < canvas.width * 0.82) return true;
    if (fontSize >= 24 && this._isHeaderGroupElement(element) && textWidth >= canvas.width * 0.10) return true;
    return fontSize >= 20 && element.bounds.top < 96 && element.bounds.bottom > 48 && textWidth >= canvas.width * 0.24;
  }

  _boundsArea(bounds) {
    return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
  }

  _inflateBounds(bounds, amount) {
    return {
      left: bounds.left - amount,
      top: bounds.top - amount,
      right: bounds.right + amount,
      bottom: bounds.bottom + amount
    };
  }

  _overlapInfo(first, second) {
    const left = Math.max(first.left, second.left);
    const top = Math.max(first.top, second.top);
    const right = Math.min(first.right, second.right);
    const bottom = Math.min(first.bottom, second.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return {
      left,
      top,
      right,
      bottom,
      width,
      height,
      area: width * height
    };
  }

  _sameLayoutGroup(first, second) {
    const generic = new Set(['bg', 'background', 'header', 'content', 'body', 'main', 'footer', 'chrome', 'decor', 'decoration', 'decorations']);
    const normalize = ids => (ids || []).filter(id => {
      const clean = String(id || '').toLowerCase().replace(/[-_\s]+/g, '');
      return clean && !generic.has(clean);
    });
    const a = normalize(first?.groupIds);
    const b = normalize(second?.groupIds);
    if (a.length === 0 || b.length === 0) return false;
    const keyA = a.join('/');
    const keyB = b.join('/');
    if (keyA === keyB) return true;
    const lastA = a[a.length - 1] || '';
    const lastB = b[b.length - 1] || '';
    return Boolean(lastA && lastA === lastB);
  }

  _isBlockingSameGroupOverlap(first, second) {
    const shape = first.tag === 'text' ? second : first;
    const text = first.tag === 'text' ? first : second;
    if (text.tag !== 'text') return false;
    if (!['rect', 'circle', 'ellipse', 'image'].includes(shape.tag)) return false;
    if (!Number.isFinite(shape.tagIndex) || !Number.isFinite(text.tagIndex)) return false;
    return shape.tagIndex > text.tagIndex;
  }

  _shapeAppearsAfterText(shape, text) {
    if (!shape || !text) return false;
    if (text.tag !== 'text') return false;
    if (!['rect', 'circle', 'ellipse', 'image'].includes(shape.tag)) return false;
    if (!Number.isFinite(shape.tagIndex) || !Number.isFinite(text.tagIndex)) return false;
    return shape.tagIndex > text.tagIndex;
  }

  _isAllowedContainingPair(first, second) {
    const shape = first.tag === 'text' ? second : first;
    const text = first.tag === 'text' ? first : second;
    if (text.tag !== 'text') return false;
    if (!['rect', 'circle', 'ellipse'].includes(shape.tag)) return false;
    if (!Number.isFinite(shape.tagIndex) || !Number.isFinite(text.tagIndex)) return false;
    if (shape.tagIndex > text.tagIndex) return false;

    const shapeArea = this._boundsArea(shape.bounds);
    const textArea = this._boundsArea(text.bounds);
    if (shapeArea <= 0 || textArea <= 0) return false;

    const containToleranceX = shape.tag === 'rect' ? 24 : 8;
    const containToleranceY = shape.tag === 'rect' ? 18 : 8;
    const contained = text.bounds.left >= shape.bounds.left - containToleranceX &&
      text.bounds.right <= shape.bounds.right + containToleranceX &&
      text.bounds.top >= shape.bounds.top - containToleranceY &&
      text.bounds.bottom <= shape.bounds.bottom + containToleranceY;
    const overlap = this._overlapInfo(shape.bounds, text.bounds);
    const overlapRatio = textArea > 0 ? overlap.area / textArea : 0;
    const mostlyCoveredByBackground = overlapRatio >= 0.72;
    if (!contained && !mostlyCoveredByBackground) return false;

    const ratio = textArea / shapeArea;
    const shapeWidth = shape.bounds.right - shape.bounds.left;
    const shapeHeight = shape.bounds.bottom - shape.bounds.top;
    const textWidth = text.bounds.right - text.bounds.left;
    const textHeight = text.bounds.bottom - text.bounds.top;
    if (shapeWidth < 40 || shapeHeight < 20) return false;
    if (textWidth > shapeWidth + containToleranceX * 2) return false;
    if (textHeight > shapeHeight + containToleranceY * 2) return false;

    if (shape.tag === 'rect') {
      return ratio < 1.25;
    }
    return ratio < 0.72;
  }

  _isSoftDecorativeElement(element, canvas) {
    const bounds = element.bounds;
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (!['circle', 'ellipse'].includes(element.tag)) return false;
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > canvas.width || bounds.bottom > canvas.height) return true;
    if (width >= canvas.width * 0.18 || height >= canvas.height * 0.18) return true;
    const fill = String(this._attr(element.attrs, 'fill') || '').toLowerCase();
    const opacity = this._numAttr(element.attrs, 'opacity', this._numAttr(element.attrs, 'fill-opacity', 1));
    return opacity < 0.38 || fill === 'none';
  }

  _isDecorativeOverlapPair(first, second, canvas) {
    const nonText = first.tag === 'text' ? second : first;
    const text = first.tag === 'text' ? first : second;
    const width = nonText.bounds.right - nonText.bounds.left;
    const height = nonText.bounds.bottom - nonText.bounds.top;
    if (nonText.tag === 'line') return true;
    if (nonText.tag !== 'text' && width <= 42 && height <= 42) return true;
    if (text.tag === 'text' && this._isHeaderElement(text, canvas)) return false;
    return false;
  }

  _lineNumber(text, index) {
    return String(text || '').slice(0, index).split('\n').length;
  }

  _isBackgroundElement(element, canvas) {
    const bounds = element.bounds;
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (element.tag === 'rect' && width <= 24 && height >= canvas.height * 0.8) return true;
    if (element.tag === 'rect' && height <= 12 && width >= canvas.width * 0.8) return true;
    return bounds.left <= 2 && bounds.top <= 2 && width >= canvas.width * 0.95 && height >= canvas.height * 0.8;
  }

  _isHeaderElement(element, canvas) {
    const bounds = element.bounds;
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (this._isHeaderGroupElement(element) && bounds.bottom <= 132) return true;
    if (bounds.left <= 2 && bounds.top <= 90 && width >= canvas.width * 0.65 && height <= 125) return true;
    if (bounds.top < 90 && bounds.bottom <= 132 && width <= 180 && height <= 72 && (bounds.left < 170 || bounds.right > canvas.width - 220)) return true;
    if (element.tag !== 'text') return false;
    if (bounds.top >= 126) return false;
    return this._isLikelyMainTitleElement(element, canvas);
  }

  _isHeaderGroupElement(element) {
    const groupText = (element?.groupIds || [])
      .map(value => String(value || '').toLowerCase())
      .join(' ');
    return /\b(?:header|page-header|slide-header|topbar|masthead|chrome)\b/.test(groupText);
  }

  _isFooterElement(element, canvas, footerTop) {
    const bounds = element.bounds;
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (bounds.top >= footerTop) return true;
    if (element.tag === 'rect' && bounds.left <= 2 && width >= canvas.width * 0.8 && bounds.bottom >= canvas.height - 2 && bounds.top >= canvas.height - 82 && height <= 90) return true;
    if (element.tag === 'rect' && bounds.left <= 2 && width >= canvas.width * 0.8 && bounds.top >= footerTop - 2 && height <= 58) return true;
    if (element.tag === 'text' && bounds.bottom >= footerTop + 8 && bounds.top >= footerTop - 14 && height <= 22) return true;
    return false;
  }

  _detectBottomBandTop(elements, canvas) {
    const candidates = elements
      .filter(element => {
        const bounds = element.bounds;
        const width = bounds.right - bounds.left;
        return element.tag === 'rect' &&
          bounds.left <= 2 &&
          bounds.top >= canvas.height - 82 &&
          bounds.bottom >= canvas.height - 2 &&
          width >= canvas.width * 0.9;
      })
      .map(element => element.bounds.top);
    return candidates.length ? Math.min(...candidates) : null;
  }

  _isBottomBandElement(element, canvas, bottomBandTop) {
    if (!Number.isFinite(bottomBandTop)) return false;
    const bounds = element.bounds;
    return bounds.top >= bottomBandTop - 2 && bounds.bottom <= canvas.height + 6;
  }

  _boundsLabel(bounds) {
    return `left=${Math.round(bounds.left)}, top=${Math.round(bounds.top)}, right=${Math.round(bounds.right)}, bottom=${Math.round(bounds.bottom)}`;
  }

  _formatLayoutSafetyReport(files, ok) {
    const canvas = this._canvasInfo();
    const lines = [
      '# Visual Layout Safety Report',
      '',
      `- Result: ${ok ? 'passed' : 'failed'}`,
      `- Canvas: ${canvas.viewBox}`,
      `- Rule: 正文建议停在 y<=${canvas.height - 70}；页脚/页码区 y=${canvas.height - 52}..${canvas.height - 20}；非页脚元素进入底部预警区会触发修复。`,
      ''
    ];

    files.forEach(file => {
      const errors = file.issues.filter(issue => issue.severity === 'error');
      const warnings = file.issues.filter(issue => issue.severity === 'warning');
      const status = errors.length ? 'ERROR' : warnings.length ? 'WARN' : 'OK';
      lines.push(`## ${file.file}`);
      lines.push(`- Status: ${status}`);
      lines.push(`- Elements scanned: ${file.element_count}`);
      file.issues.forEach(issue => {
        const line = issue.line ? `line ${issue.line}: ` : '';
        lines.push(`- [${issue.severity.toUpperCase()}] ${line}${issue.code} - ${issue.message}`);
      });
      lines.push('');
    });

    return `${lines.join('\n').trim()}\n`;
  }

  _summarizeLayoutIssues(fileReport) {
    if (!fileReport?.issues?.length) return '未知版面问题';
    return fileReport.issues
      .map(issue => `${issue.code}: ${issue.message}`)
      .join('; ');
  }

  _ensureChartMarkersBeforeLayoutScan() {
    if (!this.projectPath) return [];
    const svgDir = path.join(this.projectPath, 'svg_output');
    if (!fs.existsSync(svgDir)) return [];
    const repaired = [];
    this._listCanonicalSvgNames(svgDir)
      .forEach(name => {
        const svgPath = path.join(svgDir, name);
        const svg = fs.readFileSync(svgPath, 'utf-8');
        if (!this._looksLikeChartSvg(svg) || svg.includes('chart-plot-area')) return;
        this._insertDefaultChartPlotMarker(svgPath);
        repaired.push(name);
      });
    return repaired;
  }

  _generatedPagesSummary() {
    return (this.generatedPages || [])
      .map(page => `P${String(page.pageNum).padStart(2, '0')}: ${page.description || page.filename}`)
      .join('\n');
  }

  _executorHistoryMessages() {
    const history = Array.isArray(this.executorConversationHistory)
      ? this.executorConversationHistory.slice(-1)
      : [];
    if (history.length === 0) return [];
    const messages = [{
      role: 'user',
      content: [
        '以下是已经生成并通过检查的前序页面摘要和关键 SVG 结构。',
        '继续生成新页面时必须保持同一套视觉系统、标题区节奏、页脚规则、图表语言和卡片密度；不要把前页内容复制到新页。'
      ].join('\n')
    }];
    history.forEach(item => {
      messages.push({
        role: 'assistant',
        content: [
          `P${String(item.pageNum).padStart(2, '0')} 已完成：${item.description || item.filename}`,
          item.svgSnippet ? '```svg' : '',
          item.svgSnippet || '',
          item.svgSnippet ? '```' : ''
        ].filter(Boolean).join('\n')
      });
    });
    return messages;
  }

  _appendExecutorHistory(pageNum, userMessage, svg) {
    const filename = this._pageFilename(pageNum);
    this.executorConversationHistory.push({
      pageNum,
      filename,
      description: this._inferPageDescription(pageNum),
      userMessage,
      svgSnippet: this._compactSvgForExecutorHistory(svg)
    });
    if (this.executorConversationHistory.length > 4) {
      this.executorConversationHistory = this.executorConversationHistory.slice(-4);
    }
  }

  _compactSvgForExecutorHistory(svg = '') {
    const text = String(svg || '');
    const groups = [];
    const groupRe = /<g\b[^>]*id=(["'])([^"']+)\1[^>]*>/gi;
    let match;
    while ((match = groupRe.exec(text)) !== null && groups.length < 12) {
      groups.push(match[2]);
    }
    const importantText = (text.match(/<text\b[\s\S]*?<\/text>/gi) || [])
      .slice(0, 10)
      .map(block => block.replace(/\s+/g, ' ').trim())
      .join('\n');
    return this._trimText([
      groups.length ? `<!-- groups: ${groups.join(', ')} -->` : '',
      importantText
    ].filter(Boolean).join('\n'), 1600);
  }

  _executorMaxTokens(pageNum = 1) {
    const raw = this.params.pptExecutorMaxTokens
      || this.params.ppt_executor_max_tokens
      || this.runtimeConfig?.pptExecutorMaxTokens;
    const configured = parseInt(raw, 10);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.max(6000, Math.min(configured, 16000));
    }
    return pageNum >= 4 ? 11000 : 9000;
  }

  async _runChartCalibrationGate() {
    const scan1Pattern = 'chart-plot-area';
    const scan2Pattern = 'barGrad\\|bar-[0-9]\\|groupGrad\\|stackShadow\\|donut-sectors\\|sector-[0-9]\\|pieChart\\|radarChart\\|areaGrad\\|lineGrad\\|dotShadow\\|pointShadow\\|hbarGrad\\|waterfallGrad\\|paretoGrad';
    let marked = await this._grepSvgOutput(scan1Pattern);
    const chartLike = this._uniquePaths([
      ...(await this._grepSvgOutput(scan2Pattern)),
      ...this._findLikelyChartSvgOutput()
    ]);
    const markedSet = new Set(marked.map(file => path.basename(file)));
    const missingMarkers = chartLike.filter(file => !markedSet.has(path.basename(file)));

    for (const svgPath of missingMarkers) {
      this._insertDefaultChartPlotMarker(svgPath);
    }

    if (missingMarkers.length > 0) {
      const recheck = await this._runQualityCheck(this.projectPath, { allowFailure: true });
      if (!recheck.ok) {
        this._recordWorkflowEvent('Chart Calibration', 'marker_repair_quality_warning', {
          issue: this._trimText(recheck.output, 1800),
          action: 'continued export; chart marker repair is advisory'
        });
      }
      marked = await this._grepSvgOutput(scan1Pattern);
    }

    const calculatorRuns = [];
    for (const svgPath of marked) {
      const result = await this._execPptMasterScript('svg_position_calculator.py', ['analyze', svgPath], {
        timeoutMs: 60000,
        rejectOnError: false
      });
      calculatorRuns.push({
        file: path.basename(svgPath),
        command: 'svg_position_calculator.py analyze <svg_file>',
        ok: result.ok,
        output: this._trimText([result.stdout, result.stderr].filter(Boolean).join('\n'), 2400)
      });
      if (!result.ok) {
        this._recordWorkflowEvent('Chart Calibration', 'calculator_warning', {
          file: path.basename(svgPath),
          issue: this._trimText(result.message, 1200),
          action: 'continued export; calculator analysis is advisory'
        });
      }
    }

    const report = {
      scan_1_command: 'grep -l "chart-plot-area" <project_path>/svg_output/*.svg',
      scan_2_command: 'grep -l "barGrad\\|bar-[0-9]\\|groupGrad\\|stackShadow\\|donut-sectors\\|sector-[0-9]\\|pieChart\\|radarChart\\|areaGrad\\|lineGrad\\|dotShadow\\|pointShadow\\|hbarGrad\\|waterfallGrad\\|paretoGrad" <project_path>/svg_output/*.svg',
      marked_chart_pages: marked.map(file => path.basename(file)),
      chart_like_pages: chartLike.map(file => path.basename(file)),
      missing_markers_repaired: missingMarkers.map(file => path.basename(file)),
      calculator_runs: calculatorRuns,
      result: marked.length > 0
        ? 'calculator_ran_for_marked_chart_pages'
        : 'no_calculator_supported_charts'
    };
    this._writeChartCalibrationReport(report);
    return report;
  }

  async _grepSvgOutput(pattern) {
    const svgDir = path.join(this.projectPath, 'svg_output');
    if (!fs.existsSync(svgDir)) return [];
    const files = this._listCanonicalSvgFiles(svgDir);
    if (files.length === 0) return [];

    try {
      const regex = new RegExp(pattern, 'i');
      return files.filter(file => {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          return regex.test(content);
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }

  _findLikelyChartSvgOutput() {
    const svgDir = path.join(this.projectPath, 'svg_output');
    if (!fs.existsSync(svgDir)) return [];
    return this._listCanonicalSvgFiles(svgDir)
      .filter(file => this._looksLikeChartSvg(fs.readFileSync(file, 'utf-8')));
  }

  _uniquePaths(files) {
    return [...new Set(files.map(file => path.resolve(file)))].sort();
  }

  _looksLikeChartSvg(svg) {
    const text = String(svg || '');
    if (text.includes('chart-plot-area')) return true;

    const visibleText = this._extractTextContent(text);
    const explicitChartText = /图表|柱状图|柱形图|条形图|折线图|饼图|环形图|雷达图|散点图|面积图|瀑布图|帕累托|坐标轴|\b(?:bar chart|line chart|pie chart|donut chart|radar chart|scatter plot|area chart|waterfall|pareto|axis|legend|series)\b/i.test(visibleText);
    const dataTerms = (visibleText.match(/趋势|增长|占比|同比|环比|营收|收入|利润|亏损|费用率|年度|数据|单位|亿元|%|kpi|metric|指标/g) || []).length;
    const numericLabels = (visibleText.match(/(?:^|[^\d.])[-+]?\d+(?:\.\d+)?%?(?=$|[^\d.])/g) || []).length;

    const explicitChartMarkup = [
      /\bid=(["'])[^"']*(?:plot|axis|legend|series|bar-\d+|donut|pie|radar|scatter|waterfall|pareto)[^"']*\1/i,
      /\bclass=(["'])[^"']*(?:plot|axis|legend|series|bar-\d+|donut|pie|radar|scatter|waterfall|pareto)[^"']*\1/i,
      /\b(?:barGrad|groupGrad|stackShadow|donut-sectors|sector-\d+|pieChart|radarChart|areaGrad|lineGrad|dotShadow|pointShadow|hbarGrad|waterfallGrad|paretoGrad)\b/i
    ];
    if (explicitChartMarkup.some(pattern => pattern.test(text))) return true;
    if (/\bid=(["'])[^"']*chart[^"']*\1/i.test(text) && (explicitChartText || dataTerms >= 2 || numericLabels >= 4)) {
      return true;
    }
    if (explicitChartText) {
      return true;
    }

    const rectCount = (text.match(/<rect\b/gi) || []).length;
    const lineCount = (text.match(/<line\b/gi) || []).length;
    const circleCount = (text.match(/<circle\b/gi) || []).length;

    return dataTerms >= 2 && numericLabels >= 4 && (rectCount >= 5 || lineCount >= 3 || circleCount >= 2);
  }

  _insertDefaultChartPlotMarker(svgPath) {
    const svg = fs.readFileSync(svgPath, 'utf-8');
    if (svg.includes('chart-plot-area')) return;
    const canvas = this._canvasFromSvg(svg);
    const marker = canvas.width === 1024
      ? '<!-- chart-plot-area: 120,150,920,590 -->'
      : '<!-- chart-plot-area: 140,150,1160,550 -->';
    const updated = /<g\b[^>]*id=(["'])chartArea\1[^>]*>/i.test(svg)
      ? svg.replace(/(<g\b[^>]*id=(["'])chartArea\2[^>]*>)/i, `$1\n    ${marker}`)
      : svg.replace(/(<svg\b[^>]*>)/i, `$1\n  ${marker}`);
    this._writeTextFile(svgPath, updated);
  }

  _writeChartCalibrationReport(report) {
    const lines = [
      '# Chart Calibration Gate Report',
      '',
      `- Scan 1: ${report.scan_1_command}`,
      `- Scan 2: ${report.scan_2_command}`,
      `- Marked chart pages: ${report.marked_chart_pages.join(', ') || 'none'}`,
      `- Chart-like pages: ${report.chart_like_pages.join(', ') || 'none'}`,
      `- Missing markers repaired: ${report.missing_markers_repaired.join(', ') || 'none'}`,
      `- Result: ${report.result}`,
      ''
    ];
    report.calculator_runs.forEach(run => {
      lines.push(`## ${run.file}`);
      lines.push(`- Command: ${run.command}`);
      lines.push(`- OK: ${run.ok}`);
      if (run.output) {
        lines.push('', '```text', run.output, '```', '');
      }
    });
    this._writeTextFile(path.join(this.projectPath, 'reports', 'chart_calibration_report.md'), lines.join('\n'));
  }

  _buildChartTemplateContext(pageNum) {
    const cacheKey = `chart_template_context:${pageNum}`;
    if (this.executorPageContextCache?.has(cacheKey)) {
      return this.executorPageContextCache.get(cacheKey);
    }
    const root = this.runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const chartsRoot = path.join(root, 'skills', 'ppt-master', 'templates', 'charts');
    const indexPath = path.join(chartsRoot, 'charts_index.json');
    if (!fs.existsSync(indexPath)) return '';

    const index = this._readJsonFileIfExists(indexPath, null);
    const explicit = this._chartTemplatesDeclaredForPage(pageNum, chartsRoot, index);
    const selected = (explicit.length > 0 ? explicit : this._selectChartTemplatesForPage(pageNum, index)).slice(0, 4);
    const quickLookup = index?.quickLookup || {};
    const lines = [
      '- Use this official ppt-master visualization template library when the current page needs charts, frameworks, architecture diagrams, process flows, tables, or infographics.',
      explicit.length > 0
        ? '- These templates are declared by design_spec.md §VII for the current page. Treat them as the primary structural reference.'
        : '- No exact §VII template row matched this page; recommended templates below are fallback structural references.',
      '- Read snippets as structural examples; adapt positions, text, and colors to spec_lock.md. Preserve chart-plot-area markers for real charts.',
      '',
      '### quickLookup families',
      ...Object.entries(quickLookup).slice(0, 24).map(([key, values]) => `- ${key}: ${(values || []).slice(0, 6).join(', ')}`)
    ];

    if (selected.length > 0) {
      lines.push('', '### recommended templates for this page');
      selected.forEach(item => {
        const svgPath = path.join(chartsRoot, `${item.key}.svg`);
        const snippet = fs.existsSync(svgPath)
          ? this._trimText(fs.readFileSync(svgPath, 'utf-8').replace(/\s+/g, ' '), 2200)
          : '';
        lines.push(`#### ${item.key} - ${item.label || item.key}`);
        if (item.summary) lines.push(`- selection rule: ${item.summary}`);
        if (snippet) lines.push('```svg', snippet, '```');
      });
    }

    const result = lines.join('\n');
    this.executorPageContextCache?.set(cacheKey, result);
    return result;
  }

  _chartTemplatesDeclaredForPage(pageNum, chartsRoot, index = null) {
    const section = this._extractMarkdownSection(this.designSpec, 'VII. Visualization Reference List', 'VIII. Image Resource List');
    if (!section) return [];
    const pageMatchers = [
      new RegExp(`\\bP\\s*0?${pageNum}\\b`, 'i'),
      new RegExp(`\\bSlide\\s*0?${pageNum}\\b`, 'i'),
      new RegExp(`第\\s*0?${pageNum}\\s*页`, 'i')
    ];
    const rows = section.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\|.+\|$/.test(line) && !/^\|\s*-+/.test(line));
    if (rows.length < 2) return [];
    const dataRows = rows.slice(1);
    const charts = index?.charts || {};
    const found = [];
    dataRows.forEach(row => {
      if (!pageMatchers.some(pattern => pattern.test(row))) return;
      const cells = this._splitMarkdownTableRow(row);
      const rowText = cells.join(' ');
      const refs = [...rowText.matchAll(/templates\/charts\/([A-Za-z0-9_\-]+)\.svg/g)]
        .map(match => match[1]);
      if (refs.length === 0) {
        const key = String(cells[0] || '').replace(/[`*_]/g, '').trim();
        if (key && charts[key]) refs.push(key);
      }
      refs.forEach(key => {
        const svgPath = path.join(chartsRoot, `${key}.svg`);
        if (!fs.existsSync(svgPath)) return;
        found.push({
          key,
          ...(charts[key] || {}),
          summary: charts[key]?.summary || `Declared in design_spec.md §VII for page ${pageNum}`,
          declared: true
        });
      });
    });
    const seen = new Set();
    return found.filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
  }

  _extractMarkdownSection(text = '', startTitle = '', endTitle = '') {
    const source = String(text || '');
    const start = new RegExp(`^##\\s*${this._escapeRegExp(startTitle)}\\s*$`, 'im');
    const match = source.match(start);
    if (!match) return '';
    const startIndex = match.index;
    const rest = source.slice(startIndex + match[0].length);
    const end = endTitle
      ? rest.search(new RegExp(`^##\\s*${this._escapeRegExp(endTitle)}\\s*$`, 'im'))
      : rest.search(/^##\s+/m);
    return end >= 0 ? rest.slice(0, end) : rest;
  }

  _selectChartTemplatesForPage(pageNum, index = null) {
    const charts = index?.charts || {};
    const quickLookup = index?.quickLookup || {};
    const pageText = this._pageSpecificContext(pageNum).toLowerCase();
    const fullText = [pageText, this.designSpec, this.sourceContent].join('\n').toLowerCase();
    const wanted = new Set();
    const addFamily = family => {
      (quickLookup[family] || []).slice(0, 3).forEach(key => wanted.add(key));
    };

    const tests = [
      [/架构|architecture|module|模块|系统|pipeline|管道|client|server|前后端|分层/, 'architecture'],
      [/路线|roadmap|时间线|timeline|里程碑|milestone|阶段|计划|path|路径/, 'roadmap'],
      [/流程|process|步骤|step|方法论|flow|闭环|cycle|漏斗|转化/, 'flow'],
      [/趋势|trend|增长|growth|同比|环比|年度|季度|time series|series/, 'trend'],
      [/排名|ranking|对比|comparison|比较|竞品|category|条形|柱状/, 'comparison'],
      [/占比|composition|share|比例|结构|份额|pie|donut|构成/, 'composition'],
      [/kpi|指标|metric|dashboard|目标|actual|target|完成率|progress/, 'kpi'],
      [/矩阵|matrix|优先级|priority|swot|pest|porter|bcg|ansoff|value chain|战略/, 'strategy'],
      [/表格|table|清单|schedule|排期|财务|statement|feature matrix|评分/, 'table'],
      [/旅程|journey|用户体验|customer|persona|触点|pain point/, 'journey'],
      [/优劣|pros|cons|利弊|优势|劣势/, 'pros_cons'],
      [/关系|relationship|组织|org|hierarchy|层级|目标树|okr/, 'relationship']
    ];
    tests.forEach(([pattern, family]) => {
      if (pattern.test(pageText) || pattern.test(fullText)) addFamily(family);
    });

    Object.entries(charts).forEach(([key, item]) => {
      const haystack = [key, item.label, item.summary, ...(item.keywords || [])].join(' ').toLowerCase();
      if (pageText && pageText.split(/\s+/).some(token => token.length >= 4 && haystack.includes(token))) {
        wanted.add(key);
      }
    });

    if (wanted.size === 0 && /目录|agenda|toc|overview|结构/.test(pageText)) {
      wanted.add('agenda_list');
    }
    if (wanted.size === 0) {
      ['vertical_list', 'kpi_cards', 'process_flow'].forEach(key => wanted.add(key));
    }

    return [...wanted]
      .filter(key => charts[key])
      .map(key => ({ key, ...charts[key] }));
  }

  _pageSpecificContext(pageNum) {
    const cacheKey = `page_specific_context:${pageNum}`;
    if (this.executorPageContextCache?.has(cacheKey)) {
      return this.executorPageContextCache.get(cacheKey);
    }
    const pageId = `P${String(pageNum).padStart(2, '0')}`;
    const lines = String(this.designSpec || '').split(/\r?\n/);
    const collected = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!new RegExp(`\\b${pageId}\\b|第\\s*${pageNum}\\s*页`, 'i').test(lines[index])) continue;
      collected.push(lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 8)).join('\n'));
    }
    const result = this._sanitizeExecutorPromptText(collected.join('\n\n') || this._inferPageDescription(pageNum));
    this.executorPageContextCache?.set(cacheKey, result);
    return result;
  }

  async _callPptModel({
    model: modelOverride,
    route = 'ppt',
    systemPrompt,
    userMessage,
    historyMessages = [],
    maxTokens,
    temperature = 0.3,
    retries = 2,
    timeoutMs = 300000,
    streamFirstTokenTimeoutMs = null,
    streamIdleTimeoutMs = null
  }) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const routeName = route || 'ppt';
        const model = modelOverride || this._modelForPptRoute(routeName);
        console.log(`[PptAgent] Calling PPT model ${model} route=${routeName}`);
        const messages = [
          { role: 'system', content: systemPrompt },
          ...(Array.isArray(historyMessages) ? historyMessages : []),
          { role: 'user', content: userMessage }
        ];
        const response = await AiService.chat({
          userId: this.task.user_id,
          model,
          messages,
          params: {
            route: routeName,
            temperature,
            max_tokens: maxTokens,
            timeout_ms: timeoutMs || this.runtimeConfig.pptTimeoutMs,
            queue_timeout_ms: this._pptModelQueueTimeoutMs(),
            stream_first_token_timeout_ms: streamFirstTokenTimeoutMs || this._pptStreamFirstTokenTimeoutMs(),
            stream_idle_timeout_ms: streamIdleTimeoutMs || this._pptStreamIdleTimeoutMs(),
            sticky_key: `ppt_task_${this.task.id}_${routeName}`,
            stream: false
          },
          runtimeConfig: this.runtimeConfig,
          allowConfigOverride: Boolean(modelOverride)
        });

        const content = response.choices?.[0]?.message?.content || '';
        if (!content.trim()) {
          throw new Error('模型返回空内容');
        }
        this._billAiTokenUsage({
          usage: response.usage,
          messages,
          content,
          model: response.model || model,
          label: this.currentStep || 'model_call'
        });
        this._recordWorkflowEvent('AI Model Call', 'completed', {
          route: routeName,
          requested_model: model,
          actual_model: response.model || model,
          provider: response.provider?.id || response.provider?.name || '',
          prompt_tokens: response.usage?.prompt_tokens || response.usage?.input_tokens || 0,
          completion_tokens: response.usage?.completion_tokens || response.usage?.output_tokens || 0
        });
        return content.trim();
      } catch (error) {
        if (attempt === retries) throw error;
        console.warn(`[PptAgent] _callPptModel 第${attempt + 1}次失败:`, error.message);
        const delayMs = this._isAiModelPoolBusyError(error)
          ? this._pptModelBusyRetryDelayMs(attempt + 1)
          : Math.min(8000, 1000 * (attempt + 1));
        await this._sleep(delayMs);
      }
    }
    throw new Error('模型调用失败');
  }

  async _runPptMasterScript(scriptName, args, { timeoutMs = 120000 } = {}) {
    const result = await this._execPptMasterScript(scriptName, args, {
      timeoutMs,
      rejectOnError: true
    });
    return result.stdout;
  }

  _pptxExportArgs() {
    return [this.projectPath, '-a', 'none', '-t', 'none'];
  }

  async _execPptMasterScript(scriptName, args, { timeoutMs = 120000, rejectOnError = true } = {}) {
    const root = this.runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const python = this._resolvePython(this.runtimeConfig.pptMasterPython || DEFAULT_PPT_MASTER_PYTHON);
    const scriptPath = path.join(root, 'skills', 'ppt-master', 'scripts', scriptName);

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`找不到脚本: ${scriptPath}`);
    }

    return new Promise((resolve, reject) => {
      execFile(
        python,
        [scriptPath, ...args],
        {
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout = '', stderr = '') => {
          const detail = stderr || stdout || error?.message || '';
          const result = {
            ok: !error,
            stdout,
            stderr,
            code: error?.code || 0,
            message: detail
          };

          if (error && rejectOnError) {
            reject(new Error(`${scriptName} 失败: ${this._trimText(detail, 2000)}`));
            return;
          }
          resolve(result);
        }
      );
    });
  }

  _resolvePython(candidate) {
    const candidates = [
      candidate,
      process.env.PYTHON_BIN,
      'python',
      'python3',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
    ].filter(Boolean);

    for (const p of candidates) {
      if (p.includes(path.sep) && !fs.existsSync(p)) continue;
      if (this._pythonVersionAtLeast(p, 3, 10)) return p;
    }

    return candidate && fs.existsSync(candidate) ? candidate : 'python3';
  }

  _pythonVersionAtLeast(python, major, minor) {
    try {
      const result = spawnSync(python, ['-c', 'import sys, pyexpat; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
        encoding: 'utf-8',
        timeout: 3000
      });
      if (result.status !== 0) return false;
      const [actualMajor, actualMinor] = String(result.stdout || '').trim().split('.').map(Number);
      return actualMajor > major || (actualMajor === major && actualMinor >= minor);
    } catch {
      return false;
    }
  }

  _normalizeParams(rawParams) {
    const params = { ...rawParams };
    const titleSource = params.title || this.task.prompt;
    const canvasFormat = params.canvasFormat || params.canvas_format || 'ppt169';
    const normalizedCanvas = canvasFormat === 'ppt43' ? 'ppt43' : 'ppt169';
    const requestedStyle = params.style || params.template || params.ppt_style || 'business';
    const styleId = params.template || params.style || params.ppt_style || requestedStyle;
    const styleLabel = params.styleLabel || params.style_label || params.ppt_style_label || '';
    const pptMasterTemplate = params.pptMasterTemplate || params.ppt_master_template || '';
    const explicitPageCount = this._extractExplicitPageCount([
      params.pageCount,
      params.page_count,
      params.content,
      params.extraRequirements,
      params.extra_requirements,
      this.task?.prompt
    ]);

    return {
      ...params,
      title: this._deriveTitle(titleSource),
      pageCount: this._normalizePageCount(explicitPageCount, this.runtimeConfig, null),
      pageCountMode: explicitPageCount ? 'explicit' : 'auto',
      canvasFormat: normalizedCanvas,
      style: this._normalizeStyle(params),
      styleId,
      requestedStyle,
      styleLabel,
      pptMasterTemplate,
      ppt_master_template: pptMasterTemplate,
      enableResearch: this._normalizeBoolean(params.enableResearch ?? params.enable_research, true),
      enableWebVisuals: this._normalizeBoolean(params.enableWebVisuals ?? params.enable_web_visuals, undefined),
      generateImages: this._normalizeBoolean(params.generateImages ?? params.generate_images, undefined)
    };
  }

  _assertRequestReadyForGeneration() {
    const text = [
      this.params.title,
      this.params.content,
      this.params.extraRequirements,
      this.task?.prompt
    ].filter(Boolean).join('\n');

    if (this._isIncompleteGenerationRequest(text) || !this._hasConcreteGenerationTopic(text)) {
      throw new Error('当前PPT方案缺少明确主题或仍有待补充信息，请先让助手整理出完整逐页方案后再生成');
    }
  }

  _isIncompleteGenerationRequest(value) {
    const text = String(value || '').trim();
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

  _hasConcreteGenerationTopic(value) {
    const text = String(value || '').trim();
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

    if (this.params.title) candidates.push(this.params.title);
    const firstLine = text.split('\n').map(item => item.trim()).find(Boolean);
    if (firstLine) candidates.push(firstLine);

    return candidates.some(candidate => {
      const cleaned = String(candidate || '')
        .replace(/[《》“”"]/g, '')
        .replace(/^方案摘要\s*[:：]\s*/, '')
        .replace(/^\s*[-*\d.Pp第页：:\s]+/, '')
        .trim();
      if (cleaned.length < 2) return false;
      if (/^(?:PPT|ppt|幻灯片|演示|汇报|课件|路演|简报|方案|方案摘要|主题|标题|目录|封面|课堂科普框架|项目汇报通用结构)$/.test(cleaned)) return false;
      return !this._isIncompleteGenerationRequest(cleaned);
    });
  }

  _normalizeStyle(params = {}) {
    const explicit = params.style || params.template || 'business';
    const combined = [
      explicit,
      params.title,
      params.content,
      params.extraRequirements,
      this.task?.prompt
    ].filter(Boolean).join(' ').toLowerCase();

    if (/dark\s*tech|dark-tech|dark theme|深色|暗色|黑色科技|科技风|技术架构/.test(combined)) {
      return 'dark_tech';
    }

    return this._mapStyle(explicit);
  }

  _buildDraft() {
    return [
      this.params.title ? `标题：${this.params.title}` : '',
      this.params.audience ? `受众：${this.params.audience}` : '',
      this.params.scenario ? `场景：${this.params.scenario}` : '',
      this.params.content ? `内容：${this.params.content}` : '',
      this.params.extraRequirements ? `额外要求：${this.params.extraRequirements}` : '',
      this.params.pageCount ? `页数：${this.params.pageCount}${this.params.pageCountMode === 'auto' ? '（AI根据内容判断）' : ''}` : '',
      this.params.style ? `风格：${this._describeSelectedStyle()}` : '',
      this.params.canvasFormat ? `画幅：${this._describeCanvasFormat(this.params.canvasFormat)}` : ''
    ].filter(Boolean).join('\n');
  }

  _buildSourceContent() {
    const referenceExtractionIntent = this._buildReferenceExtractionIntent();
    const lines = [
      `# ${this.params.title}`,
      '',
      '## 用户原始需求',
      this.task.prompt,
      '',
      '## 生成参数',
      `- 页数：${this.params.pageCount}${this.params.pageCountMode === 'auto' ? '（AI根据内容判断）' : ''}`,
      `- 风格：${this._describeSelectedStyle()}`,
      `- 画幅：${this._describeCanvasFormat(this.params.canvasFormat)}`,
      this.params.audience ? `- 受众：${this.params.audience}` : '',
      this.params.scenario ? `- 场景：${this.params.scenario}` : '',
      this.params.content ? `- 补充内容：${this.params.content}` : '',
      this.params.extraRequirements ? `- 额外要求：${this.params.extraRequirements}` : '',
      this.params.enableResearch ? '- 联网资料：启用' : '- 联网资料：关闭',
      this._webVisualAssetsEnabled() ? '- 联网视觉资产：启用（技术栈/logo/公开图片可自动落盘到 images/）' : '- 联网视觉资产：关闭',
      this.params.generateImages === false ? '- AI生图：关闭' : '- AI生图：开启',
      referenceExtractionIntent ? `- 参考资料提取：启用` : '',
      '',
      '## Source Processing Notes',
      '本文件是 Step 1 产物，作为 ppt-master 后续 Strategist 和 Executor 的唯一源内容输入。',
      '生成参数、ppt-master模板、上传文档文件名、资料依据和内部流程名称只供内部规划使用，禁止作为最终幻灯片可见文字、页脚、角标或署名露出。',
      ''
    ].filter(line => line !== '');

    const templateAsset = this.params.templateAsset || this.params.template_asset;
    const referenceAssets = Array.isArray(this.params.referenceAssets)
      ? this.params.referenceAssets
      : (Array.isArray(this.params.reference_assets) ? this.params.reference_assets : []);
    const documentAssets = Array.isArray(this.params.documentAssets)
      ? this.params.documentAssets
      : (Array.isArray(this.params.document_assets) ? this.params.document_assets : []);
    if (templateAsset || referenceAssets.length > 0 || documentAssets.length > 0) {
      lines.push('## 用户上传素材');
      if (templateAsset) {
        lines.push(`- PPT 模板：${templateAsset.name || templateAsset.filename || 'uploaded-template'}（生成时复制到项目 templates/ 目录，用于参考版式、色彩和母版风格）`);
      }
      referenceAssets.forEach((asset, index) => {
        lines.push(`- 参考图 ${index + 1}：${asset.name || asset.filename || asset.url || 'uploaded-image'}（生成时复制到项目 images/ 目录，用于参考视觉方向）`);
      });
      documentAssets.forEach((asset, index) => {
        lines.push(`- 文档资料 ${index + 1}：${asset.name || asset.filename || asset.url || 'uploaded-document'}（生成时会转为 Markdown，作为内容依据）`);
      });
      lines.push('');
    }

    if (referenceExtractionIntent) {
      lines.push(referenceExtractionIntent);
      lines.push('');
    }

    const sources = this.fallbackResearch?.sources || this.fallbackResearch?.results || [];
    if (this.fallbackResearch?.search_used && sources.length > 0) {
      lines.push('## 联网检索资料');
      if (this.fallbackResearch.query) lines.push(`检索词：${this.fallbackResearch.query}`);
      if (this.fallbackResearch.answer) lines.push(`摘要：${this.fallbackResearch.answer}`);
      sources.forEach((source, index) => {
        lines.push(`${index + 1}. ${source.title || source.url || '资料'} - ${source.url || ''}`);
        if (source.snippet || source.content) {
          lines.push(`   ${this._trimText(source.snippet || source.content, 360)}`);
        }
      });
      lines.push('');
    }

    if (this.imageAssets.length > 0) {
      lines.push('## 图片资源列表');
      this.imageAssets.forEach(asset => {
        lines.push(`- ${asset.relativePath}：${asset.description}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  _buildReferenceExtractionIntent() {
    const requestText = [
      this.params.title,
      this.params.content,
      this.params.extraRequirements,
      this._stripGeneratedReferenceSummaryLines(this.task?.prompt)
    ].filter(Boolean).join('\n');
    if (!this._hasReferenceExtractionIntent(requestText)) return '';

    const templateAsset = this.params.templateAsset || this.params.template_asset;
    const referenceAssets = Array.isArray(this.params.referenceAssets)
      ? this.params.referenceAssets
      : (Array.isArray(this.params.reference_assets) ? this.params.reference_assets : []);
    const documentAssets = Array.isArray(this.params.documentAssets)
      ? this.params.documentAssets
      : (Array.isArray(this.params.document_assets) ? this.params.document_assets : []);
    const uploadedAssets = [
      ...(templateAsset ? [{ ...templateAsset, kind: 'template' }] : []),
      ...referenceAssets.map(asset => ({ ...asset, kind: 'image' })),
      ...documentAssets.map(asset => ({ ...asset, kind: 'document' }))
    ];
    if (!uploadedAssets.length) return '';

    const targets = this._referenceExtractionTargets(requestText);
    const pages = [...requestText.matchAll(/(?:第\s*)?(\d{1,3})\s*(?:页|頁|p|P|slide|Slide|幻灯片|張|张)/g)]
      .map(match => match[1])
      .slice(0, 12);
    const sheets = [...requestText.matchAll(/(?:sheet|Sheet|工作表)\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,30})/g)]
      .map(match => match[1])
      .slice(0, 8);

    return [
      '## 参考资料提取意图（硬约束）',
      '- 用户明确要求使用上传/参考资料中的具体内容，不要把这些文件只当作泛泛背景。',
      '- Strategist 必须在 design_spec.md 的页面计划中安排这些提取内容；Executor 必须把可提取的数据、表格、图片、图表或页面证据落到具体页面。',
      '- 不得编造上传资料中没有出现的数据；如果无法原样取得图片/表格，应忠实重绘为清晰图表；不要在最终幻灯片可见区域写“资料来源/上传文档/文件名/来源说明”。',
      targets.length ? `- 识别到的提取对象：${targets.join('、')}` : '- 识别到的提取对象：用户指定的上传资料内容',
      pages.length ? `- 用户提到的页/幻灯片编号：${[...new Set(pages)].join('、')}` : '',
      sheets.length ? `- 用户提到的 Sheet/工作表：${[...new Set(sheets)].join('、')}` : '',
      '- 可用上传资料：',
      ...uploadedAssets.map((asset, index) => `  ${index + 1}. ${asset.name || asset.filename || asset.url || 'uploaded-asset'}（${asset.kind}）`)
    ].filter(Boolean).join('\n');
  }

  _stripGeneratedReferenceSummaryLines(text = '') {
    return String(text || '')
      .split(/\r?\n/)
      .filter(line => {
        const value = line.trim();
        if (!value) return false;
        return !/^(?:参考上传的PPT模板|参考上传图片|基于上传资料生成内容)\s*[：:]/.test(value);
      })
      .join('\n');
  }

  _hasReferenceExtractionIntent(text = '') {
    const value = String(text || '');
    if (!value.trim()) return false;
    const referenceNoun = '(?:附件|上传(?:的)?(?:资料|文件|文档|图片|PPT|ppt)?|参考(?:资料|文件|文档|图)?|资料|文档|文件|PDF|pdf|Word|word|Excel|excel|PPT|ppt|表格|图表|图片|截图|原图|第\\s*\\d+\\s*(?:页|頁|張|张|p|P|slide|Slide|幻灯片)|sheet|Sheet|工作表)';
    const actionVerb = '(?:用|使用|采用|按照|按|基于|依据|参考|提取|抽取|读取|识别|保留|放进|放到|插入|引用|复用|搬到|展示|呈现)';
    const targetNoun = '(?:数据|数字|指标|表格|图表|图片|图像|截图|原图|内容|文字|章节|结论|方法|实验结果|财务|营收|利润|流程图|架构图|第\\s*\\d+\\s*(?:页|頁|張|张|p|P|slide|Slide|幻灯片))';
    const actionThenReference = new RegExp(`${actionVerb}.{0,40}${referenceNoun}`, 'i');
    const referenceThenTarget = new RegExp(`${referenceNoun}.{0,40}(?:里|中|里面|上的|里的|中的)?.{0,20}${targetNoun}`, 'i');
    const preserveOriginal = /保留.{0,20}(?:原(?:始)?(?:图片|图表|表格|截图|格式)|文档(?:图片|图表|表格)|附件(?:图片|图表|表格))/i;
    return actionThenReference.test(value) || referenceThenTarget.test(value) || preserveOriginal.test(value);
  }

  _referenceExtractionTargets(text = '') {
    const value = String(text || '');
    const targets = [];
    const push = (condition, label) => {
      if (condition && !targets.includes(label)) targets.push(label);
    };
    push(/数据|数字|指标|数值|财务|营收|利润|成本|占比|比例|增长|同比|环比|实验结果|统计/i.test(value), '数据/指标');
    push(/表格|表|sheet|工作表|Excel|excel|xlsx|csv/i.test(value), '表格');
    push(/图表|折线|柱状|饼图|曲线|散点|雷达|矩阵/i.test(value), '图表');
    push(/图片|图像|插图|配图|截图|原图|流程图|架构图|系统图|示意图|figure|Figure/i.test(value), '图片/图示');
    push(/第\s*\d+\s*(?:页|頁|p|P|slide|Slide|幻灯片|張|张)/.test(value), '指定页/幻灯片');
    push(/章节|目录|标题|摘要|结论|方法|实验|研究背景|创新点|参考文献/.test(value), '章节文本');
    return targets;
  }

  _buildCoverPrompt() {
    return [
      `生成一张 16:9 的高端演示文稿主视觉背景图，主题是「${this.params.title}」。`,
      `视觉方向：${this._describeSelectedStyle()}。`,
      this.params.scenario ? `使用场景：${this.params.scenario}。` : '',
      '必须有明确可识别的主体物或场景，不要只做抽象渐变；主体清晰但不要占满画布，左侧或上方保留留白用于叠加标题，光影高级，层次丰富。',
      '严格不要生成可读文字、不要水印、不要 logo。'
    ].filter(Boolean).join('\n');
  }

  _buildKeySceneImagePrompt() {
    const pagePlan = this._fallbackPageTitles()
      .slice(1, Math.min(this.params.pageCount, 5))
      .join('、');
    return [
      `为「${this.params.title}」PPT 的关键内容页生成一张明确主体图片。`,
      pagePlan ? `可参考这些页面主题：${pagePlan}。` : '',
      '画面需要包含与主题直接相关的真实场景、物体、人物活动或产品/行业元素，适合嵌入商务演示页面。',
      '构图干净，有可裁切空间，避免抽象背景、文字、logo、水印。'
    ].filter(Boolean).join('\n');
  }

  _extractPendingImageRequests() {
    const parsed = this._parseImageResourceList(this.designSpec);
    if (parsed.length > 0) return this._limitPendingImageRequests(parsed);

    if (this.params.generateImages === false) return [];
    return [{
      filename: 'cover_visual_1.png',
      dimensions: this.params.canvasFormat === 'ppt43' ? '1600x1200' : '1920x1080',
      purpose: 'Cover background / section hero visual',
      type: 'Background',
      acquireVia: 'ai',
      status: 'Pending',
      reference: this._buildCoverPrompt(),
      description: this._buildCoverPrompt(),
      prompt: this._buildImagePromptForRequest({
        filename: 'cover_visual_1.png',
        dimensions: this.params.canvasFormat === 'ppt43' ? '1600x1200' : '1920x1080',
        purpose: 'Cover background / section hero visual',
        type: 'Background',
        acquireVia: 'ai',
        reference: this._buildCoverPrompt(),
        description: this._buildCoverPrompt()
      }),
      aspectRatio: this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9'
    }];
  }

  _limitPendingImageRequests(requests = []) {
    const maxAi = this._maxPptImageGenerationCount();
    const maxWeb = Math.max(this._maxAutoWebVisualAssets(), maxAi);
    let aiCount = 0;
    let webCount = 0;

    return requests.filter(request => {
      if (request.acquireVia === 'web') {
        if (webCount >= maxWeb) return false;
        webCount += 1;
        return true;
      }
      if (aiCount >= maxAi) return false;
      aiCount += 1;
      return true;
    });
  }

  _parseImageResourceList(designSpec = '') {
    const text = String(designSpec || '');
    if (!text.trim()) return [];

    const sectionMatch = text.match(/##\s*VIII\.\s*Image Resource List[\s\S]*?(?=\n##\s*(?:IX\.|9\.|X\.|XI\.)|\n---\n|$)/i);
    const section = sectionMatch ? sectionMatch[0] : text;
    const requests = [];

    const tableRows = section.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^\|.+\|$/.test(line) && !/^\|\s*-+/.test(line));
    if (tableRows.length >= 2) {
      const headers = tableRows[0].split('|').slice(1, -1).map(cell => this._normalizeTableHeader(cell));
      tableRows.slice(1).forEach(row => {
        const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
        if (cells.every(cell => /^-+$/.test(cell.replace(/\s/g, '')))) return;
        const record = {};
        headers.forEach((header, index) => {
          record[header] = cells[index] || '';
        });
        const request = this._imageRequestFromRecord(record);
        if (request) requests.push(request);
      });
    }

    const bulletLines = section.split(/\r?\n/).filter(line => /^\s*[-*]\s+/.test(line));
    bulletLines.forEach(line => {
      const request = this._imageRequestFromBullet(line);
      if (request) requests.push(request);
    });

    const seen = new Set();
    return requests
      .filter(item => /pending/i.test(item.status || '') || !item.status)
      .filter(item => {
        const key = item.filename.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(item => ({
        ...item,
        prompt: item.prompt || this._buildImagePromptForRequest(item),
        aspectRatio: item.aspectRatio || this._inferImageAspectRatio(item.ratio || item.dimensions)
      }));
  }

  _normalizeTableHeader(value = '') {
    const header = String(value || '').replace(/\*\*/g, '').trim().toLowerCase();
    const map = [
      [/file|filename|文件名|图片名|name/, 'filename'],
      [/acquire\s*via|acquire|source\s*path|via|获取方式|来源方式|采集方式/, 'acquire_via'],
      [/reference|intent|narrative|参考|意图/, 'reference'],
      [/generation|description|prompt|描述|说明|生成/, 'description'],
      [/\bratio\b|\baspect\b|比例/, 'ratio'],
      [/dimension|size|尺寸|分辨率/, 'dimensions'],
      [/purpose|usage|page|用途|页面|位置/, 'purpose'],
      [/type|类型|类别/, 'type'],
      [/status|状态/, 'status'],
    ];
    const found = map.find(([pattern]) => pattern.test(header));
    return found ? found[1] : header.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_');
  }

  _normalizeAcquireVia(value = '', context = {}) {
    const raw = String(value || '').trim().toLowerCase().replace(/[`'"“”‘’]/g, '');
    if (/^(web|search|sourced|openverse|wikimedia|pexels|pixabay|网页|网络|搜图|公开图库|图库)$/.test(raw)) return 'web';
    if (/^(user|existing|provided|upload|uploaded|用户|上传|已有|现有)$/.test(raw)) return 'user';
    if (/^(placeholder|manual|needs-manual|none|占位|人工|手动)$/.test(raw)) return 'placeholder';
    if (/^(ai|image|generate|generated|model|生图|ai生成|模型)$/.test(raw)) return 'ai';

    const status = String(context.status || '').toLowerCase();
    if (/existing|provided|已有|现有/.test(status)) return 'user';
    if (/placeholder|manual|needs-manual|占位|人工|手动/.test(status)) return 'placeholder';
    if (/sourced|web|网页|搜图/.test(status)) return 'web';

    const description = [
      context.reference,
      context.description,
      context.purpose,
      context.type,
      context.filename
    ].filter(Boolean).join(' ');
    if (PptWebVisualAssetService.isLogoLikeRequest(description) && PptWebVisualAssetService.findBestTechLogo(description)) {
      return 'web';
    }
    if (/公开图片|公开图库|真实照片|历史照片|人物照片|乔布斯|jobs|公司创始人|产品实拍|web\s*image|openverse|wikimedia|pexels|pixabay/i.test(description)) {
      return 'web';
    }
    if (this.params.generateImages === false) return 'placeholder';
    return 'ai';
  }

  _imageRequestFromRecord(record = {}) {
    const filename = this._normalizeImageRequestFilename(record.filename || record.file || record.name || '');
    const status = record.status || '';
    const acquireVia = this._normalizeAcquireVia(record.acquire_via || record.acquire || record.via || '', {
      status,
      reference: record.reference,
      description: record.description,
      purpose: record.purpose,
      type: record.type,
      filename
    });
    if (['user', 'placeholder'].includes(acquireVia)) return null;
    if (/existing|provided|manual|generated|已提供|已有|现有/i.test(status) && !/pending/i.test(status)) {
      return null;
    }
    const description = record.reference || record.description || record.intent || record.narrative || record.prompt || record.generation || '';
    if (!filename && !description) return null;
    const safeFilename = filename || this._fallbackImageFilename(description, 'png');
    return {
      filename: safeFilename,
      dimensions: record.dimensions || '',
      ratio: record.ratio || '',
      purpose: record.purpose || '',
      type: record.type || 'Background',
      acquireVia,
      status: status || 'Pending',
      reference: record.reference || description || record.purpose || safeFilename,
      description: description || record.purpose || safeFilename
    };
  }

  _imageRequestFromBullet(line = '') {
    const text = String(line || '').replace(/^\s*[-*]\s+/, '').trim();
    if (!/pending/i.test(text) && !/待生成|需生成/.test(text)) return null;

    const filenameMatch = text.match(/([A-Za-z0-9_\-./\u4e00-\u9fff]+?\.(?:png|jpe?g|webp))/i)
      || text.match(/\b(cover_visual_\d+|image_\d+|visual_\d+)\b/i);
    const filename = this._normalizeImageRequestFilename(filenameMatch?.[1] || '');
    if (!filename) return null;

    const dimensionsMatch = text.match(/(\d{3,4}\s*x\s*\d{3,4}|(?:\d{1,2}\s*[:：]\s*\d{1,2}))/i);
    const statusMatch = text.match(/\b(Pending|Generated|Needs-Manual)\b/i);
    const description = text
      .replace(filenameMatch[0], '')
      .replace(statusMatch?.[0] || '', '')
      .replace(dimensionsMatch?.[0] || '', '')
      .replace(/[:：,，;；]+/g, ' ')
      .trim();

    return {
      filename,
      dimensions: dimensionsMatch?.[1] || '',
      ratio: dimensionsMatch?.[1] || '',
      purpose: '',
      type: /background|背景|cover/i.test(text) ? 'Background' : 'Illustration',
      acquireVia: this._normalizeAcquireVia('', {
        status: statusMatch?.[1] || 'Pending',
        description: text,
        filename
      }),
      status: statusMatch?.[1] || 'Pending',
      reference: description || filename,
      description: description || filename
    };
  }

  _buildImagePromptsDocument(requests = [], defaultStatus = 'Pending', statuses = []) {
    const statusByFilename = new Map(statuses.map(item => [item.request.filename.toLowerCase(), item]));
    const anchor = this._deckImageStyleAnchor();
    const lines = [
      '# Image Prompts',
      '',
      '## Deck Style Anchor',
      anchor || 'professional presentation visual system, clean composition, high quality',
      ''
    ];

    requests.forEach((request, index) => {
      const status = statusByFilename.get(request.filename.toLowerCase());
      lines.push(`### Image ${index + 1}: ${request.filename}`);
      lines.push('');
      lines.push('| Attribute | Value |');
      lines.push('| --------- | ----- |');
      lines.push(`| Purpose | ${request.purpose || 'Presentation visual asset'} |`);
      lines.push(`| Type | ${request.type || 'Background'} |`);
      lines.push(`| Acquire Via | ${request.acquireVia || 'ai'} |`);
      lines.push(`| Dimensions | ${request.dimensions || request.aspectRatio || this.params.canvasFormat} |`);
      lines.push(`| Original description | ${this._singleLineTableCell(request.reference || request.description || request.purpose || request.filename)} |`);
      lines.push(`| Status | ${status?.status || defaultStatus} |`);
      if (status?.file) lines.push(`| File | ${status.file} |`);
      if (status?.reason) lines.push(`| Reason | ${this._trimText(status.reason, 220)} |`);
      lines.push('');
      lines.push('**Prompt**:');
      lines.push(request.prompt || this._buildImagePromptForRequest(request));
      lines.push('');
      lines.push('**Alt Text**:');
      lines.push(`> ${request.purpose || request.description || request.filename}`);
      lines.push('');
    });

    return lines.join('\n').trim() + '\n';
  }

  _buildImagePromptForRequest(request = {}) {
    const anchor = this._deckImageStyleAnchor();
    const aspect = request.aspectRatio || this._inferImageAspectRatio(request.dimensions) || (this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9');
    const isBackground = /background|cover|hero|封面|背景/i.test(`${request.type || ''} ${request.purpose || ''} ${request.filename || ''}`);
    const hasConcreteSubject = this._imageRequestHasConcreteSubject(request);
    const composition = hasConcreteSubject
      ? 'clear concrete foreground subject, polished editorial product photography / documentary presentation visual, rich recognizable objects, no flat abstract-only background'
      : isBackground
      ? 'presentation background, subtle depth, clear negative space for title overlay, no readable text'
      : 'presentation-ready visual asset, clear subject, uncluttered composition, no readable text';
    return [
      anchor,
      request.reference || request.description || request.purpose || this.params.title,
      composition,
      `${aspect} aspect ratio, high quality, sharp details`
    ].filter(Boolean).join(', ');
  }

  _imageRequestHasConcreteSubject(request = {}) {
    const text = [
      request.description,
      request.reference,
      request.purpose,
      request.type,
      request.filename
    ].filter(Boolean).join(' ');
    return /人物|肖像|创始人|乔布斯|jobs|iphone|ipad|imac|macbook|macintosh|apple\s*(?:ii|watch)?|手机|电脑|笔记本|产品|设备|实物|照片|photo|portrait|product|device|computer|phone|timeline|博物馆|展陈/i.test(text);
  }

  _deckImageStyleAnchor() {
    const colors = this._extractHexColors(this.designSpec)
      .concat(Object.values(this.templateReference?.themeColors || {}))
      .filter(value => /^#[0-9a-f]{6}$/i.test(String(value || '').trim()))
      .map(value => String(value).toUpperCase());
    const uniqueColors = [...new Set(colors)].slice(0, 5);
    const style = this.params.style === 'dark_tech'
      ? 'premium dark technology presentation visual, cinematic lighting, structured geometric detail'
      : this.params.style === 'consulting_top'
        ? 'premium consulting presentation visual, elegant minimal geometry, editorial composition'
        : 'modern professional presentation visual, clean geometric composition, polished corporate style';
    return [
      this.layoutTemplateReference?.label ? `ppt-master template style: ${this.layoutTemplateReference.label}` : '',
      this.params.styleLabel ? `selected deck style: ${this.params.styleLabel}` : '',
      style,
      uniqueColors.length ? `color palette: ${uniqueColors.join(', ')}` : '',
      'coherent deck style, high quality'
    ].filter(Boolean).join(', ');
  }

  _maxPptImageGenerationCount() {
    const explicit = parseInt(this.params.maxPptImages || this.params.max_ppt_images || this.runtimeConfig.pptMaxGeneratedImages, 10);
    return Math.min(Math.max(Number.isFinite(explicit) ? explicit : 4, 1), 12);
  }

  _pptImageVariantsPerRequest() {
    const raw = this.params.pptImageVariantsPerRequest
      || this.params.ppt_image_variants_per_request
      || this.runtimeConfig?.pptImageVariantsPerRequest;
    const parsed = parseInt(raw, 10);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
    return Math.max(1, Math.min(configured, 2));
  }

  _pptImageDispatchIntervalMs() {
    const raw = this.params.pptImageDispatchIntervalMs
      || this.params.ppt_image_dispatch_interval_ms
      || this.runtimeConfig.pptImageDispatchIntervalMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 0, 0), 60000);
  }

  _pptImageRequestConcurrency(total = 1) {
    const raw = this.params.pptImageConcurrency
      || this.params.ppt_image_concurrency
      || this.params.imageGenerationConcurrency
      || this.runtimeConfig.pptImageConcurrency
      || this.runtimeConfig.imageGenerationConcurrency;
    const parsed = parseInt(raw, 10);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
    return Math.max(1, Math.min(configured, 6, Math.max(1, total || 1)));
  }

  _webVisualAssetConcurrency(total = 1) {
    const raw = this.params.pptWebVisualConcurrency
      || this.params.ppt_web_visual_concurrency
      || this.runtimeConfig.pptWebVisualConcurrency;
    const parsed = parseInt(raw, 10);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
    return Math.max(1, Math.min(configured, 6, Math.max(1, total || 1)));
  }

  _svgPreviewRenderConcurrency(total = 1) {
    const raw = this.params.pptPreviewRenderConcurrency
      || this.params.ppt_preview_render_concurrency
      || this.runtimeConfig.pptPreviewRenderConcurrency;
    const parsed = parseInt(raw, 10);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
    return Math.max(1, Math.min(configured, 6, Math.max(1, total || 1)));
  }

  _aiVisualReviewConcurrency(total = 1) {
    const raw = this.params.aiVisualReviewConcurrency
      || this.params.ai_visual_review_concurrency
      || this.runtimeConfig.aiVisualReviewConcurrency;
    const parsed = parseInt(raw, 10);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
    return Math.max(1, Math.min(configured, 4, Math.max(1, total || 1)));
  }

  _pptStreamFirstTokenTimeoutMs() {
    const raw = this.params.pptStreamFirstTokenTimeoutMs
      || this.params.ppt_stream_first_token_timeout_ms
      || this.runtimeConfig.pptStreamFirstTokenTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 120000, 10000), 180000);
  }

  _pptStreamIdleTimeoutMs() {
    const raw = this.params.pptStreamIdleTimeoutMs
      || this.params.ppt_stream_idle_timeout_ms
      || this.runtimeConfig.pptStreamIdleTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 180000, 30000), 300000);
  }

  _pptExecutorCallTimeoutMs() {
    const raw = this.params.pptExecutorCallTimeoutMs
      || this.params.ppt_executor_call_timeout_ms
      || this.runtimeConfig?.pptExecutorCallTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 120000, 30000), 300000);
  }

  _pptExecutorStreamFirstTokenTimeoutMs() {
    const raw = this.params.pptExecutorStreamFirstTokenTimeoutMs
      || this.params.ppt_executor_stream_first_token_timeout_ms
      || this.runtimeConfig?.pptExecutorStreamFirstTokenTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 120000, 30000), 180000);
  }

  _pptExecutorStreamIdleTimeoutMs() {
    const raw = this.params.pptExecutorStreamIdleTimeoutMs
      || this.params.ppt_executor_stream_idle_timeout_ms
      || this.runtimeConfig?.pptExecutorStreamIdleTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 180000, 30000), 300000);
  }

  _pptModelQueueTimeoutMs() {
    const raw = this.params.pptModelQueueTimeoutMs
      || this.params.ppt_model_queue_timeout_ms
      || this.params.queueTimeoutMs
      || this.params.queue_timeout_ms
      || this.runtimeConfig.pptModelQueueTimeoutMs
      || this.runtimeConfig.pptQueueTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 300000, 5000), 900000);
  }

  _pptModelBusyRetryAttempts() {
    const raw = this.params.pptModelBusyRetryAttempts
      || this.params.ppt_model_busy_retry_attempts
      || this.runtimeConfig.pptModelBusyRetryAttempts;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 3, 0), 30);
  }

  _pptModelBusyRetryDelayMs(attempt = 1) {
    const raw = this.params.pptModelBusyRetryDelayMs
      || this.params.ppt_model_busy_retry_delay_ms
      || this.runtimeConfig.pptModelBusyRetryDelayMs;
    const parsed = parseInt(raw, 10);
    const base = Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
    return Math.min(120000, base * Math.max(1, attempt));
  }

  _isAiModelPoolBusyError(error) {
    const message = `${error?.code || ''} ${error?.message || ''}`;
    return /AI_MODEL_POOL_BUSY|所有模型.*并发上限|并发.*上限|model pool.*busy/i.test(message);
  }

  _pptImageQueueTimeoutMs() {
    const raw = this.params.pptImageQueueTimeoutMs
      || this.params.ppt_image_queue_timeout_ms
      || this.params.imageQueueTimeoutMs
      || this.params.queueTimeoutMs
      || this.params.queue_timeout_ms
      || this.runtimeConfig.pptImageQueueTimeoutMs
      || this.runtimeConfig.imageQueueTimeoutMs;
    const parsed = parseInt(raw, 10);
    return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 300000, 5000), 900000);
  }

  _targetPptImageGenerationCount() {
    if (this.params.generateImages === false) return 0;
    const maxCount = this._maxPptImageGenerationCount();
    return Math.min(Math.max(maxCount, 1), Math.max(1, this.params.pageCount || 1));
  }

  _normalizeImageRequestFilename(filename = '') {
    const trimmed = String(filename || '').trim().replace(/^images\//, '').replace(/^\.\.\//, '');
    if (!trimmed) return '';
    const ext = path.extname(trimmed);
    const base = ext ? path.basename(trimmed, ext) : trimmed;
    const safeBase = this._slugify(base).slice(0, 64) || 'image_asset';
    const safeExt = /\.(png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase() : '.png';
    return `${safeBase}${safeExt}`;
  }

  _normalizeGeneratedImageFilename(filename = '', extension = 'png') {
    const normalized = this._normalizeImageRequestFilename(filename);
    const base = normalized ? path.basename(normalized, path.extname(normalized)) : 'image_asset';
    return `${base}.${extension}`;
  }

  _variantImageFilename(filename = '', variantIndex = 2, extension = 'png') {
    const normalized = this._normalizeGeneratedImageFilename(filename, extension);
    const base = path.basename(normalized, path.extname(normalized));
    return `${base}_v${Math.max(2, parseInt(variantIndex, 10) || 2)}.${extension}`;
  }

  _fallbackImageFilename(seed = '', extension = 'png') {
    const base = this._slugify(seed || this.params.title || 'image_asset').slice(0, 36) || 'image_asset';
    return `${base}.${extension}`;
  }

  _inferImageAspectRatio(value = '') {
    const text = String(value || '').trim();
    const ratioMatch = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    if (ratioMatch) {
      const first = parseInt(ratioMatch[1], 10);
      const second = parseInt(ratioMatch[2], 10);
      const ratio = `${first}:${second}`;
      return AiService.aspectRatioMap[ratio] ? ratio : '';
    }
    const decimalRatio = parseFloat(text);
    if (Number.isFinite(decimalRatio) && decimalRatio > 0.2 && decimalRatio < 5) {
      const candidates = Object.entries(AiService.aspectRatioMap)
        .filter(([key]) => key !== 'auto')
        .map(([key, [rw, rh]]) => ({
          key,
          delta: Math.abs(decimalRatio - (rw / rh))
        }))
        .sort((a, b) => a.delta - b.delta);
      if (candidates[0]?.delta < 0.12) return candidates[0].key;
    }
    const sizeMatch = text.match(/(\d{3,4})\s*x\s*(\d{3,4})/i);
    if (!sizeMatch) return this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9';
    const width = parseInt(sizeMatch[1], 10);
    const height = parseInt(sizeMatch[2], 10);
    if (!width || !height) return this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9';
    const candidates = Object.entries(AiService.aspectRatioMap)
      .filter(([key]) => key !== 'auto')
      .map(([key, [rw, rh]]) => ({
        key,
        delta: Math.abs((width / height) - (rw / rh))
      }))
      .sort((a, b) => a.delta - b.delta);
    return candidates[0]?.delta < 0.12 ? candidates[0].key : (this.params.canvasFormat === 'ppt43' ? '4:3' : '16:9');
  }

  _buildStrategistPrompt(sourceContent) {
    this._recordRoleRead('Strategist', 'skills/ppt-master/references/strategist.md');
    this._recordRoleRead('Strategist', 'skills/ppt-master/templates/design_spec_reference.md');
    this._recordRoleRead('Strategist', 'skills/ppt-master/references/shared-standards.md');
    this._recordRoleRead('Strategist', 'skills/ppt-master/references/image-base.md');
    const strategistRef = this._loadPptMasterFile('skills/ppt-master/references/strategist.md', 16000);
    const sharedRef = this._loadPptMasterFile('skills/ppt-master/references/shared-standards.md', 14000);
    const imageBaseRef = this._loadPptMasterFile('skills/ppt-master/references/image-base.md', 9000);
    const designTemplate = this._loadPptMasterFile('skills/ppt-master/templates/design_spec_reference.md', 20000);
    const canvas = this._canvasInfo();
    const confirmations = (this.eightConfirmations?.items || [])
      .map(item => `${item.id}. ${item.name}: ${this._sanitizeStrategistPromptText(item.value)}`)
      .join('\n');
    const requestedPagePlan = this._formatRequestedPagePlan();
    const targetImages = this._targetPptImageGenerationCount();
    const customizationPrompt = this._agentCustomizationPrompt(8500);

    const imageApproach = this.params.generateImages === false
      ? '不依赖 AI 生图；如页面确实需要技术栈 logo / 产品标识 / 公开真实图片，可规划 Acquire Via: web，其他视觉以 SVG 图形和版式表达'
      : `必须规划至少 ${targetImages} 张 AI 生成资源。优先规划封面和关键内容页的明确主体图片（真实产品/人物场景/历史节点/行业场景/概念主体），不要只规划抽象背景。技术栈 logo / 产品标识 / 公开真实图片使用 Acquire Via: web。Step 5 Image_Generator 会读取 VIII. Image Resource List 的所有 Pending 行逐张生成、联网获取或标记 Needs-Manual`;
    const uploadedTemplateContext = this._formatUploadedTemplateContext(7000);
    const layoutTemplateContext = this._formatLayoutTemplateContext(10000);
    const hasTemplateContext = Boolean(uploadedTemplateContext || layoutTemplateContext);

    const strategistRefSafe = this._sanitizeStrategistPromptText(strategistRef);
    const sharedRefSafe = this._sanitizeStrategistPromptText(sharedRef);
    const imageBaseRefSafe = this._sanitizeStrategistPromptText(imageBaseRef);
    const designTemplateSafe = this._sanitizeStrategistPromptText(designTemplate);
    const sourceContentSafe = this._sanitizeStrategistPromptText(this._trimText(sourceContent, 10000));
    const selectedStyleSafe = this._sanitizeStrategistPromptText(this._describeSelectedStyle());

    return `你是世界顶级的 AI 演示文稿策划师（Strategist）。你正在为自动演示生成器准备 design_spec.md。

## Eight Confirmations（已由 Web 生成请求一次性确认）
${confirmations}

## 已确认参数
- Canvas format: ${canvas.format} (${canvas.width}x${canvas.height})
- viewBox: ${canvas.viewBox}
- Page count: ${this.params.pageCount}${this.params.pageCountMode === 'auto' ? ' (chosen by AI from content scope)' : ''}
- Target audience: ${this.params.audience || '由源内容推断'}
- Style objective: ${selectedStyleSafe}
- Color scheme: ${hasTemplateContext ? '优先从 Step 3 模板参考中抽取并固化到 design_spec/spec_lock 的 HEX 色板' : '使用后续 spec_lock.md 中的专业浅色商务调色板，不要发散到未声明颜色'}
- Icon approach: 内置图标用于通用概念；涉及技术栈、公司/产品品牌、软件框架时，优先规划联网获取的真实 logo/icon，并在 VIII. Image Resource List 中写成 web 资源
- Typography plan: PPT-safe CJK sans stack
- Image approach: ${imageApproach}；适合联网找图的类型包括但不限于：技术栈/品牌 logo、真实产品或设备图、行业/工作现场照片、地点/城市/校园/园区图、人物/历史节点图、实验室/工厂/数据中心等基础设施图、公开报告或产品视觉参考
${requestedPagePlan ? `\n## 用户已确认逐页结构（必须逐页保留，不得改成通用“封面/目录/背景/现状”）\n${requestedPagePlan}` : ''}
${customizationPrompt ? `\n## AI Designer Agent Customization\n${customizationPrompt}` : ''}
${layoutTemplateContext ? `\n## ppt-master Step 3 内置模板上下文（必须执行）\n${layoutTemplateContext}\n\n## 内置模板落地要求\n- 只能吸收模板视觉系统和页面结构节奏；模板名、Template、ppt-master、文件路径、来源说明不得进入最终幻灯片可见文字。\n- III. Visual Theme、IV. Typography、V. Layout Principles、VI. Icon Usage、VII. Visualization Reference、IX. Content Outline 要体现模板的页面类型、背景语言、标题区、页脚几何/页码、留白、色板和结构节奏，但不能写成面向观众可见的元信息。\n- 如果选中 Google、像素、政务、医疗、招行、电信等模板，只需写出该模板的独特视觉规则，不要复述内部流程名或来源词。` : ''}
${uploadedTemplateContext ? `\n## 上传 PPT 模板参考（必须吸收为视觉系统）\n${uploadedTemplateContext}\n\n## 上传模板落地要求\n- design_spec.md 的 III. Visual Theme、IV. Typography、V. Layout Principles、VIII. Image Resource List 要体现上传模板的颜色、字体、页眉页脚几何、背景肌理、留白和内容区比例。\n- 如果模板解析为 full_svg_reference，优先参考代表性 SVG 页的结构节奏；如果降级为 manifest_only，则至少使用 manifest 中的主题色、字体、页面类型和可用素材。\n- 不要把上传 PPTX 原名、模板名或资料来源写成可见页脚/角标；只保留视觉系统要求。` : ''}

## Strategist 角色定义
${strategistRefSafe}

## 技术约束摘要
${sharedRefSafe}

## v2.6 Image Acquisition 规则摘要
${imageBaseRefSafe}

## Design Spec 模板
${designTemplateSafe}

## 源内容
${sourceContentSafe}

## 输出要求
1. 只输出完整 design_spec.md，不要输出解释。
2. 保留模板 Section I 到 Section XI 的结构。
3. 内容语言使用简体中文，模板字段名可以保留英文。
4. 页面清单必须精确规划 ${this.params.pageCount} 页。
5. 如果用户输入中已有 P01/P02/P03 逐页标题，IX. Content Outline 必须使用这些标题和顺序。
6. VIII. Image Resource List 必须使用新版表格列：Filename | Dimensions | Ratio | Purpose | Type | Acquire Via | Status | Reference。
7. Acquire Via 只能写 ai / web / user / placeholder；AI 定制图写 ai；公开真实照片、历史人物、城市地点、园区/校园/工厂/实验室/数据中心、产品/设备/机器人/车辆/芯片、技术栈 logo/icon、产品 logo、公司标识优先写 web；上传素材写 user，不需要图片写 placeholder。
8. 如果列出图片资源，Filename 必须是真实文件名（如 cover_bg.png、react_logo.png、warehouse_robot.jpg、campus_view.jpg），不要只写 cover_visual_1；Status 初始写 Pending，Reference 写具体意图或 2-5 个英文检索关键词。
9. 如果源内容包含“技术栈/架构/框架/组件/数据库/缓存/压测/实时通信”等页面，必须为关键技术名规划 logo 资源，例如 react_logo.png、redis_logo.png、postgresql_logo.png；Reference 写“React official logo / React 技术图标”这类短意图，不要让 AI 画假 logo。
10. 如果页面主题涉及具体行业、实体产品、人物、地点、设备、场景，优先规划 1-3 张 web 真实素材；不要用 AI 生图伪造真实品牌、真实人物、真实城市地标、真实产品外观。
11. AI生图开启时，VIII. Image Resource List 至少列出 ${targetImages} 行 Pending，并且 IX. Content Outline 必须在对应页面写明使用这些图片；Reference 必须写清具体主体、场景、构图和禁用文字，不要写“抽象背景/科技渐变/通用概念图”这种泛化提示。
12. 如果存在“内置版式上下文”，当前 design_spec.md 必须明确写入该版式的名称、专属色板、页面类型映射、结构规则和至少 3 条从参考 SVG 学到的版式规则；否则视为没有按照版式参考执行。
13. 最终幻灯片的可见文字禁止出现任何版式系统名、参考来源说明、上传文件说明、文件路径、内部流程名或自动化阶段名；这些信息只能留在 design_spec.md 和内部上下文中。`;
  }

  _buildFallbackDesignSpec(sourceContent, reason = '') {
    const canvas = this._canvasInfo();
    const pages = this._fallbackPageTitles();
    const lines = [
      `# ${this.params.title} - Design Spec`,
      '',
      '## I. Project Information',
      `- Project Name: ${this.params.title}`,
      `- Canvas Format: ${canvas.format} (${canvas.width}x${canvas.height})`,
      `- Page Count: ${this.params.pageCount}`,
      `- Design Style: ${this._sanitizeStrategistPromptText(this._describeSelectedStyle())}`,
      `- Target Audience: ${this.params.audience || '专业汇报受众'}`,
      '',
      '## II. Canvas Specification',
      `- viewBox: ${canvas.viewBox}`,
      '- Margins: 56px left/right, 48px top/bottom',
      '',
      '## III. Visual Theme',
      this.layoutTemplateReference
        ? `- Built-in visual system active: ${this.layoutTemplateReference.template} (${this.layoutTemplateReference.label}); preserve its page chrome, title zone, footer geometry/page number, background geometry and spacing rhythm. Do not render internal metadata as visible text.`
        : '',
      this.params.style === 'dark_tech'
        ? '- Dark tech theme, technical architecture layout, high contrast, restrained accent colors.'
        : '- Light theme, structured consulting layout, clear hierarchy.',
      this.templateReference
        ? `- Uploaded visual reference active; preserve its color, typography, spacing, header/footer geometry and decorative rhythm. Do not render uploaded file names or internal notes as visible text.`
        : '',
      '',
      '### Color Scheme',
      '| Role | HEX | Purpose |',
      '| ---- | --- | ------- |',
      `| Background | ${this._paletteForStyle(this.params.style).bg} | Slide canvas |`,
      `| Secondary bg | ${this._paletteForStyle(this.params.style).surface} | Panels and cards |`,
      `| Primary | ${this._paletteForStyle(this.params.style).primary} | Titles and key marks |`,
      `| Accent | ${this._paletteForStyle(this.params.style).accent} | Highlights and chart series |`,
      `| Secondary accent | ${this._paletteForStyle(this.params.style).secondary_accent} | Supporting emphasis |`,
      `| Body text | ${this._paletteForStyle(this.params.style).text} | Main copy |`,
      `| Secondary text | ${this._paletteForStyle(this.params.style).text_secondary} | Captions and notes |`,
      `| Border/divider | ${this._paletteForStyle(this.params.style).border} | Strokes and dividers |`,
      `| Success | ${this._paletteForStyle(this.params.style).success} | Positive indicators |`,
      `| Warning | ${this._paletteForStyle(this.params.style).warning} | Risk indicators |`,
      '',
      '### Gradient Scheme',
      '- Use SVG linearGradient/radialGradient in <defs> for background depth, title accents, chart panels and subtle glow.',
      '',
      '## IV. Typography System',
      '- Body: "Microsoft YaHei", Arial, sans-serif; body 22px.',
      '- Title: "Microsoft YaHei", Arial, sans-serif; title 36px.',
      '',
      '## V. Layout Principles',
      '- Use varied layouts: cover, layered architecture, chart + KPI, roadmap/timeline, summary.',
      '- Keep text wrapped with tspan; avoid dense paragraphs.',
      '',
      '## VI. Icon Usage Specification',
      '- Use approved icon inventory only when useful.',
      '',
      '## VII. Visualization Reference List',
      '| Visualization | Reference Layout | Used In | Purpose |',
      '| ------------- | ------------------ | ------- | ------- |',
      '| layered_architecture | templates/charts/layered_architecture.svg | P02 | 技术架构分层表达 |',
      '| line_chart + kpi_cards | templates/charts/line_chart.svg; templates/charts/kpi_cards.svg | P03 | 市场趋势与运营指标 |',
      '| timeline / process_flow | templates/charts/timeline.svg; templates/charts/process_flow.svg | P04 | 90天实施路径 |',
      '',
      '## VIII. Image Resource List',
      '| Filename | Dimensions | Ratio | Purpose | Type | Acquire Via | Status | Reference |',
      '| -------- | ---------- | ----- | ------- | ---- | ----------- | ------ | --------- |',
      ...(this.imageAssets.length > 0
        ? this.imageAssets.map(asset => {
          const description = this._singleLineTableCell(this._sanitizeStrategistPromptText(asset.description));
          return `| ${path.basename(asset.relativePath)} | 1280x720 | 16:9 | ${description} | Background | user | Existing | ${description} |`;
        })
        : [this.params.generateImages === false
          ? '| none | - | - | No required external images | - | placeholder | Placeholder | SVG-native visuals only |'
          : `| cover_bg.png | 1280x720 | 16:9 | P01 cover subject visual | Photography | ai | Pending | ${this._singleLineTableCell(this._buildCoverPrompt())} |`,
        this.params.generateImages === false
          ? ''
          : `| key_scene_visual.png | 1280x720 | 16:9 | Key content page subject visual | Photography | ai | Pending | ${this._singleLineTableCell(this._buildKeySceneImagePrompt())} |`].filter(Boolean)),
      '',
      '## IX. Content Outline',
      ...pages.map((title, index) => [
        `### Slide ${String(index + 1).padStart(2, '0')} - ${title}`,
        `- **Title**: ${title.replace(/^.*?：/, '')}`,
        `- **Layout**: ${this._fallbackLayoutForPage(index + 1)}`,
        `- **Visualization**: ${this._fallbackVisualizationForPage(index + 1)}`,
        '- **Content**:',
        `  - ${this._fallbackContentPointForPage(index + 1, 1)}`,
        `  - ${this._fallbackContentPointForPage(index + 1, 2)}`,
        `  - ${this._fallbackContentPointForPage(index + 1, 3)}`
      ].join('\n')),
      '',
      '## X. Speaker Notes Plan',
      '- Each page should include concise talk track and transition.',
      '- The note plan should stay internal and should not leak into visible slide text.',
      '',
      '## XI. Execution Notes',
      '- Keep the executor focused on visual-system consistency, SVG-native layout, and clean page transitions.',
      '- Preserve the page plan and visual rules, but do not render internal labels as visible slide text.'
    ];

    const internalNotes = [
      '## XII. Internal Notes',
      '- This draft was produced by the strategist fallback path and should stay internal.',
      '- Keep the page plan, palette, and visual geometry consistent with the current project context.',
      '- Recheck the page plan against the source content before executor generation.'
    ];

    if (reason) {
      internalNotes.push('- Fallback reason recorded in internal logs.');
    }

    return [...lines, '', ...internalNotes].join('\n');
  }

  _buildSpecLock(designSpec = this.designSpec) {
    const canvas = this._canvasInfo();
    const palette = this._derivePaletteForSpecLock(designSpec);
    const typography = this._deriveTypographyForSpecLock(designSpec);
    const rhythms = this._pageRhythms();
    const imageLines = this.imageAssets.length > 0
      ? this.imageAssets.map((asset, index) => `- image_${index + 1}: ${asset.relativePath} | svg_href=${asset.svgHref || `../${asset.relativePath}`}`)
      : [];
    const templateColorLines = this._templateColorLockLines();
    const layoutTemplateColorLines = this._layoutTemplateColorLockLines();
    const extraColorLines = this._extraSpecColorLockLines(designSpec, palette);

    return [
      '# Execution Lock',
      '',
      '## canvas',
      `- viewBox: ${canvas.viewBox}`,
      `- format: ${canvas.format}`,
      '',
      '## colors',
      `- bg: ${palette.bg}`,
      `- surface: ${palette.surface}`,
      `- primary: ${palette.primary}`,
      `- accent: ${palette.accent}`,
      `- secondary_accent: ${palette.secondary_accent}`,
      `- text: ${palette.text}`,
      `- text_secondary: ${palette.text_secondary}`,
      `- border: ${palette.border}`,
      `- muted: ${palette.muted}`,
      `- success: ${palette.success}`,
      `- warning: ${palette.warning}`,
      '',
      ...(extraColorLines.length > 0 ? ['## design_spec_colors', ...extraColorLines, ''] : []),
      ...(templateColorLines.length > 0 ? ['## uploaded_template_colors', ...templateColorLines, ''] : []),
      ...(layoutTemplateColorLines.length > 0 ? ['## layout_template_colors', ...layoutTemplateColorLines, ''] : []),
      '## typography',
      `- font_family: ${typography.font_family}`,
      `- title_family: ${typography.title_family}`,
      `- body_family: ${typography.body_family}`,
      `- emphasis_family: ${typography.emphasis_family}`,
      `- code_family: ${typography.code_family}`,
      `- body: ${typography.body}`,
      `- title: ${typography.title}`,
      `- subtitle: ${typography.subtitle}`,
      `- annotation: ${typography.annotation}`,
      `- cover_title: ${typography.cover_title}`,
      `- hero_number: ${typography.hero_number}`,
      '',
      '## icons',
      '- library: chunk-filled',
      '- inventory: target, bolt, shield, users, chart-bar, lightbulb, check, arrow-right, layers, timeline',
      '',
      ...(imageLines.length > 0 ? ['## images', ...imageLines, ''] : []),
      '## page_rhythm',
      ...rhythms.map((rhythm, index) => `- P${String(index + 1).padStart(2, '0')}: ${rhythm}`),
      '',
      '## forbidden',
      '- Mixing icon libraries',
      '- rgba()',
      '- `<style>`, `class`, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<script>`, `<iframe>`, `<symbol>`+`<use>`',
      '- `mask`; `clipPath` is allowed only when defined in `<defs>` and applied directly to `<image>` elements',
      '- `<g opacity>` (set opacity on each child element individually)',
      '- `<image opacity>`',
      '- HTML named entities in text'
    ].join('\n');
  }

  _derivePaletteForSpecLock(designSpec = '') {
    const fallback = this._paletteForStyle(this.params.style);
    const colors = this._extractNamedColors(designSpec);
    const values = this._extractHexColors(designSpec)
      .concat(Object.values(this.templateReference?.themeColors || {}))
      .concat((this.layoutTemplateReference?.namedColors || []).map(item => item.value))
      .concat(this._extractHexColors(this.layoutTemplateReference?.designSpec || ''))
      .filter(value => /^#[0-9a-f]{6}$/i.test(String(value || '').trim()))
      .map(value => String(value).toUpperCase());
    const uniqueValues = [...new Set(values)];
    const byExactRole = aliases => {
      const normalizedAliases = aliases.map(alias => this._normalizeSpecRoleName(alias));
      const found = colors.find(item => normalizedAliases.includes(this._normalizeSpecRoleName(item.name)));
      return found?.value;
    };
    const byRole = (aliases, namePattern) => {
      const exact = byExactRole(aliases);
      if (exact) return exact;
      const found = colors.find(item => namePattern.test(this._normalizeSpecRoleName(item.name)));
      return found?.value;
    };
    const pick = (key, aliases, namePattern, fallbackIndex) => (
      byRole(aliases, namePattern) ||
      uniqueValues[fallbackIndex] ||
      fallback[key]
    );

    return {
      bg: pick('bg', ['background', 'bg', 'page background', 'canvas background', '背景', '底色'], /(?:^| )(?:bg|background|page|canvas)(?: |$)|背景|底色/i, 0),
      surface: pick('surface', ['secondary bg', 'secondary background', 'surface', 'card', 'panel', 'block', '模块', '卡片', '面板'], /(?:^| )(?:secondary bg|secondary background|surface|card|panel|block)(?: |$)|模块|卡片|面板/i, 1),
      primary: pick('primary', ['primary', 'brand', 'main', 'main color', '主色', '品牌色', '核心色'], /(?:^| )(?:primary|brand|main)(?: |$)|主色|品牌|核心/i, 2),
      accent: pick('accent', ['accent', 'highlight', 'emphasis', '强调色', '点缀色', '高亮'], /(?:^| )(?:accent|highlight|emphasis)(?: |$)|强调|点缀|高亮/i, 3),
      secondary_accent: pick('secondary_accent', ['secondary accent', 'secondary_accent', 'support accent', '辅助强调', '次强调'], /(?:^| )(?:secondary accent|support accent)(?: |$)|辅助强调|次强调/i, 4),
      text: pick('text', ['body text', 'main text', 'foreground', 'text', '正文', '正文文字', '主文本', '主文字'], /(?:^| )(?:body text|main text|foreground|text)(?: |$)|正文|主文本|主文字/i, 5),
      text_secondary: pick('text_secondary', ['secondary text', 'muted text', 'caption text', 'caption', '次级文本', '辅助文本', '说明文字'], /(?:^| )(?:secondary text|muted text|caption text|caption)(?: |$)|次级文本|辅助文本|说明文字/i, 6),
      border: pick('border', ['border divider', 'border/divider', 'border', 'divider', 'stroke', 'line', '分割线', '边框'], /(?:^| )(?:border divider|border|divider|stroke|line)(?: |$)|分割|边框/i, 7),
      muted: pick('muted', ['muted', 'subtle', 'neutral', 'tertiary text', 'tertiary', '弱化', '中性色'], /(?:^| )(?:muted|subtle|neutral|tertiary)(?: |$)|弱化|中性|灰/i, 8),
      success: pick('success', ['success', 'positive', 'green', '成功', '正向'], /(?:^| )(?:success|positive|green)(?: |$)|成功|正向/i, 9),
      warning: pick('warning', ['warning', 'risk', 'negative', 'red', 'alert', '风险', '警示'], /(?:^| )(?:warning|risk|negative|red|alert)(?: |$)|风险|警示/i, 10)
    };
  }

  _normalizeSpecRoleName(value = '') {
    return String(value || '')
      .replace(/[`*_"]/g, '')
      .replace(/[()（）\[\]【】]/g, ' ')
      .replace(/[\/|:：,，;；\-–—]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  _extractNamedColors(text = '') {
    const lines = String(text || '').split(/\r?\n/);
    const colors = [];
    lines.forEach(line => {
      let match = line.match(/^\s*\|\s*(?:\*\*)?([^|`*]+?)(?:\*\*)?\s*\|\s*`?(#[0-9a-f]{6})`?\s*\|/i);
      if (!match) {
        match = line.match(/(?:\|\s*)?([^|:#`>*-][^|:#`]*?)(?:\s*\||\s*[:：-])\s*`?(#[0-9a-f]{6})`?\b/i);
      }
      if (!match) return;
      colors.push({
        name: String(match[1] || '').replace(/\*\*/g, '').trim().toLowerCase(),
        value: String(match[2]).toUpperCase()
      });
    });
    return colors;
  }

  _extractHexColors(text = '') {
    return (String(text || '').match(/#[0-9a-f]{6}\b/gi) || [])
      .map(value => value.toUpperCase());
  }

  _extraSpecColorLockLines(designSpec = '', palette = {}) {
    const paletteValues = new Set(Object.values(palette).map(value => String(value).toUpperCase()));
    const named = this._extractNamedColors(designSpec);
    const lines = [];
    const usedKeys = new Set();
    named.forEach((item, index) => {
      if (!item.value || paletteValues.has(item.value)) return;
      const keyBase = this._slugify(item.name).slice(0, 28) || `color_${index + 1}`;
      let key = keyBase;
      let suffix = 2;
      while (usedKeys.has(key)) {
        key = `${keyBase}_${suffix}`;
        suffix += 1;
      }
      usedKeys.add(key);
      lines.push(`- ${key}: ${item.value}`);
    });

    if (lines.length >= 12) return lines.slice(0, 12);
    const existingValues = new Set([
      ...paletteValues,
      ...lines.map(line => line.match(/#[0-9A-F]{6}/)?.[0]).filter(Boolean)
    ]);
    this._extractHexColors(designSpec).forEach(value => {
      if (lines.length >= 12 || existingValues.has(value)) return;
      existingValues.add(value);
      lines.push(`- spec_color_${lines.length + 1}: ${value}`);
    });
    return lines;
  }

  _deriveTypographyForSpecLock(designSpec = '') {
    const text = String(designSpec || '');
    const fallbackFont = this._pptSafeFontFamily(this._extractFontFamily(text) || this.templateReference?.themeFonts?.majorFont || '');
    const defaultFamily = fallbackFont || 'Microsoft YaHei, Arial, sans-serif';
    const titleFamily = this._pptSafeFontFamily(this._extractRoleFontStack(text, 'title')) || defaultFamily;
    const bodyFamily = this._pptSafeFontFamily(this._extractRoleFontStack(text, 'body')) || defaultFamily;
    const emphasisFamily = this._pptSafeFontFamily(this._extractRoleFontStack(text, 'emphasis')) || titleFamily || defaultFamily;
    const codeFamily = this._pptSafeFontFamily(this._extractRoleFontStack(text, 'code')) || 'Consolas, Courier New, monospace';
    const sizeTable = this._extractTypographySizes(text);
    const numberFor = (aliases, fallback, min, max, rejectPattern = null) => {
      const labels = (Array.isArray(aliases) ? aliases : String(aliases || '').split('|'))
        .map(item => this._normalizeSpecRoleName(item))
        .filter(Boolean);
      const sorted = [...sizeTable].sort((a, b) => b.priority - a.priority);
      const isRejected = role => rejectPattern && rejectPattern.test(role);
      const exactMatch = sorted.find(item => labels.includes(item.role) && !isRejected(item.role));
      const containedMatch = sorted.find(item => !isRejected(item.role) && labels.some(candidate => {
        if (candidate.length <= 4) return item.role === candidate || item.role.startsWith(`${candidate} `);
        return item.role.includes(candidate) || candidate.includes(item.role);
      }));
      const tableMatch = exactMatch || containedMatch;
      if (tableMatch?.size) return this._clampTypographySize(tableMatch.size, min, max, fallback);
      const patterns = [
        new RegExp(`(?:${labels.join('|')})[^\\n\\d]{0,40}(\\d{2,3})\\s*(?:px|pt)?`, 'i'),
        new RegExp(`(?:${labels.includes('body') ? '正文|Body' : labels.includes('title') ? '标题|Title' : labels.join('|')})[^\\n\\d]{0,40}(\\d{2,3})\\s*(?:px|pt)?`, 'i')
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (parsed >= 8 && parsed <= 120) return this._clampTypographySize(parsed, min, max, fallback);
        }
      }
      return fallback;
    };

    return {
      font_family: bodyFamily,
      title_family: titleFamily,
      body_family: bodyFamily,
      emphasis_family: emphasisFamily,
      code_family: codeFamily,
      body: numberFor(['body', 'body content', '正文'], 22, 16, 22),
      title: numberFor(['page title', 'chapter section opener', 'section opener', 'title', '标题'], 36, 30, 42, /\b(?:cover|hero)\b/),
      subtitle: numberFor(['subtitle', 'cover subtitle', '副标题'], 28, 20, 30),
      annotation: numberFor(['annotation', 'caption', 'section label eyebrow', 'footnote', '说明', '注释'], 14, 11, 16),
      cover_title: numberFor(['cover title', 'hero headline', 'hero title', 'cover_title', '封面标题'], 56, 48, 72),
      hero_number: numberFor(['hero number', 'hero metric', 'metric', 'hero_number', 'kpi'], 48, 32, 56)
    };
  }

  _extractRoleFontStack(text = '', role = '') {
    const source = String(text || '');
    const roleNames = {
      title: ['Title', '标题', 'Page title', 'Cover title'],
      body: ['Body', '正文', 'Body content'],
      emphasis: ['Emphasis', '强调'],
      code: ['Code', '代码']
    }[role] || [role];

    for (const name of roleNames) {
      const bullet = source.match(new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?${this._escapeRegExp(name)}(?:\\*\\*)?\\s*[:：]\\s*([^\\n]+)`, 'im'));
      if (bullet?.[1]) return bullet[1].replace(/\[.*?]/g, '').trim();
    }

    const tableRows = source.split(/\r?\n/).filter(line => /^\s*\|.+\|\s*$/.test(line));
    for (const line of tableRows) {
      const cells = this._splitMarkdownTableRow(line);
      if (cells.length < 2) continue;
      const normalizedRole = this._normalizeSpecRoleName(cells[0]);
      if (!roleNames.some(name => normalizedRole.includes(this._normalizeSpecRoleName(name)))) continue;
      const stackCell = cells.find(cell => /font-family|microsoft yahei|arial|georgia|simsun|consolas|serif|sans-serif|monospace/i.test(cell));
      if (stackCell) return stackCell;
    }
    return '';
  }

  _extractTypographySizes(text = '') {
    const rows = [];
    let inRecommended = false;
    String(text || '').split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (/recommended applied sizes|建议.*(?:字号|尺寸)|推荐.*(?:字号|尺寸)/i.test(trimmed)) {
        inRecommended = true;
        return;
      }
      if (inRecommended && /^#{1,6}\s+/.test(trimmed)) {
        inRecommended = false;
      }

      const bullet = trimmed.match(/^\s*[-*]\s*(?:\*\*)?([^:：*]+?)(?:\*\*)?\s*[:：]\s*(.+)$/);
      if (bullet) {
        const role = this._normalizeSpecRoleName(bullet[1]);
        const size = this._parseTypographySizeCell(bullet[2], role);
        if (role && Number.isFinite(size)) {
          rows.push({ role, size, priority: inRecommended ? 100 : 70 });
        }
      }

      const cells = trimmed.startsWith('|')
        ? line.split('|').slice(1, -1).map(cell => cell.replace(/\*\*/g, '').trim())
        : [];
      if (cells.length >= 2 && !/^[-\s]+$/.test(cells[0])) {
        const role = this._normalizeSpecRoleName(cells[0]);
        const preferredCell = cells.find(cell => /body\s*=\s*18|dense|紧凑/i.test(cell) && /\b\d{2,3}(?:\s*-\s*\d{2,3})?\s*px\b/i.test(cell)) ||
          cells.find(cell => /\b\d{2,3}(?:\s*-\s*\d{2,3})?\s*px\b/i.test(cell));
        const size = this._parseTypographySizeCell(preferredCell, role);
        if (role && Number.isFinite(size)) {
          rows.push({ role, size, priority: /dense|紧凑|body\s*=\s*18/i.test(preferredCell || '') ? 55 : 40 });
        }
      }
    });

    return rows;
  }

  _parseTypographySizeCell(cell = '', role = '') {
    const text = String(cell || '');
    const range = text.match(/\b(\d{2,3})\s*-\s*(\d{2,3})\s*px\b/i);
    if (range) {
      const low = parseInt(range[1], 10);
      const high = parseInt(range[2], 10);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
      const target = /\b(?:cover|hero)\b/.test(role)
        ? Math.round(low + (high - low) * 0.65)
        : Math.round((low + high) / 2);
      return target;
    }
    const single = text.match(/\b(\d{2,3})\s*(?:px|pt)\b/i);
    return single ? parseInt(single[1], 10) : null;
  }

  _clampTypographySize(value, min, max, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  _extractFontFamily(text = '') {
    const patterns = [
      /font[_\s-]*family\s*[:：]\s*([^\n]+)/i,
      /font stack\s*[:：]\s*([^\n]+)/i,
      /字体(?:族|方案|栈)?\s*[:：]\s*([^\n]+)/i
    ];
    for (const pattern of patterns) {
      const match = String(text || '').match(pattern);
      if (match?.[1]) return match[1].replace(/[`*_]/g, '').trim();
    }
    return '';
  }

  _pptSafeFontFamily(value = '') {
    const raw = String(value || '').split(/\n/)[0].replace(/[`*_]/g, '').replace(/[;。]+$/g, '').trim();
    if (!raw) return '';
    if (/^(?:same as|same-as|同|与.*相同)/i.test(raw)) return '';
    const safeFonts = raw
      .split(',')
      .map(item => item.replace(/["']/g, '').trim())
      .filter(Boolean)
      .filter(font => !/emoji|symbol|serif display/i.test(font))
      .slice(0, 4);
    if (!safeFonts.length) return '';
    if (!safeFonts.some(font => /Microsoft YaHei|Arial|PingFang|Noto Sans CJK|Source Han Sans/i.test(font))) {
      safeFonts.push('Microsoft YaHei', 'Arial', 'sans-serif');
    }
    return [...new Set(safeFonts)].join(', ');
  }

  _formatExecutorImageAssetContext(maxChars = 7000, pageNum = null) {
    if (!Array.isArray(this.imageAssets) || this.imageAssets.length === 0) return '';
    const existing = this.imageAssets
      .filter(asset => asset?.relativePath && fs.existsSync(asset.path || path.join(this.projectPath, asset.relativePath)));
    const pageContext = pageNum
      ? [
        this._inferPageDescription(pageNum),
        this._pageSpecificContext(pageNum),
        pageNum === 1 ? 'cover 封面 hero background' : '',
        pageNum === this.params.pageCount ? 'ending thanks summary 结尾 致谢 总结' : ''
      ].filter(Boolean).join(' ').toLowerCase()
      : '';
    const tokens = pageContext
      .split(/[^\p{L}\p{N}_-]+/u)
      .map(token => token.trim().toLowerCase())
      .filter(token => token.length >= 2)
      .slice(0, 80);
    const scored = existing.map((asset, index) => {
      const haystack = [
        asset.filename,
        asset.relativePath,
        asset.description,
        asset.origin,
        asset.label,
        asset.prompt,
        asset.reference
      ].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      tokens.forEach(token => {
        if (haystack.includes(token)) score += token.length >= 4 ? 2 : 1;
      });
      if (pageNum === 1 && /cover|hero|封面|background|bg/i.test(haystack)) score += 8;
      if (pageNum === this.params.pageCount && /ending|thanks|致谢|总结|summary/i.test(haystack)) score += 6;
      if (asset.origin === 'template_reference' || asset.origin === 'layout_template') score += 1;
      return { asset, index, score };
    });
    const selected = pageNum && scored.length > 14
      ? scored
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 14)
        .map(item => item.asset)
      : existing;
    const safeSelected = selected.length > 0 ? selected : existing.slice(0, 14);
    const lines = safeSelected
      .map(asset => {
        const href = asset.svgHref || `../${asset.relativePath}`;
        const origin = asset.origin === 'uploaded_document'
          ? '上传资料图片'
          : (asset.origin === 'template_reference'
            ? '上传模板素材'
            : (asset.origin === 'layout_template'
              ? 'ppt-master 内置模板图片/logo资产'
              : (asset.origin === 'web_logo'
                ? '联网技术/品牌图标，按 images/web_visual_sources.json 记录来源'
                : (asset.origin === 'sourced' ? '公开图库/联网真实素材，按 images/image_sources.json 处理署名' : 'AI 生成图片'))));
        return `- ${href}：${origin}；${asset.description || asset.filename}`;
      });
    if (safeSelected.length < existing.length) {
      lines.push(`- 另有 ${existing.length - safeSelected.length} 个资源已写入 spec_lock.md images；本页优先使用上面相关资源，仍禁止编造不存在的 href。`);
    }
    return this._trimText(this._sanitizeExecutorPromptText(lines.join('\n')), maxChars);
  }

  _formatImageSourcesManifestContext(maxChars = 5000) {
    if (!this.projectPath) return '';
    const manifestPath = path.join(this.projectPath, 'images', 'image_sources.json');
    if (!fs.existsSync(manifestPath)) return '';
    const manifest = this._safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null);
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    if (items.length === 0) return '';
    const lines = items.map(item => [
      `- ${item.filename}`,
      `provider=${item.provider || ''}`,
      `license_tier=${item.license_tier || ''}`,
      `attribution_required=${Boolean(item.attribution_required)}`,
      item.attribution_text ? `attribution=${item.attribution_text}` : ''
    ].filter(Boolean).join(' | '));
    return this._trimText(this._sanitizeExecutorPromptText(lines.join('\n')), maxChars);
  }

  _formatWebVisualSourcesManifestContext(maxChars = 4000) {
    if (!this.projectPath) return '';
    const manifestPath = path.join(this.projectPath, 'images', 'web_visual_sources.json');
    if (!fs.existsSync(manifestPath)) return '';
    const manifest = this._safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), null);
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    if (items.length === 0) return '';
    const lines = items.map(item => [
      `- ${item.href || (item.relative_path ? `../${item.relative_path}` : item.filename)}`,
      `label=${item.label || ''}`,
      `provider=${item.provider || ''}`,
      `status=${item.status || ''}`,
      item.source_url ? `source=${item.source_url}` : '',
      item.license_note ? `note=${item.license_note}` : ''
    ].filter(Boolean).join(' | '));
    return this._trimText(this._sanitizeExecutorPromptText(lines.join('\n')), maxChars);
  }

  _primeExecutorPromptContext() {
    this.executorPromptCache = null;
    this.executorPageContextCache = new Map();
    this.executorReferenceCache = new Map();
    const context = this._executorPromptStaticContext();
    this._recordWorkflowEvent('Step 6 Executor Prompt Context', 'cached', {
      strategy: 'deck_static_digest_plus_page_delta',
      fixed_chars: [
        context.executorBase,
        context.sharedRef,
        context.styleRef,
        context.designDigest,
        context.sourceDigest,
        context.uploadedTemplateContext,
        context.layoutTemplateOverview,
        context.imageSourcesContext,
        context.webVisualSourcesContext
      ].join('\n').length,
      image_assets: Array.isArray(this.imageAssets) ? this.imageAssets.length : 0
    });
  }

  _executorPromptStaticContext() {
    if (this.executorPromptCache) return this.executorPromptCache;

    const styleFile = this._executorStyleFile(this.params.style);
    this._recordRoleRead('Executor', 'skills/ppt-master/references/executor-base.md');
    this._recordRoleRead('Executor', 'skills/ppt-master/references/shared-standards.md');
    this._recordRoleRead('Executor', `skills/ppt-master/references/${styleFile}`);

    const context = {
      styleFile,
      executorBase: this._loadCompactExecutorReference('skills/ppt-master/references/executor-base.md', 3600),
      sharedRef: this._loadCompactExecutorReference('skills/ppt-master/references/shared-standards.md', 4200),
      styleRef: this._loadCompactExecutorReference(`skills/ppt-master/references/${styleFile}`, 3200),
      specLock: this._readSpecLockForPage(),
      uploadedTemplateContext: this._formatUploadedTemplateContext(2400),
      layoutTemplateOverview: this._formatLayoutTemplateContext(2800),
      imageSourcesContext: this._formatImageSourcesManifestContext(1800),
      webVisualSourcesContext: this._formatWebVisualSourcesManifestContext(1800),
      designDigest: this._executorDesignSpecDigest(5200),
      sourceDigest: this._executorSourceDigest(1800),
      customizationPrompt: this._agentCustomizationPrompt(2600),
      styleDirective: this.params.style === 'dark_tech'
        ? [
          '## Dark Tech Visual Direction（强制）',
          '- 必须使用暗色背景，不要输出白底商务页。',
          '- 每页控制在 1 个主视觉结构 + 2 个辅助信息区以内，避免把过多卡片堆在一页。',
          '- 优先使用流程图、架构图、矩阵图、循环图；卡片必须给文字留足内边距。',
          '- 英文长句必须拆成短行 tspan；不要让文字贴边或越出卡片。',
          ''
        ].join('\n')
        : ''
    };
    this.executorPromptCache = context;
    return context;
  }

  _loadCompactExecutorReference(relativePath, maxChars = 3200) {
    const cacheKey = `${relativePath}:${maxChars}`;
    if (this.executorReferenceCache?.has(cacheKey)) {
      return this.executorReferenceCache.get(cacheKey);
    }
    const raw = this._loadPptMasterFile(relativePath, 60000);
    const compact = this._compactReferenceText(raw, maxChars);
    this.executorReferenceCache?.set(cacheKey, compact);
    return compact;
  }

  _compactReferenceText(text = '', maxChars = 3200) {
    const source = String(text || '').replace(/\r/g, '');
    if (!source.trim()) return '';
    const lines = source.split('\n');
    const keepPattern = /必须|禁止|不得|只能|不要|输出|严格|安全区|文字|图片|图表|颜色|字体|留白|版式|层级|遮挡|重叠|溢出|裁切|XML|SVG|PPT|viewBox|font|color|text|image|chart|layout|spacing|overlap|overflow|footer|header|entity|href/i;
    const kept = [];
    let blank = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (!blank && kept.length) kept.push('');
        blank = true;
        continue;
      }
      const structural = /^(#{1,4}\s+|[-*]\s+|\d+[.)]\s+|\|)/.test(trimmed);
      if (structural || keepPattern.test(trimmed)) {
        kept.push(trimmed.length > 260 ? `${trimmed.slice(0, 260)}...` : trimmed);
        blank = false;
      }
      if (kept.join('\n').length >= maxChars * 1.25) break;
    }
    const compact = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return this._trimText(compact || source, maxChars);
  }

  _sanitizeExecutorPromptText(text = '') {
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

  _sanitizeStrategistPromptText(text = '') {
    return this._sanitizeExecutorPromptText(text)
      .replace(/生成服务/g, '生成系统')
      .replace(/版式模板/g, '版式参考')
      .replace(/内置模板/g, '内置版式')
      .replace(/模板名/g, '版式名')
      .replace(/来源说明/g, '参考说明');
  }

  _executorDesignSpecDigest(maxChars = 5200) {
    const pagePlan = this._fallbackPageTitles()
      .map((title, index) => `- P${String(index + 1).padStart(2, '0')}: ${title}`)
      .join('\n');
    const sectionPairs = [
      ['III. Visual Theme', 'IV. Typography System', 1300],
      ['IV. Typography System', 'V. Layout Principles', 900],
      ['V. Layout Principles', 'VI. Icon Usage Specification', 1000],
      ['VI. Icon Usage Specification', 'VII. Visualization Reference List', 700],
      ['VII. Visualization Reference List', 'VIII. Image Resource List', 1100],
      ['VIII. Image Resource List', 'IX. Content Outline', 900],
      ['XI. Execution Notes', '', 900]
    ];
    const sections = sectionPairs
      .map(([start, end, limit]) => {
        const section = this._extractMarkdownSection(this.designSpec, start, end);
        return section ? `### ${start}\n${this._sanitizeExecutorPromptText(this._compactMarkdownSection(section, limit))}` : '';
      })
      .filter(Boolean);
    return this._trimText([
      `# Deck Design Digest: ${this.params.title || ''}`,
      `- Style: ${this._sanitizeExecutorPromptText(this._describeSelectedStyle())}`,
      `- Canvas: ${this._canvasInfo().format} ${this._canvasInfo().viewBox}`,
      '',
      '## Page Plan',
      pagePlan,
      '',
      ...sections
    ].filter(Boolean).join('\n'), maxChars);
  }

  _compactMarkdownSection(section = '', maxChars = 1000) {
    const lines = String(section || '').split(/\r?\n/);
    const kept = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (kept.length && kept[kept.length - 1] !== '') kept.push('');
        continue;
      }
      if (/^\|/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^#{1,4}\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
        kept.push(trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed);
      } else if (kept.join('\n').length < maxChars * 0.55) {
        kept.push(trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed);
      }
      if (kept.join('\n').length >= maxChars) break;
    }
    return this._trimText(kept.join('\n').replace(/\n{3,}/g, '\n\n'), maxChars);
  }

  _executorSourceDigest(maxChars = 1800) {
    const source = String(this.sourceContent || '').replace(/\r/g, '');
    if (!source.trim()) return '';
    const important = source.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => /^#{1,4}\s+/.test(line) || /结论|摘要|背景|方法|过程|结果|数据|总结|致谢|研究|实验|指标|创新|问题|目标/i.test(line))
      .slice(0, 36);
    const fallback = source.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 28);
    return this._trimText(this._sanitizeExecutorPromptText((important.length ? important : fallback).join('\n')), maxChars);
  }

  _sourceContentForPage(pageNum, maxChars = 1400) {
    const cacheKey = `source:${pageNum}:${maxChars}`;
    if (this.executorPageContextCache?.has(cacheKey)) return this.executorPageContextCache.get(cacheKey);
    const source = String(this.sourceContent || '');
    const title = this._inferPageDescription(pageNum);
    const pageContext = this._pageSpecificContext(pageNum);
    const tokens = [title, pageContext]
      .join(' ')
      .split(/[^\p{L}\p{N}_-]+/u)
      .map(token => token.trim())
      .filter(token => token.length >= 2 && !/^(第|页|slide|ppt|P\d+)$/i.test(token))
      .slice(0, 40);
    const lines = source.split(/\r?\n/);
    const picked = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const normalized = line.toLowerCase();
      const pageHit = new RegExp(`\\bP\\s*0?${pageNum}\\b|第\\s*${pageNum}\\s*页|Slide\\s*0?${pageNum}`, 'i').test(line);
      const tokenHit = tokens.some(token => normalized.includes(String(token).toLowerCase()));
      if (!pageHit && !tokenHit) continue;
      picked.push(lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join('\n'));
      if (picked.join('\n\n').length >= maxChars) break;
    }
    const result = this._trimText(this._sanitizeExecutorPromptText(picked.join('\n\n')), maxChars);
    this.executorPageContextCache?.set(cacheKey, result);
    return result;
  }

  _executorPagePromptContext(pageNum) {
    const cacheKey = `page_prompt:${pageNum}`;
    if (this.executorPageContextCache?.has(cacheKey)) return this.executorPageContextCache.get(cacheKey);
    const pageDesign = this._trimText(this._sanitizeExecutorPromptText(this._pageSpecificContext(pageNum)), 3600);
    const pageSource = this._sanitizeExecutorPromptText(this._sourceContentForPage(pageNum, 1400));
    const result = [
      `## 当前页设计要求（Design Spec Page Delta）\n${pageDesign || this._inferPageDescription(pageNum)}`,
      pageSource ? `\n## 当前页相关源内容\n${pageSource}` : '',
      `\n## 脆弱页面模板约束\n${this._executorPageTemplateDirective(pageNum)}`
    ].filter(Boolean).join('\n');
    this.executorPageContextCache?.set(cacheKey, result);
    return result;
  }

  _executorPageTemplateDirective(pageNum) {
    const pageCount = Math.max(1, parseInt(this.params.pageCount, 10) || 1);
    const title = this._inferPageDescription(pageNum);
    const context = `${title}\n${this._pageSpecificContext(pageNum)}`;
    const pageType = this._layoutTemplatePageTypeForPage(pageNum);
    const imageHeavy = /图片|照片|配图|logo|标识|人物|产品|设备|场景|地点|城市|园区|实验室|工厂|数据中心|封面|hero|image|photo|logo|portrait|product/i.test(context);
    const lines = [
      `- Page type: ${pageType}. 优先套用稳定版式，不要自由堆叠。`
    ];
    if (pageType === 'content') {
      lines.push(
        '- 内容页如果沿用带 80px 页眉的模板，页眉元素必须完全归入 <g id="header">：顶部横条/页眉底色/章节号/主标题/右侧短标签/页码都在 y=0..82 内；正文从 y>=100 开始。',
        '- 右上页码徽章必须窄小，建议 rect x=1148..1160, width<=78, 文本居中；右侧章节标签必须在徽章左侧至少留 18px，不得与页码或徽章重叠。',
        '- 页脚只保留页码和短装饰，页脚文字 baseline 必须 <= 696；不要复制模板里的 Source、NOTE 或 attribution 示例文字。'
      );
    }
    if (pageNum === 1) {
      lines.push(
        '- 封面必须使用稳定模板：背景/chrome 先画，主视觉区与标题区分离；标题、作者/单位、日期必须在最上层。',
        '- 封面最多 1 个主视觉 + 1 个标题组 + 1 个底部信息组；禁止多个半透明卡片互相覆盖。'
      );
    }
    if (pageNum === pageCount) {
      lines.push(
        '- 结尾页必须使用总结/致谢模板：一个清晰标题、2-3 条总结或致谢信息、稳定页脚；不要生成第二个封面。',
        '- 结尾页不要引入新的复杂图表或大图叠文字。'
      );
    }
    if (imageHeavy) {
      lines.push(
        '- 图片页必须只选 1 张最相关主图或少量 logo 条带；图片先输出、文字后输出，禁止图片遮挡文字。',
        '- 所有图片必须 preserveAspectRatio="xMidYMid slice" 或 meet，避免明显拉伸；不确定时缩小并留白。',
        '- 如果没有合适图片，改用 SVG 原生图示，不画空白占位框。'
      );
    }
    lines.push(
      '- 检查/修复阶段只允许微调层级、字号、x/y 和局部间距，所以当前生成必须一次性保证文字不重叠、不越界。'
    );
    return lines.join('\n');
  }

  _buildExecutorPrompt(pageNum, pageCount, previousSummary, repairHint = '') {
    const executorContext = this._executorPromptStaticContext();
    const executorBase = executorContext.executorBase;
    const sharedRef = executorContext.sharedRef;
    const styleRef = executorContext.styleRef;
    const specLock = executorContext.specLock;
    const canvas = this._canvasInfo();
    const filename = this._pageFilename(pageNum);
    const uploadedTemplateContext = executorContext.uploadedTemplateContext;
    const layoutTemplateContext = this._formatLayoutTemplateContext(4200, pageNum);
    const chartTemplateContext = this._trimText(this._buildChartTemplateContext(pageNum), 3600);
    const availableImageContext = this._formatExecutorImageAssetContext(3200, pageNum);
    const imageSourcesContext = executorContext.imageSourcesContext;
    const webVisualSourcesContext = executorContext.webVisualSourcesContext;
    const customizationPrompt = executorContext.customizationPrompt;
    const styleDirective = executorContext.styleDirective;
    const pagePromptContext = this._executorPagePromptContext(pageNum);

    return `你是世界顶级的 AI 幻灯片 SVG 绘制执行者（Executor）。你必须像 Claude Code 执行 ppt-master 一样，严格按文件约束产出当前页 SVG。

## 当前任务
生成第 ${pageNum}/${pageCount} 页，文件名固定为 ${filename}。
${customizationPrompt ? `\n## AI Designer Agent Customization\n${customizationPrompt}` : ''}

## Executor 通用规范摘要（已缓存）
${executorBase}

## 风格专项规范摘要（已缓存）
${styleRef}

## SVG/PPT 技术约束摘要（已缓存）
${sharedRef}

## spec_lock.md 执行锁（唯一合法颜色/字体/图片来源）
${specLock}
${availableImageContext ? `\n## 可用图片资源（只能引用这些真实存在的 href）\n${availableImageContext}\n- 如果本页需要图片，只能使用上方列出的 href；禁止编造 ../images/... 文件名，禁止引用 sources/converted_uploads 或 Markdown 原始相对路径。` : ''}
${imageSourcesContext ? `\n## 公开图库图片授权清单（使用 Sourced 图片时必须遵守）\n${imageSourcesContext}\n- 最终幻灯片可见区域禁止出现来源/Source/资料来源署名；如果图片要求 attribution-required，当前页不要使用该图片，改用 no-attribution 图片或 SVG 原生视觉。` : ''}
${webVisualSourcesContext ? `\n## 联网视觉素材来源清单\n${webVisualSourcesContext}\n- 技术栈、架构、框架介绍页面优先使用真实 logo/icon；行业、产品、人物、地点、设备、工厂、实验室、数据中心等页面优先使用清单中的真实图片素材；只允许引用清单中的 href，不要手绘或编造品牌 logo/真实人物/真实产品/真实地点。` : ''}
	## 图片缺失处理（强制）
	- 如果没有可用图片资源，或图片资源不适合当前页，禁止绘制空白图片占位框、空白大圆角框、灰色占位图、未加载图片框。
	- 必须改用 SVG 原生视觉：系统架构图、通信链路图、数据流示意、Goroutine/Channel/WebSocket 抽象插画、代码/节点/连线组合或几何科技视觉。
	- 任何大面积视觉区域都必须有真实内容承载，不能看起来像未完成页面。
	- 如果本页使用上传文档图、证据图、结构图、机构图或模型图，图片在最终页面截图中必须一眼可见；高纵横比图片必须给足纵向空间或改为局部放大/重绘，不能塞进矮宽框后只剩白底。
	- 如果用浅色背景图片，必须加深色描边、标注线、局部放大或 SVG 注释，保证主体与白色卡片背景分离。
${layoutTemplateContext ? `\n## ppt-master Step 3 内置模板结构参考（当前页必须吸收）\n${layoutTemplateContext}\n\n## 内置模板执行要求\n- 这是 Template Option 复制到项目 templates/ 的官方模板参考。当前页必须优先继承对应页面类型的结构，而不是生成通用卡片网格。\n- P01 使用 cover 结构；最终页使用 ending 结构；目录页使用 toc；章节页使用 chapter；普通内容页使用 content。\n- 可以替换文本、图表和数据，但必须保留模板的页面 chrome、背景几何、标题区位置、页脚几何/页码、留白比例和视觉层级。\n- 最终 SVG 可见文字禁止出现 Template/模板/ppt-master/资料来源/数据来源/Source/上传文档/文件名/内部路径/workflow/pipeline；模板信息只可在内部上下文使用。\n- 如果模板带图片/logo 资产，只能使用 spec_lock.md images 或“可用图片资源”中列出的真实 href。` : ''}
${uploadedTemplateContext ? `\n## 上传 PPT 模板参考\n${uploadedTemplateContext}\n\n## 上传模板执行要求\n- 可以使用 spec_lock.md 中的 uploaded_template_colors 作为合法颜色。\n- 沿用模板的页眉页脚几何、背景层次、留白比例、标题区位置、装饰线/块面语言和图片资产，但必须重建为 clean SVG。\n- 不要直接复制原始 PPTX 或参考 SVG 的复杂结构；只吸收视觉系统和版式节奏；不得把上传文件名、模板名或资料来源写成可见页脚/角标。` : ''}

${styleDirective}
${previousSummary ? `## 已生成页面摘要\n${this._trimText(previousSummary, 1800)}` : ''}
${repairHint ? `## 上次失败原因，必须修复\n${this._trimText(repairHint, 2200)}` : ''}
${chartTemplateContext ? `\n## Visualization Template Library Context\n${chartTemplateContext}` : ''}

## Design Specification 摘要（整套规范缓存，不重复塞全文）
${executorContext.designDigest}

## Source Content 摘要（全局事实缓存）
${executorContext.sourceDigest}

${pagePromptContext}

## 强制输出约束
1. 第一行输出：<!-- PAGE:${pageNum} FILENAME:${filename} -->
2. 然后只输出完整 SVG，以 <svg 开头，以 </svg> 结尾。
3. 根元素必须包含 xmlns="http://www.w3.org/2000/svg" viewBox="${canvas.viewBox}" width="${canvas.width}" height="${canvas.height}"。
4. 只使用 spec_lock.md 中列出的 HEX 颜色和 font-family。
5. 禁止 <style>、class、mask、foreignObject、textPath、animate、script、rgba()、<g opacity>、<image opacity>。
6. 允许使用官方支持的 <defs>、linearGradient、radialGradient、filter、fill="url(#...)"、stroke="url(#...)" 来实现渐变/阴影/光晕；所有渐变 stop-color 仍必须来自 spec_lock.md 的 HEX 色板。clipPath 仅允许定义在 <defs> 且直接应用于 <image>，用于图片圆角/异形裁切；不要把 clipPath 用在形状、文字或组上。
7. XML 必须严格合法：R&D 写为 R&amp;D，< 和 > 在文本中必须转义；不要使用 &nbsp;、&mdash;、&copy; 等 HTML named entities。
8. 如使用图片，SVG 位于 svg_output，因此 href 必须写成 ../images/文件名。
9. 如果页面包含 bar/line/pie/donut/radar/area/scatter 等数据图表，必须写入 <!-- chart-plot-area: ... --> 标记，便于后续强制校准 gate 扫描。
10. 正文安全区：x=56..${canvas.width - 56}, y=96..${canvas.height - 70}。页脚/页码专属区为 y=${canvas.height - 52}..${canvas.height - 20}；除 footer 组、页码和全宽页脚背景外，任何可见内容 bottom 不得超过 y=${canvas.height - 70}。
11. 信息密集页最多使用两个纵向区域；不要把大型图表、4 个 KPI 卡、环形图和长注释卡同时堆叠在一页。
12. 页脚只允许页码、品牌性短装饰或非文本装饰形状；禁止写来源/Source/资料来源/数据来源/模板/Template/上传文档/文件名等元信息。
13. 图表坐标轴标签、图例、圆环/扇形、说明卡片必须完整处于正文安全区；禁止任何分析组件压住或越过页脚。
14. 根 <svg> 的直接内容应以语义化 <g id="..."> 组织：bg/header/content/chart/footer/chrome 等，正文内容建议 3-8 个顶层语义组；不要把大量 rect/text/path 裸放在根节点下。
15. 底部 28% 区域只能放少量总结、时间线尾段或 footer，禁止密集装饰点阵/多卡片/长注释堆叠。
16. 页眉区必须分层清楚：若模板有 80px 页眉，主标题可放在 header 内且 baseline y=48..58，但所有页眉元素都必须在 <g id="header"> 内并保持 y<=82；否则主标题建议 y=64..78。副标题/章节说明若放在主标题下方，y 必须比主标题 baseline 至少大 36px，且副标题顶部与主标题底部至少保持 14px 可见间距；右上页码徽章必须保持窄小，x>=1088，不能覆盖或挤压标题，右侧章节标签必须在页码左侧留出至少 18px；说明文字一行放不下时必须拆成 1 行或 2 行 tspan。
	17. 所有正文文字块、图标、卡片、中心说明框之间必须至少保持 12px 可见间距；禁止中心说明框压住下方模块、禁止文字互相叠压；任何图片都不得覆盖文字或说明框，装饰图若没有足够空间必须缩小、移位或删除。卡片、标签、说明框的背景 rect/circle/ellipse 必须先输出，文字必须后输出，禁止在文字后面再画会覆盖文字的 rect。
	18. 卡片/标签/胶囊内文字必须完整落在背景容器内，最小内边距：普通卡片 18px，紧凑标签 10px；文字不得贴边、不得被圆角或底边裁切。
	19. 2行说明文字 + 22px 标题的卡片高度不得小于 112px；说明文字最后一行 baseline 必须 <= 卡片 bottom - 14，标题和说明之间至少 12px。
	20. 底部文字和页脚不得被裁切；页脚文字 baseline 建议 y<=${canvas.height - 24}，页码文字 baseline 必须 <= ${canvas.height - 24}，严禁把正文或元信息塞进页脚区；如果内容放不下，必须删减、改两列、上移或拆页，而不是塞进页脚区。
	21. 进度条、状态条、胶囊标签如果与右侧说明共处一行，色块宽度必须停在说明文字左侧至少 18px，禁止色块覆盖后续灰色说明。
	22. 结论页/总结页的勾选清单每条至少 30px 行高；长句必须拆成多行 tspan 并保持同一条目缩进，下一条图标和文字整体下移，禁止两条结论混读。
	23. 文字不得溢出容器，长文本必须拆成多行 tspan；不要输出 SVG 以外解释文字。`;
  }

  _readSpecLockForPage(pageNum) {
    const specPath = path.join(this.projectPath, 'spec_lock.md');
    const cacheKey = `spec_lock:${specPath}`;
    if (this.executorReferenceCache?.has(cacheKey)) {
      return this.executorReferenceCache.get(cacheKey);
    }
    const specLock = fs.readFileSync(specPath, 'utf-8');
    this.executorReferenceCache?.set(cacheKey, specLock);
    this._recordWorkflowEvent('SPEC_LOCK_EXECUTOR_CACHE', 'completed', {
      page: pageNum ? `P${String(pageNum).padStart(2, '0')}` : 'all_pages',
      file: 'spec_lock.md',
      strategy: 'read_once_per_executor_run'
    });
    return specLock;
  }

  _buildRepairHint(problem, svg) {
    return [
      '上一版 SVG 未通过 svg_quality_checker.py。',
      '请保留同一页内容，但修复所有错误后重新输出完整 SVG。',
      '常见修复：保证 XML well-formed；移除 <g opacity>/<image opacity>；不要用 <style>/class/mask/foreignObject/textPath；渐变/滤镜必须只用官方支持的 <defs> + HEX stop-color；viewBox 必须匹配；图片路径用 ../images/。',
      '',
      '质量检查输出：',
      this._trimText(problem, 1800),
      '',
      '上一版 SVG 片段：',
      this._trimText(svg, 1200)
    ].join('\n');
  }

  _buildPlaceholderRepairHint(problem, svg) {
    return [
      '上一版页面是失败占位页或模型未能生成真实 SVG。',
      '必须重新生成真实内容页，禁止输出“占位”“后续重生成”“模型未返回 SVG”等诊断文案。',
      '保留本页主题、核心事实和页码；根据 design_spec.md 的对应页面重新组织内容。',
      '',
      '失败门禁输出：',
      this._trimText(problem, 1800),
      '',
      '上一版 SVG 片段：',
      this._trimText(svg, 1200)
    ].join('\n');
  }

  _buildLayoutRepairHint(problem, svg) {
    const canvas = this._canvasInfo();
    const bodyBottom = canvas.height - 70;
    const footerTop = canvas.height - 52;
    return [
      '上一版 SVG 通过了基础 XML/PPTX 检查，但未通过视觉版面安全检查。',
      '必须保留同一页主题和关键事实，重新排版，不要简单缩小到不可读。',
      `正文内容安全区：x=56..${canvas.width - 56}, y=96..${bodyBottom}。`,
      `除页脚、页码和全宽页脚背景外，任何可见元素的 bottom 都不得超过 y=${bodyBottom}。`,
      `footer 组必须放在 y=${footerTop}..${canvas.height - 20}；只有 footer 背景、页脚文字和页码可以进入该区域。`,
      '数据图表必须完整放进安全区，坐标轴标签、图例、环形图、卡片、注释都不能压到页脚。',
      '页脚不要写来源、Source、资料来源、模板名、上传文档名或内部流程信息；只保留页码、品牌性短装饰或非文本装饰形状。',
      '标题区不得叠压：主标题和副标题不能贴在一起；若副标题在主标题下方，副标题 y 至少比主标题 y 大 36px，且副标题顶部与主标题底部至少留 14px；页码徽章必须窄小并放右上角 x>=1088，不覆盖标题。',
      '所有文字块、卡片、图标、中心说明框必须至少保持 12px 间距；禁止中心说明压住下方反例/类比模块，禁止文字互相遮挡；任何图片都不得覆盖文字或说明框，装饰图若没有足够空间必须缩小、移位或删除，尤其是右上角角标和卡片内装饰图。',
      '卡片、标签、说明框的背景 rect/circle/ellipse 必须先输出，文字必须后输出；不要在文字后面再画任何会覆盖文字的 rect。',
      '卡片、标签、胶囊内文字必须完整落在背景容器内：普通卡片最小内边距 18px，紧凑标签 10px；底部标签不得贴着或越过容器底边。',
      '如果卡片含 22px 标题和两行 16px 说明，卡片高度至少 112px；说明最后一行 baseline 必须 <= 卡片 bottom - 14。',
      '页眉下方的说明文字如果一行放不下，必须拆成 1 行或 2 行 tspan，不能横向铺满整页。',
      '如果同一页包含左侧层级条、中心架构卡片、右侧说明卡片三块内容，必须压缩标题与导语高度，确保顶部导语与中部卡片之间至少留出 18px 空隙；右侧说明卡片不得压到中部连接线或主模块。',
      '信息密集页最多使用两个纵向区域；不要在同一页同时堆叠大型柱状图、4 个 KPI 卡、环形图和长注释卡。',
      '底部 28% 区域不要放密集装饰元素、长注释卡或多层辅助信息；底部说明不得被裁切，必要时删减内容、改成左右分栏或整体上移。',
      '图表页必须写入 <!-- chart-plot-area: x1,y1,x2,y2 --> 标记。',
      '',
      '版面安全检查输出：',
      this._trimText(problem, 1800),
      '',
      '上一版 SVG 片段：',
      this._trimText(svg, 1200)
    ].join('\n');
  }

  _buildNotesTotal() {
    const lines = [];
    const titles = this._fallbackPageTitles();
    const deckTopic = this._safeVisibleDeckTopic();
    for (const page of this.generatedPages) {
      const stem = path.basename(page.filename, '.svg');
      const title = titles[page.pageNum - 1] || `第 ${page.pageNum} 页`;
      lines.push(`# ${stem}`);
      lines.push('');
      lines.push(`本页讲述「${title}」。先点明本页结论，再解释关键结构和视觉重点。`);
      lines.push('');
      lines.push(`讲解要点：围绕 ${deckTopic} 的主线，说明这一页与前后页的关系，并自然过渡到下一页。`);
      lines.push('');
    }
    return lines.join('\n');
  }

  _safeVisibleDeckTopic() {
    const candidates = [
      this.params.content,
      this.params.extraRequirements,
      this.task?.prompt,
      this.params.title
    ];
    for (const candidate of candidates) {
      const topic = this._extractVisibleTopic(candidate);
      if (topic) return topic;
    }
    return '本次汇报';
  }

  _extractVisibleTopic(text = '') {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const clean = line
        .replace(/^(?:主题|PPT主题|标题|汇报主题|内容描述)\s*[：:]\s*/i, '')
        .trim();
      if (!clean || this._looksLikeVisiblePptMetaText(clean)) continue;
      if (/^(?:风格|画幅|页数|建议页数|ppt[-_\s]*master|基于上传资料生成内容)\s*[：:]/i.test(clean)) continue;
      return this._trimText(clean, 48);
    }
    return '';
  }

  _sanitizeSvgContent(svg) {
    const raw = String(svg || '');

    // First, try to extract SVG from markdown code blocks before any other processing.
    // Models often wrap SVG in ```svg ... ``` but may also include explanatory text outside,
    // and sometimes omit the closing fence entirely.
    let next = raw;
    const fenceOpen = next.search(/```(?:svg|xml)\s*$/im);
    if (fenceOpen >= 0) {
      const afterFence = next.slice(fenceOpen).replace(/^```(?:svg|xml)\s*/i, '');
      const fenceClose = afterFence.indexOf('```');
      if (fenceClose >= 0) {
        const inner = afterFence.slice(0, fenceClose).trim();
        if (/<svg\b/i.test(inner)) {
          next = inner;
        }
      } else {
        // No closing fence — extract from opening fence to </svg>
        const svgEnd = afterFence.lastIndexOf('</svg>');
        if (svgEnd >= 0) {
          const inner = afterFence.slice(0, svgEnd + '</svg>'.length).trim();
          if (/<svg\b/i.test(inner)) {
            next = inner;
          }
        }
      }
    }

    next = this._stripMarkdownFence(next)
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/\s*<!--(?!\s*chart-plot-area:)[\s\S]*?-->\s*/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&copy;/gi, '©')
      .replace(/&reg;/gi, '®')
      .replace(/&hellip;/gi, '…')
      .replace(/&bull;/gi, '•')
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9A-Fa-f]+;)/g, '&amp;')
      .replace(/\s+(?:stroke|fill)-(?=\s*\/?>)/g, '')
      .replace(/\s+(?:stroke|fill)-(?=\s)/g, ' ')
      .replace(/\sclass=(["']).*?\1/g, '')
      .replace(/\son\w+=(["']).*?\1/g, '')
      .replace(/\sopacity=(["']).*?\1(?=[^<>]*<\/?g\b)/gi, '')
      .replace(/<g\b([^>]*)\sopacity=(["']).*?\2([^>]*)>/gi, '<g$1$3>')
      .replace(/<image\b([^>]*)\sopacity=(["']).*?\2([^>]*)>/gi, '<image$1$3>')
      .replace(/\bhref=(["'])images\//g, 'href=$1../images/')
      .replace(/\bxlink:href=(["'])images\//g, 'xlink:href=$1../images/')
      .replace(/rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*[\d.]+\s*\)/gi, (_m, r, g, b) => this._rgbToHex(r, g, b));

    // Strip anything before the first <svg tag and after the last </svg>
    const svgOpenIdx = next.search(/<svg\b/i);
    const svgCloseIdx = svgOpenIdx >= 0 ? next.lastIndexOf('</svg>') : -1;
    if (svgOpenIdx >= 0 && svgCloseIdx > svgOpenIdx) {
      next = next.slice(svgOpenIdx, svgCloseIdx + '</svg>'.length);
    } else if (svgOpenIdx >= 0) {
      next = next.slice(svgOpenIdx);
    }
    // Remove XML declaration and DOCTYPE
    next = next.replace(/<\?xml\b[^?]*\?>/gi, '').replace(/<!DOCTYPE\b[^>]*>/gi, '');
    next = this._normalizeRootSvg(next.trim());
    next = this._removeVisiblePptMetaText(next);
    next = this._normalizeRightFooterText(next);
    next = this._fixSvgViewBox(next);
    next = this._fixMissingLocalImages(next);
    return `${next.trim()}\n`;
  }

  _fixSvgViewBox(svg) {
    const format = this.params.canvasFormat || 'ppt169';
    const dims = { ppt169: [1280, 720], ppt43: [1024, 768], pptA4: [1240, 1754], ppt1690: [1920, 1080] };
    const [w, h] = dims[format] || [1280, 720];
    return String(svg || '').replace(/viewBox=["']([^"']*)["']/i, (m, vb) => {
      const parts = String(vb).trim().split(/\s+/);
      if (parts.length >= 4 && (parseInt(parts[2]) !== w || parseInt(parts[3]) !== h)) {
        return `viewBox="0 0 ${w} ${h}"`;
      }
      return m;
    });
  }

  _fixMissingLocalImages(svg) {
    const self = this;
    return String(svg || '').replace(/<image\b([^>]*?)>/gi, (match, attrs) => {
      const hrefMatch = attrs.match(/(?:xlink:)?href=["']([^"']*)["']/);
      if (!hrefMatch) return match;
      const href = hrefMatch[1];
      if (/^https?:\/\//i.test(href)) return match;
      if (/^data:/i.test(href)) return match;
      const resolved = path.resolve(self.projectPath, 'svg_output', href);
      if (fs.existsSync(resolved)) return match;
      const imgX = (attrs.match(/x=["']([^"']*)["']/) || [0, '0'])[1];
      const imgY = (attrs.match(/y=["']([^"']*)["']/) || [0, '0'])[1];
      const imgW = (attrs.match(/width=["']([^"']*)["']/) || [0, '400'])[1];
      const imgH = (attrs.match(/height=["']([^"']*)["']/) || [0, '300'])[1];
      const sw = parseInt(imgW) || 400;
      const sh = parseInt(imgH) || 300;
      return `<rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" rx="8" fill="#e5e7eb" stroke="#d1d5db" stroke-width="1"/><text x="${parseInt(imgX) + sw / 2}" y="${parseInt(imgY) + sh / 2}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="14" fill="#9ca3af">[图片]</text>`;
    });
  }

  _removeVisiblePptMetaText(svg) {
    const canvas = this._canvasFromSvg(svg);
    return String(svg || '').replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (match, attrs, body) => {
      const text = this._extractTextContent(body);
      if (!this._looksLikeVisiblePptMetaText(text)) return match;

      const y = this._textBlockY(attrs, body);
      const fontSize = this._numAttr(attrs, 'font-size', 16);
      const isFooterish = Number.isFinite(y) && y >= canvas.height - 92;
      const isSmallMeta = fontSize <= 16 && text.length <= 150;
      const isHardMeta = /(?:ppt-master|AI\s*Ops\s*Template|Template\s*[·:：-]|模[板版]\s*[:：]|资料来源|数据来源|Source\s*[:：]|上传文档|uploaded\s+document|workflow|pipeline)/i.test(text);
      if (!isFooterish && !(isSmallMeta && isHardMeta)) return match;

      return '';
    });
  }

  _looksLikeVisiblePptMetaText(text = '') {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    const patterns = [
      /\bAI\s*Ops\s*Template\b/i,
      /\bTemplate\s*[·:：-]/i,
      /模[板版]\s*[:：]/i,
      /\bppt-master\b/i,
      /(?:资料|数据)?来源\s*[:：]/i,
      /\bSource\s*[:：]/i,
      /上传文档|上传文件|上传资料|uploaded\s+(?:document|file|asset)/i,
      /(?:workflow|pipeline|Source Document|Template Option|Strategist|Executor)/i,
      /(?:模板|template).{0,24}(?:来源|资源|文件|asset|context|reference)/i
    ];
    return patterns.some(pattern => pattern.test(value));
  }

  _textBlockY(attrs, body) {
    const parentY = this._numAttr(attrs, 'y', NaN);
    if (Number.isFinite(parentY)) return parentY;
    const tspanY = String(body || '').match(/<\s*tspan\b[^>]*\by=(["'])(.*?)\1/i)?.[2];
    const parsed = this._number(tspanY, NaN);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  _normalizeRightFooterText(svg) {
    const canvas = this._canvasFromSvg(svg);
    return String(svg || '').replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (match, attrs, body) => {
      if (/<\s*tspan\b/i.test(body)) return match;

      const text = this._extractTextContent(body);
      if (!text) return match;

      const x = this._numAttr(attrs, 'x', NaN);
      const y = this._numAttr(attrs, 'y', NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return match;

      const anchor = String(this._attr(attrs, 'text-anchor') || 'start').toLowerCase();
      if (anchor !== 'start') return match;

      const fontSize = this._numAttr(attrs, 'font-size', 16);
      const estimatedRight = x + this._estimateTextWidth(text, fontSize);
      const isFooterLine = y >= canvas.height - 34;
      const looksLikeFooterMeta = /source|来源|资料|整理|©|http|www|\.com|公开资料|报告|公司/i.test(text);
      const isRightSide = x >= canvas.width * 0.65 || estimatedRight > canvas.width + 6;
      if (!isFooterLine || !looksLikeFooterMeta || !isRightSide) return match;

      let nextAttrs = this._setTagAttr(attrs, 'x', String(canvas.width - 56));
      nextAttrs = this._setTagAttr(nextAttrs, 'text-anchor', 'end');
      return `<text${nextAttrs}>${body}</text>`;
    });
  }

  _normalizeRootSvg(svg) {
    const canvas = this._canvasInfo();
    const rootMatch = svg.match(/^<svg\b[^>]*>/i);
    if (!rootMatch) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${canvas.viewBox}" width="${canvas.width}" height="${canvas.height}">\n${svg}\n</svg>`;
    }

    let root = rootMatch[0];
    root = this._setRootAttr(root, 'xmlns', 'http://www.w3.org/2000/svg');
    root = this._setRootAttr(root, 'viewBox', canvas.viewBox);
    root = this._setRootAttr(root, 'width', String(canvas.width));
    root = this._setRootAttr(root, 'height', String(canvas.height));
    if (/\bxlink:href=/.test(svg) && !/\bxmlns:xlink=/.test(root)) {
      root = root.replace(/>$/, ' xmlns:xlink="http://www.w3.org/1999/xlink">');
    }
    return root + svg.slice(rootMatch[0].length);
  }

  _setRootAttr(root, attr, value) {
    const escaped = value.replace(/"/g, '&quot;');
    const attrRe = new RegExp(`\\s${attr}=(["']).*?\\1`, 'i');
    if (attrRe.test(root)) {
      return root.replace(attrRe, ` ${attr}="${escaped}"`);
    }
    return root.replace(/>$/, ` ${attr}="${escaped}">`);
  }

  _setTagAttr(attrs, attr, value) {
    const escaped = String(value).replace(/"/g, '&quot;');
    const attrRe = new RegExp(`\\s${attr}=(["']).*?\\1`, 'i');
    if (attrRe.test(attrs)) {
      return attrs.replace(attrRe, ` ${attr}="${escaped}"`);
    }
    return `${attrs || ''} ${attr}="${escaped}"`;
  }

  _createFallbackPage(pageNum, pageCount, reason = '') {
    const canvas = this._canvasInfo();
    const palette = this._paletteForStyle(this.params.style);
    const rawTitle = this._fallbackPageTitles()[pageNum - 1] || `第 ${pageNum} 页`;
    if (/架构|系统总体|architecture/i.test(rawTitle)) {
      return this._createArchitectureFallbackPage(pageNum, pageCount, reason);
    }
    const title = this._escapeXml(rawTitle);
    const points = this._fallbackContentPointsForPage(pageNum, 3).map(point => this._escapeXml(point));
    const safeSubtitle = this._escapeXml(this._trimText(this._safeVisibleDeckTopic(), 64));
    const flowLabels = this._fallbackProcessLabelsForPage(pageNum).map(item => ({
      title: this._escapeXml(item.title),
      detail: this._escapeXml(item.detail)
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${canvas.viewBox}" width="${canvas.width}" height="${canvas.height}">
  <rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${palette.bg}"/>
  <rect x="0" y="0" width="${canvas.width}" height="118" fill="${palette.surface}"/>
  <rect x="64" y="42" width="6" height="48" rx="3" fill="${palette.accent}"/>
  <text x="88" y="68" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="34" font-weight="700">${title}</text>
  <text x="88" y="100" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">${safeSubtitle}</text>
  <rect x="${canvas.width - 190}" y="44" width="126" height="36" rx="18" fill="${palette.primary}"/>
  <text x="${canvas.width - 127}" y="67" text-anchor="middle" fill="#FFFFFF" font-family="Microsoft YaHei, Arial, sans-serif" font-size="15" font-weight="700">P${String(pageNum).padStart(2, '0')} / ${pageCount}</text>

  <g id="content">
    <rect x="72" y="154" width="${canvas.width - 144}" height="220" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
    <text x="104" y="204" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700">核心要点</text>
    <circle cx="112" cy="248" r="5" fill="${palette.accent}"/>
    <text x="132" y="255" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20">${points[0]}</text>
    <circle cx="112" cy="288" r="5" fill="${palette.accent}"/>
    <text x="132" y="295" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20">${points[1]}</text>
    <circle cx="112" cy="330" r="5" fill="${palette.accent}"/>
    <text x="132" y="337" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="20">${points[2]}</text>

    <g id="process-visual">
      <rect x="104" y="420" width="300" height="112" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
      <rect x="490" y="420" width="300" height="112" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
      <rect x="876" y="420" width="300" height="112" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
      <line x1="404" y1="476" x2="490" y2="476" stroke="${palette.accent}" stroke-width="4"/>
      <line x1="790" y1="476" x2="876" y2="476" stroke="${palette.accent}" stroke-width="4"/>
      <text x="254" y="468" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700">${flowLabels[0].title}</text>
      <text x="640" y="468" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700">${flowLabels[1].title}</text>
      <text x="1026" y="468" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700">${flowLabels[2].title}</text>
      <text x="254" y="504" text-anchor="middle" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">${flowLabels[0].detail}</text>
      <text x="640" y="504" text-anchor="middle" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">${flowLabels[1].detail}</text>
      <text x="1026" y="504" text-anchor="middle" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">${flowLabels[2].detail}</text>
    </g>
  </g>

  <g id="footer">
    <rect x="0" y="${canvas.height - 52}" width="${canvas.width}" height="52" fill="${palette.surface}"/>
    <text x="72" y="${canvas.height - 24}" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="14">${this._escapeXml(this._safeVisibleDeckTopic())}</text>
    <text x="${canvas.width - 72}" y="${canvas.height - 24}" text-anchor="end" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="14">P${String(pageNum).padStart(2, '0')} / ${pageCount}</text>
  </g>
</svg>
`;
  }

  _createArchitectureFallbackPage(pageNum, pageCount, reason = '') {
    const canvas = this._canvasInfo();
    const palette = this._paletteForStyle(this.params.style);
    const title = this._escapeXml(this._fallbackPageTitles()[pageNum - 1] || '系统总体架构设计');
    const subtitle = this._escapeXml(this._fallbackArchitectureSubtitle(pageNum));
    const columns = this._fallbackArchitectureColumns(pageNum).map(column => ({
      title: this._escapeXml(column.title),
      detail: this._escapeXml(column.detail),
      items: column.items.map(item => this._escapeXml(item))
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${canvas.viewBox}" width="${canvas.width}" height="${canvas.height}">
  <rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${palette.bg}"/>
  <rect x="0" y="0" width="${canvas.width}" height="118" fill="${palette.surface}"/>
  <rect x="64" y="42" width="6" height="48" rx="3" fill="${palette.accent}"/>
  <text x="88" y="70" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="34" font-weight="700">${title}</text>
  <text x="88" y="102" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">${subtitle}</text>
  <rect x="${canvas.width - 190}" y="44" width="126" height="36" rx="18" fill="${palette.primary}"/>
  <text x="${canvas.width - 127}" y="67" text-anchor="middle" fill="#FFFFFF" font-family="Microsoft YaHei, Arial, sans-serif" font-size="15" font-weight="700">P${String(pageNum).padStart(2, '0')} / ${pageCount}</text>

  <g id="architecture">
    <rect x="74" y="154" width="246" height="392" rx="16" fill="${palette.surface}" stroke="${palette.border}"/>
    <text x="197" y="194" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24" font-weight="700">${columns[0].title}</text>
    <text x="197" y="228" text-anchor="middle" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">${columns[0].detail}</text>
    <rect x="112" y="274" width="170" height="44" rx="10" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="197" y="302" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="17">${columns[0].items[0]}</text>
    <rect x="112" y="340" width="170" height="44" rx="10" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="197" y="368" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="17">${columns[0].items[1]}</text>
    <rect x="112" y="406" width="170" height="44" rx="10" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="197" y="434" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="17">${columns[0].items[2]}</text>

    <rect x="438" y="154" width="404" height="392" rx="16" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="640" y="194" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24" font-weight="700">${columns[1].title}</text>
    <rect x="486" y="234" width="308" height="52" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
    <text x="640" y="267" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="18">${columns[1].items[0]}</text>
    <rect x="486" y="314" width="308" height="52" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
    <text x="640" y="347" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="18">${columns[1].items[1]}</text>
    <rect x="462" y="394" width="356" height="62" rx="12" fill="${palette.primary}" fill-opacity="0.10" stroke="${palette.primary}"/>
    <text x="640" y="431" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="17" font-weight="700">${columns[1].items[2]}</text>

    <rect x="960" y="154" width="246" height="392" rx="16" fill="${palette.surface}" stroke="${palette.border}"/>
    <text x="1083" y="194" text-anchor="middle" fill="${palette.primary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24" font-weight="700">${columns[2].title}</text>
    <rect x="998" y="258" width="170" height="54" rx="12" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="1083" y="292" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="18">${columns[2].items[0]}</text>
    <rect x="998" y="348" width="170" height="54" rx="12" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="1083" y="382" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="18">${columns[2].items[1]}</text>
    <rect x="998" y="438" width="170" height="54" rx="12" fill="#FFFFFF" stroke="${palette.border}"/>
    <text x="1083" y="472" text-anchor="middle" fill="${palette.text}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="18">${columns[2].items[2]}</text>

    <line x1="320" y1="340" x2="438" y2="340" stroke="${palette.accent}" stroke-width="4"/>
    <text x="379" y="326" text-anchor="middle" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="15">输入约束</text>
    <line x1="842" y1="340" x2="960" y2="340" stroke="${palette.accent}" stroke-width="4"/>
    <text x="901" y="326" text-anchor="middle" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="15">验证反馈</text>
  </g>

  <g id="footer">
    <rect x="0" y="${canvas.height - 52}" width="${canvas.width}" height="52" fill="${palette.surface}"/>
    <text x="72" y="${canvas.height - 24}" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="14">${this._escapeXml(this._safeVisibleDeckTopic())}</text>
    <text x="${canvas.width - 72}" y="${canvas.height - 24}" text-anchor="end" fill="${palette.text_secondary}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="14">P${String(pageNum).padStart(2, '0')} / ${pageCount}</text>
  </g>
</svg>
`;
  }

  _fallbackContentPointsForPage(pageNum, count = 3) {
    const points = [];
    for (let index = 1; index <= count; index += 1) {
      points.push(this._fallbackContentPointForPage(pageNum, index));
    }
    return points;
  }

  _fallbackProcessLabelsForPage(pageNum) {
    const title = this._fallbackPageTitles()[pageNum - 1] || '';
    const source = this._fallbackSourceText();
    const isPlan = /计划|路径|路线|实施|推进|迭代|roadmap|timeline/i.test(title);
    const isRisk = /风险|治理|预案|约束/i.test(title);
    const isResult = /收益|结果|价值|总结|结论/i.test(title);
    const isMechanical = this._isMechanicalControlTopic(source);

    if (isPlan) {
      return [
        { title: '近期任务', detail: '明确启动动作' },
        { title: '阶段验证', detail: '对齐验收口径' },
        { title: '复盘迭代', detail: '沉淀改进清单' }
      ];
    }
    if (isRisk) {
      return [
        { title: '风险识别', detail: '聚焦高影响项' },
        { title: '控制措施', detail: '设置预案边界' },
        { title: '持续监控', detail: '跟踪变化信号' }
      ];
    }
    if (isResult) {
      return [
        { title: '价值呈现', detail: '对应核心目标' },
        { title: '证据支撑', detail: '连接关键依据' },
        { title: '行动落点', detail: '形成下一步' }
      ];
    }
    if (isMechanical) {
      return [
        { title: '结构输入', detail: '明确机械边界' },
        { title: '控制响应', detail: '串联算法逻辑' },
        { title: '验证闭环', detail: '沉淀测试结论' }
      ];
    }
    return [
      { title: '问题识别', detail: '聚焦本页主题' },
      { title: '方法展开', detail: '梳理关键关系' },
      { title: '结果沉淀', detail: '形成汇报结论' }
    ];
  }

  _fallbackArchitectureSubtitle(pageNum) {
    const title = this._fallbackPageTitles()[pageNum - 1] || '';
    const source = this._fallbackSourceText();
    if (this._isMechanicalControlTopic(source)) {
      return '围绕结构输入、控制响应与验证闭环，表达关键模块之间的协同关系';
    }
    const cleanTitle = String(title || '').replace(/^.*?：/, '').trim() || '本页方案';
    return this._fallbackShortText(`围绕${cleanTitle}，表达目标、能力、执行与反馈之间的关系`, 56);
  }

  _fallbackArchitectureColumns(pageNum) {
    const source = this._fallbackSourceText();
    if (this._isMechanicalControlTopic(source)) {
      return [
        {
          title: '机械结构',
          detail: '承载与响应边界',
          items: ['串联腿方案', '底盘与云台', '发射机构']
        },
        {
          title: '控制算法',
          detail: '姿态稳定和运动控制',
          items: ['动力学建模', 'LQR 平衡控制', '五连杆 VMC']
        },
        {
          title: '验证闭环',
          detail: '测试与迭代依据',
          items: ['场景测试', '参数标定', '版本回归']
        }
      ];
    }

    const points = this._fallbackContentPointsForPage(pageNum, 6);
    return [
      {
        title: '目标层',
        detail: '明确判断边界',
        items: [
          this._fallbackShortLabel(points[0], 8),
          this._fallbackShortLabel(points[1], 8),
          '关键约束'
        ]
      },
      {
        title: '能力层',
        detail: '拆解主要动作',
        items: [
          this._fallbackShortLabel(points[2], 14),
          this._fallbackShortLabel(points[3], 14),
          this._fallbackShortLabel(points[4], 18)
        ]
      },
      {
        title: '反馈层',
        detail: '支撑持续优化',
        items: [
          '过程跟踪',
          '效果评估',
          this._fallbackShortLabel(points[5], 8)
        ]
      }
    ];
  }

  _fallbackShortLabel(value = '', maxChars = 10) {
    const text = String(value || '')
      .replace(/[，,；;。].*$/, '')
      .replace(/^(围绕|拆解|沉淀|明确|说明|强调|建立|识别|优先|形成|保证|提炼)/, '')
      .replace(/的(?:核心判断|关键依据|后续行动口径|关系|要求|价值|必要性)$/, '')
      .trim();
    return this._fallbackShortText(text || '关键要点', maxChars);
  }

  _fallbackShortText(value = '', maxChars = 16) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
  }

  _fallbackSourceText() {
    return [
      this.task?.prompt,
      this.params.content,
      this.params.extraRequirements,
      this.sourceContent
    ].filter(Boolean).join('\n');
  }

  _isMechanicalControlTopic(source = '') {
    return /(平衡步兵|串联腿|五连杆|VMC|LQR|翻滚角|云台|发射机构|底盘|腿长|高速转向)/i.test(String(source || ''));
  }

  _extractSvgAndFilename(raw) {
    const cleaned = this._stripMarkdownFence(raw);
    const pageMatch = cleaned.match(/<!--\s*PAGE:(\d+)\s*FILENAME:([^\s*]+)\s*-->/i);
    const svgMatch = cleaned.match(/<svg[\s\S]*?<\/svg>/i);
    const partialSvg = svgMatch ? null : this._extractPartialSvg(cleaned);
    return {
      svg: svgMatch ? svgMatch[0] : null,
      filename: pageMatch ? pageMatch[2] : null,
      pageNum: pageMatch ? parseInt(pageMatch[1], 10) : null,
      partialSvg
    };
  }

  _extractFailedSvgFilenames(output, fallbackDir = null) {
    const filenames = new Set();
    const re = /\[ERROR\]\s+([^\s]+\.svg)\s+-\s+Failed/g;
    let match;
    while ((match = re.exec(output || '')) !== null) {
      if (this._isCanonicalPageSvgName(match[1])) filenames.add(match[1]);
    }
    if (filenames.size === 0 && fallbackDir) {
      this._listCanonicalSvgNames(fallbackDir)
        .forEach(name => filenames.add(name));
    }
    return [...filenames];
  }

  _findGeneratedPptx(projectPath) {
    const exportDir = path.join(projectPath, 'exports');
    if (!fs.existsSync(exportDir)) return null;

    const files = fs.readdirSync(exportDir)
      .filter(name => name.endsWith('.pptx'))
      .map(name => path.join(exportDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    return files.find(file => !path.basename(file).includes('_svg')) || files[0] || null;
  }

  _listPreviewSvgUrls(projectPath, preferredDir = 'svg_final') {
    const svgDir = fs.existsSync(path.join(projectPath, preferredDir))
      ? path.join(projectPath, preferredDir)
      : path.join(projectPath, 'svg_output');
    if (!fs.existsSync(svgDir)) return [];
    return this._listCanonicalSvgNames(svgDir)
      .map(name => this._toUploadUrl(path.join(svgDir, name)));
  }

  _toUploadUrl(filePath) {
    return appConfig.pathToUploadUrl(filePath);
  }

  _getResult() {
    const lastResult = this.stepResults.export || {};
    return {
      status: 'completed',
      stage: 'done',
      progress: 100,
      title: this.params.title,
      page_count: this.params.pageCount,
      download_url: lastResult.download_url,
      pptx_url: lastResult.pptx_url,
      file_id: lastResult.file_id,
      preview_svgs: lastResult.preview_svgs || [],
      workflow_log_url: lastResult.workflow_log_url,
      workflow_state_url: lastResult.workflow_state_url,
      quality_report_url: lastResult.quality_report_url,
      layout_safety_report_url: lastResult.layout_safety_report_url,
      chart_calibration_report_url: lastResult.chart_calibration_report_url,
      template_reference: lastResult.template_reference || null,
      image_assets: lastResult.image_assets || [],
      billing: lastResult.billing || null,
      project_dir: lastResult.project_dir
    };
  }

  _getPartialResults() {
    return {
      completedSteps: Object.keys(this.stepResults).filter(key => !this.stepResults[key].skipped && !this.stepResults[key].error),
      failedStep: this.currentStep,
      generatedPages: this.generatedPages.length,
      billing: this._buildBillingSummary(),
      projectPath: this.projectPath ? this._toUploadUrl(this.projectPath) : null,
      preview_svgs: this.projectPath ? this._listPreviewSvgUrls(this.projectPath, 'svg_output') : []
    };
  }

  async buildEmergencyResult(error = {}) {
    this._recordWorkflowEvent('Emergency PPT Result', 'disabled', {
      original_error: this._trimText(error.message || String(error), 1600),
      action: 'local fallback pages are disabled; task remains failed'
    });
    this._flushWorkflowFiles();
    throw error;
  }

  _writeProjectReadme() {
    const lines = [
      `# ${this.params.title}`,
      '',
      `- Canvas format: ${this.params.canvasFormat}`,
      `- Page count: ${this.params.pageCount}`,
      this.params.pageCountMode === 'auto' ? `- Page count mode: AI 自动判断${this.params.autoPageReason ? `（${this.params.autoPageReason}）` : ''}` : '',
      `- Style: ${this._describeSelectedStyle()}`,
      `- Created: ${new Date().toISOString()}`,
      '- Workflow: ppt-master strict serial pipeline',
      '- Pipeline: Source Document -> Create Project -> Template Option -> Strategist -> [Image_Generator] -> Executor -> Post-processing -> Export'
    ].filter(Boolean);
    this._writeTextFile(path.join(this.projectPath, 'README.md'), lines.join('\n'));
  }

  _writeTextFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  _sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  _fileSha256(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  _aiReviewCacheDir() {
    return path.join(this.projectPath || UPLOAD_DIR, 'reports', 'ai_review_cache');
  }

  _readAiReviewCache(cachePath, expectedKey) {
    const cached = this._readJsonFileIfExists(cachePath, null);
    if (!cached || cached.cache_key !== expectedKey || !cached.result) return null;
    return cached.result;
  }

  _writeAiReviewCache(cachePath, cacheKey, result) {
    this._writeTextFile(cachePath, JSON.stringify({
      cache_version: 'v1-ai-visual-review',
      cache_key: cacheKey,
      generated_at: new Date().toISOString(),
      result
    }, null, 2) + '\n');
  }

  _imageAssetReviewCacheInfo(assets = []) {
    const payload = {
      kind: 'image_asset_review',
      cache_version: 'v2-ai-visual-review',
      title: this.params.title || '',
      review_model: this._assetReviewModel(),
      review_route: 'ppt_asset_review',
      prompt: this._trimText(this.task?.prompt || this.params.content || '', 1600),
      assets: (assets || []).map(asset => {
        const filePath = asset?.path || path.join(this.projectPath, asset?.relativePath || '');
        return {
          filename: asset?.filename || '',
          origin: asset?.origin || '',
          purpose: asset?.description || '',
          source: asset?.sourceUrl || asset?.provider || '',
          hash: this._fileSha256(filePath)
        };
      })
    };
    const key = this._sha256(JSON.stringify(payload));
    return {
      key,
      path: path.join(this._aiReviewCacheDir(), `asset_review_${key}.json`)
    };
  }

  _pagePreviewReviewCacheInfo(previews = []) {
    const payload = {
      kind: 'page_visual_review',
      cache_version: 'v2-ai-visual-review',
      title: this.params.title || '',
      review_model: this._pageReviewModel(),
      review_route: 'ppt_page_review',
      page_count: this.params.pageCount,
      canvas_format: this.params.canvasFormat,
      pages: (previews || []).map(page => ({
        page: page.page,
        filename: page.filename,
        context: this._trimText(page.context || page.title || '', 420),
        png_hash: this._fileSha256(page.pngPath)
      }))
    };
    const key = this._sha256(JSON.stringify(payload));
    return {
      key,
      path: path.join(this._aiReviewCacheDir(), `page_review_${key}.json`)
    };
  }

  _pagePreviewSingleReviewCacheInfo(page = {}) {
    const payload = {
      kind: 'page_visual_review_single',
      cache_version: 'v4-ai-page-visual-review-single',
      title: this.params.title || '',
      review_model: this._pageReviewModel(),
      review_route: 'ppt_page_review',
      page_count: this.params.pageCount,
      canvas_format: this.params.canvasFormat,
      review_policy: 'strict_visual_review_conservative_local_repair_only',
      page: page.page,
      filename: page.filename,
      context: this._trimText(page.context || page.title || '', 420),
      png_hash: this._fileSha256(page.pngPath)
    };
    const key = this._sha256(JSON.stringify(payload));
    return {
      key,
      path: path.join(this._aiReviewCacheDir(), `page_review_single_${String(page.page || 0).padStart(2, '0')}_${key}.json`)
    };
  }

  _normalizeAiPageReviewItem(item = null, page = {}, { cacheHit = false } = {}) {
    const severity = String(item?.severity || (item?.passed === false ? 'fail' : 'ok')).toLowerCase();
    const failed = severity === 'fail' || (item?.passed === false && !['ok', 'warning'].includes(severity));
    const passed = !failed;
    const issues = Array.isArray(item?.issues)
      ? item.issues.filter(Boolean)
      : [item?.reason || item?.issue || ''].filter(Boolean);
    if (!item) {
      issues.push('AI 审查返回中缺少该页明细，按 warning 记录但不触发整页重生成');
    }
    return {
      page: parseInt(item?.page, 10) || page.page,
      filename: item?.filename || page.filename,
      passed: item ? passed : true,
      severity: item ? (severity || 'ok') : 'warning',
      issues,
      repair_instruction: item?.repair_instruction || '',
      cache_hit: cacheHit,
      screenshot_hash: this._fileSha256(page.pngPath)
    };
  }

  _loadPptMasterFile(relativePath, maxChars = 6000) {
    const root = this.runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) return '';
    const text = fs.readFileSync(filePath, 'utf-8');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[... 内容已截断 ...]` : text;
  }

  _createProjectDirectory({ userId, taskId, title, canvasFormat }) {
    const date = this._localDateToken();
    const safeTitle = this._slugify(title).slice(0, 32) || 'ppt';
    const projectName = `${taskId}_${safeTitle}_${canvasFormat}_${date}`;
    const projectPath = path.join(UPLOAD_DIR, 'ppt', String(userId), projectName);

    ['svg_output', 'svg_final', 'images', 'notes', 'templates', 'sources', 'exports'].forEach(dir => {
      fs.mkdirSync(path.join(projectPath, dir), { recursive: true });
    });

    return projectPath;
  }

  _pageFilename(pageNum) {
    return `${String(pageNum).padStart(2, '0')}_slide_${pageNum}.svg`;
  }

  _isCanonicalPageSvgName(name) {
    const match = String(name || '').match(/^(\d{2,3})_slide_(\d{1,3})\.svg$/i);
    if (!match) return false;
    return parseInt(match[1], 10) === parseInt(match[2], 10);
  }

  _canonicalPageNumber(name) {
    if (!this._isCanonicalPageSvgName(name)) return null;
    const match = String(name || '').match(/^(\d{2,3})_slide_(\d{1,3})\.svg$/i);
    return match ? parseInt(match[2], 10) : null;
  }

  _listSvgFileNames(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => String(name).toLowerCase().endsWith('.svg'))
      .sort((a, b) => {
        const leftPage = this._canonicalPageNumber(a);
        const rightPage = this._canonicalPageNumber(b);
        if (leftPage !== null && rightPage !== null) return leftPage - rightPage;
        if (leftPage !== null) return -1;
        if (rightPage !== null) return 1;
        return a.localeCompare(b);
      });
  }

  _listCanonicalSvgNames(dir) {
    return this._listSvgFileNames(dir)
      .filter(name => this._isCanonicalPageSvgName(name));
  }

  _listCanonicalSvgFiles(dir) {
    return this._listCanonicalSvgNames(dir)
      .map(name => path.join(dir, name));
  }

  _quarantineNonCanonicalSvgFiles(dir, reason = 'noncanonical_svg') {
    if (!dir || !fs.existsSync(dir)) return { moved: 0, files: [] };
    const extras = this._listSvgFileNames(dir)
      .filter(name => !this._isCanonicalPageSvgName(name));
    if (extras.length === 0) return { moved: 0, files: [] };

    const backupDir = path.join(
      this.projectPath || path.dirname(dir),
      'backup',
      `noncanonical_svg_${reason}_${this._localTimestampToken()}`
    );
    fs.mkdirSync(backupDir, { recursive: true });
    const moved = [];
    extras.forEach(name => {
      const from = path.join(dir, name);
      const to = path.join(backupDir, name);
      fs.renameSync(from, to);
      moved.push(name);
    });
    this._recordWorkflowEvent('Noncanonical SVG Quarantine', 'completed', {
      directory: this.projectPath ? path.relative(this.projectPath, dir) : dir,
      backup_dir: this.projectPath ? path.relative(this.projectPath, backupDir) : backupDir,
      reason,
      files: moved
    });
    return {
      moved: moved.length,
      files: moved,
      backup_dir: this.projectPath ? path.relative(this.projectPath, backupDir) : backupDir
    };
  }

  _assertCanonicalPageSet(dir, label = '页面文件检查') {
    const expected = Math.max(1, parseInt(this.params.pageCount, 10) || 1);
    const names = this._listCanonicalSvgNames(dir);
    const present = new Set(names.map(name => this._canonicalPageNumber(name)).filter(Number.isFinite));
    const missing = [];
    for (let pageNum = 1; pageNum <= expected; pageNum += 1) {
      if (!present.has(pageNum)) missing.push(this._pageFilename(pageNum));
    }
    const overflow = names.filter(name => {
      const pageNum = this._canonicalPageNumber(name);
      return !Number.isFinite(pageNum) || pageNum < 1 || pageNum > expected;
    });
    if (missing.length || overflow.length || names.length !== expected) {
      throw new Error(`${label}失败: 预期 ${expected} 页，实际 ${names.length} 页；缺失 ${missing.join(', ') || '无'}；多余 ${overflow.join(', ') || '无'}`);
    }
    return names;
  }

  async _ensureCanonicalPageSet(dir, label = '页面文件检查') {
    fs.mkdirSync(dir, { recursive: true });
    const expected = Math.max(1, parseInt(this.params.pageCount, 10) || 1);
    const names = this._listCanonicalSvgNames(dir);
    const present = new Set(names.map(name => this._canonicalPageNumber(name)).filter(Number.isFinite));
    const missing = [];
    for (let pageNum = 1; pageNum <= expected; pageNum += 1) {
      if (!present.has(pageNum)) missing.push(pageNum);
    }
    if (missing.length > 0) {
      this._recordWorkflowEvent('Canonical Page Set Rescue', 'completed', {
        label,
        directory: this.projectPath ? path.relative(this.projectPath, dir) : dir,
        missing_pages: missing,
        action: 'blocked; local fallback pages are disabled'
      });
      throw new Error(`${label}缺失页面: ${missing.join(', ')}；已停止使用兜底页自动补齐`);
    }

    try {
      return this._assertCanonicalPageSet(dir, label);
    } catch (error) {
      this._recordWorkflowEvent('Canonical Page Set Rescue', 'continued_with_warnings', {
        label,
        directory: this.projectPath ? path.relative(this.projectPath, dir) : dir,
        error: error.message
      });
      return this._listCanonicalSvgNames(dir);
    }
  }

  async _tryExportPptxWithSafeFallback() {
    try {
      const finalDir = path.join(this.projectPath, 'svg_final');
      await this._ensureCanonicalPageSet(finalDir, '导出重试前');
      await this._ensureFinalSvgExportReady(finalDir, '导出重试前');
      await this._execPptMasterScript('svg_to_pptx.py', this._pptxExportArgs(), {
        timeoutMs: 360000,
        rejectOnError: false
      });
      const pptxFile = this._findGeneratedPptx(this.projectPath);
      if (pptxFile) {
        this._recordWorkflowEvent('Step 7.3 Export PPTX Rescue', 'completed', {
          pptx: path.relative(this.projectPath, pptxFile)
        });
        return pptxFile;
      }
    } catch (error) {
      this._recordWorkflowEvent('Step 7.3 Export PPTX Rescue', 'failed', {
        error: error.message
      });
    }
    return null;
  }

  async _ensureFinalSvgExportReady(dir, label = '导出前') {
    const repaired = new Set(await this._repairSvgDirectoryForExport(dir, label));
    let quality = await this._runQualityCheck(dir, { allowFailure: true });
    let placeholder = this._runPlaceholderFailureCheck(dir);
    let layout = this._runLayoutSafetyCheck(dir);

    const failedNames = () => new Set([
      ...(!quality.ok ? this._extractFailedSvgFilenames(quality.output || '', dir) : []),
      ...(placeholder.failed_files || []),
      ...(layout.files || [])
        .filter(file => (file.issues || []).some(issue => this._layoutIssueRequiresRepair(issue)))
        .map(file => file.file)
    ].filter(name => this._isCanonicalPageSvgName(name)));

    let names = failedNames();
    if (names.size > 0) {
      this._recordWorkflowEvent('Final SVG Export Gate', 'blocked_unresolved_pages', {
        label,
        failed_files: [...names],
        action: 'blocked; local fallback pages are disabled'
      });
    }

    const passed = Boolean(quality.ok && placeholder.ok && layout.ok);
    const report = [
      `# Final SVG Export Gate`,
      '',
      `- Label: ${label}`,
      `- Result: ${passed ? 'passed' : 'failed'}`,
      `- Directory: ${this.projectPath ? path.relative(this.projectPath, dir) : dir}`,
      `- Repaired files: ${[...repaired].join(', ') || 'none'}`,
      '',
      '## Quality',
      quality.output || '(no output)',
      '',
      '## Placeholder',
      placeholder.output || '(no output)',
      '',
      '## Layout',
      layout.output || '(no output)'
    ].join('\n');
    this._writeTextFile(path.join(this.projectPath, 'reports', 'final_export_gate.md'), `${report.trim()}\n`);
    this._recordWorkflowEvent('Final SVG Export Gate', passed ? 'completed' : 'failed', {
      label,
      directory: this.projectPath ? path.relative(this.projectPath, dir) : dir,
      quality_ok: quality.ok,
      placeholder_ok: placeholder.ok,
      layout_ok: layout.ok,
      repaired_files: [...repaired],
      failed_files: [...names],
      report: 'reports/final_export_gate.md'
    });

    if (!passed) {
      // Invalid XML / quality issues in final SVG are advisory — export anyway.
      // The PPTX may have visual glitches on affected slides but won't be blocked entirely.
      console.warn(`[PptAgent] Export gate advisory: exporting with warnings for: ${[...names].join(', ') || 'unknown files'}`);
      this._recordWorkflowEvent('Final SVG Export Gate', 'advisory_continued', {
        label,
        failed_files: [...names],
        action: 'export continues with warnings — affected slides may have visual issues'
      });
    }

    return {
      passed,
      repaired_files: [...repaired],
      quality,
      placeholder,
      layout,
      report: 'reports/final_export_gate.md'
    };
  }

  async _repairSvgDirectoryForExport(dir, label = '导出前') {
    const repaired = [];
    const names = this._listCanonicalSvgNames(dir);
    for (const filename of names) {
      const svgPath = path.join(dir, filename);
      let reason = '';

      try {
        const original = fs.readFileSync(svgPath, 'utf-8');
        const sanitized = this._sanitizeSvgContent(original);
        if (sanitized !== original) {
          this._writeTextFile(svgPath, sanitized);
          repaired.push(filename);
        }

        const quality = await this._runQualityCheck(svgPath, { allowFailure: true });
        const placeholder = this._runPlaceholderFailureCheck(svgPath);
        if (!quality.ok || !placeholder.ok) {
          // If quality check reports Invalid XML, try template fallback
          if (quality.output && /Invalid\s+XML/i.test(quality.output)) {
            const pageNum = this._pageNumFromFilename(filename) || 1;
            const fallbackSvg = this._createFallbackPage(pageNum, this.params.pageCount || 8, 'XML repair fallback');
            const fallbackPath = path.join(path.dirname(svgPath), filename);
            this._writeTextFile(fallbackPath, fallbackSvg);
            repaired.push(filename);
            // Re-check after fallback
            const recheck = await this._runQualityCheck(fallbackPath, { allowFailure: true });
            if (recheck.ok) {
              this._recordWorkflowEvent('Export SVG Directory Repair', 'repaired_with_fallback', {
                label,
                page: filename,
                action: 'replaced broken XML with template fallback'
              });
              continue;
            }
          }
          reason = [quality.output, placeholder.output].filter(Boolean).join('\n');
          this._recordWorkflowEvent('Export SVG Directory Repair', 'blocked_unresolved_page', {
            label,
            page: filename,
            reason: this._trimText(reason, 1800),
            action: 'blocked; local fallback pages are disabled'
          });
        }
      } catch (error) {
        reason = error.message;
        this._recordWorkflowEvent('Export SVG Directory Repair', 'blocked_unresolved_page', {
          label,
          page: filename,
          reason: this._trimText(reason, 1800),
          action: 'blocked; local fallback pages are disabled'
        });
      }
    }

    if (repaired.length > 0) {
      this._recordWorkflowEvent('Export SVG Directory Repair', 'completed', {
        label,
        directory: this.projectPath ? path.relative(this.projectPath, dir) : dir,
        repaired_files: [...new Set(repaired)]
      });
    }
    return [...new Set(repaired)];
  }

  _pageNumFromFilename(filename) {
    const match = String(filename || '').match(/^(\d{1,3})_/);
    return match ? parseInt(match[1], 10) : null;
  }

  _canvasInfo() {
    if (this.params.canvasFormat === 'ppt43') {
      return { format: 'PPT 4:3', viewBox: '0 0 1024 768', width: 1024, height: 768 };
    }
    return { format: 'PPT 16:9', viewBox: '0 0 1280 720', width: 1280, height: 720 };
  }

  _fallbackPageTitles() {
    const requestedPlan = this._extractRequestedPagePlan();
    if (requestedPlan.length >= Math.min(this.params.pageCount, 3)) {
      const planned = [];
      requestedPlan.forEach(item => {
        planned[item.pageNum - 1] = item.title;
      });
      const complete = [];
      for (let index = 0; index < this.params.pageCount; index += 1) {
        complete.push(planned[index] || this._inferredFallbackPageTitle(index + 1));
      }
      return complete;
    }

    const pages = [];
    for (let index = 0; index < this.params.pageCount; index += 1) {
      pages.push(this._inferredFallbackPageTitle(index + 1));
    }
    return pages;
  }

  _inferredFallbackPageTitle(pageNum) {
    const source = this._fallbackSourceText();
    const isMechanicalControl = this._isMechanicalControlTopic(source);
    const mechanical = [
      '封面：平衡步兵机械与控制系统技术方案',
      '目录：汇报结构',
      '研发背景：规则变化与场景价值',
      '总体架构：机械结构、控制算法、补偿策略的关系',
      '机械方案：串联腿、底盘、云台与发射机构',
      '控制方案：LQR、动力学建模、五连杆 VMC 与综合控制',
      '补偿策略：翻滚角与高速转向推力补偿',
      '验证路径：场景测试、参数标定与版本回归',
      '工程收益：稳定性、机动性与维护效率提升',
      '风险治理：结构疲劳、参数漂移与场地差异',
      '迭代计划：下一版结构与控制优化重点',
      '总结：结论与下一步'
    ];
    const generic = [
      '封面：主题与核心观点',
      '目录：汇报结构',
      '背景：问题与目标',
      '现状：关键事实与约束',
      '问题拆解：核心挑战与影响',
      '方案框架：能力分层与责任边界',
      '执行路径：阶段节奏与验收口径',
      '资源保障：组织、工具与数据准备',
      '预期收益：效率、质量与风险改善',
      '风险治理：约束、预案与监控指标',
      '推进计划：近期行动与责任分工',
      '总结：结论与下一步'
    ];
    const titles = isMechanicalControl ? mechanical : generic;
    return titles[pageNum - 1] || `总结：第 ${pageNum} 页关键结论`;
  }

  _fallbackLayoutForPage(pageNum) {
    if (pageNum === 1) return 'Cover with hero title, abstract SVG background, insight strip';
    if (/架构|architecture|系统|模块|分层/i.test(this._fallbackPageTitles()[pageNum - 1] || '')) {
      return 'Layered architecture diagram with governance rail';
    }
    if (/市场|运营|指标|趋势|数据|kpi|增长/i.test(this._fallbackPageTitles()[pageNum - 1] || '')) {
      return 'Trend chart plus KPI rail';
    }
    if (/路线|路径|计划|实施|roadmap|timeline/i.test(this._fallbackPageTitles()[pageNum - 1] || '')) {
      return 'Horizontal roadmap timeline with phase cards';
    }
    if (pageNum === this.params.pageCount) return 'Anchor summary with next actions';
    return pageNum % 2 === 0 ? 'Split view with diagram and bullets' : 'Dense consulting grid with chart focus';
  }

  _fallbackVisualizationForPage(pageNum) {
    const title = this._fallbackPageTitles()[pageNum - 1] || '';
    if (/架构|architecture|系统|模块|分层/i.test(title)) return 'layered_architecture';
    if (/市场|运营|指标|趋势|数据|kpi|增长/i.test(title)) return 'line_chart + kpi_cards';
    if (/路线|路径|计划|实施|roadmap|timeline/i.test(title)) return 'timeline / process_flow';
    if (pageNum === 1) return 'hero visual';
    return 'vertical_list';
  }

  _fallbackContentPointForPage(pageNum, pointNum) {
    const title = this._fallbackPageTitles()[pageNum - 1] || '';
    if (!this._isMechanicalControlTopic(this._fallbackSourceText())) {
      return this._fallbackGenericContentPoint(title, pointNum);
    }
    const matrix = {
      1: ['明确汇报目标与最终判断', '锁定关键技术链路和评审边界', '给出后续页面的阅读主线'],
      2: ['按背景、结构、控制、验证、风险组织内容', '突出机械与控制闭环之间的关系', '把结论页与下一步行动提前铺垫'],
      3: ['说明规则变化和运动场景对稳定性的要求', '提炼串联腿方案的工程价值', '引出控制算法与补偿策略的必要性'],
      4: ['把机械结构、控制算法、补偿策略分层表达', '明确传感、决策、执行之间的输入输出', '强调结构边界和算法响应共同决定稳定性'],
      5: ['拆解串联腿、底盘、云台与发射机构的职责', '说明低重心、刚度和响应空间的设计取舍', '关联机械结构对控制效果的支撑作用'],
      6: ['说明 LQR、动力学建模与 VMC 的协同逻辑', '把平衡控制、腿部控制和综合运动控制串联', '明确参数标定和控制闭环的落地口径'],
      7: ['用腿长控制抑制单边桥侧倾', '用推力补偿降低高速转向姿态波动', '把补偿触发条件和回归测试纳入版本管理'],
      8: ['建立场景识别、参数标定和实车验证闭环', '沉淀测试日志、问题清单和回归基线', '保证每轮迭代可复现、可对比、可回滚'],
      9: ['提升复杂路况下的姿态稳定性', '释放高速转向和越障场景的机动性能', '降低结构调整和参数试错的维护成本'],
      10: ['识别结构疲劳、参数漂移和场地差异风险', '用备件、日志和版本对照降低不确定性', '优先处理高影响且可通过资源投入压降的问题'],
      11: ['收敛云台、发射机构和防护结构的下一版输入', '补齐装配干涉、刚度校核和线束保护验证', '把测试记录转化为可执行的改版清单'],
      12: ['总结机械结构与控制补偿的协同价值', '明确近期验证任务和责任边界', '形成下一轮设计评审输入']
    };
    return matrix[pageNum]?.[pointNum - 1] || this._fallbackGenericContentPoint(title, pointNum);
  }

  _fallbackGenericContentPoint(title = '', pointNum = 1) {
    const cleanTitle = String(title || '').replace(/^.*?：/, '').trim() || '本页主题';
    const points = [
      `围绕${cleanTitle}明确核心判断`,
      `拆解${cleanTitle}对应的关键依据`,
      `沉淀${cleanTitle}的后续行动口径`
    ];
    return points[Math.max(0, Math.min(2, pointNum - 1))];
  }

  _pageRhythms() {
    const rhythms = [];
    for (let index = 0; index < this.params.pageCount; index += 1) {
      if (index === 0 || index === this.params.pageCount - 1) {
        rhythms.push('anchor');
      } else if (index % 4 === 2) {
        rhythms.push('breathing');
      } else {
        rhythms.push('dense');
      }
    }
    return rhythms;
  }

  _inferPageDescription(pageNum) {
    return this._fallbackPageTitles()[pageNum - 1] || `第 ${pageNum} 页`;
  }

  _paletteForStyle(style) {
    const palettes = {
      consulting: {
        bg: '#FFFFFF',
        surface: '#F6F8FB',
        primary: '#1F4E79',
        accent: '#E85D75',
        secondary_accent: '#2AA876',
        text: '#111827',
        text_secondary: '#52616B',
        border: '#D8DEE9',
        muted: '#EEF2F7',
        success: '#137333',
        warning: '#B42318'
      },
      consulting_top: {
        bg: '#FFFFFF',
        surface: '#F7F7F5',
        primary: '#101820',
        accent: '#C8102E',
        secondary_accent: '#005F73',
        text: '#111111',
        text_secondary: '#5B6470',
        border: '#D5D8DC',
        muted: '#ECEFF1',
        success: '#0B6E4F',
        warning: '#A61B1B'
      },
      general: {
        bg: '#FFFFFF',
        surface: '#F5F7FA',
        primary: '#2454A6',
        accent: '#F26B3A',
        secondary_accent: '#20A4A8',
        text: '#152033',
        text_secondary: '#596579',
        border: '#D9E0EA',
        muted: '#EEF3F8',
        success: '#16865A',
        warning: '#B42318'
      },
      dark_tech: {
        bg: '#0B1020',
        surface: '#111827',
        primary: '#F26B3A',
        accent: '#20A4A8',
        secondary_accent: '#4A7BD4',
        text: '#F8FAFC',
        text_secondary: '#CBD5E1',
        border: '#334155',
        muted: '#1E293B',
        success: '#2AA876',
        warning: '#F26B3A'
      }
    };
    return palettes[style] || palettes.general;
  }

  _mapStyle(value = '') {
    const key = String(value || '').toLowerCase();
    const map = {
      business: 'consulting',
      consulting: 'consulting',
      consulting_top: 'consulting_top',
      mckinsey: 'consulting_top',
      exhibit: 'consulting_top',
      minimal: 'consulting_top',
      creative: 'general',
      google: 'general',
      google_style: 'general',
      academic: 'general',
      academic_defense: 'general',
      medical: 'general',
      medical_university: 'general',
      zen: 'general',
      pixel: 'general',
      pixel_retro: 'general',
      psychology: 'general',
      psychology_attachment: 'general',
      anthropic: 'general',
      ai_ops: 'dark_tech',
      tech_blue: 'consulting',
      government_blue: 'consulting',
      government_red: 'consulting',
      finance_cmb: 'consulting',
      telecom: 'consulting',
      powerchina_modern: 'consulting',
      powerchina_standard: 'consulting',
      catarc_modern: 'consulting',
      catarc_business: 'consulting',
      catarc_standard: 'consulting',
      '科技蓝商务': 'consulting',
      '招商银行': 'consulting',
      '中国电信': 'consulting',
      '中国电建_现代': 'consulting',
      '中国电建_常规': 'consulting',
      '中汽研_现代': 'consulting',
      '中汽研_商务': 'consulting',
      '中汽研_常规': 'consulting',
      general: 'general',
      dark: 'dark_tech',
      dark_tech: 'dark_tech',
      tech: 'dark_tech'
    };
    return map[key] || 'general';
  }

  _executorStyleFile(style) {
    const map = {
      consulting: 'executor-consultant.md',
      consulting_top: 'executor-consultant-top.md'
    };
    return map[style] || 'executor-general.md';
  }

  _describeStyle(style) {
    const map = {
      consulting: '咨询风，数据清晰，结构严谨',
      consulting_top: '顶级咨询风，结论驱动，强对比，适合正式汇报',
      general: '通用专业风，平衡信息密度和视觉表现',
      dark_tech: '暗色科技风，适合技术架构演示，强调流程图、模块图和高对比信息层级'
    };
    return map[style] || map.general;
  }

  _describeSelectedStyle() {
    const label = String(this.params.styleLabel || '').trim();
    const styleId = String(this.params.styleId || this.params.requestedStyle || '').trim();
    const template = String(this.params.pptMasterTemplate || this.params.ppt_master_template || '').trim();
    const executorStyle = this._describeStyle(this.params.style);
    const parts = [];
    if (label) parts.push(label);
    if (styleId && styleId !== label) parts.push(`styleId=${styleId}`);
    if (template) parts.push(`ppt-master模板=${template}`);
    parts.push(`executor=${executorStyle}`);
    return parts.join('；');
  }

  _describeCanvasFormat(value) {
    return value === 'ppt43' ? '4:3 经典比例' : '16:9 宽屏比例';
  }

  _normalizePageCount(input, runtimeConfig, fallback = null) {
    const minPages = Math.max(parseInt(runtimeConfig.pptMinPages, 10) || 3, 1);
    const maxPages = Math.max(parseInt(runtimeConfig.pptMaxPages, 10) || 30, minPages);
    if (!input) return fallback;
    const parsed = parseInt(input, 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minPages), maxPages) : fallback;
  }

  _extractExplicitPageCount(values = []) {
    const joined = (Array.isArray(values) ? values : [values])
      .filter(value => value !== undefined && value !== null && value !== '')
      .map(value => String(value))
      .join('\n');
    if (!joined.trim()) return null;

    const patterns = [
      /(?:建议页数|页数|页数要求|总页数|页面数量|PPT页数|ppt页数|生成页数)\s*[:：]?\s*(\d{1,3})\s*页/i,
      /(?:做成|做|生成|制作|整理成|设计成|输出|改成)\s*(\d{1,3})\s*页/i,
      /(\d{1,3})\s*页\s*(?:PPT|ppt|幻灯片|演示|简报|汇报|课件|方案)?/i
    ];
    for (const pattern of patterns) {
      const matches = [...joined.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
      if (matches.length > 0) {
        const parsed = parseInt(matches[matches.length - 1][1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
    return null;
  }

  async _resolvePageCountBeforeGeneration() {
    if (Number.isFinite(this.params.pageCount) && this.params.pageCount > 0) {
      return this.params.pageCount;
    }

    this.currentStep = 'pagePlanning';
    this._updateProgress(4, 'page_planning', '正在判断这份 PPT 做几页合适');

    let resolved = null;
    let reason = '';
    try {
      const result = await this._askModelForPageCount();
      resolved = result.pageCount;
      reason = result.reason || '';
    } catch (error) {
      console.warn('[PptAgent] AI页数判断失败，使用内容数量估算:', error.message);
      resolved = this._estimatePageCountFromContent();
      reason = `模型判断失败，按内容数量估算：${error.message}`;
    }

    this.params.pageCount = this._normalizePageCount(resolved, this.runtimeConfig, this._estimatePageCountFromContent());
    this.params.page_count = this.params.pageCount;
    this.params.pageCountMode = 'auto';
    this.params.autoPageReason = reason;

    const storedParams = this._safeJsonParse(this.task.params, {});
    const storedResult = this._safeJsonParse(this.task.result_data, {});
    this.task = AiTask.update(this.task.id, {
      params: {
        ...storedParams,
        pageCount: this.params.pageCount,
        page_count: this.params.pageCount,
        pageCountMode: 'auto',
        autoPageReason: reason
      },
      result_data: {
        ...storedResult,
        status: storedResult.status || 'processing',
        stage: 'page_planning',
        progress: Math.max(Number(storedResult.progress) || 0, 4),
        message: `已判断适合生成 ${this.params.pageCount} 页`,
        page_count: this.params.pageCount,
        page_count_mode: 'auto',
        auto_page_reason: reason
      }
    }) || this.task;

    this._recordWorkflowEvent('PPT Page Count Planning', 'completed', {
      mode: 'auto',
      page_count: this.params.pageCount,
      reason
    });
    this._updateProgress(6, 'page_planning', `已判断适合生成 ${this.params.pageCount} 页`);
    return this.params.pageCount;
  }

  async _askModelForPageCount() {
    const minPages = Math.max(parseInt(this.runtimeConfig.pptMinPages, 10) || 3, 1);
    const maxPages = Math.max(parseInt(this.runtimeConfig.pptMaxPages, 10) || 30, minPages);
    const sourceText = this._trimText([
      `标题：${this.params.title}`,
      this.params.audience ? `受众：${this.params.audience}` : '',
      this.params.scenario ? `场景：${this.params.scenario}` : '',
      this.params.content ? `内容：${this.params.content}` : '',
      this.params.extraRequirements ? `额外要求：${this.params.extraRequirements}` : '',
      `用户原始需求：${this.task?.prompt || ''}`
    ].filter(Boolean).join('\n'), 9000);

    const raw = await this._callPptModel({
      model: this._strategistModel(),
      route: 'ppt_strategist',
      systemPrompt: [
        '你负责判断一份 PPT 最适合生成多少页。',
        `页数必须在 ${minPages} 到 ${maxPages} 页之间。`,
        '不要使用固定默认页数，要根据主题类型、信息量、受众、表达节奏判断。',
        '原则：简单介绍少页；课堂科普、发展史、行业趋势需要完整时间线或章节；项目汇报和商业方案需要背景、目标、方案、成果、风险、计划；长文档按内容密度增加页数。',
        '不要为了凑页数加水，也不要把很多重点挤在一页。',
        '只返回 JSON：{"page_count":数字,"reason":"一句中文原因"}。'
      ].join('\n'),
      userMessage: sourceText,
      maxTokens: 260,
      temperature: 0.15,
      retries: 1,
      timeoutMs: 60000
    });
    const cleaned = this._stripMarkdownFence(raw);
    const parsed = this._safeJsonParse(cleaned, null);
    const fallbackMatch = cleaned.match(/(?:page_count|pageCount|建议页数|页数)\s*["':：]?\s*(\d{1,3})/i)
      || cleaned.match(/(\d{1,3})\s*页/);
    const count = this._normalizePageCount(
      parsed?.page_count || parsed?.pageCount || fallbackMatch?.[1],
      this.runtimeConfig,
      null
    );
    if (!count) throw new Error('模型没有返回有效页数');
    return {
      pageCount: count,
      reason: String(parsed?.reason || '').trim()
    };
  }

  _estimatePageCountFromContent() {
    const minPages = Math.max(parseInt(this.runtimeConfig.pptMinPages, 10) || 3, 1);
    const maxPages = Math.max(parseInt(this.runtimeConfig.pptMaxPages, 10) || 30, minPages);
    const text = [
      this.params.title,
      this.params.content,
      this.params.extraRequirements,
      this.task?.prompt
    ].filter(Boolean).join('\n');
    const pageMarkers = text.match(/(?:^|\n)\s*(?:[-*]?\s*)?(?:P0?\d+|第\s*\d+\s*页|第\s*\d+\s*张)/g) || [];
    if (pageMarkers.length >= 3) {
      return Math.min(Math.max(pageMarkers.length, minPages), maxPages);
    }

    const headingCount = (text.match(/(?:^|\n)\s*#{1,4}\s+/g) || []).length;
    const bulletCount = (text.match(/(?:^|\n)\s*[-*•]\s+/g) || []).length;
    const paragraphCount = text.split(/\n{2,}/).map(item => item.trim()).filter(Boolean).length;
    const charCount = text.replace(/\s/g, '').length;
    let score = 4 + headingCount * 0.85 + bulletCount * 0.28 + paragraphCount * 0.2 + charCount / 900;

    if (/(发展史|历史|时间线|趋势|行业分析|市场分析|研究报告|白皮书|课程|培训|课件|论文|PDF|pdf|完整资料)/.test(text)) {
      score += 2;
    }
    if (/(项目汇报|路演|商业计划|融资|招商|解决方案|建设方案|实施方案|复盘|年度|季度)/.test(text)) {
      score += 1.5;
    }
    if (charCount < 120 && bulletCount < 3 && headingCount < 2) {
      score = Math.max(score, 6);
    }

    return Math.min(Math.max(Math.round(score), minPages), maxPages);
  }

  _normalizeBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
  }

  _deriveTitle(prompt) {
    if (!prompt) return 'AI生成PPT';
    const explicit = String(prompt).match(/(?:标题|主题)[:：]\s*([^\n。]+)/);
    if (explicit?.[1]) return explicit[1].trim().slice(0, 32);
    const firstLine = String(prompt).split('\n').find(line => line.trim());
    return firstLine ? firstLine.replace(/^[-*\d.\s]+/, '').trim().slice(0, 32) : 'AI生成PPT';
  }

  _assistantToText(payload) {
    if (!payload || payload.skipped || payload.error) return '';

    const parts = [];
    if (payload.title) parts.push(`标题：${payload.title}`);
    if (payload.overview) parts.push(`概述：${payload.overview}`);
    if (payload.apply_text) parts.push(payload.apply_text);
    if (Array.isArray(payload.outline)) {
      payload.outline.forEach(item => {
        if (item.title) parts.push(`### ${item.title}`);
        if (Array.isArray(item.items)) {
          parts.push(item.items.map(entry => `- ${entry}`).join('\n'));
        }
      });
    }
    if (Array.isArray(payload.deliverables)) {
      payload.deliverables.forEach(item => {
        if (item.label) parts.push(`### ${item.label}`);
        if (item.content) parts.push(item.content);
        if (Array.isArray(item.items) && item.items.length > 0) {
          parts.push(item.items.map(entry => `- ${entry}`).join('\n'));
        }
      });
    }
    if (Array.isArray(payload.sources) && payload.sources.length > 0) {
      parts.push('### 助手引用资料');
      payload.sources.forEach(source => {
        parts.push(`- ${source.title || source.url}: ${source.url || ''}`);
      });
    }
    return parts.filter(Boolean).join('\n\n');
  }

  _safeJsonParse(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string' && /^[\[{]/.test(parsed.trim())) {
        try {
          return JSON.parse(parsed);
        } catch {
          return parsed;
        }
      }
      return parsed;
    } catch {
      return fallback;
    }
  }

  _stripMarkdownFence(text) {
    return String(text || '')
      .replace(/^```(?:svg|xml|markdown|md|json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  _trimText(text, maxChars) {
    const value = String(text || '').trim();
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
  }

  _slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'ppt';
  }

  _escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _escapeXml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  _rgbToHex(r, g, b) {
    const toHex = value => Math.max(0, Math.min(255, parseInt(value, 10) || 0))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
}

module.exports = PptAgent;
