const express = require('express');
const { auth } = require('../middleware/auth');
const AiService = require('../services/aiService');
const AssistantService = require('../services/assistantService');
const ImageTemplateService = require('../services/imageTemplateService');
const StorageLimitService = require('../services/storageLimitService');
const ProjectStorageService = require('../services/projectStorageService');
const RuntimeConfigService = require('../services/runtimeConfigService');
const PptEditService = require('../services/pptEditService');
const PptCopilotAgentService = require('../services/pptCopilotAgentService');
const PptImportEditService = require('../services/pptImportEditService');
const PptAgent = require('../agents/PptAgent');
const DocumentConverterService = require('../services/documentConverterService');
const AiTask = require('../models/AiTask');
const File = require('../models/File');
const User = require('../models/User');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const appConfig = require('../config/appConfig');
const { assertSafeRemoteUrl, safeAxiosOptions } = require('../utils/urlSafety');
const { sanitizePublicObject, sanitizePublicText } = require('../utils/publicResponseSanitizer');
const { normalizeUploadOriginalName } = require('../utils/uploadName');

const router = express.Router();
const assistantRespondJobs = new Map();
const ASSISTANT_RESPOND_JOB_TTL_MS = 30 * 60 * 1000;
const ASSISTANT_RESPOND_JOB_HEARTBEAT_MS = 5000;
const CREDIT_RECHARGE_URL = 'user.html?view=credits';

function assistantJobHeartbeatTitle(elapsedMs = 0) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 12) return '正在理解你的需求';
  if (seconds < 28) return '正在读取资料并梳理线索';
  if (seconds < 50) return '正在整理可用内容';
  if (seconds < 80) return '内容较多，仍在继续处理';
  return '还在处理中，请稍等一下';
}

function publicAssistantErrorMessage(error = {}) {
  const message = String(error?.message || '').trim();
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.response?.status || 0);
  const text = [
    message,
    code,
    status || ''
  ].join(' ').toLowerCase();

  if (code === 'ECONNABORTED' || /timeout|timed out|超时/.test(text)) {
    return '内容较多，创作引擎响应超时了。请再试一次，或者把需求拆短一点。';
  }
  if (/concurrency|并发|busy|达到并发上限|too many/.test(text) || status === 429) {
    return '当前创作通道比较忙，请稍后再试一次。';
  }
  if ([401, 403].includes(status) || /api key|unauthorized|forbidden|权限/.test(text)) {
    return '创作通道鉴权失败，请联系管理员检查接口配置。';
  }
  if (status >= 500 || /5\d\d|bad gateway|service unavailable|upstream/.test(text)) {
    return '创作通道暂时不稳定，请稍后再试。';
  }
  return message || '助手后台任务失败';
}

function updateAssistantRespondJobPhase(job, phase = {}) {
  if (!job || job.status === 'completed' || job.status === 'failed') return;
  const publicTitle = phase.publicTitle || phase.public_title || phase.userTitle || phase.user_title || phase.title || assistantJobHeartbeatTitle(Date.now() - (job.createdAt || Date.now()));
  job.phase = {
    ...phase,
    publicTitle,
    title: publicTitle,
    updatedAt: new Date().toISOString()
  };
  job.phaseUpdatedAt = Date.now();
  job.updatedAt = Date.now();
}

function cleanupAssistantRespondJobs() {
  const now = Date.now();
  for (const [jobId, job] of assistantRespondJobs.entries()) {
    const updatedAt = job?.updatedAt || job?.createdAt || 0;
    if (now - updatedAt > ASSISTANT_RESPOND_JOB_TTL_MS) {
      assistantRespondJobs.delete(jobId);
    }
  }
}

function createAssistantRespondJob({ userId, payload, requestedJobId }) {
  cleanupAssistantRespondJobs();
  const safeRequestedJobId = String(requestedJobId || '').trim();
  let jobId = /^[a-zA-Z0-9_-]{12,96}$/.test(safeRequestedJobId) ? safeRequestedJobId : crypto.randomUUID();
  const existingJob = assistantRespondJobs.get(jobId);
  if (existingJob && String(existingJob.userId) === String(userId)) {
    return existingJob;
  }
  if (existingJob) {
    jobId = crypto.randomUUID();
  }
  const now = Date.now();
  const job = {
    id: jobId,
    userId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    workspace: payload.workspace || 'general',
    message: String(payload.message || '').trim(),
    streamedText: '',
    phase: null,
    phaseUpdatedAt: now,
    tools: [],
    result: null,
    error: null
  };
  assistantRespondJobs.set(jobId, job);

  setImmediate(async () => {
    job.status = 'running';
    job.updatedAt = Date.now();
    updateAssistantRespondJobPhase(job, {
      phase: 'queued',
      publicTitle: '正在理解你的需求',
      message: '已收到请求，正在准备处理'
    });
    const heartbeatTimer = setInterval(() => {
      if (job.status === 'completed' || job.status === 'failed') return;
      if (Date.now() - (job.phaseUpdatedAt || 0) < ASSISTANT_RESPOND_JOB_HEARTBEAT_MS - 500) return;
      updateAssistantRespondJobPhase(job, {
        phase: 'processing',
        publicTitle: assistantJobHeartbeatTitle(Date.now() - (job.createdAt || Date.now())),
        message: '任务仍在处理中'
      });
    }, ASSISTANT_RESPOND_JOB_HEARTBEAT_MS);
    try {
      const result = await AssistantService.respondStream({
        userId,
        workspace: payload.workspace,
        message: job.message,
        draft: typeof payload.draft === 'string' ? payload.draft : '',
        conversation: payload.conversation,
        attachments: payload.attachments,
        allowSearch: payload.allowSearch,
        onPhase: phase => {
          updateAssistantRespondJobPhase(job, phase);
        },
        onTool: tool => {
          if (!shouldExposeAssistantTool(tool)) return;
          job.tools = [...job.tools, tool].slice(-24);
          job.updatedAt = Date.now();
        },
        onDelta: text => {
          job.streamedText += String(text || '');
          job.updatedAt = Date.now();
        }
      });
      job.result = sanitizeAssistantResponse(result);
      job.status = 'completed';
      job.updatedAt = Date.now();
    } catch (error) {
      console.error('助手后台任务错误:', error);
      job.status = 'failed';
      job.error = {
        message: publicAssistantErrorMessage(error)
      };
      job.updatedAt = Date.now();
    } finally {
      clearInterval(heartbeatTimer);
    }
  });

  return job;
}

function getAssistantRespondJobForUser(jobId, userId) {
  cleanupAssistantRespondJobs();
  const job = assistantRespondJobs.get(String(jobId || ''));
  if (!job || String(job.userId) !== String(userId)) return null;
  return job;
}

function publicAssistantRespondJob(job) {
  if (!job) return null;
  return sanitizePublicPayload({
    id: job.id,
    status: job.status,
    workspace: job.workspace,
    message: job.message,
    streamed_text: job.streamedText,
    streamedText: job.streamedText,
    phase: job.phase,
    tools: job.tools,
    result: job.result,
    error: job.error,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString()
  });
}

router.post('/estimate/ppt', auth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const rawParams = req.body?.params;
    const params = typeof rawParams === 'string'
      ? safeParseJson(rawParams, {})
      : (rawParams && typeof rawParams === 'object' ? rawParams : {});
    const estimate = buildPptCreditEstimatePayload({
      params,
      prompt: prompt || params.content || params.title || '',
      userId: req.userId
    });

    const quota = User.getQuota(req.userId);
    const remaining = Number(
      quota?.credits?.remaining
      ?? quota?.universal?.remaining
      ?? quota?.ppt?.remaining
      ?? 0
    );
    const insufficient = Number.isFinite(remaining) && remaining < Number(estimate.charged_credits || 0);

    res.json({
      estimate,
      quota,
      insufficient,
      recharge_url: CREDIT_RECHARGE_URL
    });
  } catch (error) {
    console.error('PPT额度预估错误:', error);
    res.status(500).json({ error: 'PPT额度预估失败: ' + error.message });
  }
});

router.post('/generate/ppt', auth, async (req, res) => {
  try {
    const { prompt, params } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: '请输入PPT内容描述' });
    }

    const pptParams = typeof params === 'string'
      ? JSON.parse(params)
      : (params && typeof params === 'object' ? params : {});
    const estimatedPptCost = estimatePptRequestCredits(pptParams, prompt);
    const estimatedPptBilling = User.buildCreditBilling(estimatedPptCost.totalCredits, req.userId);
    if (!User.checkQuota(req.userId, 'ppt', estimatedPptBilling.chargedCredits)) {
      return res.status(403).json({
        code: 'INSUFFICIENT_CREDITS',
        error: '通用额度不足',
        message: `${User.creditBillingQuotaMessage('当前通用额度不足，本次PPT生成', estimatedPptBilling)}。请先充值后再生成。`,
        recharge_url: CREDIT_RECHARGE_URL
      });
    }

    // 创建任务记录
    const task = AiTask.create({
      userId: req.userId,
      type: 'ppt',
      prompt: prompt,
      params: pptParams
    });

    AiTask.updateStatus(task.id, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'queued',
        progress: 1,
        message: 'PPT 生成任务已创建，正在准备启动...'
      }
    });

    // 异步执行（不阻塞响应）
    setImmediate(() => {
      runPptAgentTask(task.id, '[PPT Agent]');
    });

    // 立即返回任务信息
    res.json({
      message: 'PPT生成任务已启动',
      task: formatTask(AiTask.findById(task.id))
    });
  } catch (error) {
    console.error('PPT生成错误:', error);
    res.status(500).json({ error: 'PPT生成失败: ' + error.message });
  }
});

router.post('/ppt/import', auth, async (req, res) => {
  try {
    const fileId = req.body?.fileId || req.body?.file_id || req.body?.id;
    const file = File.findById(fileId);
    if (!file) {
      return res.status(404).json({ error: '上传文件不存在' });
    }
    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问此文件' });
    }
    if (!fs.existsSync(file.path)) {
      return res.status(404).json({ error: '上传文件已丢失，请重新上传' });
    }
    const sourceName = normalizeUploadOriginalName(file.original_name || file.filename || '', file.filename || '上传PPT');
    if (!/\.(ppt|pptx)$/i.test(sourceName || file.filename || file.path || '')) {
      return res.status(400).json({ error: '只能导入 PPT/PPTX 文件' });
    }

    const title = sanitizeProjectTitle(req.body?.title || path.basename(sourceName || file.filename || '导入PPT', path.extname(sourceName || file.filename || '')));
    const task = AiTask.create({
      userId: req.userId,
      type: 'ppt',
      prompt: title || '导入PPT',
      params: {
        title: title || '导入PPT',
        editMode: 'imported_ppt',
        edit_mode: 'imported_ppt',
        sourceFileId: file.id,
        source_file_id: file.id,
        sourceFileName: sourceName
      }
    });

    AiTask.updateStatus(task.id, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'ppt_import',
        progress: 8,
        edit_mode: 'imported_ppt',
        imported_ppt: true,
        title: title || '导入PPT',
        source_file_id: file.id,
        source_file_name: sourceName,
        message: '正在导入原 PPT，并生成每页预览...'
      }
    });

    res.json({
      message: 'PPT 导入任务已启动',
      task: formatTask(AiTask.findById(task.id))
    });

    setImmediate(() => {
      runImportedPptTask(task.id, file.id);
    });
  } catch (error) {
    console.error('PPT 导入错误:', error);
    res.status(500).json({ error: 'PPT 导入失败: ' + error.message });
  }
});

router.post('/generate/image', auth, async (req, res) => {
  try {
    const { prompt, params, referenceImage, referenceImages } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: '请输入图片描述' });
    }

    const normalizedReferenceImages = normalizeReferenceImagesPayload({
      referenceImage,
      referenceImages
    });

    const imageParams = buildImageSubmissionParams({
      prompt,
      params: params || {},
      referenceImages: normalizedReferenceImages
    });

    const estimatedImageCost = estimateImageRequestCredits(imageParams);
    const estimatedImageBilling = User.buildCreditBilling(estimatedImageCost.totalCredits, req.userId);
    if (!User.checkQuota(req.userId, 'image', estimatedImageBilling.chargedCredits)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: User.creditBillingQuotaMessage('当前通用额度不足，本次图片生成', estimatedImageBilling)
      });
    }

    const recentFailedEdit = imageParams._requestSignature && imageParams.blockRecentFailedReferenceEdit === true
      ? AiTask.findRecentFailedReferenceEdit(req.userId, imageParams._requestSignature, 15)
      : null;
    if (recentFailedEdit) {
      return res.status(409).json({
        error: '这张参考图和这段描述刚刚失败过，我先帮你拦住，避免重复花费。请稍微改一下描述、换张图，或过会儿再试。',
        task: formatTask(recentFailedEdit)
      });
    }

    const task = AiTask.create({
      userId: req.userId,
      type: 'image',
      prompt,
      params: imageParams
    });

    AiTask.updateStatus(task.id, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'queued',
        progress: 5,
        message: '图片生成任务已创建，正在进入队列...'
      }
    });

    res.json({
      message: '图片生成任务已启动',
      task: formatTask(AiTask.findById(task.id))
    });

    setImmediate(() => {
      runImageTask({
        taskId: task.id,
        referenceImages: normalizedReferenceImages
      });
    });
  } catch (error) {
    console.error('图片生成错误:', formatSafeError(error));
    res.status(500).json({
      error: publicImageTaskErrorMessage({
        type: 'image',
        status: 'failed',
        errorMessage: error.message
      }) || '图片生成失败，本次未扣除站内额度。请稍后再试。'
    });
  }
});

