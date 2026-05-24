const path = require('path');
const fs = require('fs');
const AiTask = require('../models/AiTask');
const File = require('../models/File');
const User = require('../models/User');
const axios = require('axios');
const NodeFormData = require('form-data');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { loadPrompt } = require('./promptService');
const RuntimeConfigService = require('./runtimeConfigService');
const AiRouterService = require('./aiRouterService');
const AiHealthMonitorService = require('./aiHealthMonitorService');
const ImageTemplateService = require('./imageTemplateService');
const StorageLimitService = require('./storageLimitService');
const appConfig = require('../config/appConfig');
const { assertSafeRemoteUrl, safeAxiosOptions } = require('../utils/urlSafety');

const UPLOAD_DIR = appConfig.uploadDir;
const IMAGE_PREVIEW_WIDTH = 768;
const IMAGE_PREVIEW_QUALITY = 62;
const KLING_AUDIO_MAX_VOLUME_THRESHOLD_DB = -24;
const KLING_VIDEO_AUDIO_MAX_BYTES = 300 * 1024 * 1024;
const execFileAsync = promisify(execFile);

class AiService {
  static publicVideoGenerationFailureMessage() {
    return '视频生成失败，请稍后再试或调整描述后重新生成。';
  }

  static async generatePPT({ userId, prompt, params }) {
    const task = AiTask.create({
      userId,
      type: 'ppt',
      prompt,
      params
    });

    try {
      AiTask.updateStatus(task.id, 'processing');

      const result = await this.callOpenAI({
        prompt: `请根据以下内容创建一个专业PPT的JSON结构：
主题：${prompt}
要求：返回一个包含slide内容的JSON数组，每个slide包含title和content字段`,

        schema: {
          slides: [
            { title: 'string', content: 'string', layout: 'string' }
          ],
          theme: 'string',
          style: 'string'
        }
      });

      const pptPath = path.join(UPLOAD_DIR, userId.toString(), `${task.id}.json`);
      fs.writeFileSync(pptPath, JSON.stringify(result, null, 2));

      File.create({
        userId,
        taskId: task.id,
        filename: `${task.id}.json`,
        originalName: 'generated_ppt.json',
        mimeType: 'application/json',
        size: fs.statSync(pptPath).size,
        path: pptPath,
        url: `/api/files/${path.basename(pptPath)}`
      });

      const originalCredits = Math.max(
        1,
        Array.isArray(result?.slides) && result.slides.length
          ? result.slides.length * User.creditsPerPptPage()
          : User.creditsPerPptPage()
      );
      const billing = User.buildCreditBilling(originalCredits, userId);
      const chargedCredits = billing.chargedCredits;
      const pptCreditsPerPage = User.creditsPerPptPage();
      const pptCreditsPerImage = User.creditsPerPptImage();
      const billedPageCount = Math.max(Array.isArray(result?.slides) ? result.slides.length : 1, 1);
      User.updateQuota(userId, 'ppt', chargedCredits, {
        note: `PPT生成 ${billedPageCount} 页${User.creditBillingNoteSuffix(billing)}`
      });

      const resultData = {
        ...result,
        billing: {
          ...User.creditBillingMetadata(billing),
          charged_credits: chargedCredits,
          page_credits: originalCredits,
          image_credits: 0,
          page_count: billedPageCount,
          image_count: 0,
          credits_per_page: pptCreditsPerPage,
          credits_per_image: pptCreditsPerImage,
          charge_reason: 'completed_pages_only'
        }
      };

      AiTask.updateStatus(task.id, 'completed', {
        result_url: `/api/files/${path.basename(pptPath)}`,
        result_data: resultData
      });
      StorageLimitService.enforceForUser(userId);

      return { task, result };
    } catch (error) {
      AiTask.updateStatus(task.id, 'failed', {
        error_message: error.message,
        result_data: {
          status: 'failed',
          stage: 'error',
          progress: 0,
          error: error.message
        }
      });
      throw error;
    }
  }

  // 尺寸映射：将比例格式转换为 gpt-image-2 支持的像素尺寸。
  // 约束来自 OpenAI 官方规则：边长为 16 的倍数，最大边 <= 3840，长宽比 <= 3:1，总像素 655K-8.3M。
  static sizeMap = {
    'auto': 'auto',
    '1:1': '1024x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
    '3:2': '1248x832',
    '2:3': '832x1248',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '4:5': '896x1120',
    '5:4': '1120x896',
    '21:9': '1280x544'
  };

  static gptImage2SizeTable = {
    '512px': {
      '1:1': '1024x1024', '16:9': '1536x864', '9:16': '864x1536',
      '3:2': '1248x832', '2:3': '832x1248', '4:3': '1024x768',
      '3:4': '768x1024', '4:5': '896x1120', '5:4': '1120x896',
      '21:9': '1280x544'
    },
    '1k': {
      '1:1': '1024x1024', '16:9': '1536x864', '9:16': '864x1536',
      '3:2': '1248x832', '2:3': '832x1248', '4:3': '1024x768',
      '3:4': '768x1024', '4:5': '896x1120', '5:4': '1120x896',
      '21:9': '1280x544'
    },
    '2k': {
      '1:1': '2048x2048', '16:9': '2048x1152', '9:16': '1152x2048',
      '3:2': '2016x1344', '2:3': '1344x2016', '4:3': '1920x1440',
      '3:4': '1440x1920', '4:5': '1600x2000', '5:4': '2000x1600',
      '21:9': '2560x1088'
    },
    '4k': {
      '1:1': '2880x2880', '16:9': '3840x2160', '9:16': '2160x3840',
      '3:2': '3520x2352', '2:3': '2352x3520', '4:3': '3264x2448',
      '3:4': '2448x3264', '4:5': '2560x3200', '5:4': '3200x2560',
      '21:9': '3840x1648'
    }
  };

  static legacyGptImageSizeMap = {
    'auto': 'auto',
    '1:1': '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '4:3': '1536x1024',
    '3:4': '1024x1536',
    '4:5': '1024x1536',
    '5:4': '1536x1024',
    '21:9': '1536x1024'
  };

  static aspectRatioMap = {
    'auto': [1, 1],
    '1:1': [1, 1],
    '16:9': [16, 9],
    '9:16': [9, 16],
    '3:2': [3, 2],
    '2:3': [2, 3],
    '3:4': [3, 4],
    '4:3': [4, 3],
    '4:5': [4, 5],
    '5:4': [5, 4],
    '21:9': [21, 9]
  };

  static resolutionLongEdgeMap = {
    '512px': 1024,
    '1k': 1024,
    '2k': 2048,
    '4k': 3840
  };

  static async generateImage({
    userId,
    prompt,
    params,
    referenceImage = null,
    referenceImages = null,
    task: existingTask = null,
    manageFailureStatus = true,
    originalPrompt = prompt
  }) {
    const normalizedReferenceImages = this.normalizeReferenceImagesInput(referenceImages, referenceImage);
    const hasReferenceImage = normalizedReferenceImages.length > 0;
    const requestedTemplateType = params?.templateType || '';
    const shouldPreservePrompt = params?.skipTemplateEnhancement
      || ImageTemplateService.shouldPreservePrompt(prompt)
      || (hasReferenceImage && (!requestedTemplateType || requestedTemplateType === 'auto' || requestedTemplateType === 'none'));
    const referencePromptContext = hasReferenceImage
      ? this.buildReferenceImagePromptContext(normalizedReferenceImages)
      : '';
    const promptEnhancement = shouldPreservePrompt
      ? {
          prompt: referencePromptContext
            ? `${referencePromptContext}\n\n${String(prompt || '').trim()}`.trim()
            : String(prompt || '').trim(),
          templateType: requestedTemplateType && requestedTemplateType !== 'auto' && requestedTemplateType !== 'none' ? requestedTemplateType : '',
          templateLabel: ''
        }
      : ImageTemplateService.buildPromptEnhancement(prompt, params?.templateType);
    if (referencePromptContext && promptEnhancement.prompt && !promptEnhancement.prompt.includes('参考图使用规则：')) {
      promptEnhancement.prompt = `${referencePromptContext}\n\n${promptEnhancement.prompt}`.trim();
    }
    const enhancedPrompt = promptEnhancement.prompt;
    const task = existingTask || AiTask.create({
      userId,
      type: 'image',
      prompt: enhancedPrompt,
      params
    });

    try {
      AiTask.updateStatus(task.id, 'processing', {
        result_data: {
          status: 'processing',
          stage: 'generating',
          progress: 15,
          attempt: params?._attempt,
          max_attempts: params?._maxAttempts,
          retry_mode: params?.retryMode || '',
          message: params?.retryMode === 'compact'
            ? '已自动降低提示词复杂度，正在重新提交图片模型...'
            : '图片生成任务已提交，正在等待模型返回结果...'
        }
      });
      const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
      const outputFormat = params?.output_format || runtimeConfig.imageOutputFormat || 'png';
      const referenceAssets = await this.resolveReferenceImageAssets(normalizedReferenceImages);

      const responseData = referenceAssets.length
        ? await this.requestImageEdit({
            userId,
            taskId: task.id,
            prompt: enhancedPrompt,
            params,
            outputFormat,
            referenceAssets,
            runtimeConfig
          })
        : await this.requestImageGeneration({
            userId,
            taskId: task.id,
            prompt: enhancedPrompt,
            params,
            outputFormat,
            runtimeConfig
          });

      const images = this.normalizeGeneratedImages(responseData, outputFormat);
      const savedImages = await this.saveGeneratedImages({
        images,
        taskId: task.id,
        userId,
        outputFormat
      });

      const imageCount = savedImages.length;
      const originalCredits = User.estimateImageCredits(imageCount);
      const billing = User.buildCreditBilling(originalCredits, userId);
      const chargedCredits = billing.chargedCredits;
      const imageCreditsPerImage = User.creditsPerImage();
      User.updateQuota(userId, 'image', chargedCredits, {
        note: `图片生成 ${imageCount} 张${User.creditBillingNoteSuffix(billing)}`
      });

      AiTask.updateStatus(task.id, 'completed', {
        result_url: JSON.stringify(savedImages.map(img => img.url)),
        result_data: { 
          images: savedImages, 
          prompt: enhancedPrompt,
          original_prompt: originalPrompt,
          template_type: promptEnhancement.templateType,
          template_label: promptEnhancement.templateLabel,
          retry_mode: params?.retryMode || '',
          attempt: params?._attempt,
          max_attempts: params?._maxAttempts,
          reference_image_used: referenceAssets.length > 0,
          reference_image_count: referenceAssets.length,
          reference_image_label: normalizedReferenceImages[0]?.label || '',
          reference_image_labels: normalizedReferenceImages.map(item => item.label || '').filter(Boolean),
          billing: {
            ...User.creditBillingMetadata(billing),
            charged_credits: chargedCredits,
            image_count: imageCount,
            credits_per_image: imageCreditsPerImage,
            retry_charged_credits: 0,
            charge_reason: 'completed_images_only'
          }
        }
      });
      StorageLimitService.enforceForUser(userId);

      return { task, result: { images: savedImages } };
    } catch (error) {
      if (manageFailureStatus) {
        AiTask.updateStatus(task.id, 'failed', {
          error_message: error.message,
          result_data: {
            status: 'failed',
            stage: 'error',
            progress: 0,
            error: error.message,
            retry_mode: params?.retryMode || '',
            attempt: params?._attempt,
            max_attempts: params?._maxAttempts
          }
        });
      }
      throw error;
    }
  }

  static resolveImageSize(params = {}, model = '') {
    const rawSize = params?.size || process.env.IMAGE_SIZE || '1:1';
    const resolution = this.normalizeImageResolution(params?.resolution || params?.imageSize || params?.image_size || 'auto');
    const aspectRatio = this.normalizeAspectRatio(params?.aspectRatio || params?.aspect_ratio || rawSize);
    if (resolution === 'auto') {
      if (aspectRatio === 'auto') {
        return this.sizeMap[rawSize] || this.legacyGptImageSizeMap[rawSize] || rawSize;
      }
      if (this.isGptImage2Model(model)) {
        return this.sizeMap[aspectRatio] || this.sizeMap[rawSize] || rawSize;
      }
      if (this.isGptImageModel(model)) {
        return this.legacyGptImageSizeMap[aspectRatio] || this.legacyGptImageSizeMap[rawSize] || rawSize;
      }
      return this.sizeMap[aspectRatio] || this.sizeMap[rawSize] || rawSize;
    }

    if (!this.aspectRatioMap[aspectRatio]) {
      return this.sizeMap[rawSize] || this.legacyGptImageSizeMap[rawSize] || rawSize;
    }

    if (this.isGptImage2Model(model)) {
      return this.gptImage2SizeTable[resolution]?.[aspectRatio] || this.buildResolvedImageSize(aspectRatio, resolution);
    }
    if (this.isGptImageModel(model)) {
      return this.legacyGptImageSizeMap[aspectRatio] || this.sizeMap[rawSize] || rawSize;
    }
    return this.buildResolvedImageSize(aspectRatio, resolution);
  }

  static normalizeImageResolution(value = 'auto') {
    const normalized = String(value || 'auto').trim().toLowerCase().replace(/\s+/g, '');
    return this.resolutionLongEdgeMap[normalized] ? normalized : 'auto';
  }

  static normalizeAspectRatio(value = 'auto') {
    const normalized = String(value || 'auto').trim().toLowerCase().replace(/：/g, ':');
    return this.aspectRatioMap[normalized] ? normalized : 'auto';
  }

  static buildResolvedImageSize(aspectRatio, resolution) {
    const ratio = this.aspectRatioMap[aspectRatio] || this.aspectRatioMap.auto;
    const longEdge = this.resolutionLongEdgeMap[resolution] || this.resolutionLongEdgeMap['1k'];
    const maxPixels = 8294400;
    const roundTo16 = value => Math.max(16, Math.round(value / 16) * 16);

    let width;
    let height;
    if (ratio[0] >= ratio[1]) {
      width = longEdge;
      height = longEdge * ratio[1] / ratio[0];
    } else {
      height = longEdge;
      width = longEdge * ratio[0] / ratio[1];
    }

    width = roundTo16(width);
    height = roundTo16(height);

    if (width * height > maxPixels) {
      const scale = Math.sqrt(maxPixels / (width * height));
      width = Math.max(16, Math.floor((width * scale) / 16) * 16);
      height = Math.max(16, Math.floor((height * scale) / 16) * 16);
    }

    return `${width}x${height}`;
  }

  static isLocalImageProvider(imageConfig = {}) {
    const baseUrl = String(imageConfig.baseUrl || '').toLowerCase();
    const model = String(imageConfig.model || '').toLowerCase();
    return baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost') || model.startsWith('local-') || model.includes('openvino');
  }

  static resolveLocalImageSize(params = {}) {
    const aspectRatio = String(params?.aspectRatio || params?.size || '1:1').trim();
    const ratio = this.aspectRatioMap[aspectRatio] || this.aspectRatioMap['1:1'];
    const maxEdge = Math.min(Math.max(parseInt(process.env.LOCAL_IMAGE_MAX_SIZE || appConfig.localImageMaxSize || 512, 10) || 512, 256), 1024);
    let width = maxEdge;
    let height = maxEdge;
    if (ratio && ratio.length === 2) {
      const [rw, rh] = ratio;
      if (rw >= rh) {
        width = maxEdge;
        height = Math.max(256, Math.round((maxEdge * rh / rw) / 8) * 8);
      } else {
        height = maxEdge;
        width = Math.max(256, Math.round((maxEdge * rw / rh) / 8) * 8);
      }
    }
    width = Math.max(256, Math.min(1024, Math.round(width / 8) * 8));
    height = Math.max(256, Math.min(1024, Math.round(height / 8) * 8));
    return `${width}x${height}`;
  }

  static isGptImageModel(model = '') {
    return String(model || '').trim().toLowerCase().startsWith('gpt-image-');
  }

  static isGptImage2Model(model = '') {
    return String(model || '').trim().toLowerCase().startsWith('gpt-image-2');
  }

  static buildReferenceImagePromptContext(referenceImages = []) {
    const images = this.normalizeReferenceImagesInput(referenceImages).slice(0, 16);
    if (!images.length) return '';

    const lines = [
      '参考图使用规则：',
      `- 本次提供 ${images.length} 张参考图，请只参考本次请求附带的图片，不要沿用任何历史图片或旧任务内容。`,
      '- 多张参考图同时使用：优先保留用户文字需求，其次参考图片中的主体、构图、材质、配色和风格；不要把不同参考图的无关主体强行混在一起。',
      '- 如果用户要求改图，请保持参考图中被点名的身份、产品、布局或风格一致；未点名的旧元素不要自动保留。'
    ];

    const labels = images
      .map((item, index) => `${index + 1}. ${item.label || item.kind || '参考图'}`)
      .join('；');
    if (labels) {
      lines.push(`- 参考图列表：${labels}`);
    }

    return lines.join('\n');
  }