router.get('/image/templates', (req, res) => {
  res.json({
    source: sanitizePublicPayload(ImageTemplateService.getSourceInfo()),
    templates: sanitizePublicPayload(ImageTemplateService.getTemplates())
  });
});

router.post('/generate/video', auth, async (req, res) => {
  try {
    const { prompt, params } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: '请输入视频描述' });
    }

    const videoParams = params && typeof params === 'object' ? params : {};
    const estimatedVideoCost = AiService.estimateVideoCredits(videoParams);
    const estimatedVideoBilling = User.buildCreditBilling(estimatedVideoCost.totalCredits, req.userId);
    if (!User.checkQuota(req.userId, 'video', estimatedVideoBilling.chargedCredits)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: User.creditBillingQuotaMessage('当前通用额度不足，本次视频生成', estimatedVideoBilling)
      });
    }

    const result = await AiService.generateVideo({
      userId: req.userId,
      prompt,
      params: videoParams
    });

    res.json({
      message: '视频生成成功',
      task: formatTask(result.task, { userId: req.userId }),
      data: sanitizePublicVideoGenerationResult(result.result)
    });
  } catch (error) {
    console.error('视频生成错误:', formatSafeError(error));
    res.status(500).json({ error: publicVideoTaskErrorMessage({ status: 'failed', errorMessage: error.message }) });
  }
});

router.get('/reference-image', async (req, res) => {
  try {
    const imageUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';

    if (!/^https?:\/\//i.test(imageUrl)) {
      return res.status(400).json({ error: '无效的参考图地址' });
    }

    const asset = await AiService.resolveReferenceImageAsset({
      src: imageUrl,
      label: 'reference-image'
    });

    if (!asset) {
      return res.status(404).json({ error: '参考图不可用' });
    }

    res.setHeader('Content-Type', asset.mimeType || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(asset.buffer);
  } catch (error) {
    console.error('参考图代理错误:', error.message);
    res.status(502).json({ error: '参考图加载失败' });
  }
});

router.get('/image-download', auth, async (req, res) => {
  try {
    const imageUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    const filename = buildImageDownloadFilename(req.query.filename, imageUrl);

    if (!imageUrl) {
      return res.status(400).json({ error: '缺少图片地址' });
    }

    if (imageUrl.startsWith('/uploads/')) {
      return streamLocalImageDownload({ imageUrl, filename, res });
    }

    if (!/^https?:\/\//i.test(imageUrl)) {
      return res.status(400).json({ error: '无效的图片地址' });
    }

    return await streamRemoteImageDownload({ imageUrl, filename, res });
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    console.error('图片下载错误:', error.message || error);
    res.status(502).json({ error: '图片文件暂时无法下载，请稍后再试' });
  }
});

router.get('/tasks', auth, (req, res) => {
  try {
    const { type, status, limit, offset } = req.query;
    const safeLimit = clampInteger(limit, 20, 1, 100);
    const safeOffset = clampInteger(offset, 0, 0, 100000);

    const tasks = AiTask.findByUserId(req.userId, {
      type,
      status,
      limit: safeLimit,
      offset: safeOffset
    });

    const formattedTasks = tasks.map(task => formatTask(task, { userId: req.userId }));

    res.json({ tasks: formattedTasks });
  } catch (error) {
    console.error('获取任务列表错误:', error);
    res.status(500).json({ error: '获取任务列表失败' });
  }
});

router.get('/tasks/:id(\\d+)', auth, (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    res.json({ task: formatTask(task, { userId: req.userId }) });
  } catch (error) {
    console.error('获取任务详情错误:', error);
    res.status(500).json({ error: '获取任务详情失败' });
  }
});

router.delete('/tasks/:id(\\d+)', auth, (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    if (task.status === 'processing' || task.status === 'pending') {
      return res.status(409).json({ error: '任务正在生成中，暂时不能删除' });
    }

    const deleted = ProjectStorageService.deleteTaskForUser(task.id, req.userId);
    if (!deleted) {
      return res.status(404).json({ error: '任务不存在' });
    }

    res.json({
      message: '任务已删除',
      deleted: {
        id: deleted.task.id,
        type: deleted.task.type,
        removed_files: deleted.cleanup.removed,
        skipped_files: deleted.cleanup.skipped,
        removed_bytes: deleted.cleanup.removed_bytes
      }
    });
  } catch (error) {
    console.error('删除任务错误:', error);
    res.status(500).json({ error: '删除任务失败: ' + error.message });
  }
});

router.patch('/tasks/:id(\\d+)', auth, (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const title = sanitizeProjectTitle(req.body?.title);
    if (!title) {
      return res.status(400).json({ error: '项目名不能为空' });
    }

    const updated = AiTask.renameForUser(task.id, req.userId, title);
    if (!updated) {
      return res.status(400).json({ error: '项目名更新失败' });
    }

    res.json({
      message: '项目名已更新',
      task: formatTask(updated, { userId: req.userId })
    });
  } catch (error) {
    console.error('更新任务项目名错误:', error);
    res.status(500).json({ error: '更新项目名失败: ' + error.message });
  }
});

router.post('/tasks/:id(\\d+)/ppt-edit', auth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能修改 PPT 任务' });
    }

    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) {
      return res.status(400).json({ error: '请输入要修改的内容' });
    }

    const editBilling = User.buildCreditBilling(1, req.userId);
    if (!User.checkQuota(req.userId, 'ppt', editBilling.chargedCredits)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: User.creditBillingQuotaMessage('当前通用额度不足，本次PPT修改', editBilling)
      });
    }

    const result = await PptEditService.editTask({
      task,
      instruction,
      pageIndex: req.body?.pageIndex
    });

    User.updateQuota(req.userId, 'ppt', editBilling.chargedCredits, {
      note: `PPT对话修改${User.creditBillingNoteSuffix(editBilling)}`
    });

    const updated = AiTask.updateStatus(task.id, 'completed', {
      result_url: result.resultData.download_url,
      result_data: {
        ...result.resultData,
        edit_billing: User.creditBillingMetadata(editBilling)
      }
    });
    StorageLimitService.enforceForUser(req.userId);

    res.json({
      message: result.message,
      task: formatTask(updated, { userId: req.userId }),
      pages: result.pages
    });
  } catch (error) {
    console.error('PPT 编辑失败:', error);
    res.status(500).json({ error: 'PPT 编辑失败: ' + error.message });
  }
});

router.post('/tasks/:id(\\d+)/ppt-edit/propose', auth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能修改 PPT 任务' });
    }

    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) {
      return res.status(400).json({ error: '请输入要修改的内容' });
    }

    const proposal = await PptEditService.createProposal({
      task,
      instruction,
      pageIndex: req.body?.pageIndex,
      baseProposalId: req.body?.baseProposalId
    });

    res.json({
      message: proposal.summary || '已生成修改提案',
      proposal
    });
  } catch (error) {
    console.error('PPT 修改提案失败:', error);
    res.status(500).json({ error: 'PPT 修改提案失败: ' + error.message });
  }
});

router.post('/tasks/:id(\\d+)/ppt-edit/apply', auth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能修改 PPT 任务' });
    }

    const proposalId = String(req.body?.proposalId || '').trim();
    if (!proposalId) {
      return res.status(400).json({ error: '缺少修改提案' });
    }

    const editBilling = User.buildCreditBilling(1, req.userId);
    if (!User.checkQuota(req.userId, 'ppt', editBilling.chargedCredits)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: User.creditBillingQuotaMessage('当前通用额度不足，本次PPT修改', editBilling)
      });
    }

    const result = await PptEditService.applyProposal({
      task,
      proposalId
    });

    User.updateQuota(req.userId, 'ppt', editBilling.chargedCredits, {
      note: `PPT对话修改${User.creditBillingNoteSuffix(editBilling)}`
    });

    const updated = AiTask.updateStatus(task.id, 'completed', {
      result_url: result.resultData.download_url,
      result_data: {
        ...result.resultData,
        edit_billing: User.creditBillingMetadata(editBilling)
      }
    });
    StorageLimitService.enforceForUser(req.userId);

    res.json({
      message: result.message,
      task: formatTask(updated, { userId: req.userId }),
      pages: result.pages
    });
  } catch (error) {
    console.error('PPT 应用修改失败:', error);
    res.status(500).json({ error: 'PPT 应用修改失败: ' + error.message });
  }
});

router.post('/tasks/:id(\\d+)/ppt-copilot/message', auth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能处理 PPT 任务' });
    }

    const message = String(req.body?.message || req.body?.content || req.body?.instruction || '').trim();
    if (!message) {
      return res.status(400).json({ error: '请输入消息内容' });
    }

    const result = await PptCopilotAgentService.handleMessage({
      task,
      userId: req.userId,
      message,
      pageIndex: req.body?.pageIndex,
      sessionId: req.body?.sessionId || req.body?.session_id,
      session: req.body?.session,
      context: req.body?.context,
      proposalId: req.body?.proposalId || req.body?.proposal_id,
      baseProposalId: req.body?.baseProposalId || req.body?.base_proposal_id,
      autoCreateProposal: req.body?.autoCreateProposal !== false && req.body?.createProposal !== false,
      beforeApplyProposal: async () => {
        const editBilling = User.buildCreditBilling(1, req.userId);
        if (!User.checkQuota(req.userId, 'ppt', editBilling.chargedCredits)) {
          const message = User.creditBillingQuotaMessage('当前通用额度不足，本次PPT修改', editBilling);
          const error = new Error(message);
          error.statusCode = 403;
          error.responsePayload = {
            error: '通用额度不足',
            message
          };
          throw error;
        }
        return editBilling;
      },
      afterApplyProposal: async ({ applyResult, billingContext }) => {
        const editBilling = billingContext || User.buildCreditBilling(1, req.userId);
        User.updateQuota(req.userId, 'ppt', editBilling.chargedCredits, {
          note: `PPT对话修改${User.creditBillingNoteSuffix(editBilling)}`
        });

        const updated = AiTask.updateStatus(task.id, 'completed', {
          result_url: applyResult.resultData.download_url,
          result_data: {
            ...applyResult.resultData,
            edit_billing: User.creditBillingMetadata(editBilling)
          }
        });
        StorageLimitService.enforceForUser(req.userId);
        return formatTask(updated, { userId: req.userId });
      }
    });

    delete result.apply_result;
    delete result._streamed_text;
    res.json(sanitizePublicPayload(result));
  } catch (error) {
    console.error('PPT Copilot 消息处理失败:', error);
    res.status(error.statusCode || 500).json(error.responsePayload || {
      error: 'PPT助手乐米消息处理失败: ' + error.message
    });
  }
});

router.get('/tasks/:id(\\d+)/ppt-copilot/checkpoints', auth, (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能处理 PPT 任务' });
    }

    const snapshot = PptCopilotAgentService.createWorkspaceSnapshot(task);
    const checkpoints = PptCopilotAgentService.listCheckpoints(
      snapshot.projectPath,
      req.query?.sessionId || req.query?.session_id || ''
    );

    res.json(sanitizePublicPayload({
      checkpoints,
      latest: checkpoints[0] || null
    }));
  } catch (error) {
    console.error('获取 PPT Copilot 检查点失败:', error);
    res.status(500).json({ error: '获取检查点失败: ' + error.message });
  }
});

router.post('/tasks/:id(\\d+)/ppt-copilot/restore', auth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能处理 PPT 任务' });
    }

    const result = await PptCopilotAgentService.restoreCheckpoint({
      task,
      checkpointId: req.body?.checkpointId || req.body?.checkpoint_id,
      sessionId: req.body?.sessionId || req.body?.session_id || ''
    });

    const updated = AiTask.updateStatus(task.id, 'completed', {
      result_url: result.resultData.download_url,
      result_data: result.resultData
    });
    StorageLimitService.enforceForUser(req.userId);

    res.json(sanitizePublicPayload({
      message: result.message,
      task: formatTask(updated, { userId: req.userId }),
      checkpoint: result.checkpoint,
      redo_checkpoint: result.redo_checkpoint
    }));
  } catch (error) {
    console.error('PPT Copilot 回退失败:', error);
    res.status(500).json({ error: 'PPT助手乐米回退失败: ' + error.message });
  }
});

router.post('/tasks/:id(\\d+)/ppt-copilot/message/stream', auth, async (req, res) => {
  let stream = null;
  let heartbeatTimer = null;
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (task.type !== 'ppt') {
      return res.status(400).json({ error: '只能处理 PPT 任务' });
    }

    const message = String(req.body?.message || req.body?.content || req.body?.instruction || '').trim();
    if (!message) {
      return res.status(400).json({ error: '请输入消息内容' });
    }

    stream = createSseSession(req, res);
    stream.write('start', {
      status: 'connected',
      phase: 'connected',
      title: '已连接 PPT助手乐米',
      treeTitle: '准备读取工作区',
      message: '正在建立流式回复通道'
    });
    stream.write('tool', {
      type: 'workspace_snapshot',
      label: '读取 PPT 工作区快照',
      status: 'running',
      detail: '检查当前页、附件和可编辑文件'
    });
    stream.write('phase', {
      phase: req.body?.action === 'apply_proposal' ? 'apply_proposal' : 'analyze_message',
      title: req.body?.action === 'apply_proposal' ? '正在应用修改提案' : '正在分析修改请求',
      treeTitle: req.body?.action === 'apply_proposal' ? '写入 PPT 页面' : '读取当前 PPT 上下文',
      message: req.body?.action === 'apply_proposal' ? '将已确认的提案写入文件并重新导出' : '结合当前页、附件和历史提案判断下一步'
    });

    heartbeatTimer = setInterval(() => {
      stream.write('heartbeat', {
        status: 'processing',
        title: 'PPT助手乐米正在处理',
        message: '任务仍在运行，流式连接保持中'
      });
    }, 4500);

    const result = await PptCopilotAgentService.handleMessage({
      task,
      userId: req.userId,
      message,
      pageIndex: req.body?.pageIndex,
      sessionId: req.body?.sessionId || req.body?.session_id,
      session: req.body?.session,
      context: req.body?.context,
      proposalId: req.body?.proposalId || req.body?.proposal_id,
      baseProposalId: req.body?.baseProposalId || req.body?.base_proposal_id,
      autoCreateProposal: req.body?.autoCreateProposal !== false && req.body?.createProposal !== false,
      onAction: action => stream.write('tool', action),
      onPhase: phase => stream.write('phase', phase),
      onDelta: text => stream.write('delta', { text }),
      beforeApplyProposal: async () => {
        const editBilling = User.buildCreditBilling(1, req.userId);
        if (!User.checkQuota(req.userId, 'ppt', editBilling.chargedCredits)) {
          const message = User.creditBillingQuotaMessage('当前通用额度不足，本次PPT修改', editBilling);
          const error = new Error(message);
          error.statusCode = 403;
          error.responsePayload = {
            error: '通用额度不足',
            message
          };
          throw error;
        }
        return editBilling;
      },
      afterApplyProposal: async ({ applyResult, billingContext }) => {
        const editBilling = billingContext || User.buildCreditBilling(1, req.userId);
        User.updateQuota(req.userId, 'ppt', editBilling.chargedCredits, {
          note: `PPT对话修改${User.creditBillingNoteSuffix(editBilling)}`
        });

        const updated = AiTask.updateStatus(task.id, 'completed', {
          result_url: applyResult.resultData.download_url,
          result_data: {
            ...applyResult.resultData,
            edit_billing: User.creditBillingMetadata(editBilling)
          }
        });
        StorageLimitService.enforceForUser(req.userId);
        return formatTask(updated, { userId: req.userId });
      }
    });

    delete result.apply_result;
    const publicResult = sanitizePublicPayload(result);
    const actions = Array.isArray(publicResult.actions) ? publicResult.actions : [];
    if (!publicResult._streamed_text) {
      for (const action of actions) {
        stream.write('tool', action);
      }
    }

    if (!publicResult._streamed_text) {
      stream.write('phase', {
        phase: 'responding',
        title: '正在整理回复',
        treeTitle: publicResult.proposal ? '生成提案说明' : '生成答复',
        message: publicResult.proposal ? '修改预览已准备，正在输出说明' : '根据处理结果输出回复'
      });
      await streamTextDeltas(stream, pptCopilotResponseToStreamText(publicResult));
    }

    if (publicResult.proposal) {
      stream.write('proposal', publicResult.proposal);
    }
    if (publicResult.task) {
      stream.write('task', publicResult.task);
    }
    delete publicResult._streamed_text;
    stream.write('done', publicResult);
  } catch (error) {
    console.error('PPT Copilot 流式消息处理失败:', error);
    if (!stream) {
      return res.status(error.statusCode || 500).json(error.responsePayload || {
        error: 'PPT助手乐米消息处理失败: ' + error.message
      });
    }
    stream.write('error', error.responsePayload || {
      error: 'PPT助手乐米消息处理失败',
      message: error.message || '未知错误',
      statusCode: error.statusCode || 500
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (stream) stream.end();
  }
});

router.post('/tasks/:id(\\d+)/video-download-token', auth, (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    const videoUrl = getTaskVideoUrl(task);

    if (!task || task.type !== 'video') {
      return res.status(404).json({ error: '视频任务不存在' });
    }
    if (task.status !== 'completed' || !videoUrl) {
      return res.status(409).json({ error: '视频尚未生成完成' });
    }

    const disposition = req.body?.disposition === 'inline' ? 'inline' : 'attachment';
    res.json({
      expires_in: 600,
      download_url: createVideoDownloadUrl({
        taskId: task.id,
        userId: req.userId,
        disposition
      })
    });
  } catch (error) {
    console.error('创建视频下载令牌错误:', error);
    res.status(500).json({ error: '创建下载链接失败' });
  }
});

function createVideoDownloadUrl({ taskId, userId, disposition = 'attachment' } = {}) {
  const token = jwt.sign(
    {
      purpose: 'video_download',
      userId,
      taskId: Number(taskId)
    },
    appConfig.jwtSecret(),
    { expiresIn: '10m' }
  );
  const safeDisposition = disposition === 'inline' ? 'inline' : 'attachment';
  return `/api/ai/tasks/${encodeURIComponent(taskId)}/video-download?token=${encodeURIComponent(token)}&disposition=${encodeURIComponent(safeDisposition)}`;
}

router.post('/tasks/:id(\\d+)/video-recover', auth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);

    if (!task || task.type !== 'video') {
      return res.status(404).json({ error: '视频任务不存在' });
    }
    if (task.status !== 'completed') {
      return res.status(409).json({ error: '视频尚未生成完成' });
    }

    const localUrl = await AiService.recoverVideoTaskLocalUrl(task, {
      refreshExpired: true,
      updateProgress: false
    });
    const updated = AiTask.findByIdForUser(req.params.id, req.userId) || task;

    res.json({
      message: '视频已准备好',
      url: localUrl,
      task: formatTask(updated, { userId: req.userId })
    });
  } catch (error) {
    console.warn('视频取回失败:', error.message || error);
    const status = error.response?.status || error.statusCode || 0;
    const isExpired = [403, 404, 410].includes(Number(status));
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    if (isExpired && task && task.type === 'video') {
      markVideoPlaybackUnavailable(task, publicVideoUnavailableMessage());
    }
    res.status(isExpired ? 410 : 502).json({
      error: isExpired
        ? publicVideoUnavailableMessage()
        : '视频文件暂时无法准备，请稍后再试'
    });
  }
});

router.get('/tasks/:id(\\d+)/video-download', resolveVideoDownloadAuth, async (req, res) => {
  try {
    const task = AiTask.findByIdForUser(req.params.id, req.userId);
    const videoUrl = getTaskVideoUrl(task);

    if (!task || task.type !== 'video') {
      return res.status(404).json({ error: '视频任务不存在' });
    }
    if (task.status !== 'completed' || !videoUrl) {
      return res.status(409).json({ error: '视频尚未生成完成' });
    }

    const filename = buildVideoDownloadFilename(task, videoUrl);
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';

    if (videoUrl.startsWith('/uploads/')) {
      if (AiService.localUploadUrlExists(videoUrl)) {
        return streamLocalVideoDownload({ videoUrl, filename, disposition, req, res });
      }
      const recoveredVideoUrl = await cacheRemoteVideoBeforeDownload(task, videoUrl).catch(error => {
        console.warn(`视频 ${task.id} 本地文件丢失，取回失败:`, error.message);
        return '';
      });
      if (recoveredVideoUrl) {
        return streamLocalVideoDownload({ videoUrl: recoveredVideoUrl, filename: buildVideoDownloadFilename(task, recoveredVideoUrl), disposition, req, res });
      }
      markVideoPlaybackUnavailable(task, publicVideoUnavailableMessage());
      return res.status(410).json({ error: publicVideoUnavailableMessage() });
    }

    const cachedVideoUrl = await cacheRemoteVideoBeforeDownload(task, videoUrl).catch(error => {
      console.warn(`视频 ${task.id} 本地缓存失败，尝试直接代理远程链接:`, error.message);
      return '';
    });
    if (cachedVideoUrl) {
      return streamLocalVideoDownload({ videoUrl: cachedVideoUrl, filename: buildVideoDownloadFilename(task, cachedVideoUrl), disposition, req, res });
    }

    return await streamRemoteVideoDownload({ videoUrl, filename, disposition, req, res });
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    console.error('视频下载错误:', error.message || error);
    const status = error.response?.status || error.statusCode || 502;
    const message = status === 403 || status === 404 || status === 410
      ? publicVideoUnavailableMessage()
      : '视频文件暂时无法下载，请稍后再试';
    res.status(status === 403 || status === 404 ? 410 : status).json({ error: message });
  }
});