  static async requestImageGeneration({ userId, taskId, prompt, params, outputFormat, runtimeConfig }) {
    const routeCandidates = this.getImageRouterCandidates(runtimeConfig);
    if (routeCandidates.length) {
      return await AiRouterService.withCandidate({
        route: 'image',
        userId,
        messages: [{ role: 'user', content: prompt }],
        params: { ...(params || {}), sticky_key: `image_task_${taskId}` },
        candidates: routeCandidates,
        queueTimeoutMs: parseInt(params?.queue_timeout_ms || params?.queueTimeoutMs || 5000, 10) || 5000,
        isRetryable: error => this.shouldTryImageProviderFallback(error)
      }, async candidate => {
        const imageConfig = this.imageRuntimeConfigFromCandidate(candidate, runtimeConfig);
        try {
          return await this.performImageGenerationRequest({
            userId,
            taskId,
            prompt,
            params,
            outputFormat,
            imageConfig
          });
        } catch (error) {
          throw this.normalizeImageProviderError(error, 'generation', imageConfig);
        }
      });
    }

    const providers = this.orderProvidersByHealthHint(
      this.getImageProviderConfigs(runtimeConfig),
      AiHealthMonitorService.getRoutingHint('image')
    );
    let lastError = null;

    for (let index = 0; index < providers.length; index += 1) {
      const imageConfig = providers[index];
      try {
        return await this.performImageGenerationRequest({
          userId,
          taskId,
          prompt,
          params,
          outputFormat,
          imageConfig
        });
      } catch (error) {
        lastError = this.normalizeImageProviderError(error, 'generation', imageConfig);
        if (index < providers.length - 1 && this.shouldTryImageProviderFallback(lastError)) {
          console.warn('[Image Generation] primary provider failed, trying fallback:', this.safeImageError(lastError));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('图片生成请求失败');
  }

  static async performImageGenerationRequest({ userId, taskId, prompt, params, outputFormat, imageConfig }) {
    const resolvedSize = this.isLocalImageProvider(imageConfig)
      ? this.resolveLocalImageSize(params)
      : this.resolveImageSize(params, imageConfig.model);
    const requestedN = Math.max(1, Math.min(parseInt(params?.n, 10) || 1, 4));
    const requestBody = {
      model: imageConfig.model,
      prompt,
      size: resolvedSize,
      quality: params?.quality || imageConfig.quality,
      n: requestedN,
      output_format: outputFormat,
      moderation: 'low',
      user: `user_${userId}_task_${taskId}`
    };
    this.applyOptionalImageRequestParams(requestBody, params, imageConfig.model);

    let response;
    try {
      response = await axios.post(
        `${imageConfig.baseUrl}/images/generations`,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${imageConfig.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: imageConfig.timeoutMs
        }
      );
    } catch (error) {
      if (requestedN > 1 && this.isImageMultiOutputUnsupportedError(error)) {
        response = await axios.post(
          `${imageConfig.baseUrl}/images/generations`,
          { ...requestBody, n: 1 },
          {
            headers: {
              'Authorization': `Bearer ${imageConfig.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: imageConfig.timeoutMs
          }
        );
      } else {
        throw error;
      }
    }
    return {
      ...this.parseProviderResponseBody(response.data),
      _image_provider: this.safeImageProviderInfo(imageConfig)
    };
  }

  static isImageMultiOutputUnsupportedError(error) {
    const status = error?.response?.status;
    if (![400, 422].includes(status)) return false;
    const detail = [
      this.extractProviderErrorMessage(error?.response?.data || ''),
      typeof error?.response?.data === 'string' ? error.response.data : JSON.stringify(error?.response?.data || {}),
      error?.message || ''
    ].join(' ').toLowerCase();
    return /\bn\b|multiple|multi|only.*1|at most 1|must be 1|unsupported|invalid/.test(detail);
  }

  static async requestImageEdit({ userId, taskId, prompt, params, outputFormat, referenceAsset, referenceAssets, runtimeConfig }) {
    const routeCandidates = this.getImageRouterCandidates(runtimeConfig);
    if (routeCandidates.length) {
      return await AiRouterService.withCandidate({
        route: 'image',
        userId,
        messages: [{ role: 'user', content: prompt }],
        params: { ...(params || {}), sticky_key: `image_task_${taskId}` },
        candidates: routeCandidates,
        queueTimeoutMs: parseInt(params?.queue_timeout_ms || params?.queueTimeoutMs || 5000, 10) || 5000,
        isRetryable: error => this.shouldTryImageProviderFallback(error)
      }, async candidate => {
        const imageConfig = this.imageRuntimeConfigFromCandidate(candidate, runtimeConfig);
        const assets = Array.isArray(referenceAssets) && referenceAssets.length
          ? referenceAssets
          : (referenceAsset ? [referenceAsset] : []);
        try {
          return await this.performImageEditRequest({
            userId,
            taskId,
            prompt,
            params,
            outputFormat,
            referenceAssets: assets,
            imageConfig
          });
        } catch (error) {
          throw this.normalizeImageProviderError(error, 'edit', imageConfig);
        }
      });
    }

    const providers = this.orderProvidersByHealthHint(
      this.getImageProviderConfigs(runtimeConfig),
      AiHealthMonitorService.getRoutingHint('image')
    );
    const assets = Array.isArray(referenceAssets) && referenceAssets.length
      ? referenceAssets
      : (referenceAsset ? [referenceAsset] : []);
    let lastError = null;

    for (let index = 0; index < providers.length; index += 1) {
      const imageConfig = providers[index];

      try {
        return await this.performImageEditRequest({
          userId,
          taskId,
          prompt,
          params,
          outputFormat,
          referenceAssets: assets,
          imageConfig
        });
      } catch (error) {
        lastError = this.normalizeImageProviderError(error, 'edit', imageConfig);
        if (index < providers.length - 1 && this.shouldTryImageProviderFallback(lastError)) {
          console.warn('[Image Edit] primary provider failed, trying fallback:', this.safeImageError(lastError));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('参考图编辑请求失败');
  }

  static async performImageEditRequest({ userId, taskId, prompt, params, outputFormat, referenceAssets, imageConfig }) {
    const assets = Array.isArray(referenceAssets) ? referenceAssets : [];
    const resolvedSize = this.isLocalImageProvider(imageConfig)
      ? this.resolveLocalImageSize(params)
      : this.resolveImageSize(params, imageConfig.model);
    const formData = this.buildImageEditFormData({
      imageConfig,
      prompt,
      params,
      size: resolvedSize,
      outputFormat,
      referenceAssets: assets,
      userId,
      taskId
    });

    console.log('[Image Edit] request', {
      channel: imageConfig.channel,
      baseUrl: imageConfig.baseUrl,
      model: imageConfig.model,
      size: resolvedSize,
      quality: params?.quality || imageConfig.quality,
      n: params?.n || 1,
      outputFormat,
      referenceCount: assets.length,
      referenceMimeTypes: assets.map(asset => asset.mimeType),
      referenceBytes: assets.reduce((total, asset) => total + asset.buffer.length, 0),
      promptChars: String(prompt || '').length
    });

    const response = await axios.post(
      `${imageConfig.baseUrl}/images/edits`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${imageConfig.apiKey}`,
          ...formData.getHeaders()
        },
        timeout: imageConfig.timeoutMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true
      }
    );

    if (response.status < 200 || response.status >= 300) {
      const error = new Error(this.extractProviderErrorMessage(response.data) || `参考图编辑请求失败 (${response.status})`);
      error.response = {
        status: response.status,
        data: this.parseProviderResponseBody(response.data)
      };
      throw error;
    }

    return {
      ...this.parseProviderResponseBody(response.data),
      _image_provider: this.safeImageProviderInfo(imageConfig)
    };
  }

  static buildImageEditFormData({ imageConfig, prompt, params, size, outputFormat, referenceAsset, referenceAssets, userId, taskId }) {
    const formData = new NodeFormData();
    const assets = Array.isArray(referenceAssets) && referenceAssets.length
      ? referenceAssets
      : (referenceAsset ? [referenceAsset] : []);
    formData.append('model', imageConfig.model);
    formData.append('prompt', prompt);
    formData.append('size', size);
    formData.append('quality', params?.quality || imageConfig.quality);
    formData.append('n', String(params?.n || 1));
    formData.append('output_format', outputFormat);
    formData.append('moderation', 'low');
    formData.append('user', `user_${userId}_task_${taskId}`);
    this.applyOptionalImageRequestParams(formData, params, imageConfig.model);
    assets.forEach(referenceAsset => {
      formData.append(assets.length === 1 ? 'image' : 'image[]', referenceAsset.buffer, {
        filename: referenceAsset.filename,
        contentType: referenceAsset.mimeType,
        knownLength: referenceAsset.buffer.length
      });
    });
    return formData;
  }

  static applyOptionalImageRequestParams(target, params = {}, model = '') {
    const optionalParams = {
      background: params?.background,
      input_fidelity: params?.input_fidelity || params?.inputFidelity,
      output_compression: params?.output_compression || params?.outputCompression
    };

    Object.entries(optionalParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      const normalized = String(value).trim();
      if (!normalized) return;
      const normalizedLower = normalized.toLowerCase();
      if (this.isGptImage2Model(model) && key === 'input_fidelity') return;
      if (this.isGptImage2Model(model) && key === 'background' && normalizedLower === 'transparent') return;

      if (target && typeof target.append === 'function') {
        target.append(key, normalized);
      } else if (target && typeof target === 'object') {
        target[key] = key === 'output_compression' ? (parseInt(normalized, 10) || normalized) : normalized;
      }
    });
  }

  static getImageProviderConfigs(runtimeConfig = {}) {
    const providers = [this.getImageRuntimeConfig(runtimeConfig, 'primary')];
    const fallbackEnabled = runtimeConfig.imageFailoverEnabled !== false;
    const fallbackBaseUrl = this.normalizeOpenAiCompatibleBaseUrl(runtimeConfig.imageFallbackBaseUrl || '');
    const fallbackApiKey = runtimeConfig.imageFallbackApiKey || runtimeConfig.anthropicFallbackApiKey || runtimeConfig.providerApiKey;

    if (fallbackEnabled && fallbackBaseUrl && fallbackApiKey) {
      const fallbackConfig = this.getImageRuntimeConfig(runtimeConfig, 'fallback');
      const primaryKey = `${providers[0].baseUrl}|${providers[0].apiKey}|${providers[0].model}`;
      const fallbackKey = `${fallbackConfig.baseUrl}|${fallbackConfig.apiKey}|${fallbackConfig.model}`;
      if (fallbackKey !== primaryKey) {
        providers.push(fallbackConfig);
      }
    }

    return providers;
  }

  static getImageRouterCandidates(runtimeConfig = {}) {
    try {
      const routeConfig = RuntimeConfigService.resolveModelRoute(runtimeConfig, 'image', {
        category: 'image',
        providerId: runtimeConfig.imageProviderId,
        fallbackProviderIds: runtimeConfig.imageFallbackProviderIds,
        fallbackModels: runtimeConfig.imageFallbackModels,
        model: runtimeConfig.imageModel,
        timeoutMs: runtimeConfig.imageTimeoutMs
      });
      return this.orderCandidatesByHealthHint(
        routeConfig.candidates || [],
        AiHealthMonitorService.getRoutingHint('image')
      )
        .filter(candidate => candidate.format === 'openai')
        .map(candidate => ({
          ...candidate,
          channel: candidate.role || 'pool',
          timeoutMs: Math.max(parseInt(candidate.timeoutMs || runtimeConfig.imageTimeoutMs, 10) || 600000, 120000)
        }));
    } catch (error) {
      return [];
    }
  }

  static imageRuntimeConfigFromCandidate(candidate = {}, runtimeConfig = {}) {
    const provider = candidate.provider || {};
    const baseUrl = this.normalizeOpenAiCompatibleBaseUrl(provider.baseUrl || runtimeConfig.imageBaseUrl || '');
    const apiKey = provider.apiKey || runtimeConfig.imageApiKey || runtimeConfig.providerApiKey;
    if (!baseUrl || !apiKey) {
      throw new Error('图片生成缺少 Base URL 或 API Key');
    }
    return {
      id: provider.id || candidate.providerId || '',
      name: provider.name || candidate.providerName || '',
      channel: candidate.role || candidate.channel || 'pool',
      baseUrl,
      apiKey,
      model: candidate.model || runtimeConfig.imageModel || 'gpt-image-2',
      quality: runtimeConfig.imageQuality || 'high',
      timeoutMs: Math.max(parseInt(candidate.timeoutMs || runtimeConfig.imageTimeoutMs, 10) || 600000, 120000)
    };
  }

  static getImageRuntimeConfig(runtimeConfig = {}, channel = 'primary') {
    const isFallback = channel === 'fallback';
    if (!isFallback && runtimeConfig.imageProviderFormat && runtimeConfig.imageProviderFormat !== 'openai') {
      throw new Error('图片生成需要选择 OpenAI 兼容供应商');
    }

    const baseUrl = this.normalizeOpenAiCompatibleBaseUrl(isFallback
      ? runtimeConfig.imageFallbackBaseUrl
      : (runtimeConfig.imageBaseUrl || (appConfig.imageOnlyMode ? 'http://127.0.0.1:18080/v1' : 'https://timebackward.com/v1')));
    const apiKey = isFallback
      ? (runtimeConfig.imageFallbackApiKey || runtimeConfig.anthropicFallbackApiKey || runtimeConfig.providerApiKey)
      : (runtimeConfig.imageApiKey || runtimeConfig.anthropicFallbackApiKey || runtimeConfig.providerApiKey);

    if (!baseUrl || !apiKey) {
      throw new Error('图片生成缺少 Base URL 或 API Key');
    }

    return {
      channel: isFallback ? 'fallback' : 'primary',
      baseUrl,
      apiKey,
      model: isFallback ? (runtimeConfig.imageFallbackModel || runtimeConfig.imageModel || 'gpt-image-2') : (runtimeConfig.imageModel || 'gpt-image-2'),
      quality: runtimeConfig.imageQuality || 'high',
      timeoutMs: Math.max(parseInt(runtimeConfig.imageTimeoutMs, 10) || 600000, 120000)
    };
  }

  static orderProvidersByHealthHint(providers = [], hint = null) {
    if (!hint?.provider_id && !hint?.channel) return providers;
    if (!Array.isArray(providers) || providers.length < 2) return providers;

    const targetIndex = providers.findIndex(provider => {
      const sameId = hint.provider_id && provider.id === hint.provider_id;
      const sameChannel = hint.channel && provider.channel === hint.channel;
      const sameName = hint.provider_name && provider.name === hint.provider_name;
      return sameId || sameChannel || sameName;
    });
    if (targetIndex <= 0) return providers;

    const annotated = providers.map((provider, index) => ({
      ...provider,
      _failoverOriginalIndex: Number.isInteger(provider._failoverOriginalIndex) ? provider._failoverOriginalIndex : index,
      _failoverOriginalRole: provider._failoverOriginalRole || provider.channel || (index === 0 ? 'primary' : 'fallback')
    }));
    const [target] = annotated.splice(targetIndex, 1);
    return [target, ...annotated];
  }

  static orderCandidatesByHealthHint(candidates = [], hint = null) {
    if (!hint?.provider_id && !hint?.channel && !hint?.model) return candidates;
    if (!Array.isArray(candidates) || candidates.length < 2) return candidates;

    const targetIndex = candidates.findIndex(candidate => {
      const provider = candidate.provider || {};
      const sameId = hint.provider_id && (candidate.providerId === hint.provider_id || provider.id === hint.provider_id);
      const sameChannel = hint.channel && (candidate.channel === hint.channel || candidate.role === hint.channel);
      const sameName = hint.provider_name && (candidate.providerName === hint.provider_name || provider.name === hint.provider_name);
      const sameModel = !hint.model || candidate.model === hint.model;
      return sameModel && (sameId || sameChannel || sameName);
    });
    if (targetIndex <= 0) return candidates;

    const bestPriority = candidates.reduce((min, candidate) => {
      const priority = Number(candidate.priority ?? 100);
      return Number.isFinite(priority) ? Math.min(min, priority) : min;
    }, 100);

    return candidates
      .map((candidate, index) => {
        if (index !== targetIndex) return candidate;
        return {
          ...candidate,
          priority: bestPriority - 1000,
          _healthHintPriority: candidate.priority
        };
      })
      .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0)
        || Number(right.weight || 0) - Number(left.weight || 0)
        || Number(left._orderIndex || 0) - Number(right._orderIndex || 0));
  }

  static normalizeImageProviderError(error, operation, imageConfig) {
    if (error?.imageOperation && error?.imageProvider) return error;

    const providerData = this.parseProviderResponseBody(error?.response?.data);
    const message = this.extractProviderErrorMessage(providerData)
      || this.extractProviderErrorMessage(error?.response?.data)
      || error?.cause?.message
      || error?.message
      || '图片服务请求失败';
    const normalizedError = new Error(message);
    normalizedError.code = error?.code;
    normalizedError.response = error?.response
      ? {
          status: error.response.status,
          data: providerData
        }
      : undefined;
    normalizedError.imageOperation = operation;
    normalizedError.imageProvider = this.safeImageProviderInfo(imageConfig);
    normalizedError.imageFailureKind = this.classifyImageProviderError({
      status: normalizedError.response?.status,
      code: normalizedError.code,
      message,
      data: providerData
    });
    normalizedError.nonBillable = true;
    return normalizedError;
  }

  static shouldTryImageProviderFallback(error) {
    if (this.isImageSafetyPolicyError(error)) return false;
    if (this.isImageProviderQuotaError(error)) return true;
    if ([400, 401, 403, 404].includes(error?.response?.status)) return true;
    return this.isRetryableProviderError(error);
  }

  static classifyImageProviderError({ status, code, message, data } = {}) {
    const haystack = [
      status,
      code,
      message,
      data?.error?.code,
      data?.error?.type,
      data?.error?.message,
      data?.code,
      data?.type,
      data?.message,
      data?.detail,
      data?.title
    ].filter(value => value !== undefined && value !== null).join(' ').toLowerCase();

    if (this.isImageSafetyPolicyText(haystack)) return 'safety_policy';
    if (this.isImageProviderQuotaText(haystack)) return 'provider_quota';
    return 'provider_error';
  }

  static isImageSafetyPolicyError(error) {
    if (error?.imageFailureKind === 'safety_policy') return true;
    const providerData = this.parseProviderResponseBody(error?.response?.data);
    return this.classifyImageProviderError({
      status: error?.response?.status,
      code: error?.code || providerData?.error?.code || providerData?.code,
      message: error?.message,
      data: providerData
    }) === 'safety_policy';
  }

  static isImageProviderQuotaError(error) {
    if (error?.imageFailureKind === 'provider_quota') return true;
    const providerData = this.parseProviderResponseBody(error?.response?.data);
    return this.classifyImageProviderError({
      status: error?.response?.status,
      code: error?.code || providerData?.error?.code || providerData?.code,
      message: error?.message,
      data: providerData
    }) === 'provider_quota';
  }

  static isImageTransientQuotaReservationError(error) {
    const providerData = this.parseProviderResponseBody(error?.response?.data);
    const haystack = [
      error?.code,
      error?.response?.status,
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

    return [
      'insufficient_user_quota',
      'pre_consume_token_quota_failed',
      '预扣费额度失败',
      '需要预扣费额度'
    ].some(token => haystack.includes(String(token).toLowerCase()));
  }

  static isImageSafetyPolicyText(text = '') {
    const normalized = String(text || '').toLowerCase();
    return [
      'content_policy_violation',
      'content_policy',
      'content filter',
      'content_filter',
      'safety system',
      'safety_policy',
      'moderation',
      'policy_violation',
      'not allowed',
      'disallowed',
      'prohibited',
      'blocked by',
      'request was rejected',
      'violates',
      '违规',
      '审核',
      '安全策略',
      '内容安全',
      '不合规',
      '敏感内容',
      '风险内容',
      '禁止生成',
      '无法生成该内容'
    ].some(token => normalized.includes(token));
  }

  static isImageProviderQuotaText(text = '') {
    const normalized = String(text || '').toLowerCase();
    return [
      'pre_consume_token_quota_failed',
      'quota',
      'insufficient_quota',
      'insufficient funds',
      'insufficient balance',
      'billing',
      'balance',
      '预扣费',
      '剩余额度',
      '额度不足',
      '余额不足',
      '账户余额',
      '可用余额'
    ].some(token => normalized.includes(token));
  }

  static isRetryableProviderError(error) {
    const status = error?.response?.status;
    if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) {
      return true;
    }

    const code = String(error?.code || '').toUpperCase();
    return ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ESTREAMFIRSTTOKENTIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
  }

  static safeImageProviderInfo(imageConfig = {}) {
    return {
      channel: imageConfig.channel || 'primary',
      id: imageConfig.id || '',
      name: imageConfig.name || '',
      baseUrl: imageConfig.baseUrl || '',
      model: imageConfig.model || ''
    };
  }

  static safeImageError(error) {
    const status = error?.response?.status;
    const provider = error?.imageProvider || {};
    return [
      provider.channel ? `channel=${provider.channel}` : '',
      provider.baseUrl ? `provider=${provider.baseUrl}` : '',
      status ? `status=${status}` : '',
      error?.code ? `code=${error.code}` : '',
      error?.message || ''
    ].filter(Boolean).join(' ');
  }

  static normalizeOpenAiCompatibleBaseUrl(baseUrl = '') {
    const normalized = String(baseUrl || '').replace(/\/+$/, '');
    if (!normalized) return '';
    if (/\/v1$/i.test(normalized)) return normalized;
    return `${normalized}/v1`;
  }

  static normalizeKlingBaseUrl(baseUrl = '') {
    return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  }

  static isKlingVideoModel(model = '') {
    return /^kling[-_/]/i.test(String(model || '').trim());
  }

  static inferVideoProviderFormat(format = '', model = '') {
    const normalizedFormat = String(format || '').trim().toLowerCase();
    if (normalizedFormat === 'kling') return 'kling';
    if (normalizedFormat === 'openai') return 'openai';
    if (this.isKlingVideoModel(model)) return 'kling';
    return normalizedFormat || 'openai';
  }

  static runtimeVideoProviderFormat(runtimeConfig = {}) {
    return this.inferVideoProviderFormat(runtimeConfig.videoProviderFormat, runtimeConfig.videoModel);
  }

  static resolveKlingVideoModelForRequest(params = {}, runtimeConfig = {}) {
    const endpoint = this.resolveKlingVideoEndpoint(params);
    const requestedTier = String(params?.tier || params?.model_tier || params?.modelTier || '').trim().toLowerCase();
    const requestedModel = String(params?.model_name || params?.model || runtimeConfig.videoModel || '').trim().toLowerCase();
    if (requestedTier === 'lite' && endpoint !== 'omni-video') return 'kling-v2-5-turbo';
    if (/kling-v2-5|turbo/.test(requestedModel) && endpoint !== 'omni-video') return 'kling-v2-5-turbo';
    if (endpoint === 'omni-video') return 'kling-v3-omni';
    return 'kling-v3';
  }

  static withResolvedVideoCandidateModels(candidates = [], params = {}, runtimeConfig = {}) {
    return (Array.isArray(candidates) ? candidates : []).map(candidate => {
      const format = this.inferVideoProviderFormat(
        candidate.format || candidate.provider?.format || runtimeConfig.videoProviderFormat,
        candidate.model || runtimeConfig.videoModel
      );
      if (format !== 'kling') return candidate;
      const model = this.resolveKlingVideoModelForRequest(params, {
        ...runtimeConfig,
        videoModel: candidate.model || runtimeConfig.videoModel
      });
      return {
        ...candidate,
        format,
        model,
        modelName: model,
        qualifiedId: `${candidate.providerId || candidate.provider?.id || ''}/${model}`
      };
    });
  }

  static normalizeGeneratedImages(responseData, outputFormat) {
    if (!responseData || !Array.isArray(responseData.data) || responseData.data.length === 0) {
      throw this.createImageEmptyResultError();
    }

    const images = responseData.data
      .filter(item => item && item.b64_json)
      .map(item => ({
        b64_json: item.b64_json
      }));
    if (!images.length) {
      throw this.createImageEmptyResultError();
    }
    return images;
  }

  static createImageEmptyResultError(message = '图片服务未返回可用结果') {
    const error = new Error(message);
    error.code = 'IMAGE_EMPTY_RESULT';
    error.imageFailureKind = 'empty_result';
    error.nonBillable = true;
    return error;
  }

  static extractProviderErrorMessage(body) {
    const parsed = this.parseProviderResponseBody(body);
    const message = parsed?.error?.message || parsed?.message || parsed?.title || '';
    if (message) return String(message).slice(0, 240);
    const contentText = this.extractTextValue(parsed);
    if (contentText) {
      if (/Error code\s*524|524:\s*A timeout occurred|Error 524|A timeout occurred/i.test(contentText)) {
        return '图片服务超时（524），上游长时间未返回结果';
      }
      return contentText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    }
    if (typeof body === 'string' && /Error code\s*524|524:\s*A timeout occurred|A timeout occurred/i.test(body)) {
      return '图片服务超时（524），上游长时间未返回结果';
    }
    if (typeof body === 'string' && body.trim()) {
      return body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    }
    return '';
  }

  static async saveGeneratedImages({ images, taskId, userId, outputFormat }) {
    const savedImages = [];
    const extension = this.getImageExtension(outputFormat);
    const userDir = path.join(UPLOAD_DIR, userId.toString());
    const previewDir = path.join(userDir, 'previews');

    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(previewDir, { recursive: true });

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const filename = `${taskId}_${i}.${extension}`;
      const previewFilename = `${taskId}_${i}_preview.webp`;
      const imagePath = path.join(userDir, filename);
      const previewPath = path.join(previewDir, previewFilename);
      const imageBuffer = Buffer.from(imageData.b64_json, 'base64');

      fs.writeFileSync(imagePath, imageBuffer);
      const previewUrl = await this.createImagePreview({
        sourcePath: imagePath,
        previewPath,
        fallbackUrl: appConfig.pathToUploadUrl(imagePath)
      });

      savedImages.push({
        filename,
        preview_filename: previewFilename,
        url: appConfig.pathToUploadUrl(imagePath),
        preview_url: previewUrl
      });
    }

    return savedImages;
  }

  static async createImagePreview({ sourcePath, previewPath, fallbackUrl }) {
    try {
      const resolvedSourcePath = appConfig.assertInsideUploadDir(sourcePath);
      const resolvedPreviewPath = appConfig.assertInsideUploadDir(previewPath);

      fs.mkdirSync(path.dirname(resolvedPreviewPath), { recursive: true });

      await sharp(resolvedSourcePath)
        .rotate()
        .resize({
          width: IMAGE_PREVIEW_WIDTH,
          withoutEnlargement: true
        })
        .webp({
          quality: IMAGE_PREVIEW_QUALITY,
          effort: 4
        })
        .toFile(resolvedPreviewPath);
      return appConfig.pathToUploadUrl(resolvedPreviewPath);
    } catch (error) {
      console.warn('[AiService] 图片预览生成失败，回退原图:', error.message);
      return fallbackUrl;
    }
  }

  static async backfillImagePreviewsOnStartup({ batchSize = 50 } = {}) {
    const summary = {
      scanned: 0,
      updated: 0,
      previewsCreated: 0,
      originalsRecovered: 0,
      dataUrlsRemoved: 0,
      skipped: 0,
      errors: 0
    };
    const safeBatchSize = Math.min(Math.max(parseInt(batchSize, 10) || 50, 1), 200);
    let afterId = 0;

    while (true) {
      const tasks = AiTask.findCompletedImageTasksForPreviewMigration({
        limit: safeBatchSize,
        afterId,
        includeConverted: true
      });

      if (!tasks.length) break;

      for (const task of tasks) {
        afterId = Math.max(afterId, Number(task.id) || afterId);
        summary.scanned += 1;

        try {
          const result = await this.migrateImageTaskPreview(task);
          if (result.updated) summary.updated += 1;
          if (result.skipped) summary.skipped += 1;
          summary.previewsCreated += result.previewsCreated;
          summary.originalsRecovered += result.originalsRecovered;
          summary.dataUrlsRemoved += result.dataUrlsRemoved;
        } catch (error) {
          summary.errors += 1;
          console.warn(`[Startup] 图片任务 ${task.id} 预览补转失败:`, error.message);
        }
      }

      if (tasks.length < safeBatchSize) break;
    }

    if (summary.scanned > 0 || summary.errors > 0) {
      console.log(
        `[Startup] 图片预览补转完成：扫描 ${summary.scanned} 个任务，更新 ${summary.updated} 个，生成预览 ${summary.previewsCreated} 张，恢复原图 ${summary.originalsRecovered} 张，移除 base64 ${summary.dataUrlsRemoved} 处，跳过 ${summary.skipped} 个，错误 ${summary.errors} 个。`
      );
    }

    return summary;
  }

  static async migrateImageTaskPreview(task) {
    const summary = {
      updated: false,
      previewsCreated: 0,
      originalsRecovered: 0,
      dataUrlsRemoved: 0,
      skipped: false
    };
    const resultData = this.parseStoredResultData(task.result_data);

    if (!resultData || typeof resultData !== 'object' || !Array.isArray(resultData.images)) {
      summary.skipped = true;
      return summary;
    }

    let changed = false;
    const nextImages = [];

    for (let i = 0; i < resultData.images.length; i += 1) {
      const image = resultData.images[i];
      if (!image || typeof image !== 'object' || Array.isArray(image)) {
        nextImages.push(image);
        continue;
      }

      const nextImage = { ...image };
      let originalUrl = this.normalizeLocalUploadUrl(nextImage.url || nextImage.dataUrl || nextImage.data_url);
      let sourcePath = this.resolveLocalUploadPathFromUrl(originalUrl);
      const sourceExists = sourcePath && fs.existsSync(sourcePath);
      const dataUrl = this.getStoredImageDataUrl(nextImage.data_url || nextImage.dataUrl || nextImage.url);

      if ((!sourceExists || !originalUrl) && dataUrl) {
        const recovered = this.recoverImageOriginalFromDataUrl({
          dataUrl,
          task,
          imageIndex: i,
          preferredPath: sourcePath
        });

        if (recovered) {
          sourcePath = recovered.path;
          originalUrl = recovered.url;
          nextImage.url = recovered.url;
          nextImage.filename = recovered.filename;
          changed = true;
          if (recovered.created) summary.originalsRecovered += 1;
        }
      }

      if (originalUrl && nextImage.url !== originalUrl) {
        nextImage.url = originalUrl;
        changed = true;
      }

      if (sourcePath && !nextImage.filename) {
        nextImage.filename = path.basename(sourcePath);
        changed = true;
      }

      const previewInfo = await this.ensureStoredImagePreview({
        image: nextImage,
        sourcePath,
        originalUrl,
        taskId: task.id,
        imageIndex: i
      });

      if (previewInfo.changed) changed = true;
      if (previewInfo.created) summary.previewsCreated += 1;

      if (nextImage.url && (Object.prototype.hasOwnProperty.call(nextImage, 'data_url') || Object.prototype.hasOwnProperty.call(nextImage, 'dataUrl'))) {
        delete nextImage.data_url;
        delete nextImage.dataUrl;
        summary.dataUrlsRemoved += 1;
        changed = true;
      }

      nextImages.push(nextImage);
    }

    if (!changed) {
      return summary;
    }

    resultData.images = nextImages;
    const urls = nextImages
      .map(image => image && typeof image === 'object' ? image.url : '')
      .filter(Boolean);
    const updateData = { result_data: resultData };

    if (urls.length > 0) {
      updateData.result_url = JSON.stringify(urls);
    }

    AiTask.update(task.id, updateData);
    summary.updated = true;
    return summary;
  }

  static parseStoredResultData(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;

    const parsed = JSON.parse(value);
    if (typeof parsed === 'string' && /^[\[{]/.test(parsed.trim())) {
      return JSON.parse(parsed);
    }
    return parsed;
  }

  static safeParseJson(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  static getStoredImageDataUrl(value) {
    const candidate = String(value || '').trim();
    return candidate.startsWith('data:image/') ? candidate : '';
  }

  static normalizeLocalUploadUrl(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return '';

    if (candidate.startsWith('/uploads/')) {
      return candidate.split('?')[0].split('#')[0];
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.pathname.startsWith('/uploads/')) {
        return parsed.pathname;
      }
    } catch (error) {
      return '';
    }

    return '';
  }

  static resolveLocalUploadPathFromUrl(uploadUrl) {
    const normalized = this.normalizeLocalUploadUrl(uploadUrl);
    if (!normalized) return '';

    try {
      return appConfig.uploadUrlToPath(normalized);
    } catch (error) {
      return '';
    }
  }

  static recoverImageOriginalFromDataUrl({ dataUrl, task, imageIndex, preferredPath = '' }) {
    const parsed = this.parseStoredImageDataUrl(dataUrl);
    if (!parsed) return null;

    const userId = task?.user_id || task?.userId;
    if (!userId) return null;

    const extension = this.getExtensionFromMimeType(parsed.mimeType);
    const fallbackPath = path.join(UPLOAD_DIR, String(userId), `${task.id}_${imageIndex}.${extension}`);
    const imagePath = preferredPath || fallbackPath;
    const resolvedImagePath = appConfig.assertInsideUploadDir(imagePath);

    fs.mkdirSync(path.dirname(resolvedImagePath), { recursive: true });
    const created = !fs.existsSync(resolvedImagePath);
    if (created) {
      fs.writeFileSync(resolvedImagePath, parsed.buffer);
    }

    return {
      path: resolvedImagePath,
      url: appConfig.pathToUploadUrl(resolvedImagePath),
      filename: path.basename(resolvedImagePath),
      created
    };
  }

  static parseStoredImageDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
    if (!match) return null;

    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s+/g, '');
    if (!base64) return null;

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return null;

    return { mimeType, buffer };
  }

  static async ensureStoredImagePreview({ image, sourcePath, originalUrl, taskId, imageIndex }) {
    const result = { changed: false, created: false };
    if (!sourcePath || !fs.existsSync(sourcePath) || !originalUrl) {
      return result;
    }

    const existingPreviewUrl = this.normalizeLocalUploadUrl(image.preview_url || image.previewUrl || image.thumbnail_url);
    const existingPreviewPath = existingPreviewUrl && existingPreviewUrl !== originalUrl
      ? this.resolveLocalUploadPathFromUrl(existingPreviewUrl)
      : '';

    if (existingPreviewPath && fs.existsSync(existingPreviewPath)) {
      if (image.preview_url !== existingPreviewUrl) {
        image.preview_url = existingPreviewUrl;
        result.changed = true;
      }
      if (!image.preview_filename) {
        image.preview_filename = path.basename(existingPreviewPath);
        result.changed = true;
      }
      return result;
    }

    const previewPath = this.buildStoredImagePreviewPath(sourcePath, taskId, imageIndex);
    const previewUrl = await this.createImagePreview({
      sourcePath,
      previewPath,
      fallbackUrl: originalUrl
    });

    if (image.preview_url !== previewUrl) {
      image.preview_url = previewUrl;
      result.changed = true;
    }

    if (previewUrl !== originalUrl) {
      const previewFilename = path.basename(previewPath);
      if (image.preview_filename !== previewFilename) {
        image.preview_filename = previewFilename;
        result.changed = true;
      }
      result.created = true;
    }

    return result;
  }

  static buildStoredImagePreviewPath(sourcePath, taskId, imageIndex) {
    const resolvedSourcePath = appConfig.assertInsideUploadDir(sourcePath);
    const previewDir = appConfig.assertInsideUploadDir(path.join(path.dirname(resolvedSourcePath), 'previews'));
    const sourceBase = path.parse(resolvedSourcePath).name || `${taskId}_${imageIndex}`;
    const safeBase = sourceBase
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 96) || `${taskId}_${imageIndex}`;

    return appConfig.assertInsideUploadDir(path.join(previewDir, `${safeBase}_preview.webp`));
  }

  static normalizeReferenceImagesInput(referenceImages, referenceImage = null) {
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

  static async resolveReferenceImageAssets(referenceImages) {
    const normalizedReferenceImages = this.normalizeReferenceImagesInput(referenceImages);
    const assets = [];
    for (const referenceImage of normalizedReferenceImages) {
      const asset = await this.resolveReferenceImageAsset(referenceImage);
      if (asset) assets.push(asset);
    }
    return assets;
  }

  static async resolveReferenceImageAsset(referenceImage) {
    if (!referenceImage || !referenceImage.src || typeof referenceImage.src !== 'string') {
      return null;
    }

    const src = referenceImage.src.trim();
    if (!src) {
      return null;
    }

    if (src.startsWith('data:image/')) {
      return await this.normalizeReferenceImageAsset(
        this.parseDataUrlReference(src, referenceImage.label),
        referenceImage.label
      );
    }

    if (src.startsWith('/uploads/')) {
      return await this.normalizeReferenceImageAsset(
        this.readLocalReference(src, referenceImage.label),
        referenceImage.label
      );
    }

    if (src.startsWith('/api/ai/reference-image?')) {
      const query = src.split('?')[1] || '';
      const remoteUrl = new URLSearchParams(query).get('url');
      if (remoteUrl) {
        return await this.normalizeReferenceImageAsset(
          await this.fetchRemoteReference(remoteUrl, referenceImage.label),
          referenceImage.label
        );
      }
    }

    if (/^https?:\/\//i.test(src)) {
      return await this.normalizeReferenceImageAsset(
        await this.fetchRemoteReference(src, referenceImage.label),
        referenceImage.label
      );
    }

    throw new Error('暂不支持当前参考图来源');
  }

  static parseDataUrlReference(src, label = '') {
    const match = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      throw new Error('参考图数据格式无效');
    }

    const mimeType = match[1];
    return {
      buffer: Buffer.from(match[2], 'base64'),
      mimeType,
      filename: this.buildReferenceFilename(label, mimeType)
    };
  }

  static async normalizeReferenceImageAsset(asset, label = '') {
    if (!asset || !asset.buffer) return asset;

    const mimeType = this.normalizeReferenceMimeType(asset.mimeType);
    if (!this.isHeicMimeType(mimeType)) {
      return asset;
    }

    return await this.convertHeicBufferToPng(asset, label);
  }

  static async convertHeicBufferToPng(asset, label = '') {
    if (!asset || !asset.buffer) {
      throw new Error('HEIC/HEIF 图片数据为空');
    }

    const outputFilename = this.buildReferenceFilename(label || asset.filename || 'reference-image', 'image/png');

    try {
      const buffer = await sharp(asset.buffer, { limitInputPixels: 80_000_000 })
        .rotate()
        .png()
        .toBuffer();

      return {
        buffer,
        mimeType: 'image/png',
        filename: outputFilename
      };
    } catch (error) {
      try {
        const buffer = await heicConvert({
          buffer: asset.buffer,
          format: 'PNG',
          quality: 1
        });

        return {
          buffer: Buffer.from(buffer),
          mimeType: 'image/png',
          filename: outputFilename
        };
      } catch (jsFallbackError) {
        try {
          return await this.convertHeicWithSips(asset, label);
        } catch (nativeFallbackError) {
          throw new Error('HEIC/HEIF 图片转换失败，请换成 JPG、PNG 或 WebP 后再试');
        }
      }
    }
  }