function clampInteger(value, fallback, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function resolveVideoDownloadAuth(req, res, next) {
  try {
    const taskId = Number(req.params.id);
    const token = String(req.query.token || '').trim();
    if (token) {
      const decoded = jwt.verify(token, appConfig.jwtSecret());
      if (
        decoded?.purpose !== 'video_download' ||
        Number(decoded.taskId) !== taskId ||
        !Number(decoded.userId)
      ) {
        return res.status(401).json({ error: '下载链接无效' });
      }
      const user = User.refreshVipStatus(decoded.userId);
      if (!user) {
        return res.status(401).json({ error: '用户不存在' });
      }
      req.user = user;
      req.userId = user.id;
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未授权，请先登录' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], appConfig.jwtSecret());
    const user = User.refreshVipStatus(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }
    req.user = user;
    req.userId = user.id;
    return next();
  } catch (error) {
    return res.status(401).json({ error: '下载链接已过期，请重新点击保存' });
  }
}

function getTaskVideoUrl(task) {
  if (!task) return '';
  const resultData = safeParseJson(task.result_data, {}) || {};
  const existingLocalUrl = AiService.findExistingLocalVideoUrlForTask(task, resultData);
  if (existingLocalUrl) return existingLocalUrl;

  const storedUrl = AiService.getTaskStoredVideoUrl(task, resultData);
  if (AiService.isLocalUploadUrl(storedUrl) && !AiService.localUploadUrlExists(storedUrl)) {
    return AiService.getTaskRemoteVideoUrl(task, resultData) || storedUrl;
  }
  return storedUrl;
}

async function cacheRemoteVideoBeforeDownload(task, videoUrl) {
  if (!task) return '';
  const localUrl = await AiService.recoverVideoTaskLocalUrl(task, {
    remoteUrl: videoUrl,
    refreshExpired: true,
    updateProgress: false
  });
  return localUrl;
}

function buildVideoDownloadFilename(task, videoUrl) {
  const resultData = safeParseJson(task.result_data, {}) || {};
  const title = resultData.title || safeParseJson(task.params, {})?.title || task.prompt || 'ai-video';
  const safeBase = String(title || 'ai-video')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36) || 'ai-video';
  const ext = inferVideoExtension(videoUrl) || '.mp4';
  return `${safeBase}-${task.id}${ext}`;
}

function inferVideoExtension(videoUrl) {
  try {
    const parsed = videoUrl.startsWith('/uploads/')
      ? { pathname: videoUrl }
      : new URL(videoUrl);
    const ext = path.extname(decodeURIComponent(parsed.pathname || '')).toLowerCase();
    if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return ext;
  } catch (error) {
    return '.mp4';
  }
  return '.mp4';
}

function inferVideoMimeType(filename, fallback = 'video/mp4') {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.m4v') return 'video/x-m4v';
  return fallback || 'video/mp4';
}

function contentDisposition(disposition, filename) {
  const asciiName = String(filename || 'ai-video.mp4')
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/["\\]/g, '_') || 'ai-video.mp4';
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename || asciiName)}`;
}

function streamLocalVideoDownload({ videoUrl, filename, disposition, req, res }) {
  const filePath = appConfig.uploadUrlToPath(videoUrl);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '视频文件暂时无法下载，请稍后再试' });
  }

  const stat = fs.statSync(filePath);
  const range = parseRangeHeader(req.headers.range, stat.size);
  const headers = {
    'Content-Type': inferVideoMimeType(filename),
    'Content-Disposition': contentDisposition(disposition, filename),
    'Cache-Control': 'private, max-age=300',
    'Accept-Ranges': 'bytes'
  };

  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    return fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  return fs.createReadStream(filePath).pipe(res);
}

async function streamRemoteVideoDownload({ videoUrl, filename, disposition, req, res }) {
  const safeUrl = await assertSafeRemoteUrl(videoUrl);
  const response = await axios.get(safeUrl.toString(), {
    ...safeAxiosOptions(),
    responseType: 'stream',
    timeout: 45000,
    maxRedirects: 3,
    validateStatus: status => (status >= 200 && status < 300) || status === 206,
    headers: {
      Accept: 'video/mp4,video/*,*/*;q=0.8',
      ...(req.headers.range ? { Range: req.headers.range } : {})
    }
  });

  const statusCode = response.status === 206 ? 206 : 200;
  const contentType = String(response.headers['content-type'] || '').split(';')[0] || inferVideoMimeType(filename);
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(disposition, filename),
    'Cache-Control': 'private, max-age=300',
    'Accept-Ranges': response.headers['accept-ranges'] || 'bytes'
  };
  if (response.headers['content-length']) headers['Content-Length'] = response.headers['content-length'];
  if (response.headers['content-range']) headers['Content-Range'] = response.headers['content-range'];

  res.writeHead(statusCode, headers);
  response.data.on('error', error => {
    if (!res.destroyed) res.destroy(error);
  });
  response.data.pipe(res);
}

function buildImageDownloadFilename(rawFilename, imageUrl) {
  const ext = inferImageExtension(imageUrl);
  const rawBase = String(rawFilename || '').replace(path.extname(String(rawFilename || '')), '');
  const safeBase = (rawBase || 'ai-image')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36) || 'ai-image';
  return `${safeBase}${ext}`;
}

function inferImageExtension(imageUrl) {
  try {
    const parsed = imageUrl.startsWith('/uploads/')
      ? { pathname: imageUrl }
      : new URL(imageUrl);
    const ext = path.extname(decodeURIComponent(parsed.pathname || '')).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif'].includes(ext)) return ext;
  } catch (error) {
    return '.png';
  }
  return '.png';
}

function inferImageMimeType(filename, fallback = 'image/png') {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return fallback || 'image/png';
}

function streamLocalImageDownload({ imageUrl, filename, res }) {
  const filePath = appConfig.uploadUrlToPath(imageUrl);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '图片文件已丢失' });
  }

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': inferImageMimeType(filename),
    'Content-Disposition': contentDisposition('attachment', filename),
    'Cache-Control': 'private, max-age=300',
    'Content-Length': stat.size
  });
  return fs.createReadStream(filePath).pipe(res);
}

async function streamRemoteImageDownload({ imageUrl, filename, res }) {
  const safeUrl = await assertSafeRemoteUrl(imageUrl);
  const response = await axios.get(safeUrl.toString(), {
    ...safeAxiosOptions(),
    responseType: 'stream',
    timeout: 45000,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 300,
    headers: {
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8'
    }
  });

  const contentType = String(response.headers['content-type'] || '').split(';')[0] || inferImageMimeType(filename);
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition('attachment', filename),
    'Cache-Control': 'private, max-age=300'
  };
  if (response.headers['content-length']) headers['Content-Length'] = response.headers['content-length'];
  res.writeHead(200, headers);
  response.data.on('error', error => {
    if (!res.destroyed) res.destroy(error);
  });
  response.data.pipe(res);
}

function parseRangeHeader(rangeHeader, size) {
  const raw = String(rangeHeader || '').trim();
  if (!raw || !raw.startsWith('bytes=')) return null;
  const match = raw.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    const suffixLength = Math.max(end || 0, 0);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end };
}

function safeParseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string' && /^[\[{]/.test(parsed.trim())) {
      try {
        return JSON.parse(parsed);
      } catch (error) {
        return parsed;
      }
    }
    return parsed;
  } catch (error) {
    return fallback;
  }
}

function sanitizeProjectTitle(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function prepareVideoTaskForPublicResponse(task, rawResultData = {}) {
  if (!task || task.type !== 'video' || task.status !== 'completed') return task;

  const resultData = rawResultData || {};
  const existingLocalUrl = AiService.findExistingLocalVideoUrlForTask(task, resultData);
  if (existingLocalUrl) {
    return AiService.updateVideoTaskLocalStorage(task, existingLocalUrl, {
      resultData,
      originalUrl: AiService.getTaskRemoteVideoUrl(task, resultData),
      recovered: false
    }) || task;
  }

  const storedUrl = AiService.getTaskStoredVideoUrl(task, resultData);
  if (!AiService.isLocalUploadUrl(storedUrl)) return task;

  const remoteUrl = AiService.getTaskRemoteVideoUrl(task, resultData);
  const nextResultData = {
    ...resultData,
    status: resultData.status || 'completed',
    stage: remoteUrl ? 'needs_preparation' : 'unavailable',
    progress: 100,
    playback_state: remoteUrl ? 'needs_preparation' : 'unavailable',
    playback_message: remoteUrl ? '视频文件需要重新准备，点开后会自动处理。' : publicVideoUnavailableMessage(),
    url: remoteUrl || '',
    video_url: remoteUrl || '',
    videoUrl: remoteUrl || '',
    storage: {
      ...(resultData.storage || {}),
      persisted: Boolean(resultData.storage?.persisted),
      unavailable: !remoteUrl,
      warning: remoteUrl ? '' : publicVideoUnavailableMessage()
    }
  };

  delete nextResultData.storage.local_url;
  if (remoteUrl) {
    delete nextResultData.storage.warning;
  }

  return {
    ...task,
    result_url: remoteUrl || '',
    result_data: nextResultData
  };
}

function formatTask(task, options = {}) {
  if (!task) return null;
  let taskForResponse = task;
  const rawResultData = safeParseJson(task.result_data, null);
  if (task.type === 'video' && task.status === 'completed') {
    taskForResponse = prepareVideoTaskForPublicResponse(task, rawResultData || {});
  }

  const resultData = sanitizeTaskResultData(safeParseJson(taskForResponse.result_data, null), taskForResponse.type);
  const publicError = taskForResponse.type === 'video'
    ? publicVideoTaskErrorMessage({
      status: taskForResponse.status,
      errorMessage: taskForResponse.error_message,
      resultData
    })
    : publicImageTaskErrorMessage({
    type: taskForResponse.type,
    status: taskForResponse.status,
    errorMessage: taskForResponse.error_message,
    resultData
  });

  const formatted = {
    id: taskForResponse.id,
    type: taskForResponse.type,
    status: taskForResponse.status,
    prompt: sanitizePublicText(String(taskForResponse.prompt || ''), RuntimeConfigService.getRuntimeConfig()),
    params: sanitizeTaskParams(safeParseJson(taskForResponse.params, {}), taskForResponse.type),
    title: sanitizePublicText(String(resultData?.title || safeParseJson(taskForResponse.params, {})?.title || ''), RuntimeConfigService.getRuntimeConfig()),
    result_url: signPublicUploadUrl(taskForResponse.result_url),
    result_data: resultData,
    error_message: sanitizePublicText(publicError, RuntimeConfigService.getRuntimeConfig()),
    created_at: taskForResponse.created_at,
    completed_at: taskForResponse.completed_at
  };

  if (taskForResponse.type === 'video' && taskForResponse.status === 'completed' && options.userId) {
    const videoUrl = getTaskVideoUrl(taskForResponse);
    if (videoUrl) {
      formatted.video_playback_url = createVideoDownloadUrl({
        taskId: taskForResponse.id,
        userId: options.userId,
        disposition: 'inline'
      });
    }
  }

  return formatted;
}

function sanitizeTaskParams(params, taskType = '') {
  if (!params || typeof params !== 'object') return params;
  const sanitized = Array.isArray(params) ? params.slice() : { ...params };
  if (taskType === 'video') {
    [
      'model',
      'model_name',
      'provider',
      'provider_task_id',
      'task_id',
      'taskId',
      'external_task_id',
      'externalTaskId',
      'raw_status',
      'rawStatus',
      'task_status',
      'taskStatus'
    ].forEach(key => {
      delete sanitized[key];
    });
  }
  return sanitizePublicPayload(sanitized);
}

function sanitizePublicVideoGenerationResult(result) {
  if (!result || typeof result !== 'object') return sanitizePublicPayload(result);
  const sanitized = { ...result };
  [
    'task_id',
    'taskId',
    'provider_task_id',
    'providerTaskId',
    'external_task_id',
    'externalTaskId',
    'model',
    'model_name',
    'provider',
    'raw_status',
    'rawStatus',
    'task_status',
    'taskStatus'
  ].forEach(key => {
    delete sanitized[key];
  });
  return sanitizePublicPayload(sanitized);
}

function signPublicUploadUrl(value) {
  if (!value || !appConfig.signedUploadsEnabled || typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('/uploads/')) return value;
  return appConfig.signUploadUrl(text, { ttlSeconds: 3600 });
}

function signPublicUploadUrls(value) {
  if (!appConfig.signedUploadsEnabled) return value;
  if (typeof value === 'string') return signPublicUploadUrl(value);
  if (Array.isArray(value)) return value.map(signPublicUploadUrls);
  if (!value || typeof value !== 'object') return value;

  const next = { ...value };
  [
    'url',
    'result_url',
    'download_url',
    'pptx_url',
    'preview_url',
    'previewUrl',
    'thumbnail_url',
    'thumbnailUrl',
    'data_url',
    'dataUrl',
    'output_url',
    'project_dir',
    'workflow_state_url',
    'original_image',
    'normalized_url',
    'local_url',
    'normalizedUrl',
    'source_url',
    'sourceUrl'
  ].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = signPublicUploadUrls(next[key]);
    }
  });
  if (Array.isArray(next.images)) next.images = next.images.map(signPublicUploadUrls);
  if (Array.isArray(next.image_assets)) next.image_assets = next.image_assets.map(signPublicUploadUrls);
  if (Array.isArray(next.live_image_assets)) next.live_image_assets = next.live_image_assets.map(signPublicUploadUrls);
  if (Array.isArray(next.preview_svgs)) next.preview_svgs = next.preview_svgs.map(signPublicUploadUrls);
  if (Array.isArray(next.preview_urls)) next.preview_urls = next.preview_urls.map(signPublicUploadUrls);
  if (Array.isArray(next.files)) next.files = next.files.map(signPublicUploadUrls);
  return next;
}

function markVideoPlaybackUnavailable(task, message) {
  if (!task || task.type !== 'video') return null;
  const resultData = safeParseJson(task.result_data, {}) || {};
  return AiTask.update(task.id, {
    result_data: {
      ...resultData,
      playback_state: 'unavailable',
      playback_message: message,
      storage: {
        ...(resultData.storage || {}),
        persisted: Boolean(resultData.storage?.persisted),
        unavailable: true,
        unavailable_at: new Date().toISOString(),
        warning: message
      }
    }
  });
}

function sanitizeTaskResultData(resultData, taskType = '') {
  if (!resultData || typeof resultData !== 'object') return resultData;
  const runtimeConfig = RuntimeConfigService.getRuntimeConfig();

  const sanitized = Array.isArray(resultData) ? resultData.slice() : { ...resultData };
  delete sanitized.internal_error;
  delete sanitized.internal_last_error;
  delete sanitized.provider_error;
  delete sanitized.raw_error;
  delete sanitized.model;
  delete sanitized.provider;
  delete sanitized.image_provider;
  delete sanitized._image_provider;
  delete sanitized.agent_stack;

  if (taskType === 'video') {
    sanitizeVideoTaskResultData(sanitized);
  }

  if (Array.isArray(sanitized.images)) {
    sanitized.images = sanitized.images.map(sanitizeImageResultItem);
  }

  if (typeof sanitized.original_prompt === 'string' && !sanitized.public_prompt) {
    sanitized.public_prompt = sanitized.original_prompt;
  }
  if (typeof sanitized.public_prompt === 'string') {
    sanitized.prompt = sanitized.public_prompt;
  }
  delete sanitized.public_prompt;
  delete sanitized.original_prompt;

  if (sanitized.status === 'failed' || sanitized.stage === 'error') {
    const message = taskType === 'video'
      ? publicVideoTaskErrorMessage({
        status: 'failed',
        errorMessage: sanitized.message || sanitized.error || sanitized.last_error,
        resultData: sanitized
      })
      : publicImageTaskErrorMessage({
        type: taskType || 'image',
        status: 'failed',
        errorMessage: sanitized.message || sanitized.error || sanitized.last_error,
        resultData: sanitized
      });
    sanitized.message = message;
    sanitized.error = message;
    sanitized.last_error = message;
  } else if (taskType === 'video' && isPublicVideoProcessingState(sanitized)) {
    sanitized.message = publicVideoProcessingMessage(sanitized);
  } else if (taskType === 'video' && sanitized.playback_state === 'unavailable') {
    sanitized.message = publicVideoUnavailableMessage();
    sanitized.playback_message = publicVideoUnavailableMessage();
  }

  return signPublicUploadUrls(sanitizePublicPayload(sanitized, runtimeConfig));
}

function sanitizeVideoTaskResultData(resultData) {
  [
    'task_id',
    'taskId',
    'provider_task_id',
    'providerTaskId',
    'external_task_id',
    'externalTaskId',
    'task_status',
    'taskStatus',
    'raw_status',
    'rawStatus',
    'original_url',
    'originalUrl',
    'remote_url',
    'remoteUrl',
    'source_url',
    'sourceUrl',
    'raw_payload',
    'rawPayload',
    'raw_response',
    'rawResponse',
    'last_payload',
    'lastPayload'
  ].forEach(key => {
    delete resultData[key];
  });

  if (resultData.storage && typeof resultData.storage === 'object' && !Array.isArray(resultData.storage)) {
    resultData.storage = { ...resultData.storage };
    [
      'original_url',
      'originalUrl',
      'remote_url',
      'remoteUrl',
      'source_url',
      'sourceUrl',
      'warning'
    ].forEach(key => {
      delete resultData.storage[key];
    });
  }

  if (resultData.audio && typeof resultData.audio === 'object' && !Array.isArray(resultData.audio)) {
    resultData.audio = { ...resultData.audio };
    [
      'source_url',
      'sourceUrl',
      'original_source_url',
      'originalSourceUrl',
      'remote_url',
      'remoteUrl'
    ].forEach(key => {
      delete resultData.audio[key];
    });
  }

  if (resultData.playback_state === 'unavailable') {
    resultData.playback_message = publicVideoUnavailableMessage();
    if (resultData.storage && typeof resultData.storage === 'object' && !Array.isArray(resultData.storage)) {
      resultData.storage.warning = publicVideoUnavailableMessage();
    }
  }
}

function isPublicVideoProcessingState(resultData = {}) {
  const status = String(resultData.status || '').toLowerCase();
  const stage = String(resultData.stage || '').toLowerCase();
  return ['pending', 'processing', 'queued', 'recovering'].includes(status)
    || [
      'queued',
      'submitted',
      'polling',
      'video_persisting',
      'recovering',
      'audio_check',
      'audio_normalizing'
    ].includes(stage);
}

function publicVideoProcessingMessage(resultData = {}) {
  if (resultData.playback_state === 'recovering' || String(resultData.stage || '').toLowerCase() === 'recovering') {
    return '正在准备视频文件，请稍候。';
  }
  return '视频生成中，请耐心等待，完成后会自动放入图库。';
}

function publicVideoTaskErrorMessage({ status, errorMessage, resultData } = {}) {
  const hasFailure = status === 'failed'
    || resultData?.status === 'failed'
    || resultData?.stage === 'error'
    || Boolean(errorMessage);
  if (!hasFailure) return null;
  return AiService.publicVideoGenerationFailureMessage
    ? AiService.publicVideoGenerationFailureMessage()
    : '视频生成失败，请稍后再试或调整描述后重新生成。';
}

function publicVideoUnavailableMessage() {
  return '视频暂时不可用，请稍后再试。';
}

function sanitizeImageResultItem(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return image;

  const sanitized = { ...image };
  if (sanitized.url || sanitized.preview_url || sanitized.previewUrl || sanitized.thumbnail_url) {
    delete sanitized.data_url;
    delete sanitized.dataUrl;
  }
  return signPublicUploadUrls(sanitizePublicPayload(sanitized));
}

function sanitizePublicPayload(payload, runtimeConfig = RuntimeConfigService.getRuntimeConfig()) {
  return signPublicUploadUrls(sanitizePublicObject(payload, runtimeConfig, {
    keysToRemove: new Set(['model', 'provider', 'image_provider', '_image_provider', 'agent_stack'])
  }));
}

function publicImageTaskErrorMessage({ type, status, errorMessage, resultData } = {}) {
  if (type !== 'image' && !resultData?.failure_kind) {
    return errorMessage || null;
  }

  const failureKind = resultData?.failure_kind || '';
  if (failureKind === 'safety_policy') {
    return '图片内容未通过安全审核，本次未扣除站内额度。请调整描述或更换参考图后再试。';
  }
  if (failureKind === 'transient_quota_retry_exhausted') {
    return '乐米本次失误了，很抱歉。这次没有扣除点数，可以试试重新生成。';
  }
  if (failureKind === 'provider_quota') {
    return '图片服务额度暂时不足，本次未扣除站内额度。请稍后再试或联系管理员检查图片平台配置。';
  }

  const message = String(errorMessage || resultData?.message || resultData?.error || '');
  if (looksLikeTransientQuotaReservationMessage(message)) {
    return '乐米本次失误了，很抱歉。这次没有扣除点数，可以试试重新生成。';
  }
  if (looksLikeImageSafetyPolicyMessage(message)) {
    return '图片内容未通过安全审核，本次未扣除站内额度。请调整描述或更换参考图后再试。';
  }
  if (looksLikeProviderQuotaMessage(message)) {
    return '图片服务额度暂时不足，本次未扣除站内额度。请稍后再试或联系管理员检查图片平台配置。';
  }
  if (looksLikeInternalProviderMessage(message)) {
    return status === 'failed'
      ? '图片生成失败，本次未扣除站内额度。请稍后再试。'
      : '图片服务暂时不可用';
  }

  return message || (status === 'failed' ? '图片生成失败，本次未扣除站内额度。请稍后再试。' : null);
}

function looksLikeImageSafetyPolicyMessage(message = '') {
  return AiService.isImageSafetyPolicyText(message);
}

function looksLikeProviderQuotaMessage(message = '') {
  return AiService.isImageProviderQuotaText(message);
}

function looksLikeTransientQuotaReservationMessage(message = '') {
  return [
    'insufficient_user_quota',
    'pre_consume_token_quota_failed',
    '预扣费额度失败',
    '需要预扣费额度'
  ].some(token => String(message || '').toLowerCase().includes(String(token).toLowerCase()));
}

function looksLikeInternalProviderMessage(message = '') {
  const normalized = String(message || '').toLowerCase();
  return [
    'request id:',
    'http ',
    'error code',
    'api key',
    'authorization',
    'bearer ',
    'base_url',
    'baseurl',
    'llm api',
    '@context',
    '<html',
    '<!doctype',
    'traceback',
    'stack',
    'axioserror'
  ].some(token => normalized.includes(token));
}

function normalizeReferenceImagesPayload({ referenceImage, referenceImages }) {
  const rawItems = Array.isArray(referenceImages) && referenceImages.length
    ? referenceImages
    : (referenceImage && typeof referenceImage === 'object' ? [referenceImage] : []);
  const seen = new Set();
  return rawItems
    .filter(item => item && typeof item === 'object' && typeof item.src === 'string' && item.src.trim())
    .map(item => ({
      src: item.src.trim(),
      kind: typeof item.kind === 'string' ? item.kind.trim() : '',
      label: typeof item.label === 'string' ? item.label.trim().slice(0, 160) : ''
    }))
    .filter(item => {
      if (seen.has(item.src)) return false;
      seen.add(item.src);
      return true;
    })
    .slice(0, 16);
}

function buildImageSubmissionParams({ prompt, params = {}, referenceImages = [] }) {
  const nextParams = params && typeof params === 'object' ? { ...params } : {};
  const normalizedReferenceImages = normalizeReferenceImagesPayload({ referenceImages });
  const hasReferenceImage = normalizedReferenceImages.length > 0;
  nextParams.n = 1;

  if (!hasReferenceImage) {
    return nextParams;
  }

  // Reference image edits are fingerprinted so callers can optionally block
  // accidental duplicate submissions, but automatic retries stay within one
  // task and are billed only after a final image is saved.
  nextParams.costGuard = nextParams.costGuard !== false;

  const referenceSignature = hashStableText(normalizedReferenceImages
    .map(referenceImage => [
      referenceImage.kind || '',
      referenceImage.label || '',
      referenceImage.src || ''
    ].join('\n'))
    .join('\n---reference---\n'));
  const promptSignature = hashStableText(String(prompt || '').replace(/\s+/g, ' ').trim());
  const requestSignature = hashStableText([
    promptSignature,
    referenceSignature,
    nextParams.size || 'auto',
    nextParams.aspectRatio || nextParams.aspect_ratio || '',
    nextParams.resolution || nextParams.imageSize || nextParams.image_size || '',
    nextParams.quality || '',
    nextParams.output_format || 'png'
  ].join(':'));

  nextParams._referenceSignature = referenceSignature;
  nextParams._referenceCount = normalizedReferenceImages.length;
  nextParams._requestSignature = requestSignature;
  nextParams._referenceEdit = true;
  return nextParams;
}

function hashStableText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function normalizeBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePptPageCount(input, runtimeConfig = {}) {
  const minPages = Math.max(parseInt(runtimeConfig.pptMinPages, 10) || 3, 1);
  const maxPages = Math.max(parseInt(runtimeConfig.pptMaxPages, 10) || 30, minPages);
  const parsed = parseInt(input, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minPages), maxPages) : null;
}

function extractExplicitPptPageCount(values = [], runtimeConfig = {}) {
  const text = (Array.isArray(values) ? values : [values])
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => String(value))
    .join('\n');
  if (!text.trim()) return null;

  const patterns = [
    /(?:建议页数|页数|页数要求|总页数|页面数量|PPT页数|ppt页数|生成页数)\s*[:：]?\s*(\d{1,3})\s*页/gi,
    /(?:做成|做|生成|制作|整理成|设计成|输出|改成)\s*(\d{1,3})\s*页/gi,
    /(\d{1,3})\s*页\s*(?:PPT|ppt|幻灯片|演示|简报|汇报|课件|方案)?/gi
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      const parsed = normalizePptPageCount(matches[matches.length - 1][1], runtimeConfig);
      if (parsed) return parsed;
    }
  }
  return null;
}

function estimateAutoPptPageCount(values = [], runtimeConfig = {}) {
  const minPages = Math.max(parseInt(runtimeConfig.pptMinPages, 10) || 3, 1);
  const maxPages = Math.max(parseInt(runtimeConfig.pptMaxPages, 10) || 30, minPages);
  const text = (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map(value => String(value))
    .join('\n');
  const pageMarkers = text.match(/(?:^|\n)\s*(?:[-*]?\s*)?(?:P0?\d+|第\s*\d+\s*页|第\s*\d+\s*张)/g) || [];
  if (pageMarkers.length >= 3) return Math.min(Math.max(pageMarkers.length, minPages), maxPages);

  const headingCount = (text.match(/(?:^|\n)\s*#{1,4}\s+/g) || []).length;
  const bulletCount = (text.match(/(?:^|\n)\s*[-*•]\s+/g) || []).length;
  const paragraphCount = text.split(/\n{2,}/).map(item => item.trim()).filter(Boolean).length;
  const charCount = text.replace(/\s/g, '').length;
  let score = 4 + headingCount * 0.85 + bulletCount * 0.28 + paragraphCount * 0.2 + charCount / 900;
  if (/(发展史|历史|时间线|趋势|行业分析|市场分析|研究报告|白皮书|课程|培训|课件|论文|PDF|pdf|完整资料)/.test(text)) score += 2;
  if (/(项目汇报|路演|商业计划|融资|招商|解决方案|建设方案|实施方案|复盘|年度|季度)/.test(text)) score += 1.5;
  if (charCount < 120 && bulletCount < 3 && headingCount < 2) score = Math.max(score, 6);
  return Math.min(Math.max(Math.round(score), minPages), maxPages);
}

function shouldGeneratePptImages(params = {}, runtimeConfig = {}) {
  const explicit = normalizeBooleanFlag(params.generateImages ?? params.generate_images, undefined);
  const enabled = explicit === true || (explicit === undefined && runtimeConfig.pptGenerateImages);
  const hasImageProvider = Boolean(runtimeConfig.imageApiKey);
  return enabled && hasImageProvider;
}

function estimatePptImageRequestCount(params = {}, runtimeConfig = {}) {
  if (!shouldGeneratePptImages(params, runtimeConfig)) return 0;
  const explicit = parseInt(params.maxPptImages || params.max_ppt_images || runtimeConfig.pptMaxGeneratedImages, 10);
  return Math.min(Math.max(Number.isFinite(explicit) ? explicit : 4, 1), 12);
}

function estimatePptRequestCredits(params = {}, prompt = '') {
  const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
  const pageCount = extractExplicitPptPageCount([
    params.pageCount,
    params.page_count,
    params.content,
    params.extraRequirements,
    prompt
  ], runtimeConfig) || estimateAutoPptPageCount([
    params.title,
    params.content,
    params.extraRequirements,
    prompt
  ], runtimeConfig);
  const imageCount = estimatePptImageRequestCount(params, runtimeConfig);
  return {
    pageCount,
    imageCount,
    totalCredits: User.estimatePptCredits({ pageCount, imageCount })
  };
}

function buildPptCreditEstimatePayload({ params = {}, prompt = '', userId = null } = {}) {
  const estimate = estimatePptRequestCredits(params, prompt);
  const pageCredits = Math.max(0, Number(estimate.pageCount || 0) * User.creditsPerPptPage());
  const imageCredits = Math.max(0, Number(estimate.imageCount || 0) * User.creditsPerPptImage());
  const billing = User.buildCreditBilling(estimate.totalCredits, userId);
  return {
    page_count: estimate.pageCount,
    image_count: estimate.imageCount,
    page_credits: Math.ceil(pageCredits),
    image_credits: Math.ceil(imageCredits),
    base_credits: estimate.totalCredits,
    original_credits: billing.originalCredits,
    charged_credits: billing.chargedCredits,
    discount_credits: billing.discountCredits,
    discount_rate: billing.discountRate,
    discount_label: billing.discountLabel,
    vip_discount_applied: billing.vipDiscountApplied,
    credits_per_page: User.creditsPerPptPage(),
    credits_per_image: User.creditsPerPptImage(),
    credits_per_1k_tokens: User.creditsPerAiTokenThousand(),
    token_note: '这是生成前的基础额度预估；AI 对话和页面生成 token 会按实际用量另计，完成后以实际扣费为准。'
  };
}

function estimateImageRequestCredits(params = {}) {
  const imageCount = Math.max(1, parseInt(params?.n || params?.count || 1, 10) || 1);
  return {
    imageCount,
    totalCredits: User.estimateImageCredits(imageCount)
  };
}

async function runPptAgentTask(taskId, logPrefix = '[PPT Agent]') {
  const agent = new PptAgent();
  try {
    const result = await agent.start({ taskId });
    AiTask.updateStatus(taskId, 'completed', {
      result_url: result?.download_url,
      result_data: {
        status: 'completed',
        stage: 'done',
        progress: 100,
        ...result
      }
    });
    const task = AiTask.findById(taskId);
    if (task?.user_id) {
      StorageLimitService.enforceForUser(task.user_id);
    }
  } catch (error) {
    console.error(`${logPrefix} 任务失败:`, error);
    AiTask.updateStatus(taskId, 'failed', {
      error_message: error.message,
      result_data: {
        status: 'failed',
        stage: 'error',
        progress: 0,
        error: error.message
      }
    });
  }
}

async function runImportedPptTask(taskId, fileId) {
  const task = AiTask.findById(taskId);
  const file = File.findById(fileId);
  try {
    if (!task || !file) throw new Error('导入任务或文件不存在');
    const params = safeParseJson(task.params, {}) || {};
    const sourceName = normalizeUploadOriginalName(file.original_name || file.filename || '', file.filename || '上传PPT');
    AiTask.updateStatus(taskId, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'ppt_import',
        progress: 18,
        edit_mode: 'imported_ppt',
        imported_ppt: true,
        title: params.title || task.prompt || sourceName || '导入PPT',
        source_file_id: file.id,
        source_file_name: sourceName,
        message: '正在转换页面截图并建立可编辑工程...'
      }
    });
    const resultData = await PptImportEditService.importFileAsTask({ file, task });
    AiTask.updateStatus(taskId, 'completed', {
      result_url: resultData.download_url || resultData.pptx_url,
      result_data: resultData
    });
    if (task.user_id) {
      StorageLimitService.enforceForUser(task.user_id);
    }
  } catch (error) {
    console.error('[PPT Import] 任务失败:', error);
    AiTask.updateStatus(taskId, 'failed', {
      error_message: error.message,
      result_data: {
        status: 'failed',
        stage: 'error',
        progress: 100,
        edit_mode: 'imported_ppt',
        imported_ppt: true,
        message: error.message,
        error: error.message
      }
    });
  }
}

async function runImageTask({ taskId, referenceImage, referenceImages }) {
  const task = AiTask.findById(taskId);
  if (!task) {
    console.error('[Image Agent] 任务失败:', '图片任务不存在');
    return;
  }

  const params = safeParseJson(task.params, {});
  const normalizedReferenceImages = normalizeReferenceImagesPayload({
    referenceImage,
    referenceImages
  });
  const maxAttempts = params.autoRetry === false ? 1 : Math.max(parseInt(params.maxAttempts, 10) || 3, 1);
  const originalPrompt = extractOriginalImagePrompt(task.prompt);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptContext = buildImageAttemptContext({
      prompt: task.prompt,
      params,
      attempt,
      maxAttempts
    });

    try {
      AiTask.updateStatus(taskId, 'processing', {
        result_data: {
          status: 'processing',
          stage: attemptContext.stage,
          progress: attempt > 1 ? 18 : 10,
          attempt,
          max_attempts: maxAttempts,
          retry_mode: attemptContext.retryMode,
          message: attemptContext.message
        }
      });

      await AiService.generateImage({
        userId: task.user_id,
        prompt: attemptContext.prompt,
        params: attemptContext.params,
        referenceImages: normalizedReferenceImages,
        task,
        manageFailureStatus: false,
        originalPrompt
      });
      return;
    } catch (error) {
      const retryDecision = getImageRetryDecision({
        error,
        attempt,
        maxAttempts,
        referenceImages: normalizedReferenceImages,
        params: attemptContext.params
      });
      const canRetry = retryDecision.canRetry;
      const publicMessage = retryDecision.message || buildPublicImageFailureMessage({
        error,
        attempt,
        isReferenceEdit: normalizedReferenceImages.length > 0 || error?.imageOperation === 'edit'
      });
      console.error(`[Image Agent] 任务失败${canRetry ? '，准备重试' : ''}:`, formatSafeError(error));

      if (canRetry) {
        if (retryDecision.retryStrategy) {
          params._retryStrategy = retryDecision.retryStrategy;
        }
        AiTask.updateStatus(taskId, 'processing', {
          result_data: {
            status: 'processing',
            stage: 'retry_wait',
            progress: 12,
            attempt,
            max_attempts: maxAttempts,
            retry_mode: attemptContext.retryMode,
            next_retry_mode: retryDecision.retryStrategy === 'same_request' ? 'same_request' : 'compact',
            message: publicMessage,
            billing: {
              charged_credits: 0,
              retry_charged_credits: 0,
              charge_reason: 'not_completed'
            },
            last_error: publicMessage,
            internal_last_error: error.message
          }
        });
        await delay(3000);
        continue;
      }

      AiTask.updateStatus(taskId, 'failed', {
        error_message: publicMessage,
        result_data: {
          status: 'failed',
          stage: 'error',
          progress: 0,
          attempt,
          max_attempts: maxAttempts,
          retry_mode: attemptContext.retryMode,
          error: publicMessage,
          last_error: publicMessage,
          internal_error: error.message,
          failure_kind: retryDecision.failureKind || 'provider_error',
          billing: {
            charged_credits: 0,
            retry_charged_credits: 0,
            charge_reason: retryDecision.chargeReason || 'not_completed'
          },
          message: publicMessage
        }
      });
      return;
    }
  }
}

function buildImageAttemptContext({ prompt, params, attempt, maxAttempts }) {
  const baseParams = params && typeof params === 'object' ? { ...params } : {};
  const attemptParams = {
    ...baseParams,
    _attempt: attempt,
    _maxAttempts: maxAttempts
  };

  if (attempt <= 1) {
    return {
      prompt,
      params: attemptParams,
      stage: 'generating',
      retryMode: '',
      message: '图片生成任务正在提交给模型...'
    };
  }

  if (baseParams._retryStrategy === 'same_request') {
    const retryParams = {
      ...attemptParams,
      retryMode: 'same_request'
    };

    return {
      prompt,
      params: retryParams,
      stage: 'retrying',
      retryMode: 'same_request',
      message: `刚才提交图片时出了点小问题，正在重新生成第 ${attempt}/${maxAttempts} 次...`
    };
  }

  const retryParams = {
    ...attemptParams,
    n: 1,
    quality: attemptParams.quality || 'high',
    output_format: attemptParams.output_format || 'png',
    size: chooseRetryImageSize(attemptParams.size, prompt),
    templateType: 'none',
    skipTemplateEnhancement: true,
    retryMode: 'compact'
  };

  return {
    prompt: buildCompactImageRetryPrompt(prompt),
    params: retryParams,
    stage: 'retrying',
    retryMode: 'compact',
    message: `上一次生成没有成功，正在简化提示词和参数重试第 ${attempt}/${maxAttempts} 次...`
  };
}

function extractOriginalImagePrompt(prompt) {
  const text = String(prompt || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  const match = text.match(/用户原始需求[:：]\s*([\s\S]*?)(?:\n系统自动识别任务类型[:：]|\n结构要求[:：]|\n输出比例建议[:：]|\n质量与防坑约束[:：]|\n最终画面|$)/);
  return (match ? match[1] : text).trim();
}

function buildCompactImageRetryPrompt(prompt) {
  const original = extractOriginalImagePrompt(prompt)
    .replace(/\s+/g, ' ')
    .trim();
  const concise = original.length > 420 ? `${original.slice(0, 420).trim()}...` : original;

  return [
    '图片生成重试版提示词。',
    `用户需求：${concise}`,
    '可靠性要求：生成单张图，只保留核心主体、姿态和氛围；最多两个主要人物或一个主视觉；使用半身或中景构图；背景简洁干净；不要海报排版、不要信息图、不要大段文字、不要堆叠复杂道具和碎元素；主体清晰，构图稳定，细节适量。'
  ].join('\n');
}

function chooseRetryImageSize(size, prompt) {
  const explicitSize = String(size || '').trim();
  if (explicitSize && explicitSize !== 'auto') {
    return explicitSize;
  }

  const text = String(prompt || '').toLowerCase();
  if (/9\s*[:：]\s*16|竖屏|手机壁纸|story|reels/.test(text)) return '9:16';
  if (/3\s*[:：]\s*4|竖版|纵向|portrait/.test(text)) return '3:4';
  if (/2\s*[:：]\s*3|摄影竖图|poster portrait/.test(text)) return '2:3';
  if (/4\s*[:：]\s*5|社媒竖图|小红书|instagram post/.test(text)) return '4:5';
  if (/16\s*[:：]\s*9|横版|宽屏|landscape|banner/.test(text)) return '16:9';
  if (/21\s*[:：]\s*9|超宽|全景|panorama|cinematic wide/.test(text)) return '21:9';
  if (/3\s*[:：]\s*2|摄影横图|相机横图/.test(text)) return '3:2';
  if (/5\s*[:：]\s*4|商品横图/.test(text)) return '5:4';
  if (/4\s*[:：]\s*3/.test(text)) return '4:3';
  return '1:1';
}

function formatSafeError(error) {
  const status = error?.response?.status;
  const code = error?.code || error?.response?.data?.error?.code || '';
  const message = error?.response?.data?.error?.message || error?.message || String(error);
  return [status ? `status=${status}` : '', code ? `code=${code}` : '', message].filter(Boolean).join(' ');
}

function getImageRetryDecision({ error, attempt, maxAttempts, referenceImage, referenceImages, params = {} }) {
  const hasReferenceImage = Array.isArray(referenceImages) ? referenceImages.length > 0 : Boolean(referenceImage);
  const isReferenceEdit = hasReferenceImage || error?.imageOperation === 'edit';
  const isTransientQuotaReservationError = AiService.isImageTransientQuotaReservationError(error);
  const isRecoverableBadRequest = isRecoverableImageBadRequest(error);

  if (AiService.isImageSafetyPolicyError(error)) {
    return {
      canRetry: false,
      failureKind: 'safety_policy',
      chargeReason: 'safety_policy_no_charge',
      message: '图片内容未通过安全审核，本次未扣除站内额度。请调整描述或更换参考图后再试。'
    };
  }

  if (isTransientQuotaReservationError) {
    if (attempt >= maxAttempts) {
      return {
        canRetry: false,
        failureKind: 'transient_quota_retry_exhausted',
        chargeReason: 'transient_quota_retry_exhausted',
        message: '乐米本次失误了，很抱歉。这次没有扣除点数，可以试试重新生成。'
      };
    }

    return {
      canRetry: true,
      failureKind: 'transient_quota_retry_pending',
      chargeReason: 'not_completed',
      retryStrategy: 'same_request',
      message: `刚才提交图片时出了点小问题，正在自动重试第 ${attempt + 1}/${maxAttempts} 次，不会额外扣除点数。`
    };
  }

  if (AiService.isImageProviderQuotaError(error)) {
    return {
      canRetry: false,
      failureKind: 'provider_quota',
      chargeReason: 'provider_quota_no_charge',
      message: '图片服务额度暂时不足，本次未扣除站内额度。请稍后再试或联系管理员检查图片平台配置。'
    };
  }

  if (attempt >= maxAttempts) {
    return {
      canRetry: false,
      failureKind: isRecoverableBadRequest
        ? 'recoverable_bad_request_retry_exhausted'
        : (isReferenceEdit ? 'reference_edit_failed' : 'provider_error'),
      chargeReason: 'not_completed'
    };
  }

  if (isRecoverableBadRequest) {
    return {
      failureKind: 'recoverable_bad_request',
      chargeReason: 'not_completed',
      canRetry: true,
      retryStrategy: 'compact',
      message: `${isReferenceEdit ? '参考图编辑请求' : '图片生成请求'}被图片服务拒绝了，3 秒后会自动简化提示词重试第 ${attempt + 1}/${maxAttempts} 次。自动重试不额外扣除站内额度。`
    };
  }

  if (!isRetryableImageError(error)) {
    return {
      canRetry: false,
      failureKind: isReferenceEdit ? 'reference_edit_failed' : 'provider_error',
      chargeReason: 'not_completed'
    };
  }

  return {
    failureKind: 'retryable_provider_error',
    chargeReason: 'not_completed',
    canRetry: true,
    message: `生成失败，3 秒后会自动重试第 ${attempt + 1}/${maxAttempts} 次。自动重试不额外扣除站内额度。`
  };
}

function buildPublicImageFailureMessage({ error, attempt, isReferenceEdit }) {
  if (AiService.isImageSafetyPolicyError(error)) {
    return '图片内容未通过安全审核，本次未扣除站内额度。请调整描述或更换参考图后再试。';
  }
  if (AiService.isImageTransientQuotaReservationError(error)) {
    return '乐米本次失误了，很抱歉。这次没有扣除点数，可以试试重新生成。';
  }
  if (AiService.isImageProviderQuotaError(error)) {
    return '图片服务额度暂时不足，本次未扣除站内额度。请稍后再试或联系管理员检查图片平台配置。';
  }

  if (attempt > 1) {
    return isReferenceEdit
      ? `自动重试 ${attempt - 1} 次后参考图改图仍失败，本次未扣除站内额度。请简化修改要求或稍后再试。`
      : `自动重试 ${attempt - 1} 次后仍生成失败，本次未扣除站内额度。请稍后再试。`;
  }

  return isReferenceEdit
    ? '参考图改图暂时失败，本次未扣除站内额度。请简化修改要求或稍后再试。'
    : '图片生成失败，本次未扣除站内额度。请稍后再试。';
}

function isRetryableImageError(error) {
  if (AiService.isImageSafetyPolicyError(error) || AiService.isImageProviderQuotaError(error)) {
    return false;
  }

  const status = error?.response?.status;
  if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) {
    return true;
  }

  const code = String(error?.code || '').toUpperCase();
  if (['IMAGE_EMPTY_RESULT', 'IMAGE_EMPTY_RESPONSE'].includes(code)) return true;
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;

  const message = String(error?.message || '').toLowerCase();
  return /图片服务未返回可用结果|no usable image|empty image result|empty result/.test(message);
}

function isRecoverableImageBadRequest(error) {
  if (AiService.isImageSafetyPolicyError(error)
    || AiService.isImageProviderQuotaError(error)
    || AiService.isImageTransientQuotaReservationError(error)) {
    return false;
  }

  const status = Number(error?.response?.status || 0);
  if (![400, 422].includes(status)) return false;

  const providerData = AiService.parseProviderResponseBody(error?.response?.data);
  const haystack = [
    error?.code,
    error?.message,
    providerData?.error?.code,
    providerData?.error?.type,
    providerData?.error?.message,
    providerData?.code,
    providerData?.type,
    providerData?.message,
    providerData?.detail,
    providerData?.title
  ].filter(value => value !== undefined && value !== null).join(' ').toLowerCase();

  if ([
    'api key',
    'apikey',
    'unauthorized',
    'forbidden',
    'permission_denied',
    'authentication',
    'auth',
    'invalid_token',
    'model_not_found',
    'unknown model',
    'model does not exist',
    'model not found',
    'unsupported model',
    'invalid model',
    'endpoint_not_found',
    'route not found'
  ].some(token => haystack.includes(token))) {
    return false;
  }

  return true;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// SSE 端点：实时接收任务更新
router.get('/tasks/stream', auth, (req, res) => {
  // 设置 SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // 发送初始连接成功消息
  res.write('event: connected\ndata: {"status":"connected"}\n\n');

  // 定时检查新完成的任务
  let lastCheckedId = null;
  const checkInterval = setInterval(async () => {
    try {
      // 获取该用户最新的图片任务
      const tasks = AiTask.findByUserId(req.userId, {
        type: 'image',
        status: 'completed',
        limit: 5
      });

      // 过滤出新的完成任务（相对于上次检查）
      const newTasks = lastCheckedId
        ? tasks.filter(t => t.id > lastCheckedId)
        : tasks;

      for (const task of newTasks) {
        res.write(`event: task_completed\ndata: ${JSON.stringify(formatTask(task, { userId: req.userId }))}\n\n`);
      }

      if (tasks.length > 0) {
        lastCheckedId = tasks[0].id;
      }
    } catch (error) {
      console.error('SSE 检查任务错误:', error);
    }
  }, 5000); // 每5秒检查一次

  // 客户端断开连接时清理
  req.on('close', () => {
    clearInterval(checkInterval);
  });
});

// 获取新完成的任务（轮询用）
router.get('/tasks/new', auth, (req, res) => {
  try {
    const { since_id } = req.query;
    const tasks = AiTask.findByUserId(req.userId, {
      type: 'image',
      status: 'completed',
      limit: 20
    });

    // 过滤出新任务
    const newTasks = since_id
      ? tasks.filter(t => t.id > parseInt(since_id))
      : tasks;

    const formattedTasks = newTasks.map(formatTask);

    res.json({ tasks: formattedTasks, latest_id: tasks.length > 0 ? tasks[0].id : null });
  } catch (error) {
    console.error('获取新任务错误:', error);
    res.status(500).json({ error: '获取新任务失败' });
  }
});

router.get('/stats', auth, (req, res) => {
  try {
    const stats = AiTask.countByUser(req.userId);
    const quota = User.getQuota(req.userId);
    const storage = StorageLimitService.getUserStorageSummary(req.userId);

    const summary = {
      total: stats.reduce((sum, s) => sum + s.count, 0),
      byType: {},
      byStatus: {}
    };

    stats.forEach(s => {
      summary.byType[s.type] = (summary.byType[s.type] || 0) + s.count;
      summary.byStatus[s.status] = (summary.byStatus[s.status] || 0) + s.count;
    });

    res.json({ stats: summary, quota, storage });
  } catch (error) {
    console.error('获取统计数据错误:', error);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

// 对话接口
router.post('/chat', auth, async (req, res) => {
  try {
    const { messages, model, params } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '请提供对话消息' });
    }

    // 检查通用额度
    if (!User.checkQuota(req.userId, 'chat', 1)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再使用对话'
      });
    }

    const result = await AiService.chat({
      userId: req.userId,
      messages,
      model,
      params: { ...(params || {}), route: 'chat' }
    });

    const usageBilling = User.billTokenUsage(req.userId, result.usage, {
      source: 'chat',
      legacyType: 'chat',
      notePrefix: 'AI对话 token 计费',
      fallback: {
        messages,
        content: result.choices?.[0]?.message?.content || ''
      }
    });

    res.json({
      message: '对话成功',
      data: sanitizeChatResponse({
        ...result,
        usage_billing: usageBilling
      })
    });
  } catch (error) {
    console.error('对话错误:', error);
    res.status(500).json({ error: '对话失败: ' + error.message });
  }
});

router.post('/chat/assistant', auth, async (req, res) => {
  try {
    const { messages, model, params } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '请提供对话消息' });
    }

    if (!User.checkQuota(req.userId, 'chat', 1)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再使用助手'
      });
    }

    const result = await AiService.chat({
      userId: 'assistant',
      messages,
      model,
      params: { ...(params || {}), route: 'assistant' }
    });
    const usageBilling = User.billTokenUsage(req.userId, result.usage, {
      source: 'chat',
      legacyType: 'chat',
      notePrefix: 'AI助手对话 token 计费',
      fallback: {
        messages,
        content: result.choices?.[0]?.message?.content || ''
      }
    });

    res.json({
      message: '对话成功',
      data: sanitizeChatResponse({
        ...result,
        usage_billing: usageBilling
      })
    });
  } catch (error) {
    console.error('助手对话错误:', error);
    res.status(500).json({ error: '对话失败: ' + error.message });
  }
});

router.post('/assistant/respond', auth, async (req, res) => {
  try {
    const {
      workspace,
      message,
      draft,
      conversation,
      attachments,
      allowSearch
    } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '请提供助手输入内容' });
    }

    if (!User.checkQuota(req.userId, 'chat', 1)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再使用助手'
      });
    }

    const result = await AssistantService.respond({
      userId: req.userId,
      workspace,
      message: message.trim(),
      draft: typeof draft === 'string' ? draft : '',
      conversation,
      attachments,
      allowSearch
    });

    res.json(sanitizeAssistantResponse(result));
  } catch (error) {
    console.error('助手代理错误:', error);
    res.status(500).json({ error: publicAssistantErrorMessage(error) });
  }
});

router.post('/assistant/respond/jobs', auth, async (req, res) => {
  try {
    const {
      workspace,
      message,
      draft,
      conversation,
      attachments,
      allowSearch
    } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '请提供助手输入内容' });
    }

    if (!User.checkQuota(req.userId, 'chat', 1)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再使用助手'
      });
    }

    const job = createAssistantRespondJob({
      userId: req.userId,
      requestedJobId: req.body?.jobId || req.body?.job_id || req.body?.clientJobId || req.body?.client_job_id,
      payload: {
        workspace,
        message: message.trim(),
        draft,
        conversation,
        attachments,
        allowSearch
      }
    });

    res.json({
      message: '助手后台任务已启动',
      job: publicAssistantRespondJob(job)
    });
  } catch (error) {
    console.error('启动助手后台任务错误:', error);
    res.status(500).json({ error: publicAssistantErrorMessage(error) });
  }
});

router.get('/assistant/respond/jobs/:jobId', auth, (req, res) => {
  const job = getAssistantRespondJobForUser(req.params.jobId, req.userId);
  if (!job) {
    return res.status(404).json({ error: '助手后台任务不存在或已过期' });
  }
  res.json({
    job: publicAssistantRespondJob(job)
  });
});

router.post('/assistant/respond/stream', auth, async (req, res) => {
  let stream = null;
  let heartbeatTimer = null;
  try {
    const {
      workspace,
      message,
      draft,
      conversation,
      attachments,
      allowSearch
    } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '请提供助手输入内容' });
    }

    if (!User.checkQuota(req.userId, 'chat', 1)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再使用助手'
      });
    }

    stream = createSseSession(req, res);
    stream.write('start', {
      status: 'connected',
      phase: 'connected',
      title: '正在准备回复',
      message: '正在连接助手'
    });

    heartbeatTimer = setInterval(() => {
      stream.write('heartbeat', {
        status: 'processing',
        title: '乐米正在整理回复',
        message: '任务仍在运行，流式连接保持中'
      });
    }, 4500);

    const result = await AssistantService.respondStream({
      userId: req.userId,
      workspace,
      message: message.trim(),
      draft: typeof draft === 'string' ? draft : '',
      conversation,
      attachments,
      allowSearch,
      onPhase: phase => stream.write('phase', phase),
      onTool: tool => {
        if (shouldExposeAssistantTool(tool)) {
          stream.write('tool', tool);
        }
      },
      onDelta: text => stream.write('delta', { text })
    });

    const publicResult = sanitizeAssistantResponse(result);
    const trace = Array.isArray(publicResult?.assistant?.trace) ? publicResult.assistant.trace : [];
    if (!publicResult._streamed_text) {
      for (const step of trace) {
        const tool = {
          ...step,
          status: step.status || 'completed'
        };
        if (shouldExposeAssistantTool(tool)) {
          stream.write('tool', tool);
        }
      }
    }

    if (!publicResult._streamed_text) {
      stream.write('phase', {
        phase: 'responding',
        title: '正在生成回复',
        treeTitle: '输出可用内容',
        message: '根据整理结果开始流式输出'
      });
      await streamTextDeltas(stream, assistantResponseToStreamText(publicResult));
    }
    delete publicResult._streamed_text;
    stream.write('done', publicResult);
  } catch (error) {
    console.error('助手代理流式错误:', error);
    if (!stream) {
      return res.status(500).json({ error: publicAssistantErrorMessage(error) });
    }
    stream.write('error', {
      error: '助手暂时不可用',
      message: publicAssistantErrorMessage(error),
      statusCode: 500
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (stream) stream.end();
  }
});

function shouldExposeAssistantTool(tool = {}) {
  const kind = String(tool.kind || tool.type || tool.action || '').trim().toLowerCase();
  const status = String(tool.status || tool.state || '').trim().toLowerCase();
  if (status === 'failed' || status === 'error') return true;
  return new Set([
    'search',
    'web_search',
    'workspace_snapshot',
    'resource_read',
    'model_intent',
    'create_proposal',
    'apply_proposal',
    'ppt_edit',
    'export'
  ]).has(kind);
}

function createSseSession(req, res) {
  let closed = false;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  res.on('close', () => {
    closed = true;
  });
  res.on('finish', () => {
    closed = true;
  });

  return {
    isClosed: () => closed || res.writableEnded || res.destroyed,
    write(event, data = {}) {
      if (closed || res.writableEnded || res.destroyed) return false;
      const payload = JSON.stringify({
        at: new Date().toISOString(),
        ...data
      });
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
      return true;
    },
    end() {
      if (!closed && !res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  };
}

async function streamTextDeltas(stream, text, options = {}) {
  const chunks = splitStreamText(text, options);
  for (const chunk of chunks) {
    if (stream.isClosed()) return;
    stream.write('delta', { text: chunk });
    await wait(options.delayMs || 18);
  }
}

function splitStreamText(text, options = {}) {
  const source = String(text || '').trim();
  if (!source) return [];
  const maxChars = options.maxChars || 1600;
  const maxChunkLength = options.maxChunkLength || 18;
  const clipped = source.length > maxChars ? `${source.slice(0, maxChars)}...` : source;
  const chunks = [];
  let current = '';

  for (const char of clipped) {
    current += char;
    if (/[\n。！？!?，,；;：:\s]/.test(char) || current.length >= maxChunkLength) {
      chunks.push(current);
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks.slice(0, options.maxChunks || 140);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assistantResponseToStreamText(result = {}) {
  const assistant = result.assistant || {};
  const parts = [];
  if (assistant.overview) parts.push(assistant.overview);
  if (Array.isArray(assistant.deliverables)) {
    assistant.deliverables.slice(0, 2).forEach(item => {
      if (item?.label) parts.push(item.label);
      if (item?.content) parts.push(item.content);
      if (Array.isArray(item?.items) && item.items.length) {
        parts.push(item.items.slice(0, 5).map(entry => `- ${entry}`).join('\n'));
      }
    });
  }
  return parts.join('\n\n').trim();
}

function pptCopilotResponseToStreamText(result = {}) {
  return String(result.message || result.reply || result.proposal?.summary || 'PPT助手乐米已完成本轮处理。').trim();
}

function sanitizeChatResponse(result) {
  const sanitized = sanitizePublicPayload(result);
  if (!sanitized || !Array.isArray(sanitized.choices)) return sanitized;
  return {
    ...sanitized,
    choices: sanitized.choices.map(choice => ({
      ...choice,
      message: choice?.message
        ? {
            ...choice.message,
            content: sanitizePublicText(choice.message.content, RuntimeConfigService.getRuntimeConfig())
          }
        : choice?.message
    }))
  };
}

function sanitizeAssistantResponse(result) {
  if (!result || typeof result !== 'object') return result;
  return sanitizePublicPayload(result);
}

// Configure multer for document uploads
const DOC_UPLOAD_DIR = appConfig.documentUploadDir;
fs.mkdirSync(DOC_UPLOAD_DIR, { recursive: true });

const docStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOC_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const originalName = normalizeUploadOriginalName(file.originalname, file.originalname || 'document');
    file.originalname = originalName;
    cb(null, uniqueSuffix + path.extname(originalName));
  }
});

const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: appConfig.maxFileSize },
  fileFilter: (req, file, cb) => {
    const originalName = normalizeUploadOriginalName(file.originalname, file.originalname || '');
    file.originalname = originalName;
    const ext = path.extname(originalName).toLowerCase();
    const supported = ['.pdf', '.docx', '.doc', '.pptx', '.ppt'];
    if (supported.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件格式: ${ext}`));
    }
  }
});