  static async convertHeicWithSips(asset, label = '') {
    if (process.platform !== 'darwin') {
      throw new Error('当前环境不支持 sips 转换');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-heic-'));
    const inputPath = path.join(tempDir, `input.${this.getExtensionFromMimeType(asset.mimeType)}`);
    const outputPath = path.join(tempDir, 'output.png');

    try {
      fs.writeFileSync(inputPath, asset.buffer);
      await execFileAsync('sips', ['-s', 'format', 'png', inputPath, '--out', outputPath], {
        timeout: 30000,
        maxBuffer: 1024 * 1024
      });

      const buffer = fs.readFileSync(outputPath);
      return {
        buffer,
        mimeType: 'image/png',
        filename: this.buildReferenceFilename(label || asset.filename || 'reference-image', 'image/png')
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  static readLocalReference(src, label = '') {
    const filePath = appConfig.uploadUrlToPath(src);

    if (!fs.existsSync(filePath)) {
      throw new Error('参考图文件不存在');
    }

    const extension = path.extname(filePath).toLowerCase();
    return {
      buffer: fs.readFileSync(filePath),
      mimeType: this.inferMimeTypeFromExtension(extension),
      filename: this.buildReferenceFilename(label || path.basename(filePath), this.inferMimeTypeFromExtension(extension))
    };
  }

  static async fetchRemoteReference(src, label = '') {
    const safeUrl = await assertSafeRemoteUrl(src, { allowedProtocols: ['http:', 'https:'] });
    const response = await axios.get(safeUrl.toString(), {
      ...safeAxiosOptions(),
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': safeUrl.origin
      }
    });

    const mimeType = this.normalizeReferenceMimeType((response.headers['content-type'] || '').split(';')[0] || 'image/png');
    const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif', 'image/x-heic', 'image/x-heif', 'image/heic-sequence', 'image/heif-sequence']);
    if (!allowedImageTypes.has(mimeType)) {
      throw new Error(`远程地址不是图片资源: ${mimeType}`);
    }
    return {
      buffer: Buffer.from(response.data),
      mimeType,
      filename: this.buildReferenceFilename(label, mimeType)
    };
  }

  static buildReferenceFilename(label = '', mimeType = 'image/png') {
    const safeBase = String(label || 'reference-image')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'reference-image';

    return `${safeBase}.${this.getExtensionFromMimeType(mimeType)}`;
  }

  static getImageMimeType(format) {
    return String(format).toLowerCase() === 'jpeg' ? 'image/jpeg' : 'image/png';
  }

  static getImageExtension(format) {
    return String(format).toLowerCase() === 'jpeg' ? 'jpg' : 'png';
  }

  static inferMimeTypeFromExtension(extension) {
    switch (String(extension || '').toLowerCase()) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.gif':
        return 'image/gif';
      case '.avif':
        return 'image/avif';
      case '.heic':
        return 'image/heic';
      case '.heif':
        return 'image/heif';
      default:
        return 'image/png';
    }
  }

  static getExtensionFromMimeType(mimeType) {
    switch (this.normalizeReferenceMimeType(mimeType)) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/webp':
        return 'webp';
      case 'image/gif':
        return 'gif';
      case 'image/avif':
        return 'avif';
      case 'image/heic':
        return 'heic';
      case 'image/heif':
        return 'heif';
      default:
        return 'png';
    }
  }

  static normalizeReferenceMimeType(mimeType = '') {
    const value = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (value === 'image/x-heic' || value === 'image/heic-sequence') return 'image/heic';
    if (value === 'image/x-heif' || value === 'image/heif-sequence') return 'image/heif';
    return value;
  }

  static isHeicMimeType(mimeType = '') {
    const normalized = this.normalizeReferenceMimeType(mimeType);
    return normalized === 'image/heic' || normalized === 'image/heif';
  }

  static estimateVideoCredits(params = {}) {
    const pricing = RuntimeConfigService.getRuntimeConfig().pricing?.video || {};
    const number = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const endpoint = this.resolveKlingVideoEndpoint(params);
    const rawMethod = String(params?.generation_method || params?.generationMethod || '').trim().toLowerCase();
    const rawModel = String(params?.model_name || params?.model || '').trim().toLowerCase();
    const rawTier = String(params?.tier || params?.model_tier || params?.modelTier || '').trim().toLowerCase();
    const requestedLite = rawTier === 'lite' || /kling-v2-5|turbo/.test(rawModel);
    const tier = requestedLite && endpoint !== 'omni-video'
      ? 'lite'
      : (endpoint === 'omni-video' ? 'omni' : 'pro');
    const requestedDuration = parseInt(params?.duration, 10) || 5;
    const duration = tier === 'lite'
      ? (requestedDuration >= 10 ? 10 : 5)
      : Math.min(15, Math.max(3, requestedDuration));
    const rawMode = String(params?.mode || params?.quality || 'std').trim().toLowerCase();
    const mode = rawMode === 'pro' || rawMode === 'high' || rawMode === 'hd' || rawMode === '4k' ? 'pro' : 'std';
    const soundOn = tier !== 'lite' && String(params?.sound || '').trim().toLowerCase() === 'on';
    const hasReference = this.extractKlingReferenceImages(params).length > 0;
    const soundMultiplier = soundOn ? Math.max(1, number(pricing.soundMultiplier, 1.5)) : 1;
    let baseCredits;
    let formula;

    if (tier === 'lite') {
      const liteFiveSecondCredits = mode === 'std'
        ? number(pricing.liteStdFiveSeconds, 25)
        : number(pricing.liteProFiveSeconds, 50);
      baseCredits = liteFiveSecondCredits * Math.max(1, Math.ceil(duration / 5));
      formula = `Lite / ${mode === 'std' ? '标准' : '高清'} / ${duration}秒`;
    } else if (tier === 'omni') {
      const omniPerSecondCredits = mode === 'std'
        ? number(pricing.omniStdPerSecond, number(pricing.proStdPerSecond, 20))
        : number(pricing.omniProPerSecond, number(pricing.proProPerSecond, 30));
      const omniLabel = rawMethod === 'frames' ? '首尾帧' : '多图参考';
      baseCredits = omniPerSecondCredits * duration * soundMultiplier;
      formula = `Pro / ${omniLabel} / ${mode === 'std' ? '标准' : '高清'} / ${duration}秒`;
    } else {
      const proPerSecondCredits = mode === 'std'
        ? number(pricing.proStdPerSecond, 20)
        : number(pricing.proProPerSecond, 30);
      baseCredits = proPerSecondCredits * duration * soundMultiplier;
      formula = `Pro / ${mode === 'std' ? '标准' : '高清'} / ${duration}秒`;
    }

    const totalCredits = Math.max(1, Math.ceil(baseCredits));
    return {
      totalCredits,
      baseCredits,
      tier,
      mode,
      duration,
      soundMultiplier,
      formula: formula + (soundOn ? ` / 声音x${soundMultiplier}` : ''),
      hasReference
    };
  }

  static async generateVideo({ userId, prompt, params }) {
    const clientRequestId = String(params?.client_request_id || params?.clientRequestId || '').trim();
    const videoCreditEstimate = this.estimateVideoCredits(params || {});
    const videoTitle = await this.generateVideoTitle({ userId, prompt, params });
    const taskParams = {
      ...(params && typeof params === 'object' ? params : {}),
      title: videoTitle
    };
    const task = AiTask.create({
      userId,
      type: 'video',
      prompt,
      params: taskParams
    });

    try {
      AiTask.updateStatus(task.id, 'processing', {
        result_data: {
          status: 'processing',
          stage: 'queued',
          progress: 5,
          client_request_id: clientRequestId || undefined,
          title: videoTitle,
          message: '视频生成任务已创建，正在准备生成...'
        }
      });
      const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
      const videoResult = await this.generateVideoViaRouter({
        userId,
        taskId: task.id,
        prompt,
        params: taskParams,
        runtimeConfig
      });
      const finalVideoResult = await this.prepareCompletedVideoResult({
        videoResult,
        task,
        prompt,
        params: taskParams,
        runtimeConfig
      });

      const billing = User.buildCreditBilling(videoCreditEstimate.totalCredits, userId);
      User.updateQuota(userId, 'video', billing.chargedCredits, {
        note: `视频生成 ${finalVideoResult.duration || taskParams?.duration || 5} 秒，${videoCreditEstimate.formula}${User.creditBillingNoteSuffix(billing)}`
      });

      const completedTask = AiTask.updateStatus(task.id, 'completed', {
        result_url: finalVideoResult.url,
        result_data: {
          status: 'completed',
          stage: 'completed',
          progress: 100,
          client_request_id: clientRequestId || undefined,
          url: finalVideoResult.url,
          original_url: finalVideoResult.originalUrl || undefined,
          title: videoTitle,
          prompt,
          task_id: finalVideoResult.taskId || finalVideoResult.id || '',
          provider: finalVideoResult.provider || 'video',
          model: finalVideoResult.model || runtimeConfig.videoModel || '',
          duration: finalVideoResult.duration || taskParams?.duration || '',
          aspect_ratio: finalVideoResult.aspectRatio || taskParams?.aspect_ratio || '',
          audio: finalVideoResult.audio || undefined,
          storage: finalVideoResult.storage || undefined,
          billing: {
            ...User.creditBillingMetadata(billing),
            charged_credits: billing.chargedCredits,
            base_credits: videoCreditEstimate.baseCredits,
            sound_multiplier: videoCreditEstimate.soundMultiplier,
            pricing_formula: videoCreditEstimate.formula
          }
        }
      });

      return {
        task: completedTask || AiTask.findById(task.id) || task,
        result: {
          url: finalVideoResult.url,
          title: videoTitle,
          task_id: finalVideoResult.taskId || finalVideoResult.id || '',
          status: 'completed',
          charged_credits: billing.chargedCredits
        }
      };
    } catch (error) {
      const publicMessage = this.publicVideoGenerationFailureMessage();
      AiTask.updateStatus(task.id, 'failed', {
        error_message: publicMessage,
        result_data: {
          status: 'failed',
          stage: 'error',
          progress: 0,
          client_request_id: clientRequestId || undefined,
          title: videoTitle,
          message: publicMessage,
          error: publicMessage,
          internal_error: error.message
        }
      });
      throw error;
    }
  }

  static async generateVideoViaRouter({ userId, taskId, prompt, params, runtimeConfig }) {
    const candidates = this.withResolvedVideoCandidateModels(
      this.getVideoRouterCandidates(runtimeConfig),
      params,
      runtimeConfig
    );
    if (!candidates.length) {
      return this.runtimeVideoProviderFormat(runtimeConfig) === 'kling'
        ? await this.generateKlingVideo({ taskId, prompt, params, runtimeConfig })
        : await this.generateOpenAiCompatibleVideo({ taskId, prompt, params, runtimeConfig });
    }

    return await AiRouterService.withCandidate({
      route: 'video',
      userId,
      messages: [{ role: 'user', content: prompt }],
      params: { ...(params || {}), sticky_key: `video_task_${taskId}` },
      candidates,
      queueTimeoutMs: parseInt(params?.queue_timeout_ms || params?.queueTimeoutMs || 5000, 10) || 5000,
      isRetryable: error => this.shouldTryVideoProviderFallback(error)
    }, async candidate => {
      const candidateRuntimeConfig = this.videoRuntimeConfigFromCandidate(candidate, runtimeConfig);
      return this.runtimeVideoProviderFormat(candidateRuntimeConfig) === 'kling'
        ? await this.generateKlingVideo({ taskId, prompt, params, runtimeConfig: candidateRuntimeConfig })
        : await this.generateOpenAiCompatibleVideo({ taskId, prompt, params, runtimeConfig: candidateRuntimeConfig });
    });
  }

  static getVideoRouterCandidates(runtimeConfig = {}) {
    try {
      const routeConfig = RuntimeConfigService.resolveModelRoute(runtimeConfig, 'video', {
        category: 'video',
        providerId: runtimeConfig.videoProviderId,
        fallbackProviderIds: runtimeConfig.videoFallbackProviderIds,
        fallbackModels: runtimeConfig.videoFallbackModels,
        model: runtimeConfig.videoModel,
        timeoutMs: 300000
      });
      return this.orderCandidatesByHealthHint(
        routeConfig.candidates || [],
        AiHealthMonitorService.getRoutingHint('video')
      );
    } catch (error) {
      return [];
    }
  }

  static videoRuntimeConfigFromCandidate(candidate = {}, runtimeConfig = {}) {
    const provider = candidate.provider || {};
    const videoModel = candidate.model || runtimeConfig.videoModel;
    const format = this.inferVideoProviderFormat(
      provider.format || candidate.format || runtimeConfig.videoProviderFormat || 'openai',
      videoModel
    );
    const baseUrl = format === 'kling'
      ? this.normalizeKlingBaseUrl(provider.baseUrl || runtimeConfig.videoBaseUrl || '')
      : this.normalizeOpenAiCompatibleBaseUrl(provider.baseUrl || runtimeConfig.videoBaseUrl || '');
    const apiKey = provider.apiKey || runtimeConfig.videoApiKey || runtimeConfig.providerApiKey;
    if (!baseUrl || !apiKey) {
      throw new Error('视频生成缺少供应商 Base URL 或 API Key');
    }
    return {
      ...runtimeConfig,
      videoProviderId: provider.id || candidate.providerId || runtimeConfig.videoProviderId || '',
      videoProviderName: provider.name || candidate.providerName || runtimeConfig.videoProviderName || '',
      videoProviderFormat: format,
      videoBaseUrl: baseUrl,
      videoApiKey: apiKey,
      videoModel
    };
  }

  static shouldTryVideoProviderFallback(error) {
    if ([400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(error?.response?.status)) return true;
    return this.isRetryableProviderError(error) || /模型|model|quota|限流|超时|timeout|capacity/i.test(String(error?.message || ''));
  }

  static async generateVideoTitle({ userId, prompt, params }) {
    const fallback = this.fallbackVideoTitle(prompt);
    try {
      const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
      const result = await this.chat({
        userId,
        runtimeConfig,
        messages: [
          {
            role: 'system',
            content: [
              '你是视频作品标题助手。',
              '请为用户的视频生成需求写一个简短中文标题。',
              '要求：8到16个中文字符，最多18个字符；不要引号、书名号、冒号、句号；不要解释；只输出标题。'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              `视频描述：${String(prompt || '').trim()}`,
              `生成方式：${params?.generation_method || params?.method || '未指定'}`,
              `比例：${params?.aspect_ratio || params?.aspectRatio || '未指定'}`,
              `时长：${params?.duration || '未指定'}秒`
            ].join('\n')
          }
        ],
        params: {
          route: 'assistant',
          temperature: 0.35,
          max_tokens: 40,
          timeout_ms: Math.min(Math.max(Number(runtimeConfig.assistantTimeoutMs || 60000), 10000), 30000)
        }
      });
      const rawTitle = this.extractTextValue(result);
      return this.normalizeVideoTitle(rawTitle, fallback);
    } catch (error) {
      console.warn('[Video Title] 对话模型标题生成失败，使用本地标题:', error.message);
      return fallback;
    }
  }

  static async prepareCompletedVideoResult({ videoResult, task, prompt, params, runtimeConfig }) {
    if (!videoResult?.url) return videoResult;
    let preparedResult = videoResult;

    if (this.shouldNormalizeCompletedVideoAudio({ videoResult, params })) {
      try {
        const audioResult = await this.ensureKlingVideoAudible({
          task,
          videoResult,
          prompt,
          params,
          runtimeConfig
        });
        if (audioResult?.url) {
          preparedResult = {
            ...videoResult,
            url: audioResult.url,
            originalUrl: videoResult.url,
            audio: audioResult.audio
          };
        }
      } catch (error) {
        console.warn(`[AiService] 视频音频后处理失败，继续使用原视频 task=${task?.id}:`, error.message);
        preparedResult = {
          ...videoResult,
          audio: {
            requested: true,
            normalized: false,
            warning: error.message
          }
        };
      }
    }

    return await this.ensureCompletedVideoStoredLocally({
      task,
      videoResult: preparedResult,
      prompt,
      params
    });
  }

  static shouldNormalizeCompletedVideoAudio({ videoResult, params }) {
    const provider = String(videoResult?.provider || '').trim().toLowerCase();
    const modelName = String(videoResult?.model || params?.model_name || params?.model || '').trim();
    const soundOn = String(params?.sound || '').trim().toLowerCase() === 'on';
    return provider === 'kling' && soundOn && this.supportsKlingSound(modelName);
  }

  static async ensureKlingVideoAudible({ task, videoResult, prompt, params, runtimeConfig }) {
    const taskId = task?.id || videoResult?.taskId || Date.now();
    const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]+/g, '_') || 'video';
    const audioDir = appConfig.assertInsideUploadDir(path.join(UPLOAD_DIR, 'video-audio-normalized', safeTaskId));
    const sourcePath = path.join(audioDir, 'source.mp4');
    const outputPath = path.join(audioDir, 'audible.mp4');

    fs.mkdirSync(audioDir, { recursive: true });

    AiTask.updateStatus(taskId, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'audio_check',
        progress: 96,
        client_request_id: params?.client_request_id || params?.clientRequestId || undefined,
        title: params?.title || this.fallbackVideoTitle(prompt),
        provider: videoResult.provider || 'kling',
        model: videoResult.model || params?.model_name || params?.model || '',
        task_id: videoResult.taskId || videoResult.id || '',
        message: '视频已生成，正在检查声音是否可听...'
      }
    });

    await this.downloadRemoteVideo(videoResult.url, sourcePath);
    const sourceUrl = appConfig.pathToUploadUrl(sourcePath);
    const probe = await this.probeVideoAudio(sourcePath);
    const volume = probe.hasAudio ? await this.detectAudioVolume(sourcePath) : null;

    const audioMetadata = {
      requested: true,
      source_url: sourceUrl,
      original_source_url: videoResult.url,
      has_audio: probe.hasAudio,
      codec: probe.codec || '',
      channels: probe.channels || null,
      sample_rate: probe.sampleRate || null,
      duration: probe.duration || videoResult.duration || '',
      mean_volume_db: volume?.meanVolume ?? null,
      max_volume_db: volume?.maxVolume ?? null,
      normalized: false
    };

    if (!probe.hasAudio || !Number.isFinite(volume?.maxVolume)) {
      audioMetadata.warning = probe.hasAudio ? '未能检测到有效音量' : '视频结果没有音轨';
      return {
        url: sourceUrl,
        audio: audioMetadata
      };
    }

    if (volume.maxVolume >= KLING_AUDIO_MAX_VOLUME_THRESHOLD_DB) {
      return {
        url: sourceUrl,
        audio: audioMetadata
      };
    }

    AiTask.updateStatus(taskId, 'processing', {
      result_data: {
        status: 'processing',
        stage: 'audio_normalizing',
        progress: 98,
        client_request_id: params?.client_request_id || params?.clientRequestId || undefined,
        title: params?.title || this.fallbackVideoTitle(prompt),
        provider: videoResult.provider || 'kling',
        model: videoResult.model || params?.model_name || params?.model || '',
        task_id: videoResult.taskId || videoResult.id || '',
        audio: audioMetadata,
        message: '检测到视频声音偏低，正在自动增强音量...'
      }
    });

    const normalizedVolume = await this.normalizeVideoAudio(sourcePath, outputPath, volume.maxVolume);
    const outputUrl = appConfig.pathToUploadUrl(outputPath);

    return {
      url: outputUrl,
      audio: {
        ...audioMetadata,
        normalized: true,
        normalized_url: outputUrl,
        source_url: sourceUrl,
        original_source_url: videoResult.url,
        output_mean_volume_db: normalizedVolume?.meanVolume ?? null,
        output_max_volume_db: normalizedVolume?.maxVolume ?? null
      }
    };
  }

  static async downloadRemoteVideo(url, outputPath) {
    const safeUrl = await assertSafeRemoteUrl(url, { allowedProtocols: ['http:', 'https:'] });
    const resolvedOutputPath = appConfig.assertInsideUploadDir(outputPath);
    const response = await axios.get(safeUrl.toString(), {
      ...safeAxiosOptions(),
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: KLING_VIDEO_AUDIO_MAX_BYTES,
      maxBodyLength: KLING_VIDEO_AUDIO_MAX_BYTES,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': 'video/mp4,video/*,*/*;q=0.8',
        'Referer': safeUrl.origin
      }
    });

    const contentLength = Number(response.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > KLING_VIDEO_AUDIO_MAX_BYTES) {
      throw new Error('视频文件过大，跳过声音增强');
    }

    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    await pipeline(response.data, fs.createWriteStream(resolvedOutputPath));
    return resolvedOutputPath;
  }

  static async ensureCompletedVideoStoredLocally({ task, videoResult, prompt, params }) {
    if (!videoResult?.url) {
      return videoResult;
    }

    if (this.isLocalUploadUrl(videoResult.url)) {
      return {
        ...videoResult,
        storage: {
          ...(videoResult.storage || {}),
          local_url: videoResult.url,
          original_url: videoResult.originalUrl || videoResult.storage?.original_url || '',
          persisted: true
        }
      };
    }

    try {
      const localUrl = await this.storeRemoteVideoForTask({
        task,
        remoteUrl: videoResult.url,
        prompt,
        params
      });
      return {
        ...videoResult,
        url: localUrl,
        originalUrl: videoResult.originalUrl || videoResult.url,
        storage: {
          ...(videoResult.storage || {}),
          local_url: localUrl,
          original_url: videoResult.originalUrl || videoResult.url,
          persisted: true
        }
      };
    } catch (error) {
      const recoveredLocalUrl = await this.recoverVideoTaskLocalUrl(task, {
        remoteUrl: videoResult.url,
        refreshExpired: true,
        updateProgress: false
      }).catch(() => '');

      if (recoveredLocalUrl) {
        return {
          ...videoResult,
          url: recoveredLocalUrl,
          originalUrl: videoResult.originalUrl || videoResult.url,
          storage: {
            ...(videoResult.storage || {}),
            local_url: recoveredLocalUrl,
            original_url: videoResult.originalUrl || videoResult.url,
            persisted: true,
            recovered: true
          }
        };
      }

      console.warn(`[AiService] 视频本地持久化失败，继续使用临时远程链接 task=${task?.id}:`, error.message);
      return {
        ...videoResult,
        storage: {
          ...(videoResult.storage || {}),
          persisted: false,
          warning: error.message
        }
      };
    }
  }

  static async storeRemoteVideoForTask({ task, remoteUrl, prompt, params, updateProgress = true }) {
    if (!remoteUrl) throw new Error('视频地址为空');
    if (this.isLocalUploadUrl(remoteUrl)) return remoteUrl;

    const taskId = task?.id || params?.task_id || Date.now();
    const safeTaskId = String(taskId).replace(/[^a-zA-Z0-9_-]+/g, '_') || 'video';
    const extension = this.inferVideoExtension(remoteUrl);
    const filename = `video${extension}`;
    const outputDir = appConfig.assertInsideUploadDir(path.join(UPLOAD_DIR, 'videos', safeTaskId));
    const outputPath = path.join(outputDir, filename);
    const localUrl = appConfig.pathToUploadUrl(outputPath);

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return localUrl;
    }

    if (updateProgress) {
      const existingTask = task?.id ? (AiTask.findById(task.id) || task) : task;
      const existingResultData = this.safeParseJson(existingTask?.result_data, {}) || {};
      AiTask.updateStatus(taskId, 'processing', {
        result_data: {
          ...existingResultData,
          status: 'processing',
          stage: 'video_persisting',
          progress: 97,
          client_request_id: params?.client_request_id || params?.clientRequestId || undefined,
          title: params?.title || this.fallbackVideoTitle(prompt || task?.prompt || ''),
          message: '视频已生成，正在保存到本地图库...'
        }
      });
    }

    await this.downloadRemoteVideo(remoteUrl, outputPath);
    return localUrl;
  }

  static isLocalUploadUrl(url) {
    return String(url || '').trim().startsWith('/uploads/');
  }

  static normalizeStoredVideoUrl(value) {
    let videoUrl = String(value || '').trim();
    if (videoUrl.charAt(0) === '[') {
      const parsed = this.safeParseJson(videoUrl, []);
      videoUrl = Array.isArray(parsed) ? String(parsed[0] || '').trim() : videoUrl;
    }
    return videoUrl;
  }

  static getTaskStoredVideoUrl(task, resultDataOverride = null) {
    if (!task) return '';
    const resultData = resultDataOverride || this.safeParseJson(task.result_data, {}) || {};
    return this.normalizeStoredVideoUrl(
      resultData.storage?.local_url ||
      resultData.url ||
      resultData.video_url ||
      resultData.videoUrl ||
      task.result_url ||
      ''
    );
  }

  static getTaskRemoteVideoUrl(task, resultDataOverride = null, preferredRemoteUrl = '') {
    if (!task) return '';
    const resultData = resultDataOverride || this.safeParseJson(task.result_data, {}) || {};
    const candidates = [
      preferredRemoteUrl,
      resultData.original_url,
      resultData.storage?.original_url,
      resultData.audio?.original_source_url,
      resultData.url,
      resultData.video_url,
      resultData.videoUrl,
      task.result_url
    ];

    for (const candidate of candidates) {
      const url = this.normalizeStoredVideoUrl(candidate);
      if (/^https?:\/\//i.test(url)) return url;
    }
    return '';
  }

  static localUploadUrlExists(url) {
    const normalized = this.normalizeLocalUploadUrl(url);
    if (!normalized) return false;
    try {
      const filePath = appConfig.uploadUrlToPath(normalized);
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
    } catch (error) {
      return false;
    }
  }

  static findExistingLocalVideoUrlForTask(task, resultDataOverride = null) {
    if (!task || task.type !== 'video') return '';
    const resultData = resultDataOverride || this.safeParseJson(task.result_data, {}) || {};
    const urls = [];
    const push = value => {
      const normalized = this.normalizeLocalUploadUrl(value);
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
    };

    push(resultData.storage?.local_url);
    push(resultData.url);
    push(resultData.video_url);
    push(resultData.videoUrl);
    push(task.result_url);
    push(resultData.audio?.normalized_url);
    push(resultData.audio?.source_url);

    const safeTaskId = String(task.id || '').replace(/[^a-zA-Z0-9_-]+/g, '_');
    if (safeTaskId) {
      ['.mp4', '.mov', '.webm', '.m4v'].forEach(ext => {
        push(`/uploads/videos/${safeTaskId}/video${ext}`);
      });
      push(`/uploads/video-audio-normalized/${safeTaskId}/audible.mp4`);
      push(`/uploads/video-audio-normalized/${safeTaskId}/source.mp4`);
    }

    return urls.find(url => this.localUploadUrlExists(url)) || '';
  }

  static updateVideoTaskLocalStorage(task, localUrl, { resultData: resultDataOverride = null, originalUrl = '', recovered = false } = {}) {
    if (!task || !localUrl || !this.isLocalUploadUrl(localUrl)) return null;
    const resultData = resultDataOverride || this.safeParseJson(task.result_data, {}) || {};
    const previousUrl = this.getTaskStoredVideoUrl(task, resultData);
    const storedOriginalUrl = originalUrl ||
      resultData.original_url ||
      resultData.storage?.original_url ||
      (!this.isLocalUploadUrl(previousUrl) ? previousUrl : '');
    const nextResultData = {
      ...resultData,
      status: resultData.status || 'completed',
      stage: resultData.stage === 'video_persisting' ? 'completed' : (resultData.stage || 'completed'),
      progress: 100,
      url: localUrl,
      original_url: storedOriginalUrl || resultData.original_url || undefined,
      playback_state: 'ready',
      storage: {
        ...(resultData.storage || {}),
        local_url: localUrl,
        original_url: storedOriginalUrl || resultData.storage?.original_url || '',
        persisted: true,
        recovered: Boolean(recovered || resultData.storage?.recovered),
        recovered_at: recovered ? new Date().toISOString() : resultData.storage?.recovered_at
      }
    };

    return AiTask.update(task.id, {
      result_url: localUrl,
      result_data: nextResultData
    });
  }

  static async recoverVideoTaskLocalUrl(task, {
    remoteUrl = '',
    refreshExpired = true,
    updateProgress = false
  } = {}) {
    if (!task || task.type !== 'video') return '';
    const resultData = this.safeParseJson(task.result_data, {}) || {};
    const existingLocalUrl = this.findExistingLocalVideoUrlForTask(task, resultData);
    if (existingLocalUrl) {
      this.updateVideoTaskLocalStorage(task, existingLocalUrl, {
        resultData,
        originalUrl: this.getTaskRemoteVideoUrl(task, resultData, remoteUrl),
        recovered: true
      });
      return existingLocalUrl;
    }

    let effectiveRemoteUrl = this.getTaskRemoteVideoUrl(task, resultData, remoteUrl);
    if (!effectiveRemoteUrl) {
      throw new Error('视频源文件没有可取回地址');
    }

    const params = this.safeParseJson(task.params, {}) || {};
    let firstError = null;
    try {
      const localUrl = await this.storeRemoteVideoForTask({
        task,
        remoteUrl: effectiveRemoteUrl,
        prompt: task.prompt,
        params,
        updateProgress
      });
      this.updateVideoTaskLocalStorage(task, localUrl, {
        resultData,
        originalUrl: effectiveRemoteUrl,
        recovered: true
      });
      return localUrl;
    } catch (error) {
      firstError = error;
    }

    if (refreshExpired) {
      const refreshedUrl = await this.refreshVideoResultUrlForTask(task).catch(() => '');
      if (refreshedUrl && refreshedUrl !== effectiveRemoteUrl) {
        effectiveRemoteUrl = refreshedUrl;
        const localUrl = await this.storeRemoteVideoForTask({
          task,
          remoteUrl: effectiveRemoteUrl,
          prompt: task.prompt,
          params,
          updateProgress
        });
        const freshTask = AiTask.findById(task.id) || task;
        this.updateVideoTaskLocalStorage(freshTask, localUrl, {
          resultData: this.safeParseJson(freshTask.result_data, resultData) || resultData,
          originalUrl: effectiveRemoteUrl,
          recovered: true
        });
        return localUrl;
      }
    }

    throw firstError || new Error('视频文件取回失败');
  }

  static inferVideoExtension(videoUrl) {
    try {
      const parsed = this.isLocalUploadUrl(videoUrl)
        ? { pathname: videoUrl }
        : new URL(videoUrl);
      const ext = path.extname(decodeURIComponent(parsed.pathname || '')).toLowerCase();
      if (['.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return ext;
    } catch (error) {}
    return '.mp4';
  }

  static async refreshVideoResultUrlForTask(task) {
    if (!task || task.type !== 'video') return '';
    const resultData = this.safeParseJson(task.result_data, {}) || {};
    const params = this.safeParseJson(task.params, {}) || {};
    const provider = String(resultData.provider || '').toLowerCase();
    const providerTaskId = resultData.task_id || resultData.taskId || '';
    if (provider !== 'kling' || !providerTaskId) return '';

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const videoBaseUrl = this.normalizeKlingBaseUrl(runtimeConfig.videoBaseUrl || runtimeConfig.providerBaseUrl || '');
    const videoApiKey = runtimeConfig.videoApiKey || runtimeConfig.providerApiKey;
    if (!videoBaseUrl || !videoApiKey) return '';

    const endpoint = this.resolveKlingVideoEndpoint(params);
    const response = await axios.get(
      `${videoBaseUrl}/kling/v1/videos/${endpoint}/${encodeURIComponent(providerTaskId)}`,
      {
        headers: {
          Authorization: `Bearer ${videoApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 60000
      }
    );
    const normalized = this.normalizeKlingTaskResult(response.data);
    if (!normalized.completed || !normalized.url) return '';

    AiTask.update(task.id, {
      result_url: normalized.url,
      result_data: {
        ...resultData,
        status: 'completed',
        stage: 'completed',
        progress: 100,
        url: normalized.url,
        refreshed_url_at: new Date().toISOString(),
        original_url: resultData.original_url || resultData.url || task.result_url || ''
      }
    });
    return normalized.url;
  }

  static async probeVideoAudio(videoPath) {
    const resolvedVideoPath = appConfig.assertInsideUploadDir(videoPath);
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,channels,sample_rate,duration',
        '-of', 'json',
        resolvedVideoPath
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );

    const parsed = this.safeParseJson(stdout, {});
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
    return {
      hasAudio: Boolean(stream),
      codec: stream?.codec_name || '',
      channels: stream?.channels ? Number(stream.channels) : null,
      sampleRate: stream?.sample_rate ? Number(stream.sample_rate) : null,
      duration: stream?.duration || ''
    };
  }

  static async detectAudioVolume(videoPath) {
    const resolvedVideoPath = appConfig.assertInsideUploadDir(videoPath);
    try {
      const { stdout, stderr } = await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostats',
          '-i', resolvedVideoPath,
          '-map', '0:a:0',
          '-af', 'volumedetect',
          '-f', 'null',
          '-'
        ],
        { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
      );
      return this.parseFfmpegVolumeDetect(`${stdout || ''}\n${stderr || ''}`);
    } catch (error) {
      const output = `${error.stdout || ''}\n${error.stderr || ''}`;
      return this.parseFfmpegVolumeDetect(output);
    }
  }

  static parseFfmpegVolumeDetect(output = '') {
    const meanMatch = String(output).match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
    const maxMatch = String(output).match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
    const parseDb = (value) => {
      if (!value) return null;
      if (/^-?inf$/i.test(value)) return -Infinity;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };

    return {
      meanVolume: parseDb(meanMatch?.[1]),
      maxVolume: parseDb(maxMatch?.[1])
    };
  }

  static async normalizeVideoAudio(sourcePath, outputPath, sourceMaxVolume) {
    const resolvedSourcePath = appConfig.assertInsideUploadDir(sourcePath);
    const resolvedOutputPath = appConfig.assertInsideUploadDir(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

    const boostDb = Number.isFinite(sourceMaxVolume)
      ? Math.max(6, Math.min(36, -12 - sourceMaxVolume))
      : 18;

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-i', resolvedSourcePath,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-af', `volume=${boostDb.toFixed(1)}dB,alimiter=limit=0.95`,
        '-movflags', '+faststart',
        resolvedOutputPath
      ],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }
    );

    return await this.detectAudioVolume(resolvedOutputPath);
  }

  static fallbackVideoTitle(prompt) {
    return this.normalizeVideoTitle(prompt, '生成视频');
  }

  static normalizeVideoTitle(value, fallback = '生成视频') {
    const text = String(value || '')
      .replace(/["'`“”‘’《》【】\[\]{}（）()]/g, '')
      .replace(/^[\s:：\-—_#*]+|[\s:：\-—_#*。！？,.，、；;]+$/g, '')
      .replace(/\s+/g, '')
      .trim();
    if (!text) return fallback;
    const chars = Array.from(text);
    return chars.slice(0, 18).join('') || fallback;
  }

  static async generateOpenAiCompatibleVideo({ taskId, prompt, params, runtimeConfig }) {
    const videoBaseUrl = this.normalizeOpenAiCompatibleBaseUrl(runtimeConfig.videoBaseUrl || runtimeConfig.providerBaseUrl || '');
    const videoApiKey = runtimeConfig.videoApiKey || runtimeConfig.providerApiKey;

    if (this.runtimeVideoProviderFormat(runtimeConfig) !== 'openai') {
      throw new Error('视频生成供应商协议不受支持，请检查后台视频供应商配置');
    }

    if (!videoBaseUrl || !videoApiKey) {
      throw new Error('视频生成缺少供应商 Base URL 或 API Key');
    }

    const response = await axios.post(
      `${videoBaseUrl}/videos/generations`,
      {
        model: runtimeConfig.videoModel || 'sora-1.0-turbo',
        prompt,
        duration: params?.duration || 10,
        aspect_ratio: params?.aspect_ratio || '16:9'
      },
      {
        headers: {
          'Authorization': `Bearer ${videoApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 300000
      }
    );

    const videoResult = {
      id: response.data.id,
      status: response.data.status || 'processing',
      url: response.data.url || null
    };

    const maxAttempts = 60;
    let attempts = 0;
    while (['processing', 'pending', 'queued', 'submitted'].includes(videoResult.status) && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const statusResponse = await axios.get(
        `${videoBaseUrl}/videos/generations/${videoResult.id}`,
        {
          headers: {
            'Authorization': `Bearer ${videoApiKey}`
          }
        }
      );

      videoResult.status = statusResponse.data.status;
      if (statusResponse.data.url) {
        videoResult.url = statusResponse.data.url;
      }
      attempts++;

      AiTask.updateStatus(taskId, 'processing', {
        result_data: {
          status: 'processing',
          stage: 'polling',
          progress: Math.min(95, 10 + attempts),
          client_request_id: params?.client_request_id || params?.clientRequestId || undefined,
          title: params?.title || this.fallbackVideoTitle(prompt),
          task_id: videoResult.id,
          message: '视频生成中，请稍候...'
        }
      });
    }

    if (videoResult.status === 'failed') {
      throw new Error('视频生成失败');
    }
    if (!videoResult.url) {
      throw new Error('视频生成超时或未返回可用视频地址');
    }

    return {
      ...videoResult,
      provider: 'openai',
      model: runtimeConfig.videoModel || 'sora-1.0-turbo',
      duration: params?.duration || 10,
      aspectRatio: params?.aspect_ratio || '16:9'
    };
  }

  static async generateKlingVideo({ taskId, prompt, params, runtimeConfig }) {
    const videoBaseUrl = this.normalizeKlingBaseUrl(runtimeConfig.videoBaseUrl || runtimeConfig.providerBaseUrl || '');
    const videoApiKey = runtimeConfig.videoApiKey || runtimeConfig.providerApiKey;

    if (!videoBaseUrl || !videoApiKey) {
      throw new Error('视频生成缺少 Base URL 或 API Key');
    }

    const requestedTier = String(params?.tier || params?.model_tier || params?.modelTier || '').trim().toLowerCase();
    const requestedLite = requestedTier === 'lite';
    const endpoint = this.resolveKlingVideoEndpoint(params);
    if (requestedLite && endpoint === 'omni-video') {
      throw new Error('Lite 暂不支持多图参考或首尾帧，请切换 Pro 后再生成。');
    }
    const modelName = this.resolveKlingVideoModelForRequest(params, runtimeConfig);
    const mode = this.normalizeKlingVideoMode(params?.mode || params?.quality);
    const duration = this.normalizeKlingDuration(params?.duration, endpoint, modelName);
    const aspectRatio = this.normalizeKlingAspectRatio(params?.aspect_ratio || params?.aspectRatio);
    const preparedParams = await this.prepareKlingVideoParamsForEndpoint({
      params,
      endpoint,
      taskId,
      runtimeConfig
    });
    if (preparedParams !== params && endpoint !== 'image2video') {
      AiTask.update(taskId, { params: preparedParams });
    }
    const payload = this.buildKlingVideoPayload({ endpoint, prompt, params: preparedParams, modelName, mode, duration, aspectRatio });

    AiTask.updateStatus(taskId, 'processing', {
        result_data: {
          status: 'processing',
          stage: 'submitted',
          progress: 10,
          client_request_id: preparedParams?.client_request_id || preparedParams?.clientRequestId || undefined,
          title: preparedParams?.title || this.fallbackVideoTitle(prompt),
          provider: 'kling',
          model: modelName,
          message: '正在提交视频生成任务...'
      }
    });

    let createResponse;
    try {
      createResponse = await axios.post(
        `${videoBaseUrl}/kling/v1/videos/${endpoint}`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${videoApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 60000
        }
      );
    } catch (error) {
      throw new Error(this.extractKlingProviderErrorMessage(error) || error.message || '视频任务提交失败');
    }

    if (Number(createResponse.data?.code) !== 0 && createResponse.data?.code !== undefined) {
      throw new Error(createResponse.data?.message || '视频任务提交失败');
    }

    const taskIdFromProvider = createResponse.data?.data?.task_id || createResponse.data?.task_id || createResponse.data?.id;
    if (!taskIdFromProvider) {
      throw new Error('视频接口未返回任务 ID');
    }

    const maxAttempts = Math.max(1, parseInt(params?.poll_attempts, 10) || 120);
    const pollIntervalMs = Math.max(3000, parseInt(params?.poll_interval_ms, 10) || 5000);
    let lastPayload = createResponse.data;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      const queryResponse = await axios.get(
        `${videoBaseUrl}/kling/v1/videos/${endpoint}/${encodeURIComponent(taskIdFromProvider)}`,
        {
          headers: {
            'Authorization': `Bearer ${videoApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 60000
        }
      ).catch(error => {
        throw new Error(this.extractKlingProviderErrorMessage(error) || error.message || '视频任务查询失败');
      });
      lastPayload = queryResponse.data;

      const normalized = this.normalizeKlingTaskResult(lastPayload);
      const progress = Math.min(95, 15 + Math.floor(((attempt + 1) / maxAttempts) * 80));
      AiTask.updateStatus(taskId, 'processing', {
        result_data: {
          status: 'processing',
          stage: 'polling',
          progress,
          client_request_id: preparedParams?.client_request_id || preparedParams?.clientRequestId || undefined,
          title: preparedParams?.title || this.fallbackVideoTitle(prompt),
          provider: 'kling',
          model: modelName,
          task_id: taskIdFromProvider,
          task_status: normalized.status,
          message: normalized.message || '视频生成中，正在等待任务完成...'
        }
      });

      if (normalized.failed) {
        throw new Error(normalized.message || '视频生成失败');
      }
      if (normalized.completed && normalized.url) {
        return {
          provider: 'kling',
          model: modelName,
          taskId: taskIdFromProvider,
          status: normalized.status,
          url: normalized.url,
          duration,
          aspectRatio,
          rawStatus: normalized.rawStatus
        };
      }
    }

    const normalized = this.normalizeKlingTaskResult(lastPayload);
    if (normalized.url) {
      return {
        provider: 'kling',
        model: modelName,
        taskId: taskIdFromProvider,
        status: normalized.status || 'completed',
        url: normalized.url,
        duration,
        aspectRatio,
        rawStatus: normalized.rawStatus
      };
    }

    throw new Error('视频生成超时，请稍后在生成记录中查看或重试');
  }

  static resolveKlingVideoEndpoint(params = {}) {
    const rawMethod = String(params?.generation_method || params?.generationMethod || '').trim().toLowerCase();
    const rawModel = String(params?.model_name || params?.model || '').trim().toLowerCase();
    if (['omni', 'multi_image', 'multi-image', 'multiimage', 'reference', 'references', 'frames'].includes(rawMethod)) {
      return 'omni-video';
    }
    if (rawMethod === 'text') return 'text2video';
    if (rawMethod === 'image') return 'image2video';
    if (this.extractKlingGeneralReferenceImages(params).length) return 'omni-video';
    if (this.extractKlingTailImage(params)) return 'omni-video';
    if (this.extractKlingSourceImage(params)) return 'image2video';
    if (!rawMethod && (rawModel === 'kling-v3-omni' || rawModel === 'kling-omni-video')) return 'omni-video';
    return 'text2video';
  }

  static buildKlingVideoPayload({ endpoint, prompt, params, modelName, mode, duration, aspectRatio }) {
    if (endpoint === 'omni-video') {
      return this.buildKlingOmniVideoPayload({ prompt, params, modelName, mode, duration, aspectRatio });
    }
    if (endpoint === 'image2video') {
      const sourceImage = this.extractKlingSourceImage(params);
      if (!sourceImage) {
        throw new Error('图生视频需要至少上传首帧图');
      }
      return this.buildKlingImageToVideoPayload({ prompt, params, modelName, mode, duration, sourceImage });
    }
    return this.buildKlingTextToVideoPayload({ prompt, params, modelName, mode, duration, aspectRatio });
  }

  static async prepareKlingVideoParamsForEndpoint({ params = {}, endpoint = '', taskId, runtimeConfig = {} }) {
    if (endpoint === 'image2video') {
      return await this.prepareKlingImageToVideoParams({ params, taskId, runtimeConfig });
    }

    if (endpoint !== 'omni-video') return params;

    const references = this.extractKlingReferenceImages(params);
    if (!references.length) return params;

    const normalizedReferences = [];
    for (let index = 0; index < references.length; index += 1) {
      const item = references[index];
      const imageUrl = await this.normalizeKlingOmniImageUrl({
        src: item.image_url,
        taskId,
        imageIndex: index,
        runtimeConfig
      });
      const normalized = { image_url: imageUrl };
      const type = String(item.type || '').trim();
      if (['first_frame', 'end_frame'].includes(type)) normalized.type = type;
      normalizedReferences.push(normalized);
    }

    const nextParams = { ...(params || {}), image_list: normalizedReferences };
    delete nextParams.image_url;
    delete nextParams.image;
    delete nextParams.first_frame;
    delete nextParams.image_tail;
    delete nextParams.last_frame;
    delete nextParams.tail_image_url;
    delete nextParams.tailImageUrl;
    return nextParams;
  }

  static async prepareKlingImageToVideoParams({ params = {}, taskId, runtimeConfig = {} }) {
    const sourceImage = this.extractKlingSourceImage(params);
    const tailImage = this.extractKlingTailImage(params);
    if (!sourceImage && !tailImage) return params;

    const nextParams = { ...(params || {}) };
    if (sourceImage) {
      nextParams.image = await this.normalizeKlingImageToVideoInput({
        src: sourceImage,
        label: '首帧图',
        taskId,
        imageIndex: 0,
        runtimeConfig
      });
      delete nextParams.image_url;
      delete nextParams.first_frame;
      delete nextParams.referenceImage;
      delete nextParams.reference_image;
    }

    if (tailImage) {
      nextParams.image_tail = await this.normalizeKlingImageToVideoInput({
        src: tailImage,
        label: '尾帧图',
        taskId,
        imageIndex: 1,
        runtimeConfig
      });
      delete nextParams.last_frame;
      delete nextParams.tail_image_url;
      delete nextParams.tailImageUrl;
    }

    return nextParams;
  }

  static async normalizeKlingImageToVideoInput({ src, label = '参考图', runtimeConfig = {} } = {}) {
    const value = String(src || '').trim();
    if (!value) {
      throw new Error(`图生视频缺少${label}`);
    }

    if (/^https?:\/\//i.test(value) && !this.normalizeLocalUploadUrl(value)) {
      return value;
    }

    if (value.startsWith('/api/ai/reference-image?')) {
      const query = value.split('?')[1] || '';
      const remoteUrl = new URLSearchParams(query).get('url');
      if (/^https?:\/\//i.test(remoteUrl || '')) {
        return remoteUrl.trim();
      }
      throw new Error(`图生视频的${label}图库代理地址无效，请换一张图片`);
    }

    if (/^data:image\//i.test(value)) {
      const parsed = this.parseStoredImageDataUrl(value);
      if (!parsed) {
        throw new Error(`图生视频${label}数据格式无效`);
      }
      return parsed.buffer.toString('base64');
    }

    const uploadUrl = this.normalizeLocalUploadUrl(value);
    if (uploadUrl) {
      const publicUploadUrl = this.tryPublicUploadUrl(uploadUrl, runtimeConfig);
      if (publicUploadUrl) {
        return publicUploadUrl;
      }

      const imagePath = this.resolveLocalUploadPathFromUrl(uploadUrl);
      if (!imagePath || !fs.existsSync(imagePath)) {
        throw new Error(`图生视频${label}文件不存在，请重新选择图片`);
      }
      return fs.readFileSync(imagePath).toString('base64');
    }

    throw new Error(`图生视频${label}只支持 HTTP(S) 图片、图库图片或站内上传图片`);
  }

  static tryPublicUploadUrl(uploadUrl, runtimeConfig = {}) {
    try {
      return this.toPublicUploadUrl(uploadUrl, runtimeConfig);
    } catch (error) {
      return '';
    }
  }

  static async normalizeKlingOmniImageUrl({ src, taskId, imageIndex = 0, runtimeConfig = {} }) {
    const value = String(src || '').trim();
    if (!value) {
      throw new Error('多参考视频缺少参考图地址');
    }
    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    if (value.startsWith('/api/ai/reference-image?')) {
      const query = value.split('?')[1] || '';
      const remoteUrl = new URLSearchParams(query).get('url');
      if (/^https?:\/\//i.test(remoteUrl || '')) {
        return remoteUrl.trim();
      }
      throw new Error('多参考视频的图库代理地址无效，请换一张图片');
    }

    if (value.startsWith('/uploads/')) {
      return this.toPublicUploadUrl(value, runtimeConfig);
    }

    if (/^data:image\//i.test(value)) {
      const saved = this.saveKlingOmniReferenceDataUrl({ dataUrl: value, taskId, imageIndex });
      return this.toPublicUploadUrl(saved.url, runtimeConfig);
    }

    throw new Error('多参考视频只支持 HTTP(S) 图片 URL 或站内上传图片');
  }

  static saveKlingOmniReferenceDataUrl({ dataUrl, taskId, imageIndex = 0 }) {
    const parsed = this.parseStoredImageDataUrl(dataUrl);
    if (!parsed) {
      throw new Error('多参考视频参考图数据格式无效');
    }

    const extension = this.getExtensionFromMimeType(parsed.mimeType);
    const safeTaskId = String(taskId || 'pending').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'pending';
    const digest = crypto
      .createHash('sha256')
      .update(parsed.buffer)
      .digest('hex')
      .slice(0, 16);
    const filename = `ref_${String(imageIndex + 1).padStart(2, '0')}_${digest}.${extension}`;
    const imagePath = appConfig.assertInsideUploadDir(path.join(UPLOAD_DIR, 'video-references', safeTaskId, filename));

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    if (!fs.existsSync(imagePath)) {
      fs.writeFileSync(imagePath, parsed.buffer);
    }

    return {
      path: imagePath,
      url: appConfig.pathToUploadUrl(imagePath)
    };
  }

  static toPublicUploadUrl(uploadUrl, runtimeConfig = {}) {
    const normalizedUploadUrl = this.normalizeLocalUploadUrl(uploadUrl);
    if (!normalizedUploadUrl) {
      throw new Error('站内参考图地址无效');
    }

    const publicBaseUrl = this.normalizePublicBaseUrl(runtimeConfig.sitePublicBaseUrl);
    if (!publicBaseUrl) {
      throw new Error('多参考视频需要公网可访问的参考图。请在后台“站点设置”配置“网站公网地址”，或使用 HTTP(S) 图片 URL。');
    }

    const publicUploadUrl = appConfig.signedUploadsEnabled
      ? appConfig.signUploadUrl(normalizedUploadUrl, { ttlSeconds: 3600 })
      : normalizedUploadUrl;
    return `${publicBaseUrl}${publicUploadUrl}`;
  }

  static normalizePublicBaseUrl(value = '') {
    const candidate = String(value || '').trim().replace(/\/+$/, '');
    if (!candidate) return '';

    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(parsed.hostname)) return '';
      return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    } catch (error) {
      return '';
    }
  }

  static normalizeKlingVideoModelName(value, endpoint = '') {
    if (endpoint === 'omni-video') {
      return 'kling-v3-omni';
    }
    const normalized = String(value || '').trim();
    if (/^kling-v2-5-turbo$/i.test(normalized)) {
      return 'kling-v2-5-turbo';
    }
    return 'kling-v3';
  }

  static normalizeKlingVideoMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === '4k') return 'pro';
    if (['std', 'pro'].includes(normalized)) return normalized;
    return 'std';
  }

  static normalizeKlingDuration(value, endpoint = '', modelName = '') {
    const duration = parseInt(value, 10);
    if (/kling-v2-5-turbo/i.test(String(modelName || ''))) {
      if (duration >= 10) return '10';
      return '5';
    }
    if (endpoint === 'omni-video') {
      if (duration >= 15) return '15';
      if (duration >= 3) return String(duration);
      return '5';
    }
    if (endpoint === 'text2video' || endpoint === 'image2video') {
      if (duration >= 15) return '15';
      if (duration >= 3) return String(duration);
      return '5';
    }
    if (duration >= 10) return '10';
    return '5';
  }

  static normalizeKlingAspectRatio(value) {
    const normalized = String(value || '').trim();
    return ['16:9', '9:16', '1:1'].includes(normalized) ? normalized : '16:9';
  }

  static extractKlingSourceImage(params = {}) {
    const directImage = String(
      params.image ||
      params.referenceImage ||
      params.reference_image ||
      params.image_url ||
      params.first_frame ||
      ''
    ).trim();
    if (directImage) return directImage;

    const fromList = this.extractKlingReferenceImages(params).find(item => item.type === 'first_frame');
    return String(fromList?.image_url || '').trim();
  }

  static extractKlingTailImage(params = {}) {
    const directImage = String(
      params.image_tail ||
      params.last_frame ||
      params.tail_image_url ||
      params.tailImageUrl ||
      ''
    ).trim();
    if (directImage) return directImage;

    const fromList = this.extractKlingReferenceImages(params).find(item => item.type === 'end_frame');
    return String(fromList?.image_url || '').trim();
  }

  static extractKlingReferenceImages(params = {}) {
    const references = [];
    const pushReference = (value, type = '') => {
      const src = String(value || '').trim();
      if (!src) return;
      if (references.some(item => item.image_url === src)) return;
      references.push(type ? { image_url: src, type } : { image_url: src });
    };

    pushReference(params?.first_frame || params?.image_url || params?.image, 'first_frame');
    pushReference(params?.image_tail || params?.last_frame || params?.tail_image_url || params?.tailImageUrl, 'end_frame');

    if (Array.isArray(params?.image_list)) {
      params.image_list.forEach(item => {
        if (typeof item === 'string') pushReference(item);
        else if (item && typeof item === 'object') pushReference(item.image_url || item.image || item.url || item.src, item.type);
      });
    }
    if (Array.isArray(params?.reference_images)) {
      params.reference_images.forEach((item, index) => {
        if (typeof item === 'string') pushReference(item);
        else if (item && typeof item === 'object') pushReference(item.image_url || item.image || item.url || item.src, item.type || item.kind);
      });
    }
    if (Array.isArray(params?.referenceImages)) {
      params.referenceImages.forEach(item => {
        if (typeof item === 'string') pushReference(item);
        else if (item && typeof item === 'object') pushReference(item.image_url || item.image || item.url || item.src, item.type || item.kind);
      });
    }

    return references.slice(0, 8);
  }

  static extractKlingGeneralReferenceImages(params = {}) {
    return this.extractKlingReferenceImages(params)
      .filter(item => !['first_frame', 'end_frame'].includes(String(item.type || '').trim()))
      .map(item => ({ image: item.image_url }))
      .slice(0, 4);
  }

  static buildKlingTextToVideoPayload({ prompt, params, modelName, mode, duration, aspectRatio }) {
    const payload = {
      model_name: modelName,
      prompt: String(prompt || '').slice(0, 2500),
      negative_prompt: String(params?.negative_prompt || params?.negativePrompt || '').slice(0, 2500),
      cfg_scale: this.normalizeKlingCfgScale(params?.cfg_scale),
      mode,
      aspect_ratio: aspectRatio,
      duration,
      multi_shot: false,
      callback_url: String(params?.callback_url || ''),
      external_task_id: String(params?.external_task_id || ''),
      watermark_info: {
        enabled: false
      }
    };
    if (this.supportsKlingSound(modelName)) {
      payload.sound = params?.sound === 'on' ? 'on' : 'off';
    }
    return this.omitEmptyKlingFields(payload);
  }

  static buildKlingImageToVideoPayload({ prompt, params, modelName, mode, duration, sourceImage }) {
    const payload = {
      model_name: modelName,
      image: sourceImage,
      image_tail: this.extractKlingTailImage(params),
      prompt: String(prompt || '').slice(0, 2500),
      negative_prompt: String(params?.negative_prompt || params?.negativePrompt || '').slice(0, 2500),
      mode,
      duration,
      multi_shot: false,
      callback_url: String(params?.callback_url || ''),
      external_task_id: String(params?.external_task_id || ''),
      watermark_info: {
        enabled: false
      }
    };
    if (!this.isKlingV2Model(modelName)) {
      payload.cfg_scale = this.normalizeKlingCfgScale(params?.cfg_scale);
    }
    if (this.supportsKlingSound(modelName)) {
      payload.sound = params?.sound === 'on' ? 'on' : 'off';
    }
    return this.omitEmptyKlingFields(payload);
  }

  static buildKlingOmniVideoPayload({ prompt, params, modelName, mode, duration, aspectRatio }) {
    const imageList = this.extractKlingReferenceImages(params)
      .map(item => {
        const normalized = { image_url: item.image_url };
        const type = String(item.type || '').trim();
        if (['first_frame', 'end_frame'].includes(type)) normalized.type = type;
        return normalized;
      })
      .slice(0, 8);

    const payload = {
      model_name: modelName,
      prompt: String(prompt || '').slice(0, 2500),
      negative_prompt: String(params?.negative_prompt || params?.negativePrompt || '').slice(0, 2500),
      multi_shot: false,
      mode,
      aspect_ratio: aspectRatio,
      duration,
      watermark_info: {
        enabled: false
      },
      callback_url: String(params?.callback_url || ''),
      external_task_id: String(params?.external_task_id || '')
    };

    if (imageList.length) {
      payload.image_list = imageList;
    }

    if (this.supportsKlingSound(modelName)) {
      payload.sound = params?.sound === 'on' ? 'on' : 'off';
    }

    return this.omitEmptyKlingFields(payload);
  }

  static isKlingV2Model(modelName = '') {
    return /^kling-v2(?:$|-)/i.test(String(modelName || '').trim());
  }

  static supportsKlingSound(modelName = '') {
    return /^kling-v(?:2-6|3)(?:$|-)/i.test(String(modelName || '').trim());
  }

  static normalizeKlingCfgScale(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0.5;
    return Math.max(0, Math.min(1, numeric));
  }

  static omitEmptyKlingFields(payload) {
    return Object.fromEntries(
      Object.entries(payload).filter(([, value]) => {
        if (value === undefined || value === null) return false;
        if (typeof value === 'string' && value.trim() === '') return false;
        if (Array.isArray(value) && value.length === 0) return false;
        return true;
      })
    );
  }

  static normalizeKlingTaskResult(payload = {}) {
    const data = payload?.data || payload || {};
    const rawStatus = data.task_status || data.status || '';
    const status = String(rawStatus || '').toLowerCase();
    const message = data.task_status_msg || data.message || payload?.message || '';
    const videos = data.task_result?.videos || data.taskResult?.videos || data.videos || [];
    const firstVideo = Array.isArray(videos) ? videos.find(item => item?.url) : null;
    const url = firstVideo?.url || data.video_url || data.url || data.result_url || '';
    const completed = ['succeed', 'succeeded', 'success', 'completed', 'complete'].includes(status) || Boolean(url);
    const failed = ['failed', 'fail', 'error', 'rejected'].includes(status);

    return {
      rawStatus,
      status,
      message,
      url,
      completed,
      failed
    };
  }

  static extractKlingProviderErrorMessage(error) {
    const status = error?.response?.status;
    const providerMessage = this.extractProviderErrorMessage(error?.response?.data || '');
    if (providerMessage) {
      return `视频任务提交失败：${providerMessage}`;
    }
    if (status) {
      return `视频任务提交失败（HTTP ${status}）`;
    }
    return '';
  }

  // 文本对话：按后台配置的场景路由选择供应商、模型、超时和备用模型。
  static async chat({ userId, messages, model, params, runtimeConfig: runtimeConfigOverride, allowConfigOverride = false }) {
    try {
      const runtimeConfig = runtimeConfigOverride || RuntimeConfigService.getRuntimeConfig();
      const route = params?.route || 'chat';
      const routeConfig = RuntimeConfigService.resolveTextRoute(runtimeConfig, route, {
        model: allowConfigOverride ? model : undefined,
        providerId: allowConfigOverride ? params?.provider_id : undefined,
        fallbackProviderIds: allowConfigOverride ? params?.fallback_provider_ids : undefined,
        fallbackModels: allowConfigOverride ? params?.fallback_models : undefined,
        timeoutMs: allowConfigOverride ? params?.timeout_ms : undefined
      });
      const routingHint = AiHealthMonitorService.getRoutingHint(routeConfig.route || route);
      routeConfig.providers = this.orderProvidersByHealthHint(routeConfig.providers, routingHint);
      routeConfig.candidates = this.orderCandidatesByHealthHint(routeConfig.candidates, routingHint);

      const routeParams = { ...(params || {}), user_id: userId };
      const useStream = this.shouldUseStreamingTextRoute(routeParams);

      return useStream ? await this.chatTextRouteStream({
        routeConfig,
        messages,
        params: routeParams,
        onDelta: null
      }) : await this.chatTextRoute({
        routeConfig,
        messages,
        params: routeParams
      });
    } catch (error) {
      console.error('Chat API Error:', error.response?.data || error.message);
      throw error;
    }
  }

  static async chatStream({ userId, messages, model, params, runtimeConfig: runtimeConfigOverride, onDelta, allowConfigOverride = false }) {
    try {
      const runtimeConfig = runtimeConfigOverride || RuntimeConfigService.getRuntimeConfig();
      const route = params?.route || 'chat';
      const routeConfig = RuntimeConfigService.resolveTextRoute(runtimeConfig, route, {
        model: allowConfigOverride ? model : undefined,
        providerId: allowConfigOverride ? params?.provider_id : undefined,
        fallbackProviderIds: allowConfigOverride ? params?.fallback_provider_ids : undefined,
        fallbackModels: allowConfigOverride ? params?.fallback_models : undefined,
        timeoutMs: allowConfigOverride ? params?.timeout_ms : undefined
      });
      const routingHint = AiHealthMonitorService.getRoutingHint(routeConfig.route || route);
      routeConfig.providers = this.orderProvidersByHealthHint(routeConfig.providers, routingHint);
      routeConfig.candidates = this.orderCandidatesByHealthHint(routeConfig.candidates, routingHint);

      return await this.chatTextRouteStream({
        routeConfig,
        messages,
        params: { ...(params || {}), user_id: userId },
        onDelta
      });
    } catch (error) {
      console.error('Chat Stream API Error:', error.response?.data || error.message);
      throw error;
    }
  }

  static async chatTextRoute({ routeConfig, messages, params }) {
    if (Array.isArray(routeConfig.candidates) && routeConfig.candidates.length) {
      return await this.chatModelPoolRoute({ routeConfig, messages, params, stream: false });
    }

    const payload = this.toAnthropicPayload({
      messages,
      model: routeConfig.model,
      params
    });
    let lastError = null;

    for (let index = 0; index < routeConfig.providers.length; index += 1) {
      const provider = routeConfig.providers[index];
      const originalIndex = Number.isInteger(provider._failoverOriginalIndex) ? provider._failoverOriginalIndex : index;
      const channel = provider._failoverOriginalRole || (originalIndex === 0 ? 'primary' : 'fallback');
      const model = (routeConfig.modelOverridden || originalIndex === 0)
        ? (routeConfig.model || provider.defaultModel)
        : (provider.defaultModel || routeConfig.model);
      const providerConfig = {
        ...provider,
        channel,
        model
      };

      try {
        const result = this.shouldUseAnthropicProtocol(provider, model)
          ? await this.requestAnthropicCompletion({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              payload,
              model,
              timeoutMs: routeConfig.timeoutMs || provider.timeoutMs || 60000
            })
          : await this.requestOpenAiCompatibleCompletion({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              messages,
              model,
              params,
              timeoutMs: routeConfig.timeoutMs || provider.timeoutMs || 60000
            });

        return this.formatTextRouteResponse(result, providerConfig);
      } catch (error) {
        lastError = this.normalizeTextProviderError(error, providerConfig);
        if (index < routeConfig.providers.length - 1 && this.shouldTryTextProviderFallback(lastError)) {
          console.warn('[AiService] Text provider failed, trying fallback:', this.safeTextProviderError(lastError));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('文本模型请求失败');
  }

  static shouldUseStreamingTextRoute(params = {}) {
    if (params?.stream === false || params?.force_non_stream === true) return false;
    if (String(params?.stream_mode || params?.streamMode || '').trim().toLowerCase() === 'off') return false;
    return true;
  }

  static textStreamIdleTimeoutMs(params = {}) {
    const parsed = parseInt(params?.stream_idle_timeout_ms ?? params?.streamIdleTimeoutMs, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(10000, parsed);
    }
    return 60000;
  }

  static textStreamFirstContentTimeoutMs(params = {}) {
    const parsed = parseInt(
      params?.stream_first_token_timeout_ms
        ?? params?.streamFirstTokenTimeoutMs
        ?? params?.stream_initial_timeout_ms
        ?? params?.streamInitialTimeoutMs,
      10
    );
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(5000, parsed);
    }
    return 0;
  }

  static textStreamIdleTimeoutError(idleTimeoutMs) {
    const error = new Error(`文本模型流式响应连续 ${Math.round(idleTimeoutMs / 1000)} 秒无数据`);
    error.code = 'ESOCKETTIMEDOUT';
    return error;
  }

  static textStreamFirstContentTimeoutError(timeoutMs) {
    const error = new Error(`文本模型流式响应 ${Math.round(timeoutMs / 1000)} 秒内未返回首个正文 token`);
    error.code = 'ESTREAMFIRSTTOKENTIMEOUT';
    return error;
  }

  static async runWithInitialStreamTimeout(requestFactory, idleTimeoutMs) {
    const timeoutMs = parseInt(idleTimeoutMs, 10) || 60000;
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout = null;
    const timeoutError = this.textStreamIdleTimeoutError(timeoutMs);
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      if (rejectTimeout) rejectTimeout(timeoutError);
    }, timeoutMs);

    const requestPromise = requestFactory(controller.signal);
    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (error) {
      requestPromise.catch(() => {});
      if (timedOut) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  static async chatModelPoolRoute({ routeConfig, messages, params, stream = false, onDelta = null }) {
    return await AiRouterService.withCandidate({
      route: routeConfig.route || 'chat',
      userId: params?.user_id || params?.userId || '',
      messages,
      params,
      candidates: routeConfig.candidates,
      streamMode: stream ? 'stream' : 'non_stream',
      queueTimeoutMs: parseInt(params?.queue_timeout_ms || params?.queueTimeoutMs || routeConfig.queueTimeoutMs || 8000, 10) || 8000,
      isRetryable: error => this.shouldTryTextProviderFallback(error),
      onAttempt: candidate => {
        if (candidate.role !== 'primary') {
          console.warn('[AiService] Text model router selected fallback/pool candidate:', `${candidate.qualifiedId} route=${routeConfig.route || 'chat'}`);
        }
      }
    }, async candidate => {
      const provider = candidate.provider || {};
      const model = candidate.model || provider.defaultModel || routeConfig.model;
      const providerConfig = {
        ...provider,
        channel: candidate.role || 'pool',
        model
      };
      const payload = this.toAnthropicPayload({
        messages,
        model,
        params
      });

      try {
        const result = this.shouldUseAnthropicProtocol(provider, model)
          ? (stream
              ? await this.requestAnthropicCompletionStream({
                  baseUrl: provider.baseUrl,
                  apiKey: provider.apiKey,
                  payload,
                  model,
                  timeoutMs: this.textStreamIdleTimeoutMs(params),
                  idleTimeoutMs: this.textStreamIdleTimeoutMs(params),
                  firstContentTimeoutMs: this.textStreamFirstContentTimeoutMs(params),
                  onDelta
                })
              : await this.requestAnthropicCompletion({
                  baseUrl: provider.baseUrl,
                  apiKey: provider.apiKey,
                  payload,
                  model,
                  timeoutMs: candidate.timeoutMs || routeConfig.timeoutMs || provider.timeoutMs || 60000
                }))
          : (stream
              ? await this.requestOpenAiCompatibleCompletionStream({
                  baseUrl: provider.baseUrl,
                  apiKey: provider.apiKey,
                  messages,
                  model,
                  params,
                  timeoutMs: this.textStreamIdleTimeoutMs(params),
                  idleTimeoutMs: this.textStreamIdleTimeoutMs(params),
                  firstContentTimeoutMs: this.textStreamFirstContentTimeoutMs(params),
                  onDelta
                })
              : await this.requestOpenAiCompatibleCompletion({
                  baseUrl: provider.baseUrl,
                  apiKey: provider.apiKey,
                  messages,
                  model,
                  params,
                  timeoutMs: candidate.timeoutMs || routeConfig.timeoutMs || provider.timeoutMs || 60000
                }));

        return this.formatTextRouteResponse(result, providerConfig);
      } catch (error) {
        throw this.normalizeTextProviderError(error, providerConfig);
      }
    });
  }

  static async chatTextRouteStream({ routeConfig, messages, params, onDelta }) {
    if (Array.isArray(routeConfig.candidates) && routeConfig.candidates.length) {
      return await this.chatModelPoolRoute({ routeConfig, messages, params, stream: true, onDelta });
    }

    const payload = this.toAnthropicPayload({
      messages,
      model: routeConfig.model,
      params
    });
    let lastError = null;

    for (let index = 0; index < routeConfig.providers.length; index += 1) {
      const provider = routeConfig.providers[index];
      const originalIndex = Number.isInteger(provider._failoverOriginalIndex) ? provider._failoverOriginalIndex : index;
      const channel = provider._failoverOriginalRole || (originalIndex === 0 ? 'primary' : 'fallback');
      const model = (routeConfig.modelOverridden || originalIndex === 0)
        ? (routeConfig.model || provider.defaultModel)
        : (provider.defaultModel || routeConfig.model);
      const providerConfig = {
        ...provider,
        channel,
        model
      };

      try {
        const result = this.shouldUseAnthropicProtocol(provider, model)
          ? await this.requestAnthropicCompletionStream({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              payload,
              model,
              timeoutMs: this.textStreamIdleTimeoutMs(params),
              idleTimeoutMs: this.textStreamIdleTimeoutMs(params),
              firstContentTimeoutMs: this.textStreamFirstContentTimeoutMs(params),
              onDelta
            })
          : await this.requestOpenAiCompatibleCompletionStream({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              messages,
              model,
              params,
              timeoutMs: this.textStreamIdleTimeoutMs(params),
              idleTimeoutMs: this.textStreamIdleTimeoutMs(params),
              firstContentTimeoutMs: this.textStreamFirstContentTimeoutMs(params),
              onDelta
            });

        return this.formatTextRouteResponse(result, providerConfig);
      } catch (error) {
        lastError = this.normalizeTextProviderError(error, providerConfig);
        if (index < routeConfig.providers.length - 1 && this.shouldTryTextProviderFallback(lastError)) {
          console.warn('[AiService] Text stream provider failed, trying fallback:', this.safeTextProviderError(lastError));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('文本模型流式请求失败');
  }

  static async requestOpenAiCompatibleCompletion({ baseUrl, apiKey, messages, model, params, timeoutMs }) {
    const response = await axios.post(
      `${this.normalizeOpenAiCompatibleBaseUrl(baseUrl)}/chat/completions`,
      {
        model,
        messages,
        temperature: params?.temperature ?? 0.7,
        max_tokens: params?.max_tokens ?? 4096,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs || params?.timeout_ms || 60000,
        responseType: 'text',
        transformResponse: [data => data]
      }
    );
    response.data = this.parseProviderResponseBody(response.data);
    const content = this.extractTextValue(response.data);
    const choices = response.data?.choices || (content ? [{ index: 0, message: { role: 'assistant', content }, finish_reason: null }] : []);

    if (!choices.length) {
      const error = new Error(`OpenAI-compatible provider returned empty content for ${model}`);
      error.code = 'EMPTY_MODEL_RESPONSE';
      error.response = {
        status: response.status,
        data: response.data
      };
      throw error;
    }

    return {
      data: response.data,
      model: response.data?.model || model,
      choices,
      usage: response.data?.usage
    };
  }

  static async requestOpenAiCompatibleCompletionStream({ baseUrl, apiKey, messages, model, params, timeoutMs, idleTimeoutMs, firstContentTimeoutMs, onDelta }) {
    const streamIdleMs = idleTimeoutMs || timeoutMs || params?.timeout_ms || 60000;
    const response = await this.runWithInitialStreamTimeout(
      signal => axios.post(
        `${this.normalizeOpenAiCompatibleBaseUrl(baseUrl)}/chat/completions`,
        {
          model,
          messages,
          temperature: params?.temperature ?? 0.7,
          max_tokens: params?.max_tokens ?? 4096,
          stream: true
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
          },
          timeout: 0,
          signal,
          responseType: 'stream'
        }
      ),
      streamIdleMs
    );

    let content = '';
    let finalChunk = {};
    let usage = null;
    let responseModel = model;
    let responseId = '';

    await this.readServerSentEvents(response.data, event => {
      const raw = String(event.data || '').trim();
      if (!raw || raw === '[DONE]') return;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return;
      }
      finalChunk = parsed;
      if (parsed.id) responseId = parsed.id;
      if (parsed.model) responseModel = parsed.model;
      if (parsed.usage) usage = parsed.usage;

      const delta = this.extractOpenAiStreamDelta(parsed);
      if (delta) {
        content += delta;
        if (onDelta) onDelta(delta, parsed);
      }
    }, {
      idleTimeoutMs: streamIdleMs,
      firstContentTimeoutMs,
      isContentEvent: event => {
        const raw = String(event.data || '').trim();
        if (!raw || raw === '[DONE]') return false;
        try {
          return Boolean(this.extractOpenAiStreamDelta(JSON.parse(raw)));
        } catch {
          return false;
        }
      }
    });

    if (!content.trim()) {
      const error = new Error(`OpenAI-compatible provider returned empty stream for ${model}`);
      error.code = 'EMPTY_MODEL_RESPONSE';
      error.response = {
        status: response.status,
        data: finalChunk
      };
      throw error;
    }

    return {
      data: {
        ...finalChunk,
        id: responseId || finalChunk.id,
        model: responseModel
      },
      model: responseModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finalChunk.choices?.[0]?.finish_reason || null
        }
      ],
      usage
    };
  }

  static formatTextRouteResponse(result, provider) {
    if (result.choices) {
      return {
        id: result.data?.id,
        choices: result.choices,
        usage: result.usage,
        model: result.model || result.data?.model || provider?.model || '',
        provider: this.safeTextProviderInfo(provider)
      };
    }

    return {
      id: result.data?.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content
          },
          finish_reason: result.data?.stop_reason || result.data?.choices?.[0]?.finish_reason || null
        }
      ],
      usage: result.data?.usage,
      model: result.model || result.data?.model || provider?.model || '',
      provider: this.safeTextProviderInfo(provider)
    };
  }

  static normalizeTextProviderError(error, provider) {
    if (error?.textProvider) return error;

    const providerData = this.parseProviderResponseBody(error?.response?.data);
    const message = this.extractProviderErrorMessage(providerData)
      || this.extractProviderErrorMessage(error?.response?.data)
      || error?.cause?.message
      || error?.message
      || '文本模型请求失败';
    const normalizedError = new Error(message);
    normalizedError.code = error?.code;
    normalizedError.response = error?.response
      ? {
          status: error.response.status,
          data: providerData
        }
      : undefined;
    normalizedError.textProvider = this.safeTextProviderInfo(provider);
    return normalizedError;
  }

  static shouldTryTextProviderFallback(error) {
    const status = error?.response?.status;
    if ([401, 403, 404].includes(status)) return true;
    if (status === 400) {
      const providerData = this.parseProviderResponseBody(error?.response?.data);
      const haystack = [
        error?.message,
        providerData?.error?.code,
        providerData?.error?.type,
        providerData?.error?.message,
        providerData?.code,
        providerData?.type,
        providerData?.message
      ].filter(Boolean).join(' ').toLowerCase();
      return /model|模型|unsupported|not found|provider|quota|limit|capacity|route/.test(haystack);
    }
    return this.isRetryableProviderError(error) || String(error?.code || '').toUpperCase() === 'EMPTY_MODEL_RESPONSE';
  }

  static safeTextProviderInfo(provider = {}) {
    return {
      channel: provider.channel || 'primary',
      id: provider.id || '',
      name: provider.name || '',
      format: provider.format || '',
      baseUrl: provider.baseUrl || '',
      model: provider.model || provider.defaultModel || ''
    };
  }

  static safeTextProviderError(error) {
    const status = error?.response?.status;
    const provider = error?.textProvider || {};
    return [
      provider.channel ? `channel=${provider.channel}` : '',
      provider.id ? `provider=${provider.id}` : '',
      provider.baseUrl ? `baseUrl=${provider.baseUrl}` : '',
      status ? `status=${status}` : '',
      error?.code ? `code=${error.code}` : '',
      error?.message || ''
    ].filter(Boolean).join(' ');
  }

  static async chatOpenAiCompatible({ runtimeConfig, messages, model, params }) {
    const providers = this.getOpenAiChatProviderConfigs(runtimeConfig, model);
    let lastError = null;

    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      try {
        const response = await axios.post(
          `${provider.baseUrl}/chat/completions`,
          {
            model: provider.model,
            messages,
            temperature: params?.temperature ?? 0.7,
            max_tokens: params?.max_tokens ?? 4096,
            stream: false
          },
          {
            headers: {
              'Authorization': `Bearer ${provider.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: params?.timeout_ms || 60000
          }
        );

        return {
          id: response.data.id,
          model: response.data.model || provider.model,
          choices: response.data.choices,
          usage: response.data.usage,
          provider: this.safeOpenAiChatProviderInfo(provider)
        };
      } catch (error) {
        lastError = this.normalizeOpenAiChatError(error, provider);
        if (index < providers.length - 1 && this.shouldTryOpenAiChatProviderFallback(lastError)) {
          console.warn('[AiService] OpenAI-compatible chat primary failed, trying fallback:', this.safeOpenAiChatError(lastError));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('OpenAI-compatible chat request failed');
  }

  static getOpenAiChatProviderConfigs(runtimeConfig = {}, model) {
    const providers = [this.getOpenAiChatRuntimeConfig(runtimeConfig, model, 'primary')];
    const fallbackEnabled = runtimeConfig.openAiChatFailoverEnabled === true
      || runtimeConfig.openAiChatFailoverEnabled === 'true'
      || runtimeConfig.openAiChatFailoverEnabled === 1;
    if (!fallbackEnabled) return providers;

    const fallbackBaseUrl = String(runtimeConfig.openAiChatFallbackBaseUrl || '').replace(/\/+$/, '');
    const fallbackApiKey = runtimeConfig.openAiChatFallbackApiKey || '';
    if (!fallbackBaseUrl || !fallbackApiKey) return providers;

    const fallbackConfig = this.getOpenAiChatRuntimeConfig(runtimeConfig, model, 'fallback');
    const primaryKey = `${providers[0].baseUrl}|${providers[0].apiKey}|${providers[0].model}`;
    const fallbackKey = `${fallbackConfig.baseUrl}|${fallbackConfig.apiKey}|${fallbackConfig.model}`;
    if (fallbackKey !== primaryKey) providers.push(fallbackConfig);
    return providers;
  }

  static getOpenAiChatRuntimeConfig(runtimeConfig = {}, model, channel = 'primary') {
    const isFallback = channel === 'fallback';
    const baseUrl = String(isFallback ? runtimeConfig.openAiChatFallbackBaseUrl : runtimeConfig.providerBaseUrl || '').replace(/\/+$/, '');
    const apiKey = isFallback ? runtimeConfig.openAiChatFallbackApiKey : runtimeConfig.providerApiKey;

    if (!baseUrl || !apiKey) {
      throw new Error('OpenAI-compatible chat 缺少 Base URL 或 API Key');
    }

    return {
      channel: isFallback ? 'fallback' : 'primary',
      baseUrl,
      apiKey,
      model: isFallback ? (runtimeConfig.openAiChatFallbackModel || model) : model
    };
  }

  static normalizeOpenAiChatError(error, provider) {
    if (error?.openAiChatProvider) return error;

    const providerData = this.parseProviderResponseBody(error?.response?.data);
    const message = this.extractProviderErrorMessage(providerData)
      || this.extractProviderErrorMessage(error?.response?.data)
      || error?.cause?.message
      || error?.message
      || 'OpenAI-compatible chat 请求失败';
    const normalizedError = new Error(message);
    normalizedError.code = error?.code;
    normalizedError.response = error?.response
      ? {
          status: error.response.status,
          data: providerData
        }
      : undefined;
    normalizedError.openAiChatProvider = this.safeOpenAiChatProviderInfo(provider);
    return normalizedError;
  }

  static shouldTryOpenAiChatProviderFallback(error) {
    if ([400, 401, 403, 404].includes(error?.response?.status)) return true;
    return this.isRetryableProviderError(error);
  }

  static safeOpenAiChatProviderInfo(provider = {}) {
    return {
      channel: provider.channel || 'primary',
      baseUrl: provider.baseUrl || '',
      model: provider.model || ''
    };
  }

  static safeOpenAiChatError(error) {
    const status = error?.response?.status;
    const provider = error?.openAiChatProvider || {};
    return [
      provider.channel ? `channel=${provider.channel}` : '',
      provider.baseUrl ? `provider=${provider.baseUrl}` : '',
      status ? `status=${status}` : '',
      error?.code ? `code=${error.code}` : '',
      error?.message || ''
    ].filter(Boolean).join(' ');
  }

  static async chatAnthropic({ runtimeConfig, messages, model, params }) {
    const payload = this.toAnthropicPayload({
      messages,
      model,
      params
    });

    let result;
    try {
      result = await this.requestAnthropicCompletion({
        baseUrl: runtimeConfig.providerBaseUrl,
        apiKey: runtimeConfig.providerApiKey,
        payload,
        model,
        timeoutMs: params?.timeout_ms || 60000
      });
    } catch (error) {
      if (!this.shouldTryAnthropicFallback(error, runtimeConfig)) {
        throw error;
      }

      console.warn('[AiService] Anthropic primary failed, switching to fallback provider:', this.safeProviderError(error));
      result = await this.requestAnthropicFallbackCompletion({
        runtimeConfig,
        payload,
        model,
        timeoutMs: params?.timeout_ms || 60000
      });
    }

    return {
      id: result.data?.id,
      model: result.data?.model || result.model || model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content
          },
          finish_reason: result.data?.stop_reason || result.data?.choices?.[0]?.finish_reason || null
        }
      ],
      usage: result.data?.usage
    };
  }

  static async requestAnthropicCompletion({ baseUrl, apiKey, payload, model, timeoutMs }) {
    const response = await this.postAnthropicMessages({
      baseUrl,
      apiKey,
      payload: { ...payload, model },
      timeoutMs
    });
    const content = this.extractAnthropicText(response.data);

    if (!content) {
      const error = new Error(`Anthropic provider returned empty content for ${model}`);
      error.code = 'EMPTY_MODEL_RESPONSE';
      error.response = {
        status: response.status,
        data: response.data
      };
      throw error;
    }

    return {
      data: response.data,
      model,
      content
    };
  }

  static async requestAnthropicCompletionStream({ baseUrl, apiKey, payload, model, timeoutMs, idleTimeoutMs, firstContentTimeoutMs, onDelta }) {
    const response = await this.postAnthropicMessagesStream({
      baseUrl,
      apiKey,
      payload: { ...payload, model },
      timeoutMs,
      onDelta,
      idleTimeoutMs,
      firstContentTimeoutMs
    });

    if (!response.content.trim()) {
      const error = new Error(`Anthropic provider returned empty stream for ${model}`);
      error.code = 'EMPTY_MODEL_RESPONSE';
      error.response = {
        status: response.status,
        data: response.data
      };
      throw error;
    }

    return {
      data: response.data,
      model,
      content: response.content
    };
  }

  static async requestAnthropicFallbackCompletion({ runtimeConfig, payload, model, timeoutMs }) {
    const candidates = this.anthropicFallbackModelCandidates(model, runtimeConfig);
    let lastError = null;

    for (const candidate of candidates) {
      try {
        if (candidate !== model) {
          console.warn(`[AiService] Trying Anthropic fallback model ${candidate} after ${model} failed on fallback provider`);
        }
        return await this.requestAnthropicCompletion({
          baseUrl: runtimeConfig.anthropicFallbackBaseUrl,
          apiKey: runtimeConfig.anthropicFallbackApiKey,
          payload,
          model: candidate,
          timeoutMs
        });
      } catch (error) {
        lastError = error;
        if (!this.shouldTryNextAnthropicFallbackModel(error)) {
          throw error;
        }
        console.warn('[AiService] Anthropic fallback model failed:', candidate, this.safeProviderError(error));
      }
    }

    throw lastError || new Error('Anthropic fallback provider failed');
  }

  static anthropicFallbackModelCandidates(model, runtimeConfig = {}) {
    const candidates = [model];
    const fallbackBaseUrl = String(runtimeConfig.anthropicFallbackBaseUrl || '');

    if (/timebackward\.com/i.test(fallbackBaseUrl) && /^claude[-_]opus[-_]4[-_]7$/i.test(String(model || ''))) {
      candidates.push('claude-opus-4-6');
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  static async postAnthropicMessages({ baseUrl, apiKey, payload, timeoutMs }) {
    const response = await axios.post(
      this.anthropicMessagesUrl(baseUrl),
      { stream: false, ...payload },
      {
        headers: {
          'x-api-key': apiKey,
          'Authorization': `Bearer ${apiKey}`,
          'anthropic-version': '2023-06-01',
          'accept': 'application/json',
          'content-type': 'application/json'
        },
        timeout: timeoutMs,
        responseType: 'text',
        transformResponse: [data => data]
      }
    );
    response.data = this.parseProviderResponseBody(response.data);
    return response;
  }

  static async postAnthropicMessagesStream({ baseUrl, apiKey, payload, timeoutMs, onDelta, idleTimeoutMs, firstContentTimeoutMs }) {
    const streamIdleMs = idleTimeoutMs || timeoutMs || 60000;
    const response = await this.runWithInitialStreamTimeout(
      signal => axios.post(
        this.anthropicMessagesUrl(baseUrl),
        { stream: true, ...payload },
        {
          headers: {
            'x-api-key': apiKey,
            'Authorization': `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
            'accept': 'text/event-stream',
            'content-type': 'application/json'
          },
          timeout: 0,
          signal,
          responseType: 'stream'
        }
      ),
      streamIdleMs
    );

    let content = '';
    let finalData = {};
    await this.readServerSentEvents(response.data, event => {
      const raw = String(event.data || '').trim();
      if (!raw || raw === '[DONE]') return;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        return;
      }
      finalData = parsed;
      const delta = this.extractAnthropicStreamDelta(parsed);
      if (delta) {
        content += delta;
        if (onDelta) onDelta(delta, parsed);
      }
    }, {
      idleTimeoutMs: streamIdleMs,
      firstContentTimeoutMs,
      isContentEvent: event => {
        const raw = String(event.data || '').trim();
        if (!raw || raw === '[DONE]') return false;
        try {
          return Boolean(this.extractAnthropicStreamDelta(JSON.parse(raw)));
        } catch {
          return false;
        }
      }
    });

    return {
      status: response.status,
      data: {
        ...finalData,
        content: content ? [{ type: 'text', text: content }] : finalData.content
      },
      content
    };
  }

  static shouldTryAnthropicFallback(error, runtimeConfig = {}) {
    if (!runtimeConfig.anthropicFallbackBaseUrl || !runtimeConfig.anthropicFallbackApiKey) return false;
    const primary = String(runtimeConfig.providerBaseUrl || '').replace(/\/+$/, '');
    const fallback = String(runtimeConfig.anthropicFallbackBaseUrl || '').replace(/\/+$/, '');
    if (!fallback || primary === fallback) return false;

    const status = error.response?.status;
    if ([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) return true;

    const code = String(error.code || '').toUpperCase();
    return ['EMPTY_MODEL_RESPONSE', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ESTREAMFIRSTTOKENTIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
  }

  static shouldTryNextAnthropicFallbackModel(error) {
    const status = error.response?.status;
    if ([404, 408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) return true;

    const data = this.parseProviderResponseBody(error.response?.data);
    const providerCode = String(data?.error?.code || data?.error_code || '').toLowerCase();
    if (providerCode.includes('model') || providerCode.includes('capacity') || providerCode.includes('rate')) return true;

    const code = String(error.code || '').toUpperCase();
    return ['EMPTY_MODEL_RESPONSE', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ESTREAMFIRSTTOKENTIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
  }

  static safeProviderError(error) {
    const status = error.response?.status;
    const data = this.parseProviderResponseBody(error.response?.data);
    const code = data?.error_code || data?.error?.code || error.code || '';
    const title = data?.title || data?.error?.message || error.message || '';
    return [status ? `status=${status}` : '', code ? `code=${code}` : '', title].filter(Boolean).join(' ');
  }

  static toAnthropicPayload({ messages = [], model, params = {} }) {
    const systemParts = [];
    const anthropicMessages = [];

    for (const message of messages || []) {
      if (!message || !message.role) continue;
      const content = this.normalizeMessageContent(message.content);
      if (!content) continue;

      if (message.role === 'system') {
        systemParts.push(content);
        continue;
      }

      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const previous = anthropicMessages[anthropicMessages.length - 1];
      if (previous && previous.role === role) {
        previous.content = this.mergeAnthropicContent(previous.content, content);
      } else {
        anthropicMessages.push({ role, content });
      }
    }

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: 'Hello' });
    }

    const payload = {
      model,
      max_tokens: params?.max_tokens ?? 4096,
      messages: anthropicMessages
    };

    if (systemParts.length > 0) {
      payload.system = systemParts.join('\n\n');
    }

    if (params?.temperature !== undefined) {
      payload.temperature = params.temperature;
    }

    return payload;
  }

  static normalizeMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const blocks = content.map(item => this.normalizeAnthropicContentBlock(item)).filter(Boolean);
      if (blocks.length === 0) return '';
      if (blocks.every(item => typeof item === 'string')) return blocks.join('\n');
      return blocks.flatMap(item => typeof item === 'string' ? [{ type: 'text', text: item }] : [item]);
    }
    if (content === undefined || content === null) return '';
    return JSON.stringify(content);
  }

  static normalizeAnthropicContentBlock(item) {
    if (typeof item === 'string') return item;
    if (item?.type === 'text') return item.text || '';
    if (item?.type === 'image_url') {
      const imageUrl = item.image_url?.url || item.url || '';
      const parsed = this.parseDataUrlImageBlock(imageUrl);
      if (parsed) return parsed;
      if (/^https?:\/\//i.test(imageUrl)) {
        return {
          type: 'image',
          source: {
            type: 'url',
            url: imageUrl
          }
        };
      }
    }
    return JSON.stringify(item);
  }

  static parseDataUrlImageBlock(value) {
    const match = String(value || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
    if (!match) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1],
        data: match[2].replace(/\s+/g, '')
      }
    };
  }

  static mergeAnthropicContent(current, next) {
    if (typeof current === 'string' && typeof next === 'string') {
      return `${current}\n\n${next}`;
    }

    const currentBlocks = Array.isArray(current)
      ? current
      : [{ type: 'text', text: String(current || '') }];
    const nextBlocks = Array.isArray(next)
      ? next
      : [{ type: 'text', text: String(next || '') }];
    return currentBlocks.concat(nextBlocks).filter(block => !(block.type === 'text' && !block.text));
  }

  static extractAnthropicText(data) {
    return this.extractTextValue(data).trim();
  }

  static parseProviderResponseBody(body) {
    if (body && typeof body === 'object') return body;
    if (typeof body !== 'string') return body || {};

    const text = body.trim();
    if (!text) return {};

    if (text.startsWith('data:') || /\ndata:/.test(text)) {
      return this.parseEventStreamResponse(text);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return { content: [{ type: 'text', text }] };
    }
  }

  static parseEventStreamResponse(text) {
    const chunks = [];
    const events = text.split(/\n\n+/);

    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.replace(/^data:\s?/, ''));
      if (dataLines.length === 0) continue;

      const raw = dataLines.join('\n').trim();
      if (!raw || raw === '[DONE]') continue;

      try {
        chunks.push(JSON.parse(raw));
      } catch (error) {
        chunks.push({ content: [{ type: 'text', text: raw }] });
      }
    }

    const last = chunks[chunks.length - 1] || {};
    const content = chunks
      .map(chunk => this.extractTextValue(chunk))
      .filter(Boolean)
      .join('')
      .trim();

    return {
      ...last,
      content: content ? [{ type: 'text', text: content }] : (last.content || []),
      usage: last.usage || chunks.find(chunk => chunk.usage)?.usage,
      model: last.model || chunks.find(chunk => chunk.model)?.model,
      id: last.id || chunks.find(chunk => chunk.id)?.id
    };
  }

  static async readServerSentEvents(stream, onEvent, options = {}) {
    const idleTimeoutMs = parseInt(options?.idleTimeoutMs, 10) || 60000;
    const firstContentTimeoutMs = parseInt(options?.firstContentTimeoutMs, 10) || 0;
    let timedOut = false;
    let firstContentTimedOut = false;
    let firstContentSeen = firstContentTimeoutMs <= 0;
    let timer = null;
    let firstContentTimer = null;
    let rejectIdle = null;
    let rejectFirstContent = null;
    const timeoutError = this.textStreamIdleTimeoutError(idleTimeoutMs);
    const firstContentTimeoutError = firstContentTimeoutMs > 0
      ? this.textStreamFirstContentTimeoutError(firstContentTimeoutMs)
      : null;
    const idleTimeoutPromise = new Promise((_, reject) => {
      rejectIdle = reject;
    });
    const firstContentTimeoutPromise = firstContentTimeoutMs > 0
      ? new Promise((_, reject) => {
          rejectFirstContent = reject;
        })
      : null;
    const clearIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const clearFirstContentTimer = () => {
      if (firstContentTimer) clearTimeout(firstContentTimer);
      firstContentTimer = null;
    };
    const resetIdleTimer = () => {
      clearIdleTimer();
      timer = setTimeout(() => {
        timedOut = true;
        if (typeof stream.destroy === 'function') stream.destroy(timeoutError);
        if (rejectIdle) rejectIdle(timeoutError);
      }, idleTimeoutMs);
    };
    const resetFirstContentTimer = () => {
      clearFirstContentTimer();
      if (firstContentSeen || firstContentTimeoutMs <= 0) return;
      firstContentTimer = setTimeout(() => {
        firstContentTimedOut = true;
        if (typeof stream.destroy === 'function') stream.destroy(firstContentTimeoutError);
        if (rejectFirstContent) rejectFirstContent(firstContentTimeoutError);
      }, firstContentTimeoutMs);
    };
    const markFirstContent = () => {
      if (firstContentSeen) return;
      firstContentSeen = true;
      clearFirstContentTimer();
    };
    const handleParsedEvent = parsed => {
      if (!parsed) return;
      if (!firstContentSeen && typeof options?.isContentEvent === 'function') {
        try {
          if (options.isContentEvent(parsed)) markFirstContent();
        } catch {
          // Content detection is best-effort; parsing happens again in the caller.
        }
      }
      onEvent(parsed, { markFirstContent });
    };

    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      const error = new Error('文本模型没有返回可读取的流式响应');
      error.code = 'EMPTY_STREAM_RESPONSE';
      throw error;
    }

    let buffer = '';
    const readPromise = (async () => {
      resetIdleTimer();
      resetFirstContentTimer();
      for await (const chunk of stream) {
        resetIdleTimer();
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        let boundaryMatch = buffer.match(/\r?\n\r?\n/);
        while (boundaryMatch) {
          const boundaryIndex = boundaryMatch.index;
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + boundaryMatch[0].length);
          const parsed = this.parseServerSentEventBlock(rawEvent);
          handleParsedEvent(parsed);
          boundaryMatch = buffer.match(/\r?\n\r?\n/);
        }
      }

      if (buffer.trim()) {
        const parsed = this.parseServerSentEventBlock(buffer);
        handleParsedEvent(parsed);
      }
    })();

    try {
      await Promise.race([readPromise, idleTimeoutPromise, firstContentTimeoutPromise].filter(Boolean));
      await readPromise;
    } catch (error) {
      readPromise.catch(() => {});
      if (timedOut) throw timeoutError;
      if (firstContentTimedOut) throw firstContentTimeoutError;
      throw error;
    } finally {
      clearIdleTimer();
      clearFirstContentTimer();
    }
  }

  static parseServerSentEventBlock(block) {
    const lines = String(block || '').split(/\r?\n/);
    const dataLines = [];
    let event = 'message';
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const separatorIndex = line.indexOf(':');
      const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
      const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).replace(/^ /, '') : '';
      if (field === 'event') event = value || 'message';
      if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return null;
    return {
      event,
      data: dataLines.join('\n')
    };
  }

  static extractOpenAiStreamDelta(chunk) {
    if (!chunk || typeof chunk !== 'object') return '';
    if (!Array.isArray(chunk.choices)) return this.extractTextValue(chunk.delta || chunk);
    return chunk.choices
      .map(choice => this.extractTextValue(choice.delta?.content)
        || this.extractTextValue(choice.delta?.text)
        || this.extractTextValue(choice.delta)
        || this.extractTextValue(choice.message?.content)
        || this.extractTextValue(choice.text))
      .filter(Boolean)
      .join('');
  }

  static extractAnthropicStreamDelta(chunk) {
    if (!chunk || typeof chunk !== 'object') return '';
    if (chunk.type === 'content_block_delta') {
      return this.extractTextValue(chunk.delta?.text || chunk.delta);
    }
    if (chunk.type === 'content_block_start') {
      return this.extractTextValue(chunk.content_block?.text || '');
    }
    if (chunk.type === 'text_delta') {
      return this.extractTextValue(chunk.text || chunk.delta);
    }
    return '';
  }

  static extractTextValue(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(item => this.extractTextValue(item)).filter(Boolean).join('\n');
    }
    if (typeof value !== 'object') return '';

    const blockType = String(value.type || '').trim().toLowerCase();
    if (['thinking', 'thinking_delta', 'reasoning', 'reasoning_delta', 'signature'].includes(blockType)) {
      return '';
    }
    if (typeof value.text === 'string' && (value.type === 'text' || value.type === 'text_delta' || !value.type)) {
      return value.text;
    }
    if (typeof value.output_text === 'string') {
      return value.output_text;
    }
    if (value.content !== undefined) {
      return this.extractTextValue(value.content);
    }
    if (value.message?.content !== undefined) {
      return this.extractTextValue(value.message.content);
    }
    if (value.delta?.text !== undefined) {
      return this.extractTextValue(value.delta.text);
    }
    if (value.delta?.content !== undefined) {
      return this.extractTextValue(value.delta.content);
    }
    if (Array.isArray(value.choices)) {
      return value.choices
        .map(choice => this.extractTextValue(choice.message?.content)
          || this.extractTextValue(choice.delta?.content)
          || this.extractTextValue(choice.delta?.text))
        .filter(Boolean)
        .join('');
    }
    if (Array.isArray(value.output)) {
      return value.output.map(item => this.extractTextValue(item)).filter(Boolean).join('\n');
    }

    return '';
  }

  static isAnthropicModel(model = '') {
    return /^claude[-_]/i.test(String(model || ''));
  }

  static shouldUseAnthropicProtocol(provider = {}, model = '') {
    return provider?.format === 'anthropic' && this.isAnthropicModel(model);
  }

  static anthropicMessagesUrl(baseUrl = '') {
    const normalized = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
    return `${normalized}/v1/messages`;
  }

  static async callOpenAI({ prompt, schema }) {
    // 使用 timebackward API 替代 OpenAI
    try {
      const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
      const response = await this.chat({
        userId: 'legacy-ppt',
        model: runtimeConfig.pptModel || 'claude-opus-4-7',
        messages: [
          {
            role: 'system',
            content: loadPrompt('ppt')
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        params: { route: 'ppt', temperature: 0.7, max_tokens: 4096, timeout_ms: runtimeConfig.pptTimeoutMs || 60000 }
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
      if (!runtimeConfig.providerApiKey) {
        return this.mockGenerateContent(prompt, schema);
      }
      throw error;
    }
  }

  static mockGenerateContent(prompt, schema) {
    console.log('使用模拟数据 (未配置API Key)');

    if (schema && Array.isArray(schema.slides)) {
      return {
        slides: [
          { title: '封面', content: prompt.substring(0, 50), layout: 'cover' },
          { title: '目录', content: '1. 概述\n2. 详细内容\n3. 总结', layout: 'toc' },
          { title: '第一部分', content: '这是根据您的需求生成的详细内容...', layout: 'content' },
          { title: '总结', content: '感谢观看', layout: 'ending' }
        ],
        theme: 'modern-blue',
        style: 'professional'
      };
    }

    return { content: prompt, status: 'mock' };
  }

  static async processTask(taskId) {
    const task = AiTask.findById(taskId);
    if (!task) {
      throw new Error('任务不存在');
    }

    const params = task.params ? JSON.parse(task.params) : {};

    switch (task.type) {
      case 'ppt':
        return this.generatePPT({ userId: task.user_id, prompt: task.prompt, params });
      case 'image':
        return this.generateImage({ userId: task.user_id, prompt: task.prompt, params, task });
      case 'video':
        return this.generateVideo({ userId: task.user_id, prompt: task.prompt, params });
      default:
        throw new Error(`不支持的任务类型: ${task.type}`);
    }
  }
}

module.exports = AiService;