// Document conversion endpoint
router.post('/convert/document', auth, docUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文档文件' });
    }

    if (!User.checkQuota(req.userId, 'ppt', 1)) {
      fs.unlinkSync(req.file.path); // Clean up uploaded file
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再转换'
      });
    }

    const converter = DocumentConverterService.detectConverter(req.file.originalname);
    if (!converter) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '不支持的文件格式' });
    }

    const result = await DocumentConverterService.convert(req.file.path, {
      outputDir: DOC_UPLOAD_DIR,
      converter
    });

    // Build markdown preview (first 3000 chars)
    const preview = result.markdown.slice(0, 3000);
    const hasMore = result.markdown.length > 3000;

    res.json({
      message: '文档转换成功',
      data: {
        converter,
        fileName: req.file.originalname,
        fileSize: result.fileSize,
        lineCount: result.lineCount,
        duration: result.duration,
        outputPath: result.outputPath,
        markdown: result.markdown,
        preview,
        hasMore,
        wordCount: result.markdown.length
      }
    });
  } catch (error) {
    console.error('文档转换错误:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: '文档转换失败: ' + error.message });
  }
});

// Convert document by URL (web pages)
router.post('/convert/url', auth, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: '请提供有效的URL' });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ error: 'URL必须以 http:// 或 https:// 开头' });
    }
    await assertSafeRemoteUrl(url, { allowedProtocols: ['http:', 'https:'] });

    if (!User.checkQuota(req.userId, 'ppt', 1)) {
      return res.status(403).json({
        error: '通用额度不足',
        message: '当前通用额度不足，请先在用户中心兑换额度后再转换'
      });
    }

    const runtimeConfig = require('../services/runtimeConfigService').getRuntimeConfig();
    const python = DocumentConverterService.resolvePython(runtimeConfig);
    const scriptPath = path.join(runtimeConfig.pptMasterRoot || appConfig.defaultPptMasterRoot, 'skills', 'ppt-master', 'scripts', 'source_to_md', 'web_to_md.py');

    const outputDir = DOC_UPLOAD_DIR;
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `web_${Date.now()}.md`);

    const { execFile } = require('child_process');
    const startTime = Date.now();

    await new Promise((resolve, reject) => {
      execFile(
        python,
        [scriptPath, url, '-o', outputDir],
        { timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (error, stdout, stderr) => {
          if (error && !fs.existsSync(outputPath)) {
            reject(new Error(`网页抓取失败: ${stderr || error.message}`));
            return;
          }
          resolve(stdout);
        }
      );
    });

    const markdown = fs.readFileSync(outputPath, 'utf-8');
    const preview = markdown.slice(0, 3000);

    res.json({
      message: '网页转换成功',
      data: {
        sourceUrl: url,
        lineCount: markdown.split('\n').length,
        duration: Date.now() - startTime,
        markdown,
        preview,
        hasMore: markdown.length > 3000,
        wordCount: markdown.length
      }
    });
  } catch (error) {
    console.error('网页转换错误:', error);
    res.status(500).json({ error: '网页转换失败: ' + error.message });
  }
});

// Convert document from existing file path (for internal use)
router.post('/convert/from-path', auth, async (req, res) => {
  try {
    const fileId = req.body?.fileId || req.body?.file_id || req.body?.id;
    const rawFilePath = req.body?.filePath || req.body?.file_path || '';
    let file = null;

    if (fileId) {
      file = File.findById(fileId);
      if (!file) {
        return res.status(404).json({ error: '文件不存在' });
      }
      if (String(file.user_id) !== String(req.userId)) {
        return res.status(403).json({ error: '无权访问此文件' });
      }
    } else if (rawFilePath && typeof rawFilePath === 'string') {
      const resolvedPath = appConfig.assertInsideUploadDir(path.resolve(rawFilePath));
      file = (File.findByUserId(req.userId, { limit: 500, offset: 0 }) || [])
        .find(item => item.path && path.resolve(item.path) === resolvedPath);
      if (!file) {
        return res.status(403).json({ error: '无权访问此文件' });
      }
    } else {
      return res.status(400).json({ error: '请提供有效的文件标识' });
    }

    const filePath = appConfig.assertInsideUploadDir(path.resolve(file.path));

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const result = await DocumentConverterService.convert(filePath);
    const preview = result.markdown.slice(0, 3000);

    res.json({
      message: '文档转换成功',
      data: {
        converter: result.converter,
        lineCount: result.lineCount,
        duration: result.duration,
        markdown: result.markdown,
        preview,
        hasMore: result.markdown.length > 3000,
        wordCount: result.markdown.length
      }
    });
  } catch (error) {
    console.error('文档转换错误:', error);
    res.status(500).json({ error: '文档转换失败: ' + error.message });
  }
});

// Document to PPT generation
router.post('/generate/ppt-from-doc', auth, docUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文档文件' });
    }

    const { params } = req.body;
    const parsedParams = typeof params === 'string' ? JSON.parse(params) : (params || {});
    const estimatedPptCost = estimatePptRequestCredits(parsedParams, parsedParams.content || parsedParams.title || req.file.originalname);
    const estimatedPptBilling = User.buildCreditBilling(estimatedPptCost.totalCredits, req.userId);

    if (!User.checkQuota(req.userId, 'ppt', estimatedPptBilling.chargedCredits)) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({
        code: 'INSUFFICIENT_CREDITS',
        error: '通用额度不足',
        message: `${User.creditBillingQuotaMessage('当前通用额度不足，本次PPT生成', estimatedPptBilling)}。请先充值后再生成。`,
        recharge_url: CREDIT_RECHARGE_URL
      });
    }

    const converter = DocumentConverterService.detectConverter(req.file.originalname);
    if (!converter) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '不支持的文件格式' });
    }

    // Step 1: Convert document to markdown
    const convertResult = await DocumentConverterService.convert(req.file.path, {
      outputDir: DOC_UPLOAD_DIR,
      converter
    });

    // Step 2: Create PPT task with the converted content
    const task = AiTask.create({
      userId: req.userId,
      type: 'ppt',
      prompt: convertResult.markdown, // Use converted markdown as prompt
      params: {
        ...parsedParams,
        sourceFile: req.file.originalname,
        sourceConverter: converter,
        documentConverted: true
      }
    });

    AiTask.updateStatus(task.id, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'queued',
        progress: 1,
        message: '文档已转换，PPT 正在准备生成...'
      }
    });

    // Clean up uploaded file after conversion
    fs.unlinkSync(req.file.path);

    // Start PPT generation asynchronously
    setImmediate(() => {
      runPptAgentTask(task.id, '[PPT Document Agent]');
    });

    res.json({
      message: '文档转PPT任务已启动',
      task: {
        id: task.id,
        status: 'processing',
        type: 'ppt',
        sourceFile: req.file.originalname,
        converter,
        preview: convertResult.markdown.slice(0, 1000)
      }
    });
  } catch (error) {
    console.error('文档转PPT错误:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: '文档转PPT失败: ' + error.message });
  }
});

// Get supported document formats
router.get('/convert/formats', (req, res) => {
  const formats = [
    { type: 'pdf', extensions: ['.pdf'], description: 'PDF文档' },
    { type: 'doc', extensions: ['.docx', '.doc'], description: 'Word文档' },
    { type: 'ppt', extensions: ['.pptx', '.ppt'], description: 'PPT演示文稿' }
  ];

  res.json({
    formats,
    maxFileSize: '50MB'
  });
});

// Image provider status for local debugging / admin check
router.get('/image-provider/status', auth, async (req, res) => {
  try {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const providerMode = AiService.imageProviderMode ? AiService.imageProviderMode(runtimeConfig) : (process.env.IMAGE_PROVIDER || '');
    const isMock = AiService.isMockImageMode ? AiService.isMockImageMode(runtimeConfig) : providerMode === 'mock';
    const imageConfig = isMock
      ? AiService.getLocalImageRuntimeConfig(runtimeConfig, 'local')
      : AiService.getImageRuntimeConfig(runtimeConfig, 'primary');

    const healthUrl = imageConfig.baseUrl.replace(/\/v1$/i, '') + '/health';
    let reachable = false;
    let health = null;
    let error = '';
    try {
      const axios = require('axios');
      const response = await axios.get(healthUrl, { timeout: 5000, validateStatus: () => true });
      reachable = response.status >= 200 && response.status < 500;
      health = response.data;
    } catch (healthError) {
      error = healthError.message;
    }

    res.json({
      provider_mode: providerMode || (isMock ? 'mock' : 'openai-compatible'),
      mock_mode: isMock,
      base_url: imageConfig.baseUrl,
      model: imageConfig.model,
      reachable,
      health,
      error
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      provider_mode: process.env.IMAGE_PROVIDER || '',
      hint: '检查 backend/.env.local 里的 IMAGE_PROVIDER、IMAGE_BASE_URL、IMAGE_API_KEY、IMAGE_MODEL'
    });
  }
});


module.exports = router;
