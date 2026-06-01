const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db } = require('../models/database');
const CryptoVault = require('../utils/cryptoVault');
const appConfig = require('../config/appConfig');

const ADMIN_CONFIG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT,
    label TEXT,
    type TEXT DEFAULT 'text',
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const DEFAULT_RECHARGE_PACKAGES = [
  { id: 'vip-monthly', type: 'vip', title: '开通 VIP', benefitText: '会员期间所有额度 8 折使用', originalPrice: '98', price: '68', tag: '五一特惠', vipDays: 30 },
  { id: 'credits-20000', type: 'credits', title: '20000 积分', credits: 20000, originalPrice: '648', price: '388.8', tag: '五一特惠' },
  { id: 'credits-3800', type: 'credits', title: '3800 积分', credits: 3800, originalPrice: '128', price: '76.8', tag: '五一特惠' },
  { id: 'credits-850', type: 'credits', title: '850 积分', credits: 850, originalPrice: '29.9', price: '17.9', tag: '五一特惠' },
  { id: 'credits-500', type: 'credits', title: '500 积分', credits: 500, originalPrice: '19.9', price: '11.9', tag: '五一特惠' },
  { id: 'credits-100', type: 'credits', title: '100 积分', credits: 100, originalPrice: '4.99', price: '2.99', tag: '五一特惠' }
];

const CONFIG_DEFINITIONS = [
  {
    key: 'provider_base_url',
    group: 'provider',
    label: 'AI 服务 Base URL',
    type: 'text',
    description: '统一 AI 服务地址，例如 https://timebackward.com/v1',
    defaultValue: process.env.TIME_BACKWARD_BASE_URL || 'https://llmapi.pro',
    hidden: true
  },
  {
    key: 'provider_api_key',
    group: 'provider',
    label: 'AI 服务 API Key',
    type: 'password',
    description: 'PPT、对话、图片、视频共用的服务密钥',
    defaultValue: process.env.TIME_BACKWARD_API_KEY || '',
    hidden: true
  },
  {
    key: 'anthropic_fallback_base_url',
    group: 'provider',
    label: 'Anthropic 备用 Base URL',
    type: 'text',
    description: 'Claude/Anthropic Messages 主通道失败时自动切换的备用服务地址，例如 https://timebackward.com',
    defaultValue: process.env.ANTHROPIC_FALLBACK_BASE_URL || process.env.TIMEBACKWARD_FALLBACK_BASE_URL || 'https://timebackward.com',
    hidden: true
  },
  {
    key: 'anthropic_fallback_api_key',
    group: 'provider',
    label: 'Anthropic 备用 API Key',
    type: 'password',
    description: 'Claude/Anthropic Messages 备用通道密钥。留空则不启用备用通道',
    defaultValue: process.env.ANTHROPIC_FALLBACK_API_KEY || process.env.TIMEBACKWARD_FALLBACK_API_KEY || '',
    hidden: true
  },
  {
    key: 'text_provider_profiles',
    group: 'provider',
    label: '模型供应商',
    type: 'provider_profiles',
    description: '统一维护模型供应商。支持 OpenAI 兼容、Anthropic，以及视频接口',
    defaultValue: process.env.TEXT_PROVIDER_PROFILES || ''
  },
  {
    key: 'chat_model',
    group: 'text',
    label: '对话模型',
    type: 'model_select',
    description: '普通对话接口默认模型',
    defaultValue: process.env.CHAT_MODEL || 'claude-opus-4-7',
    providerKey: 'chat_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'chat_provider_id',
    group: 'text',
    label: '对话供应商',
    type: 'provider_select',
    description: '普通对话默认使用的供应商',
    defaultValue: process.env.CHAT_PROVIDER_ID || 'primary'
  },
  {
    key: 'chat_fallback_provider_ids',
    group: 'text',
    label: '对话备用模型',
    type: 'text',
    description: '普通对话失败时按顺序尝试的备用模型，支持旧版供应商 ID 列表或新版供应商/模型 JSON',
    defaultValue: process.env.CHAT_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'chat_timeout_ms',
    group: 'text',
    label: '对话超时',
    type: 'number',
    description: '普通对话请求超时时间，毫秒',
    defaultValue: process.env.CHAT_TIMEOUT_MS || '60000'
  },
  {
    key: 'ppt_model',
    group: 'text',
    label: 'PPT 模型',
    type: 'model_select',
    description: '用于 PPT Agent 策划、设计规范和逐页 SVG 生成的模型',
    defaultValue: process.env.PPT_MODEL || process.env.CHAT_MODEL || 'claude-opus-4-7',
    providerKey: 'ppt_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_strategist_model',
    group: 'text',
    label: 'PPT 策划模型',
    type: 'model_select',
    description: '用于页数判断、页面结构、design_spec/spec_lock 生成。可选 DeepSeek 等高速纯文本模型',
    defaultValue: process.env.PPT_STRATEGIST_MODEL || '',
    providerKey: 'ppt_strategist_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_strategist_provider_id',
    group: 'text',
    label: 'PPT 策划供应商',
    type: 'provider_select',
    description: 'PPT 策划和文本规划使用的供应商；留空时沿用 PPT 主供应商',
    defaultValue: process.env.PPT_STRATEGIST_PROVIDER_ID || ''
  },
  {
    key: 'ppt_strategist_fallback_provider_ids',
    group: 'text',
    label: 'PPT 策划备用模型',
    type: 'text',
    description: 'PPT 策划失败时按顺序尝试的备用模型，支持供应商/模型 JSON',
    defaultValue: process.env.PPT_STRATEGIST_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_strategist_timeout_ms',
    group: 'text',
    label: 'PPT 策划超时',
    type: 'number',
    description: 'PPT 策划类单次模型请求超时时间，毫秒',
    defaultValue: process.env.PPT_STRATEGIST_TIMEOUT_MS || '90000'
  },
  {
    key: 'ppt_executor_model',
    group: 'text',
    label: 'PPT SVG 执行模型',
    type: 'model_select',
    description: '用于逐页 SVG 绘制、截断续写等重执行任务。建议使用代码/SVG 能力强的模型',
    defaultValue: process.env.PPT_EXECUTOR_MODEL || '',
    providerKey: 'ppt_executor_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_executor_provider_id',
    group: 'text',
    label: 'PPT SVG 执行供应商',
    type: 'provider_select',
    description: '逐页 SVG 生成使用的供应商；留空时沿用 PPT 主供应商',
    defaultValue: process.env.PPT_EXECUTOR_PROVIDER_ID || ''
  },
  {
    key: 'ppt_executor_fallback_provider_ids',
    group: 'text',
    label: 'PPT SVG 执行备用模型',
    type: 'text',
    description: '逐页 SVG 生成失败时按顺序尝试的备用模型，支持供应商/模型 JSON',
    defaultValue: process.env.PPT_EXECUTOR_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_executor_timeout_ms',
    group: 'text',
    label: 'PPT SVG 执行超时',
    type: 'number',
    description: '逐页 SVG 生成单次模型请求超时时间，毫秒',
    defaultValue: process.env.PPT_EXECUTOR_TIMEOUT_MS || '240000'
  },
  {
    key: 'ppt_vision_review_model',
    group: 'text',
    label: 'PPT 视觉质检模型',
    type: 'model_select',
    description: '用于图片资源审查、整页截图审查和单页微审。建议配置更快的视觉模型',
    defaultValue: process.env.PPT_VISION_REVIEW_MODEL || '',
    providerKey: 'ppt_vision_review_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_vision_review_provider_id',
    group: 'text',
    label: 'PPT 视觉质检供应商',
    type: 'provider_select',
    description: 'PPT 视觉质检使用的供应商；留空时自动选择已启用的 GPT/Claude/Qwen-VL 等视觉候选，不会默认继承 DeepSeek 纯文本模型',
    defaultValue: process.env.PPT_VISION_REVIEW_PROVIDER_ID || ''
  },
  {
    key: 'ppt_vision_review_fallback_provider_ids',
    group: 'text',
    label: 'PPT 视觉质检备用模型',
    type: 'text',
    description: '视觉质检失败时按顺序尝试的备用模型，支持供应商/模型 JSON',
    defaultValue: process.env.PPT_VISION_REVIEW_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_vision_review_timeout_ms',
    group: 'text',
    label: 'PPT 视觉质检超时',
    type: 'number',
    description: '图片/截图视觉质检单次模型请求超时时间，毫秒',
    defaultValue: process.env.PPT_VISION_REVIEW_TIMEOUT_MS || '90000'
  },
  {
    key: 'ppt_asset_review_model',
    group: 'text',
    label: 'PPT 资源审查模型',
    type: 'model_select',
    description: '用于审查联网图片、logo 和 AI 配图是否错配。留空时沿用 PPT 视觉质检模型',
    defaultValue: process.env.PPT_ASSET_REVIEW_MODEL || '',
    providerKey: 'ppt_asset_review_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_asset_review_provider_id',
    group: 'text',
    label: 'PPT 资源审查供应商',
    type: 'provider_select',
    description: '资源图片审查使用的供应商；留空时自动沿用可处理图片输入的视觉质检候选',
    defaultValue: process.env.PPT_ASSET_REVIEW_PROVIDER_ID || ''
  },
  {
    key: 'ppt_asset_review_fallback_provider_ids',
    group: 'text',
    label: 'PPT 资源审查备用模型',
    type: 'text',
    description: '资源审查失败时按顺序尝试的备用模型，支持供应商/模型 JSON',
    defaultValue: process.env.PPT_ASSET_REVIEW_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_asset_review_timeout_ms',
    group: 'text',
    label: 'PPT 资源审查超时',
    type: 'number',
    description: '图片资源审查单次模型请求超时时间，毫秒',
    defaultValue: process.env.PPT_ASSET_REVIEW_TIMEOUT_MS || ''
  },
  {
    key: 'ppt_page_review_model',
    group: 'text',
    label: 'PPT 整页终检模型',
    type: 'model_select',
    description: '用于整页截图终检，检查错版、遮挡、错字和前后关系。留空时沿用 PPT 视觉质检模型',
    defaultValue: process.env.PPT_PAGE_REVIEW_MODEL || '',
    providerKey: 'ppt_page_review_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_page_review_provider_id',
    group: 'text',
    label: 'PPT 整页终检供应商',
    type: 'provider_select',
    description: '整页截图终检使用的供应商；留空时自动沿用可处理图片输入的视觉质检候选',
    defaultValue: process.env.PPT_PAGE_REVIEW_PROVIDER_ID || ''
  },
  {
    key: 'ppt_page_review_fallback_provider_ids',
    group: 'text',
    label: 'PPT 整页终检备用模型',
    type: 'text',
    description: '整页终检失败时按顺序尝试的备用模型，支持供应商/模型 JSON',
    defaultValue: process.env.PPT_PAGE_REVIEW_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_page_review_timeout_ms',
    group: 'text',
    label: 'PPT 整页终检超时',
    type: 'number',
    description: '整页截图终检单次模型请求超时时间，毫秒',
    defaultValue: process.env.PPT_PAGE_REVIEW_TIMEOUT_MS || ''
  },
  {
    key: 'ppt_micro_review_model',
    group: 'text',
    label: 'PPT 单页微审模型',
    type: 'model_select',
    description: '用于每页生成后的轻量版面微审。留空时沿用 PPT 视觉质检模型',
    defaultValue: process.env.PPT_MICRO_REVIEW_MODEL || '',
    providerKey: 'ppt_micro_review_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'ppt_micro_review_provider_id',
    group: 'text',
    label: 'PPT 单页微审供应商',
    type: 'provider_select',
    description: '单页微审使用的供应商；留空时自动沿用可处理图片输入的视觉质检候选',
    defaultValue: process.env.PPT_MICRO_REVIEW_PROVIDER_ID || ''
  },
  {
    key: 'ppt_micro_review_fallback_provider_ids',
    group: 'text',
    label: 'PPT 单页微审备用模型',
    type: 'text',
    description: '单页微审失败时按顺序尝试的备用模型，支持供应商/模型 JSON',
    defaultValue: process.env.PPT_MICRO_REVIEW_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_micro_review_timeout_ms',
    group: 'text',
    label: 'PPT 单页微审超时',
    type: 'number',
    description: '单页微审单次模型请求超时时间，毫秒',
    defaultValue: process.env.PPT_MICRO_REVIEW_TIMEOUT_MS || ''
  },
  {
    key: 'ppt_provider_id',
    group: 'text',
    label: 'PPT 供应商',
    type: 'provider_select',
    description: 'PPT Agent 默认使用的供应商',
    defaultValue: process.env.PPT_PROVIDER_ID || 'primary'
  },
  {
    key: 'ppt_fallback_provider_ids',
    group: 'text',
    label: 'PPT 备用模型',
    type: 'text',
    description: 'PPT Agent 失败时按顺序尝试的备用模型，支持旧版供应商 ID 列表或新版供应商/模型 JSON',
    defaultValue: process.env.PPT_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'ppt_timeout_ms',
    group: 'text',
    label: 'PPT 对话超时',
    type: 'number',
    description: 'PPT Agent 单次模型请求默认超时时间，毫秒',
    defaultValue: process.env.PPT_TIMEOUT_MS || '90000'
  },
  {
    key: 'ppt_master_root',
    group: 'ppt_agent',
    label: 'PPT Master 根目录',
    type: 'text',
    description: '可留空使用部署默认路径；填了不存在的本机路径时会自动回退到项目内 external/ppt-master',
    defaultValue: process.env.PPT_MASTER_ROOT || appConfig.defaultPptMasterRoot
  },
  {
    key: 'ppt_master_python',
    group: 'ppt_agent',
    label: 'PPT Master Python',
    type: 'text',
    description: '可留空使用部署默认 Python；Docker 默认 /opt/ppt-venv/bin/python',
    defaultValue: process.env.PPT_MASTER_PYTHON || appConfig.defaultPptMasterPython
  },
  {
    key: 'ppt_generate_images',
    group: 'ppt_agent',
    label: 'PPT 自动配图',
    type: 'toggle',
    description: '开启后 PPT Agent 会调用内置图片引擎生成封面或章节主视觉',
    defaultValue: process.env.PPT_GENERATE_IMAGES || 'true'
  },
  {
    key: 'ppt_max_web_visual_assets',
    group: 'ppt_agent',
    label: 'PPT 联网视觉资产数量',
    type: 'number',
    description: '自动从公开图标/图片源准备技术栈 logo、品牌图标等视觉资产的最大数量',
    defaultValue: process.env.PPT_MAX_WEB_VISUAL_ASSETS || '10'
  },
  {
    key: 'ppt_web_image_search_timeout_ms',
    group: 'ppt_agent',
    label: 'PPT 联网图片超时',
    type: 'number',
    description: '公开图片检索单张最长等待时间，超时后跳过该图片，不阻塞整份 PPT',
    defaultValue: process.env.PPT_WEB_IMAGE_SEARCH_TIMEOUT_MS || '20000'
  },
  {
    key: 'ppt_image_concurrency',
    group: 'ppt_agent',
    label: 'PPT 配图并发',
    type: 'number',
    description: 'PPT 自动配图阶段同时提交的图片请求数。建议配合模型池最大并发控制，默认尽量并行',
    defaultValue: process.env.PPT_IMAGE_CONCURRENCY || '6'
  },
  {
    key: 'ppt_image_variants_per_request',
    group: 'ppt_agent',
    label: 'PPT 单图候选数',
    type: 'number',
    description: '每个 AI 配图需求同时请求几张候选图。建议 2；供应商不支持时会自动降级为 1',
    defaultValue: process.env.PPT_IMAGE_VARIANTS_PER_REQUEST || '2'
  },
  {
    key: 'ppt_background_image_generation',
    group: 'ppt_agent',
    label: 'PPT 配图后台并行',
    type: 'toggle',
    description: '开启后配图会在后台继续生成，PPT 页面先使用已落盘素材或 SVG 原生图示，导出前等待配图收尾',
    defaultValue: process.env.PPT_BACKGROUND_IMAGE_GENERATION || 'true'
  },
  {
    key: 'ai_visual_review_concurrency',
    group: 'ppt_agent',
    label: 'PPT 整页质检并发',
    type: 'number',
    description: '整页截图 AI 视觉质检并发数。建议 2，使用支持图片输入的快模型',
    defaultValue: process.env.AI_VISUAL_REVIEW_CONCURRENCY || '2'
  },
  {
    key: 'single_page_micro_review_concurrency',
    group: 'ppt_agent',
    label: 'PPT 单页微审并发',
    type: 'number',
    description: '逐页生成后后台微审的并发数。建议 2，避免阻塞主生成链路',
    defaultValue: process.env.SINGLE_PAGE_MICRO_REVIEW_CONCURRENCY || '2'
  },
  {
    key: 'ppt_min_pages',
    group: 'ppt_agent',
    label: 'PPT 最小页数',
    type: 'number',
    description: '限制单次自动生成的最小页数，由前端和 PPT Agent 共同读取',
    defaultValue: process.env.PPT_MIN_PAGES || '3'
  },
  {
    key: 'ppt_max_pages',
    group: 'ppt_agent',
    label: 'PPT 最大页数',
    type: 'number',
    description: '限制单次自动生成的最大页数，避免任务过长',
    defaultValue: process.env.PPT_MAX_PAGES || '30'
  },
  {
    key: 'assistant_model',
    group: 'text',
    label: '助手模型',
    type: 'model_select',
    description: '乐米助手使用的模型',
    defaultValue: process.env.ASSISTANT_MODEL || process.env.CHAT_MODEL || 'claude-opus-4-7',
    providerKey: 'assistant_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'assistant_provider_id',
    group: 'text',
    label: '助手供应商',
    type: 'provider_select',
    description: '通用乐米助手默认使用的供应商',
    defaultValue: process.env.ASSISTANT_PROVIDER_ID || 'primary'
  },
  {
    key: 'assistant_fallback_provider_ids',
    group: 'text',
    label: '助手备用模型',
    type: 'text',
    description: '通用乐米助手失败时按顺序尝试的备用模型，支持旧版供应商 ID 列表或新版供应商/模型 JSON',
    defaultValue: process.env.ASSISTANT_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'assistant_timeout_ms',
    group: 'text',
    label: '助手超时',
    type: 'number',
    description: '通用乐米助手请求超时时间，毫秒',
    defaultValue: process.env.ASSISTANT_TIMEOUT_MS || '60000'
  },
  {
    key: 'image_assistant_base_url',
    group: 'image',
    label: '图片助手 Base URL',
    type: 'text',
    description: '图片页 AI 助手使用的 OpenAI 兼容地址，例如 https://timebackward.com/v1',
    defaultValue: process.env.IMAGE_ASSISTANT_BASE_URL || process.env.IMAGE_BASE_URL || 'https://timebackward.com/v1',
    hidden: true
  },
  {
    key: 'image_assistant_api_key',
    group: 'image',
    label: '图片助手 API Key',
    type: 'password',
    description: '图片页 AI 助手密钥；留空时使用图片 API Key 或 Anthropic 备用 Key',
    defaultValue: process.env.IMAGE_ASSISTANT_API_KEY || '',
    hidden: true
  },
  {
    key: 'image_assistant_model',
    group: 'image',
    label: '图片助手模型',
    type: 'model_select',
    description: '图片页右侧乐米用于整理提示词的文本引擎',
    defaultValue: process.env.IMAGE_ASSISTANT_MODEL || 'gpt-5.5',
    providerKey: 'image_assistant_provider_id',
    modelCategory: 'text'
  },
  {
    key: 'image_assistant_provider_id',
    group: 'image',
    label: '图片助手供应商',
    type: 'provider_select',
    description: '图片 AI 助手使用的模型供应商',
    defaultValue: process.env.IMAGE_ASSISTANT_PROVIDER_ID || process.env.CHAT_PROVIDER_ID || 'primary'
  },
  {
    key: 'image_assistant_fallback_provider_ids',
    group: 'image',
    label: '图片助手备用模型',
    type: 'text',
    description: '图片 AI 助手失败时按顺序尝试的备用模型，支持旧版供应商 ID 列表或新版供应商/模型 JSON',
    defaultValue: process.env.IMAGE_ASSISTANT_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'image_assistant_timeout_ms',
    group: 'image',
    label: '图片助手超时',
    type: 'number',
    description: '图片 AI 助手请求超时时间，毫秒',
    defaultValue: process.env.IMAGE_ASSISTANT_TIMEOUT_MS || '60000'
  },
  {
    key: 'image_assistant_failover_enabled',
    group: 'image',
    label: '图片助手备用容灾',
    type: 'toggle',
    description: '开启后，图片 AI 助手主通道出现 5xx、超时、网络错误或限流时自动切换备用通道',
    defaultValue: process.env.IMAGE_ASSISTANT_FAILOVER_ENABLED || 'true',
    hidden: true
  },
  {
    key: 'image_assistant_fallback_base_url',
    group: 'image',
    label: '图片助手备用 Base URL',
    type: 'text',
    description: '图片 AI 助手备用 OpenAI 兼容地址，例如 https://timebackward.com/v1',
    defaultValue: process.env.IMAGE_ASSISTANT_FALLBACK_BASE_URL || process.env.IMAGE_FALLBACK_BASE_URL || '',
    hidden: true
  },
  {
    key: 'image_assistant_fallback_api_key',
    group: 'image',
    label: '图片助手备用 API Key',
    type: 'password',
    description: '图片 AI 助手备用密钥；留空时使用图片备用 Key 或通用 AI 服务 Key',
    defaultValue: process.env.IMAGE_ASSISTANT_FALLBACK_API_KEY || '',
    hidden: true
  },
  {
    key: 'image_assistant_fallback_model',
    group: 'image',
    label: '图片助手备用模型',
    type: 'text',
    description: '图片 AI 助手备用通道模型；留空时沿用图片助手主模型',
    defaultValue: process.env.IMAGE_ASSISTANT_FALLBACK_MODEL || '',
    hidden: true
  },
  {
    key: 'image_base_url',
    group: 'image',
    label: '图片主通道 Base URL',
    type: 'text',
    description: '图片生成主通道 OpenAI 兼容地址，例如 https://api.penguinsaichat.dpdns.org/v1',
    defaultValue: process.env.IMAGE_BASE_URL || process.env.TIMEBACKWARD_IMAGE_BASE_URL || 'https://timebackward.com/v1',
    hidden: true
  },
  {
    key: 'image_api_key',
    group: 'image',
    label: '图片主通道 API Key',
    type: 'password',
    description: '图片生成主通道密钥；留空时使用 Anthropic 备用 Key',
    defaultValue: process.env.IMAGE_API_KEY || process.env.TIMEBACKWARD_IMAGE_API_KEY || '',
    hidden: true
  },
  {
    key: 'image_failover_enabled',
    group: 'image',
    label: '图片备用容灾',
    type: 'toggle',
    description: '开启后，主通道出现 5xx、超时、网络错误或限流时自动切换备用通道',
    defaultValue: process.env.IMAGE_FAILOVER_ENABLED || 'true',
    hidden: true
  },
  {
    key: 'image_fallback_base_url',
    group: 'image',
    label: '图片备用 Base URL',
    type: 'text',
    description: '图片生成备用 OpenAI 兼容地址，例如 https://timebackward.com/v1',
    defaultValue: process.env.IMAGE_FALLBACK_BASE_URL || process.env.TIMEBACKWARD_IMAGE_BASE_URL || 'https://image.pollinations.ai',
    hidden: true
  },
  {
    key: 'image_fallback_api_key',
    group: 'image',
    label: '图片备用 API Key',
    type: 'password',
    description: '图片生成备用密钥；留空时使用 Anthropic 备用 Key 或通用 AI 服务 Key',
    defaultValue: process.env.IMAGE_FALLBACK_API_KEY || process.env.TIMEBACKWARD_IMAGE_API_KEY || '',
    hidden: true
  },
  {
    key: 'image_fallback_model',
    group: 'image',
    label: '图片备用模型',
    type: 'text',
    description: '备用通道使用的图片模型；留空时沿用图片主模型',
    defaultValue: process.env.IMAGE_FALLBACK_MODEL || '',
    hidden: true
  },
  {
    key: 'image_provider_id',
    group: 'image',
    label: '图片生成供应商',
    type: 'provider_select',
    description: '图片生成使用的 OpenAI 兼容供应商',
    defaultValue: process.env.IMAGE_PROVIDER_ID || '',
    requiredFormat: 'openai'
  },
  {
    key: 'image_fallback_provider_ids',
    group: 'image',
    label: '图片备用模型',
    type: 'text',
    description: '图片生成失败时按顺序尝试的备用图片模型，支持旧版供应商 ID 列表或新版供应商/模型 JSON',
    defaultValue: process.env.IMAGE_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'image_model',
    group: 'image',
    label: '图片模型',
    type: 'model_select',
    description: '填写默认图片引擎标识',
    defaultValue: process.env.IMAGE_MODEL || 'gpt-image-2',
    providerKey: 'image_provider_id',
    modelCategory: 'image'
  },
  {
    key: 'image_quality',
    group: 'image',
    label: '图片质量',
    type: 'select',
    description: '默认图片生成质量',
    defaultValue: process.env.IMAGE_QUALITY || 'high',
    options: [
      { label: '低', value: 'low' },
      { label: '中', value: 'medium' },
      { label: '高', value: 'high' }
    ]
  },
  {
    key: 'image_output_format',
    group: 'image',
    label: '默认输出格式',
    type: 'select',
    description: '图片生成默认输出格式',
    defaultValue: process.env.IMAGE_OUTPUT_FORMAT || 'png',
    options: [
      { label: 'PNG', value: 'png' },
      { label: 'JPEG', value: 'jpeg' }
    ]
  },
  {
    key: 'image_timeout_ms',
    group: 'image',
    label: '图片请求超时',
    type: 'number',
    description: '图片模型最长等待时间，毫秒；复杂图片建议 300000-600000',
    defaultValue: process.env.IMAGE_TIMEOUT_MS || '600000'
  },
  {
    key: 'video_provider_id',
    group: 'video',
    label: '视频生成供应商',
    type: 'provider_select',
    description: '视频生成使用的供应商，推荐配置视频中转站',
    defaultValue: process.env.VIDEO_PROVIDER_ID || '',
    requiredFormat: ''
  },
  {
    key: 'video_fallback_provider_ids',
    group: 'video',
    label: '视频备用模型',
    type: 'text',
    description: '视频生成失败时按顺序尝试的备用视频模型，支持旧版供应商 ID 列表或新版供应商/模型 JSON',
    defaultValue: process.env.VIDEO_FALLBACK_PROVIDER_IDS || ''
  },
  {
    key: 'video_model',
    group: 'video',
    label: '视频模型',
    type: 'model_select',
    description: '填写默认视频引擎标识',
    defaultValue: process.env.VIDEO_MODEL || 'kling-v3',
    providerKey: 'video_provider_id',
    modelCategory: 'video'
  },
  {
    key: 'registration_initial_credits',
    group: 'pricing',
    label: '注册送额度',
    type: 'number',
    description: '新用户注册成功后自动发放的通用积分；填写 0 可关闭注册赠送',
    defaultValue: process.env.REGISTRATION_INITIAL_CREDITS || '100'
  },
  {
    key: 'pricing_ppt_page_credits',
    group: 'pricing',
    label: 'PPT 每页价格',
    type: 'number',
    description: 'PPT 生成按最终页数计费，每页消耗的通用积分',
    defaultValue: process.env.PRICING_PPT_PAGE_CREDITS || '5'
  },
  {
    key: 'pricing_ppt_image_credits',
    group: 'pricing',
    label: 'PPT AI 配图价格',
    type: 'number',
    description: 'PPT 内自动生成并嵌入的每张 AI 图片价格',
    defaultValue: process.env.PRICING_PPT_IMAGE_CREDITS || '5'
  },
  {
    key: 'pricing_image_credits',
    group: 'pricing',
    label: '图片每张价格',
    type: 'number',
    description: '图片生成每张成图消耗的通用积分',
    defaultValue: process.env.PRICING_IMAGE_CREDITS || '5'
  },
  {
    key: 'pricing_ai_token_credits_per_1k',
    group: 'pricing',
    label: 'AI助手 Token 价格',
    type: 'number',
    description: '乐米助手、PPT 生成代理等文本模型按实际 token 计费；每 1000 token 消耗的通用积分，建议 0.1（约 1 积分 / 1 万 tokens）',
    defaultValue: process.env.PRICING_AI_TOKEN_CREDITS_PER_1K || '0.1'
  },
  {
    key: 'pricing_video_lite_std_5s',
    group: 'pricing',
    label: 'Lite 标准 5 秒',
    type: 'number',
    description: 'Lite 档标准质量每 5 秒价格，10 秒按两段计费',
    defaultValue: process.env.PRICING_VIDEO_LITE_STD_5S || '25'
  },
  {
    key: 'pricing_video_lite_pro_5s',
    group: 'pricing',
    label: 'Lite 高清 5 秒',
    type: 'number',
    description: 'Lite 档高清质量每 5 秒价格，10 秒按两段计费',
    defaultValue: process.env.PRICING_VIDEO_LITE_PRO_5S || '50'
  },
  {
    key: 'pricing_video_pro_std_1s',
    group: 'pricing',
    label: 'Pro 标准每秒',
    type: 'number',
    description: 'Pro 档标准质量每秒价格',
    defaultValue: process.env.PRICING_VIDEO_PRO_STD_1S || '20'
  },
  {
    key: 'pricing_video_pro_pro_1s',
    group: 'pricing',
    label: 'Pro 高清每秒',
    type: 'number',
    description: 'Pro 档高清质量每秒价格',
    defaultValue: process.env.PRICING_VIDEO_PRO_PRO_1S || '30'
  },
  {
    key: 'pricing_video_omni_std_1s',
    group: 'pricing',
    label: '多参考标准每秒',
    type: 'number',
    description: '多参考档标准质量每秒价格',
    defaultValue: process.env.PRICING_VIDEO_OMNI_STD_1S || process.env.PRICING_VIDEO_PRO_STD_1S || '20'
  },
  {
    key: 'pricing_video_omni_pro_1s',
    group: 'pricing',
    label: '多参考高清每秒',
    type: 'number',
    description: '多参考档高清质量每秒价格',
    defaultValue: process.env.PRICING_VIDEO_OMNI_PRO_1S || process.env.PRICING_VIDEO_PRO_PRO_1S || '30'
  },
  {
    key: 'pricing_video_sound_multiplier',
    group: 'pricing',
    label: '视频声音倍率',
    type: 'number',
    description: '开启声音时的视频价格倍率。Lite 不支持声音，不应用倍率',
    defaultValue: process.env.PRICING_VIDEO_SOUND_MULTIPLIER || '1.5'
  },
  {
    key: 'search_api_key',
    group: 'search',
    label: 'Tavily API Key',
    type: 'password',
    description: '用于联网检索与参考图搜索',
    defaultValue: process.env.TAVILY_API_KEY || ''
  },
  {
    key: 'search_base_url',
    group: 'search',
    label: 'Tavily Base URL',
    type: 'text',
    description: '通常为 https://api.tavily.com',
    defaultValue: process.env.TAVILY_BASE_URL || 'https://api.tavily.com'
  },
  {
    key: 'email_verification_enabled',
    group: 'email',
    label: '邮箱验证码',
    type: 'toggle',
    description: '开启后注册必须通过邮箱验证码。建议使用专门的发信邮箱',
    defaultValue: process.env.EMAIL_VERIFICATION_ENABLED || 'true'
  },
  {
    key: 'smtp_host',
    group: 'email',
    label: 'SMTP Host',
    type: 'text',
    description: '发信邮箱的 SMTP 服务器，例如 smtp.qq.com 或 smtp.163.com',
    defaultValue: process.env.SMTP_HOST || ''
  },
  {
    key: 'smtp_port',
    group: 'email',
    label: 'SMTP 端口',
    type: 'number',
    description: '常用 465 或 587。465 通常开启 SSL，587 通常关闭 SSL',
    defaultValue: process.env.SMTP_PORT || '465'
  },
  {
    key: 'smtp_secure',
    group: 'email',
    label: 'SMTP SSL',
    type: 'toggle',
    description: '端口 465 通常开启，端口 587 通常关闭',
    defaultValue: process.env.SMTP_SECURE || 'true'
  },
  {
    key: 'smtp_user',
    group: 'email',
    label: '发信邮箱账号',
    type: 'text',
    description: '专门用于发送验证码的邮箱地址',
    defaultValue: process.env.SMTP_USER || ''
  },
  {
    key: 'smtp_pass',
    group: 'email',
    label: '邮箱授权码',
    type: 'password',
    description: '邮箱后台生成的 SMTP 授权码或应用专用密码，不是登录密码',
    defaultValue: process.env.SMTP_PASS || ''
  },
  {
    key: 'smtp_from',
    group: 'email',
    label: '发件人',
    type: 'text',
    description: '建议格式：AI Designer <your@email.com>，邮箱地址最好与发信账号一致',
    defaultValue: process.env.SMTP_FROM || ''
  },
  {
    key: 'email_dev_log_codes',
    group: 'email',
    label: '开发日志验证码',
    type: 'toggle',
    description: '仅本地调试使用。开启后未配置 SMTP 时验证码会输出到后端日志',
    defaultValue: process.env.EMAIL_DEV_LOG_CODES || (!appConfig.isProduction ? 'true' : 'false')
  },
  {
    key: 'site_name',
    group: 'site',
    label: '网站名称',
    type: 'text',
    description: '后台与前台显示名称',
    defaultValue: process.env.SITE_NAME || 'AI Designer'
  },
  {
    key: 'site_public_base_url',
    group: 'site',
    label: '网站公网地址',
    type: 'text',
    description: '网站对外访问域名，例如 https://your-domain.com。用于支付宝回调、支付后返回、多参考视频读取上传图片等公网访问场景',
    defaultValue: process.env.SITE_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || ''
  },
  {
    key: 'site_purchase_card_url',
    group: 'payment',
    label: '兑换码购买外链',
    type: 'text',
    description: '当钱包充值方式选择“兑换码购买外链”时，用户点击套餐会跳转到这里购买兑换码',
    defaultValue: process.env.SITE_PURCHASE_CARD_URL || ''
  },
  {
    key: 'site_recharge_mode',
    group: 'payment',
    label: '钱包充值方式',
    type: 'select',
    description: '控制用户钱包里的充值按钮走支付宝直充，还是跳转到兑换码购买外链',
    defaultValue: process.env.SITE_RECHARGE_MODE || 'alipay',
    options: [
      { value: 'alipay', label: '支付宝直充' },
      { value: 'card_link', label: '兑换码购买外链' }
    ]
  },
  {
    key: 'site_recharge_packages',
    group: 'payment',
    label: '钱包充值套餐',
    type: 'textarea',
    description: '钱包充值套餐，只配置展示价格和到账权益；用户点击后按当前充值方式创建订单或跳转外链。',
    defaultValue: process.env.SITE_RECHARGE_PACKAGES || JSON.stringify(DEFAULT_RECHARGE_PACKAGES, null, 2)
  },
  {
    key: 'alipay_enabled',
    group: 'payment',
    label: '支付宝充值',
    type: 'toggle',
    description: '开启后用户钱包里的充值按钮会直接创建支付宝支付订单',
    defaultValue: process.env.ALIPAY_ENABLED || 'false'
  },
  {
    key: 'alipay_app_id',
    group: 'payment',
    label: '支付宝 App ID',
    type: 'text',
    description: '支付宝开放平台应用的 APPID',
    defaultValue: process.env.ALIPAY_APP_ID || ''
  },
  {
    key: 'alipay_app_private_key',
    group: 'payment',
    label: '应用私钥',
    type: 'password',
    description: 'RSA2 应用私钥，支持带 BEGIN PRIVATE KEY 的 PEM 或单行私钥',
    defaultValue: process.env.ALIPAY_APP_PRIVATE_KEY || ''
  },
  {
    key: 'alipay_public_key',
    group: 'payment',
    label: '支付宝公钥',
    type: 'password',
    description: '用于验签支付宝异步通知，支持 PEM 或支付宝开放平台复制的单行公钥',
    defaultValue: process.env.ALIPAY_PUBLIC_KEY || ''
  },
  {
    key: 'alipay_gateway',
    group: 'payment',
    label: '支付宝网关',
    type: 'text',
    description: '正式环境一般为 https://openapi.alipay.com/gateway.do，沙箱为 https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    defaultValue: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do'
  },
  {
    key: 'alipay_return_url',
    group: 'payment',
    label: '支付后返回地址',
    type: 'text',
    description: '可留空，系统会使用 网站公网地址/user.html?view=credits',
    defaultValue: process.env.ALIPAY_RETURN_URL || ''
  },
  {
    key: 'alipay_notify_url',
    group: 'payment',
    label: '异步通知地址',
    type: 'text',
    description: '可留空，系统会使用 网站公网地址/api/pay/alipay/notify；此地址必须公网可访问',
    defaultValue: process.env.ALIPAY_NOTIFY_URL || ''
  },
  {
    key: 'ai_health_scheduler_enabled',
    group: 'site',
    label: 'AI 定时巡检',
    type: 'toggle',
    description: '开启后后台每 5 分钟自动检测 AI 渠道连通性；关闭后只保留手动检测',
    defaultValue: process.env.AI_HEALTH_SCHEDULER_ENABLED || 'true'
  },
  {
    key: 'site_announcement_enabled',
    group: 'site',
    label: '首页公告',
    type: 'toggle',
    description: '开启后首页会显示公告按钮，并在用户首次看到当前公告时自动弹出',
    defaultValue: process.env.SITE_ANNOUNCEMENT_ENABLED || 'false'
  },
  {
    key: 'site_announcement_title',
    group: 'site',
    label: '公告标题',
    type: 'text',
    description: '首页公告弹窗标题',
    defaultValue: process.env.SITE_ANNOUNCEMENT_TITLE || '平台公告'
  },
  {
    key: 'site_announcement_content',
    group: 'site',
    label: '公告内容',
    type: 'textarea',
    description: '首页公告正文，支持 Markdown、链接和图片；留空时不会展示公告',
    defaultValue: process.env.SITE_ANNOUNCEMENT_CONTENT || ''
  },
  {
    key: 'maintenance_mode',
    group: 'site',
    label: '维护模式',
    type: 'toggle',
    description: '开启后普通用户可被限制访问',
    defaultValue: 'false'
  }
];

const GROUP_LABELS = {
  provider: '模型供应商',
  text: '文本与助手',
  ppt_agent: 'PPT Agent',
  image: '图片生成',
  video: '视频生成',
  pricing: '价格设置',
  search: '联网检索',
  email: '邮件验证码',
  payment: '支付充值',
  site: '站点设置'
};

class RuntimeConfigService {
  static isSensitiveDefinition(definition = {}) {
    return definition.type === 'password' || definition.key === 'text_provider_profiles';
  }

  static encodeStoredValue(definition, value) {
    const normalized = String(value ?? '');
    return this.isSensitiveDefinition(definition) ? CryptoVault.encrypt(normalized) : normalized;
  }

  static decodeStoredValue(definition, value) {
    const normalized = String(value ?? '');
    return this.isSensitiveDefinition(definition) ? CryptoVault.decrypt(normalized) : normalized;
  }

  static maskSensitiveValue(definition, value) {
    if (!this.isSensitiveDefinition(definition)) return value;
    if (definition.key === 'text_provider_profiles') {
      try {
        const profiles = JSON.parse(String(value || '[]'));
        if (!Array.isArray(profiles)) return '[]';
        return JSON.stringify(profiles.map(profile => ({
          ...profile,
          apiKey: profile?.apiKey ? '********' : ''
        })), null, 2);
      } catch (error) {
        return '[]';
      }
    }
    return String(value || '').trim() ? '********' : '';
  }

  static isMaskedSecretValue(value) {
    return /^\*+$/.test(String(value || '').trim());
  }

  static assertUniqueProviderProfileIds(value) {
    let profiles;
    try {
      profiles = JSON.parse(String(value || '[]'));
    } catch (error) {
      throw new Error('模型供应商配置不是有效 JSON');
    }
    if (!Array.isArray(profiles)) {
      throw new Error('模型供应商配置必须是数组');
    }
    const seen = new Map();
    profiles.forEach((profile, index) => {
      const normalized = this.normalizeTextProviderProfile(profile, index);
      if (!normalized.id) return;
      if (seen.has(normalized.id)) {
        const first = seen.get(normalized.id);
        throw new Error(`模型供应商 ID 重复：${normalized.id}，请给第 ${first + 1} 个和第 ${index + 1} 个供应商设置不同 ID`);
      }
      seen.set(normalized.id, index);
    });
  }

  static mergeMaskedProviderProfiles(nextValue, previousValue, fallbackPreviousValue = '') {
    let nextProfiles;
    let previousProfiles;
    try {
      nextProfiles = JSON.parse(String(nextValue || '[]'));
      previousProfiles = JSON.parse(String(previousValue || '[]'));
      if ((!Array.isArray(previousProfiles) || !previousProfiles.length) && fallbackPreviousValue) {
        previousProfiles = JSON.parse(String(fallbackPreviousValue || '[]'));
      }
    } catch (error) {
      return nextValue;
    }
    if (!Array.isArray(nextProfiles) || !Array.isArray(previousProfiles)) return nextValue;

    const previousById = new Map(
      previousProfiles
        .map((profile, index) => [this.normalizeTextProviderProfile(profile, index).id, profile])
        .filter(([id]) => id)
    );
    const merged = nextProfiles.map((profile, index) => {
      const normalized = this.normalizeTextProviderProfile(profile, index);
      if (!this.isMaskedSecretValue(profile?.apiKey || profile?.api_key || profile?.key || '')) {
        return profile;
      }
      const previous = previousById.get(normalized.id) || previousProfiles[index];
      if (!previous) return { ...profile, apiKey: '' };
      return {
        ...profile,
        apiKey: previous.apiKey || previous.api_key || previous.key || ''
      };
    });
    return JSON.stringify(merged, null, 2);
  }

  static definitionForKey(key) {
    return CONFIG_DEFINITIONS.find(item => item.key === key) || null;
  }

  static init() {
    db.exec(ADMIN_CONFIG_TABLE_SQL);

    CONFIG_DEFINITIONS.forEach(definition => {
      db.prepare(`
        INSERT INTO admin_config (key, value, label, type, description)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          label = excluded.label,
          type = excluded.type,
          description = excluded.description
	      `).run(
	        definition.key,
	        this.encodeStoredValue(definition, definition.defaultValue ?? ''),
	        definition.label,
	        definition.type,
	        definition.description || ''
	      );

      const row = db.prepare('SELECT value FROM admin_config WHERE key = ?').get(definition.key);
      if (
        row &&
        row.value &&
        this.isSensitiveDefinition(definition) &&
        !CryptoVault.isEncrypted(row.value)
      ) {
        db.prepare('UPDATE admin_config SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?')
          .run(this.encodeStoredValue(definition, row.value), definition.key);
      }
	    });
	  }

  static getDefinitions() {
    this.init();
    return CONFIG_DEFINITIONS.slice();
  }

  static getAdminConfigs() {
    this.init();
	    const rows = db.prepare('SELECT * FROM admin_config').all();
	    const rowMap = new Map(rows.map(row => [row.key, row]));
	    const raw = rows.reduce((accumulator, row) => {
	      const definition = this.definitionForKey(row.key);
	      accumulator[row.key] = definition ? this.decodeStoredValue(definition, row.value ?? '') : (row.value ?? '');
	      return accumulator;
	    }, {});

    return CONFIG_DEFINITIONS
      .filter(definition => !definition.hidden)
      .map(definition => {
      const row = rowMap.get(definition.key) || {};
	      const storedValue = this.decodeStoredValue(definition, row.value ?? String(definition.defaultValue ?? ''));
      const resolvedPptMasterRoot = definition.key === 'ppt_master_root' ? this.resolvePptMasterRoot(storedValue) : '';
      const resolvedValue = definition.key === 'text_provider_profiles' && !String(storedValue || '').trim()
        ? JSON.stringify(this.buildDefaultTextProviderProfiles(raw), null, 2)
        : (definition.key === 'ppt_master_root'
          ? resolvedPptMasterRoot
          : (definition.key === 'ppt_master_python'
            ? this.resolvePptMasterPython(storedValue, this.resolvePptMasterRoot(raw.ppt_master_root))
            : storedValue));
      const value = this.maskSensitiveValue(definition, resolvedValue);
      return {
        id: row.id || null,
        key: definition.key,
        value,
        label: definition.label,
        type: definition.type,
        description: definition.description || '',
        group: definition.group,
        group_label: GROUP_LABELS[definition.group] || definition.group,
        options: definition.options || [],
        provider_key: definition.providerKey || '',
        model_category: definition.modelCategory || '',
        required_format: definition.requiredFormat || '',
        updated_at: row.updated_at || null
      };
    });
  }

  static updateConfigs(updates) {
    this.init();

    Object.entries(updates || {}).forEach(([key, value]) => {
	      const definition = this.definitionForKey(key);
	      if (!definition) {
	        return;
	      }

          if (this.isSensitiveDefinition(definition) && typeof value === 'string' && /^\*+$/.test(value.trim())) {
            return;
          }

          let nextValue = value ?? '';
          if (definition.key === 'text_provider_profiles') {
            const previousRow = db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key);
            const previousValue = previousRow ? this.decodeStoredValue(definition, previousRow.value ?? '') : '';
            const fallbackPreviousValue = JSON.stringify(this.buildDefaultTextProviderProfiles(this.getConfigMap()), null, 2);
            nextValue = this.mergeMaskedProviderProfiles(nextValue, previousValue, fallbackPreviousValue);
            this.assertUniqueProviderProfileIds(nextValue);
          }

		      db.prepare(`
		        UPDATE admin_config
		        SET value = ?, updated_at = CURRENT_TIMESTAMP
		        WHERE key = ?
		      `).run(this.encodeStoredValue(definition, nextValue), key);
	    });

    return this.getAdminConfigs();
  }

  static getConfigMap() {
    this.init();
    const rows = db.prepare('SELECT key, value FROM admin_config').all();
    return rows.reduce((accumulator, row) => {
      const definition = this.definitionForKey(row.key);
      accumulator[row.key] = definition ? this.decodeStoredValue(definition, row.value ?? '') : (row.value ?? '');
      return accumulator;
    }, {});
  }

  static getRuntimeConfig(overrides = {}) {
    const stored = this.getConfigMap();
    const normalizedOverrides = { ...(overrides || {}) };
    if (Object.prototype.hasOwnProperty.call(normalizedOverrides, 'text_provider_profiles')) {
      normalizedOverrides.text_provider_profiles = this.mergeMaskedProviderProfiles(
        normalizedOverrides.text_provider_profiles,
        stored.text_provider_profiles || '',
        JSON.stringify(this.buildDefaultTextProviderProfiles(stored), null, 2)
      );
    }
    const raw = {};

    CONFIG_DEFINITIONS.forEach(definition => {
      if (Object.prototype.hasOwnProperty.call(normalizedOverrides, definition.key)) {
        raw[definition.key] = String(normalizedOverrides[definition.key] ?? '');
      } else if (Object.prototype.hasOwnProperty.call(stored, definition.key)) {
        raw[definition.key] = String(stored[definition.key] ?? '');
      } else {
        raw[definition.key] = String(definition.defaultValue ?? '');
      }
    });

    const textProviders = this.getTextProviderProfiles(raw);
    const textRoutes = this.getTextRoutes(raw);
    const primaryTextProvider = this.resolveFeatureProvider(textProviders, raw.chat_provider_id || 'primary', '', {
      category: 'chat',
      strictExists: false
    })
      || textProviders.find(provider => this.providerSupportsModelCategory(provider, 'chat'))
      || null;
    const imageProvider = this.resolveFeatureProvider(textProviders, raw.image_provider_id, 'openai', {
      category: 'image',
      strictExists: false
    });
    const videoProvider = this.resolveFeatureProvider(textProviders, raw.video_provider_id, '', {
      category: 'video',
      strictExists: false,
      fallbackOnIncompatible: true
    });
    const imageAssistantProvider = this.resolveFeatureProvider(
      textProviders,
      raw.image_assistant_provider_id || raw.chat_provider_id || 'primary',
      '',
      { category: 'chat', strictExists: false }
    ) || primaryTextProvider;
    const defaultVisionRoute = this.defaultVisionTextRoute(textProviders, raw);
    const pptVisionReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_vision_review_provider_id'],
      modelKeys: ['ppt_vision_review_model']
    });
    const pptAssetReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_asset_review_provider_id', 'ppt_vision_review_provider_id'],
      modelKeys: ['ppt_asset_review_model', 'ppt_vision_review_model']
    });
    const pptPageReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_page_review_provider_id', 'ppt_vision_review_provider_id'],
      modelKeys: ['ppt_page_review_model', 'ppt_vision_review_model']
    });
    const pptMicroReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_micro_review_provider_id', 'ppt_vision_review_provider_id'],
      modelKeys: ['ppt_micro_review_model', 'ppt_vision_review_model']
    });
    const pptMinPages = Math.max(parseInt(raw.ppt_min_pages, 10) || 3, 1);
    const pptMaxPages = Math.max(parseInt(raw.ppt_max_pages, 10) || 30, pptMinPages);
    const configuredVideoModel = raw.video_model || videoProvider?.defaultModel || '';
    const videoModel = videoProvider?.format === 'kling'
      ? (/^kling-/i.test(String(configuredVideoModel || ''))
          ? configuredVideoModel
          : (videoProvider?.defaultModel && /^kling-/i.test(String(videoProvider.defaultModel))
            ? videoProvider.defaultModel
            : 'kling-v3'))
      : (configuredVideoModel || 'sora-1.0-turbo');
    const videoProviderFormat = this.inferVideoProviderFormat(videoProvider, videoModel);
    const pptMasterRoot = this.resolvePptMasterRoot(raw.ppt_master_root);
    const pptMasterPython = this.resolvePptMasterPython(raw.ppt_master_python, pptMasterRoot);
    const pricing = this.buildPricingConfig(raw);
    const chatFallbackModels = this.parseFallbackModelList(raw.chat_fallback_provider_ids || '');
    const pptFallbackModels = this.parseFallbackModelList(raw.ppt_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptStrategistFallbackModels = this.parseFallbackModelList(raw.ppt_strategist_fallback_provider_ids || raw.ppt_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptExecutorFallbackModels = this.parseFallbackModelList(raw.ppt_executor_fallback_provider_ids || raw.ppt_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptVisionReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_vision_review_fallback_provider_ids, pptVisionReviewRoute);
    const pptAssetReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_asset_review_fallback_provider_ids || raw.ppt_vision_review_fallback_provider_ids, pptAssetReviewRoute);
    const pptPageReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_page_review_fallback_provider_ids || raw.ppt_vision_review_fallback_provider_ids, pptPageReviewRoute);
    const pptMicroReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_micro_review_fallback_provider_ids || raw.ppt_vision_review_fallback_provider_ids, pptMicroReviewRoute);
    const assistantFallbackModels = this.parseFallbackModelList(raw.assistant_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const imageAssistantFallbackModels = this.parseFallbackModelList(raw.image_assistant_fallback_provider_ids || '');
    const imageFallbackModels = this.parseFallbackModelList(raw.image_fallback_provider_ids || '');
    const videoFallbackModels = this.parseFallbackModelList(raw.video_fallback_provider_ids || '');

    return {
      providerBaseUrl: this.normalizeBaseUrl(primaryTextProvider?.baseUrl || raw.provider_base_url, 'https://llmapi.pro'),
      providerApiKey: primaryTextProvider?.apiKey || raw.provider_api_key,
      providerFormat: primaryTextProvider?.format || (this.isAnthropicModel(raw.chat_model) ? 'anthropic' : 'openai'),
      providerName: primaryTextProvider?.name || '',
      anthropicFallbackBaseUrl: this.normalizeBaseUrl(raw.anthropic_fallback_base_url, ''),
      anthropicFallbackApiKey: raw.anthropic_fallback_api_key,
      textProviders,
      modelProviders: textProviders,
      textRoutes,
      chatModel: raw.chat_model || 'claude-opus-4-7',
      chatProviderId: raw.chat_provider_id || 'primary',
      chatFallbackProviderIds: chatFallbackModels.map(item => item.providerId),
      chatFallbackModels,
      chatTimeoutMs: this.normalizeTimeout(raw.chat_timeout_ms, 60000, 10000),
      pptModel: raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
      pptProviderId: raw.ppt_provider_id || raw.chat_provider_id || 'primary',
      pptFallbackProviderIds: pptFallbackModels.map(item => item.providerId),
      pptFallbackModels,
      pptTimeoutMs: this.normalizeTimeout(raw.ppt_timeout_ms, 90000, 10000),
      pptStrategistModel: raw.ppt_strategist_model || raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
      pptStrategistProviderId: raw.ppt_strategist_provider_id || raw.ppt_provider_id || raw.chat_provider_id || 'primary',
      pptStrategistFallbackProviderIds: pptStrategistFallbackModels.map(item => item.providerId),
      pptStrategistFallbackModels,
      pptStrategistTimeoutMs: this.normalizeTimeout(raw.ppt_strategist_timeout_ms, this.normalizeTimeout(raw.ppt_timeout_ms, 90000, 10000), 10000),
      pptExecutorModel: raw.ppt_executor_model || raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
      pptExecutorProviderId: raw.ppt_executor_provider_id || raw.ppt_provider_id || raw.chat_provider_id || 'primary',
      pptExecutorFallbackProviderIds: pptExecutorFallbackModels.map(item => item.providerId),
      pptExecutorFallbackModels,
      pptExecutorTimeoutMs: this.normalizeTimeout(raw.ppt_executor_timeout_ms, 240000, 10000),
      pptVisionReviewModel: pptVisionReviewRoute.model,
      pptVisionReviewProviderId: pptVisionReviewRoute.providerId,
      pptVisionReviewFallbackProviderIds: pptVisionReviewFallbackModels.map(item => item.providerId),
      pptVisionReviewFallbackModels,
      pptVisionReviewTimeoutMs: this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000),
      pptAssetReviewModel: pptAssetReviewRoute.model,
      pptAssetReviewProviderId: pptAssetReviewRoute.providerId,
      pptAssetReviewFallbackProviderIds: pptAssetReviewFallbackModels.map(item => item.providerId),
      pptAssetReviewFallbackModels,
      pptAssetReviewTimeoutMs: this.normalizeTimeout(raw.ppt_asset_review_timeout_ms, this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000), 10000),
      pptPageReviewModel: pptPageReviewRoute.model,
      pptPageReviewProviderId: pptPageReviewRoute.providerId,
      pptPageReviewFallbackProviderIds: pptPageReviewFallbackModels.map(item => item.providerId),
      pptPageReviewFallbackModels,
      pptPageReviewTimeoutMs: this.normalizeTimeout(raw.ppt_page_review_timeout_ms, this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000), 10000),
      pptMicroReviewModel: pptMicroReviewRoute.model,
      pptMicroReviewProviderId: pptMicroReviewRoute.providerId,
      pptMicroReviewFallbackProviderIds: pptMicroReviewFallbackModels.map(item => item.providerId),
      pptMicroReviewFallbackModels,
      pptMicroReviewTimeoutMs: this.normalizeTimeout(raw.ppt_micro_review_timeout_ms, this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000), 10000),
      pptMasterRoot,
      pptMasterPython,
      pptGenerateImages: raw.ppt_generate_images === 'true' || raw.ppt_generate_images === '1',
      pptMaxWebVisualAssets: Math.min(Math.max(parseInt(raw.ppt_max_web_visual_assets, 10) || 10, 0), 18),
      pptWebImageSearchTimeoutMs: Math.min(Math.max(parseInt(raw.ppt_web_image_search_timeout_ms, 10) || 20000, 5000), 45000),
      pptImageConcurrency: Math.min(Math.max(parseInt(raw.ppt_image_concurrency, 10) || 6, 1), 6),
      pptImageVariantsPerRequest: Math.min(Math.max(parseInt(raw.ppt_image_variants_per_request, 10) || 2, 1), 2),
      pptBackgroundImageGeneration: raw.ppt_background_image_generation !== 'false' && raw.ppt_background_image_generation !== '0',
      aiVisualReviewConcurrency: Math.min(Math.max(parseInt(raw.ai_visual_review_concurrency, 10) || 2, 1), 4),
      singlePageMicroReviewConcurrency: Math.min(Math.max(parseInt(raw.single_page_micro_review_concurrency, 10) || 2, 1), 4),
      pptMinPages,
      defaultPptPageCount: null,
      pptMaxPages,
      assistantModel: raw.assistant_model || raw.chat_model || 'claude-opus-4-7',
      assistantProviderId: raw.assistant_provider_id || raw.chat_provider_id || 'primary',
      assistantFallbackProviderIds: assistantFallbackModels.map(item => item.providerId),
      assistantFallbackModels,
      assistantTimeoutMs: this.normalizeTimeout(raw.assistant_timeout_ms, 60000, 10000),
      imageProviderId: imageProvider?.id || raw.image_provider_id || '',
      imageFallbackProviderIds: imageFallbackModels.map(item => item.providerId),
      imageFallbackModels,
      imageProviderName: imageProvider?.name || '',
      imageProviderFormat: imageProvider?.format || '',
      imageBaseUrl: this.normalizeOpenAiBaseUrl(imageProvider?.baseUrl || raw.image_base_url || 'https://timebackward.com/v1'),
      imageApiKey: imageProvider?.apiKey || raw.image_api_key || raw.anthropic_fallback_api_key || raw.provider_api_key,
      imageFailoverEnabled: raw.image_failover_enabled === 'true' || raw.image_failover_enabled === '1',
      imageFallbackBaseUrl: this.normalizeOpenAiBaseUrl(raw.image_fallback_base_url || ''),
      imageFallbackApiKey: raw.image_fallback_api_key || '',
      imageFallbackModel: raw.image_fallback_model || '',
      imageAssistantBaseUrl: this.normalizeBaseUrl(imageAssistantProvider?.baseUrl || raw.image_assistant_base_url || raw.provider_base_url || process.env.TIME_BACKWARD_BASE_URL || 'https://timebackward.com/v1', ''),
      imageAssistantApiKey: imageAssistantProvider?.apiKey || raw.image_assistant_api_key || raw.provider_api_key || raw.anthropic_fallback_api_key || raw.image_api_key,
      imageAssistantModel: raw.image_assistant_model || 'gpt-5.5',
      imageAssistantProviderId: imageAssistantProvider?.id || raw.image_assistant_provider_id || raw.chat_provider_id || 'primary',
      imageAssistantFallbackProviderIds: imageAssistantFallbackModels.map(item => item.providerId),
      imageAssistantFallbackModels,
      imageAssistantTimeoutMs: this.normalizeTimeout(raw.image_assistant_timeout_ms, 60000, 10000),
      imageAssistantFailoverEnabled: raw.image_assistant_failover_enabled === 'true' || raw.image_assistant_failover_enabled === '1',
      imageAssistantFallbackBaseUrl: this.normalizeOpenAiBaseUrl(raw.image_assistant_fallback_base_url || raw.image_fallback_base_url || ''),
      imageAssistantFallbackApiKey: raw.image_assistant_fallback_api_key || raw.image_fallback_api_key || raw.anthropic_fallback_api_key || raw.provider_api_key,
      imageAssistantFallbackModel: raw.image_assistant_fallback_model || '',
      imageModel: raw.image_model || imageProvider?.defaultModel || 'gpt-image-2',
      imageQuality: raw.image_quality || 'high',
      imageOutputFormat: raw.image_output_format || 'png',
      imageTimeoutMs: Math.max(parseInt(raw.image_timeout_ms, 10) || 600000, 120000),
      videoProviderId: videoProvider?.id || raw.video_provider_id || '',
      videoFallbackProviderIds: videoFallbackModels.map(item => item.providerId),
      videoFallbackModels,
      videoProviderName: videoProvider?.name || '',
      videoProviderFormat,
      videoBaseUrl: videoProvider
        ? (videoProviderFormat === 'kling'
            ? this.normalizeKlingBaseUrl(videoProvider.baseUrl || '')
            : this.normalizeOpenAiBaseUrl(videoProvider.baseUrl || ''))
        : '',
      videoApiKey: videoProvider?.apiKey || '',
      videoModel,
      pricing,
      searchApiKey: raw.search_api_key,
      searchBaseUrl: this.normalizeBaseUrl(raw.search_base_url, 'https://api.tavily.com'),
      emailVerificationEnabled: this.parseBool(raw.email_verification_enabled, true),
      registrationInitialCredits: Math.max(0, Math.floor(this.normalizePositiveNumber(raw.registration_initial_credits, 100, 0))),
      smtpHost: raw.smtp_host || '',
      smtpPort: this.normalizePort(raw.smtp_port, 465),
      smtpSecure: this.parseBool(raw.smtp_secure, this.normalizePort(raw.smtp_port, 465) === 465),
      smtpUser: raw.smtp_user || '',
      smtpPass: raw.smtp_pass || '',
      smtpFrom: raw.smtp_from || (raw.smtp_user ? `AI Designer <${raw.smtp_user}>` : ''),
      emailDevLogCodes: this.parseBool(raw.email_dev_log_codes, !appConfig.isProduction),
	      siteName: raw.site_name || 'AI Designer',
	      sitePublicBaseUrl: this.normalizeBaseUrl(raw.site_public_base_url || '', ''),
	      alipay: this.buildAlipayConfig(raw),
	      rechargeMode: this.normalizeRechargeMode(raw.site_recharge_mode),
	      purchaseCardUrl: this.normalizePublicHttpUrl(raw.site_purchase_card_url || ''),
	      rechargePackages: this.parseRechargePackages(raw.site_recharge_packages),
      aiHealthSchedulerEnabled: this.parseBool(raw.ai_health_scheduler_enabled, true),
      siteAnnouncement: {
        enabled: raw.site_announcement_enabled === 'true' || raw.site_announcement_enabled === '1',
        title: raw.site_announcement_title || '平台公告',
        content: raw.site_announcement_content || ''
      },
      maintenanceMode: raw.maintenance_mode === 'true' || raw.maintenance_mode === '1',
      raw
    };
  }

  static buildPricingConfig(raw = {}) {
    const number = (key, fallback, min = 0) => this.normalizePositiveNumber(raw[key], fallback, min);
    return {
      ppt: {
        pageCredits: number('pricing_ppt_page_credits', 5),
        imageCredits: number('pricing_ppt_image_credits', 5)
      },
      image: {
        creditsPerImage: number('pricing_image_credits', 5)
      },
      assistant: {
        tokenCreditsPerThousand: number('pricing_ai_token_credits_per_1k', 0.1)
      },
      vipDiscountRate: 0.8,
      video: {
        liteStdFiveSeconds: number('pricing_video_lite_std_5s', 25),
        liteProFiveSeconds: number('pricing_video_lite_pro_5s', 50),
        proStdPerSecond: number('pricing_video_pro_std_1s', 20),
        proProPerSecond: number('pricing_video_pro_pro_1s', 30),
        omniStdPerSecond: number('pricing_video_omni_std_1s', number('pricing_video_pro_std_1s', 20)),
        omniProPerSecond: number('pricing_video_omni_pro_1s', number('pricing_video_pro_pro_1s', 30)),
        soundMultiplier: number('pricing_video_sound_multiplier', 1.5, 1)
      }
    };
  }

  static getTextProviderProfiles(raw = {}) {
    const parsed = this.safeJsonArray(raw.text_provider_profiles);
    const source = parsed.length ? parsed : this.buildDefaultTextProviderProfiles(raw);
    const normalized = source
      .map((profile, index) => this.normalizeTextProviderProfile(profile, index))
      .filter(profile => profile.id && profile.baseUrl && profile.apiKey);

    return this.dedupeProfiles(normalized.length ? normalized : this.buildDefaultTextProviderProfiles(raw));
  }

  static buildDefaultTextProviderProfiles(raw = {}) {
    const chatModel = raw.chat_model || process.env.CHAT_MODEL || 'claude-opus-4-7';
    const profiles = [
      {
        id: 'primary',
        name: '主文本服务',
        format: this.isAnthropicModel(chatModel) ? 'anthropic' : 'openai',
        baseUrl: raw.provider_base_url || process.env.TIME_BACKWARD_BASE_URL || 'https://llmapi.pro',
        apiKey: raw.provider_api_key || process.env.TIME_BACKWARD_API_KEY || '',
        defaultModel: chatModel,
        timeoutMs: this.normalizeTimeout(raw.chat_timeout_ms, 60000, 10000),
        enabled: true
      }
    ];

    if (raw.anthropic_fallback_base_url || raw.anthropic_fallback_api_key) {
      profiles.push({
        id: 'anthropic_fallback',
        name: 'Anthropic 备用',
        format: 'anthropic',
        baseUrl: raw.anthropic_fallback_base_url || 'https://timebackward.com',
        apiKey: raw.anthropic_fallback_api_key || '',
        defaultModel: raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
        timeoutMs: this.normalizeTimeout(raw.chat_timeout_ms, 60000, 10000),
        enabled: Boolean(raw.anthropic_fallback_api_key)
      });
    }

    const imageAssistantBaseUrl = raw.image_assistant_base_url || raw.provider_base_url || process.env.IMAGE_ASSISTANT_BASE_URL || process.env.TIME_BACKWARD_BASE_URL || '';
    const imageAssistantApiKey = raw.image_assistant_api_key || raw.provider_api_key || raw.anthropic_fallback_api_key || raw.image_api_key || process.env.IMAGE_ASSISTANT_API_KEY || process.env.TIME_BACKWARD_API_KEY || '';
    if (imageAssistantBaseUrl || imageAssistantApiKey) {
      profiles.push({
        id: 'image_assistant',
        name: '图片助手服务',
        format: 'openai',
        baseUrl: imageAssistantBaseUrl || 'https://timebackward.com/v1',
        apiKey: imageAssistantApiKey,
        defaultModel: raw.image_assistant_model || 'gpt-5.5',
        timeoutMs: this.normalizeTimeout(raw.image_assistant_timeout_ms, 60000, 10000),
        enabled: Boolean(imageAssistantApiKey)
      });
    }

    const imageAssistantFallbackBaseUrl = raw.image_assistant_fallback_base_url || raw.image_fallback_base_url || '';
    const imageAssistantFallbackApiKey = raw.image_assistant_fallback_api_key || raw.image_fallback_api_key || raw.anthropic_fallback_api_key || '';
    if (imageAssistantFallbackBaseUrl || imageAssistantFallbackApiKey) {
      profiles.push({
        id: 'image_assistant_fallback',
        name: '图片助手备用',
        format: 'openai',
        baseUrl: imageAssistantFallbackBaseUrl || 'https://timebackward.com/v1',
        apiKey: imageAssistantFallbackApiKey,
        defaultModel: raw.image_assistant_fallback_model || raw.image_assistant_model || 'gpt-5.5',
        timeoutMs: this.normalizeTimeout(raw.image_assistant_timeout_ms, 60000, 10000),
        enabled: Boolean(imageAssistantFallbackApiKey)
      });
    }

    return profiles;
  }

  static safeJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'string' || !value.trim()) return [];

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  static normalizeTextProviderProfile(profile = {}, index = 0) {
    const rawId = String(profile.id || profile.key || profile.name || `provider_${index + 1}`)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const model = String(profile.defaultModel || profile.model || '').trim();
    const rawFormat = String(profile.format || profile.apiFormat || '').toLowerCase();
    const apiKey = String(profile.apiKey || profile.api_key || profile.key || '').trim();
    const normalizedFormat = ['anthropic', 'openai', 'kling'].includes(rawFormat)
      ? rawFormat
      : (this.isAnthropicModel(model) ? 'anthropic' : 'openai');

    return {
      id: rawId || `provider_${index + 1}`,
      name: String(profile.name || profile.label || rawId || `供应商 ${index + 1}`).trim(),
      format: normalizedFormat,
      baseUrl: this.normalizeBaseUrl(profile.baseUrl || profile.base_url || profile.url || '', ''),
      apiKey: this.isMaskedSecretValue(apiKey) ? '' : apiKey,
      defaultModel: model,
      models: this.normalizeProviderModels(profile.models || profile.modelList || profile.model_list, { providerFormat: normalizedFormat }),
      lastModelCheckAt: String(profile.lastModelCheckAt || profile.last_model_check_at || '').trim(),
      modelCheckError: String(profile.modelCheckError || profile.model_check_error || '').trim(),
      timeoutMs: this.normalizeTimeout(profile.timeoutMs || profile.timeout_ms, 60000, 10000),
      enabled: profile.enabled !== false && profile.enabled !== 'false' && profile.disabled !== true && profile.disabled !== 'true'
    };
  }

  static normalizeProviderModels(value, context = {}) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const models = [];

    source.forEach((item, index) => {
      const id = typeof item === 'string'
        ? item
        : (item?.id || item?.name || item?.model || '');
      const normalizedId = String(id || '').trim();
      if (!normalizedId || seen.has(normalizedId)) return;
      seen.add(normalizedId);
      const raw = typeof item === 'object' && item ? item : {};
      const priority = parseInt(raw.priority ?? raw.order ?? raw.sort ?? (index + 1), 10);
      const maxConcurrency = parseInt(raw.maxConcurrency ?? raw.max_concurrency ?? raw.concurrency ?? 3, 10);
      const timeoutMs = parseInt(raw.timeoutMs ?? raw.timeout_ms ?? '', 10);
      models.push({
        id: normalizedId,
        name: String((typeof item === 'object' && (item.name || item.display_name || item.label)) || normalizedId).trim(),
        category: this.normalizeModelCategory(raw.category || raw.type || raw.capability || raw.kind || '', normalizedId, context),
        enabled: raw.enabled !== false && raw.enabled !== 'false' && raw.disabled !== true && raw.disabled !== 'true',
        priority: Number.isFinite(priority) && priority > 0 ? priority : index + 1,
        maxConcurrency: Number.isFinite(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 3,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null
      });
    });

    return models;
  }

  static normalizeModelCategory(value = '', model = '', context = {}) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['chat', 'text', 'conversation', 'assistant', 'ppt'].includes(normalized)) return 'chat';
    if (['image', 'images', 'picture'].includes(normalized)) return 'image';
    if (['video', 'videos'].includes(normalized)) return 'video';
    if (context?.providerFormat === 'kling') return 'video';
    if (this.isKnownImageModel(model)) return 'image';
    if (this.isKnownVideoModel(model)) return 'video';
    return 'chat';
  }

  static dedupeProfiles(profiles = []) {
    const seen = new Set();
    const result = [];

    profiles.forEach((profile, index) => {
      const normalized = this.normalizeTextProviderProfile(profile, index);
      if (!normalized.id || seen.has(normalized.id)) return;
      seen.add(normalized.id);
      result.push(normalized);
    });

    return result;
  }

  static defaultVisionTextRoute(providers = [], raw = {}) {
    const candidates = [];
    (Array.isArray(providers) ? providers : []).forEach((provider, providerIndex) => {
      if (!this.isTextGenerationProvider(provider)) return;
      const catalog = this.getProviderModelCatalog(provider)
        .filter(model => model.enabled !== false)
        .filter(model => this.normalizeModelCategory(model.category, model.id, { providerFormat: provider.format }) === 'chat');
      catalog.forEach((model, modelIndex) => {
        const score = this.visionReviewModelScore(model.id, provider, providerIndex, modelIndex);
        if (score === Infinity) return;
        candidates.push({
          providerId: provider.id,
          model: model.id,
          score
        });
      });
    });

    candidates.sort((left, right) => left.score - right.score);
    return candidates[0] || { providerId: '', model: '' };
  }

  static resolvePptVisionReviewRoute(raw = {}, defaultVisionRoute = {}, providers = [], options = {}) {
    const providerKeys = Array.isArray(options.providerKeys) ? options.providerKeys : [];
    const modelKeys = Array.isArray(options.modelKeys) ? options.modelKeys : [];
    const explicitProviderId = this.firstRawValue(raw, providerKeys);
    const explicitModel = this.firstRawValue(raw, modelKeys);
    const fallbackRoute = {
      providerId: defaultVisionRoute.providerId || raw.ppt_provider_id || raw.chat_provider_id || 'primary',
      model: defaultVisionRoute.model || raw.ppt_model || raw.chat_model || 'gpt-5.5'
    };
    if (explicitProviderId || explicitModel) {
      const explicitProvider = this.findTextProvider(providers, explicitProviderId);
      const modelRoute = explicitModel && this.isVisionReviewTextModel(explicitModel)
        ? (this.findEnabledVisionReviewRouteForModel(providers, explicitModel) || this.findEnabledTextRouteForModel(providers, explicitModel))
        : null;
      const providerVisionModel = explicitProvider ? this.firstEnabledVisionReviewModel(explicitProvider) : '';
      if (explicitProviderId && !explicitModel && providerVisionModel) {
        return {
          providerId: explicitProvider.id,
          model: providerVisionModel
        };
      }
      if (explicitProviderId && !explicitModel && !providerVisionModel) {
        return fallbackRoute;
      }
      if (explicitProviderId && explicitModel && !this.isVisionReviewTextModel(explicitModel) && providerVisionModel) {
        return {
          providerId: explicitProvider.id,
          model: providerVisionModel
        };
      }
      if (explicitModel && !this.isVisionReviewTextModel(explicitModel)) {
        return fallbackRoute;
      }
      if (explicitModel && modelRoute && explicitProviderId && explicitProvider && !this.providerHasEnabledVisionReviewModel(explicitProvider, explicitModel)) {
        return {
          providerId: modelRoute.providerId,
          model: explicitModel
        };
      }
      return {
        providerId: explicitProviderId || modelRoute?.providerId || fallbackRoute.providerId,
        model: explicitModel || providerVisionModel || fallbackRoute.model
      };
    }
    return fallbackRoute;
  }

  static firstEnabledVisionReviewModel(provider = {}) {
    if (!this.isTextGenerationProvider(provider)) return '';
    const catalog = this.getProviderModelCatalog(provider)
      .filter(model => model.enabled !== false)
      .filter(model => this.normalizeModelCategory(model.category, model.id, { providerFormat: provider.format }) === 'chat')
      .filter(model => this.isVisionReviewTextModel(model.id))
      .map((model, index) => ({
        id: model.id,
        score: this.visionReviewModelScore(model.id, provider, 0, index)
      }))
      .filter(item => item.score !== Infinity)
      .sort((left, right) => left.score - right.score);
    return catalog[0]?.id || '';
  }

  static providerHasEnabledVisionReviewModel(provider = {}, model = '') {
    const target = String(model || '').trim();
    if (!target || !this.isTextGenerationProvider(provider)) return false;
    return this.getProviderModelCatalog(provider).some(modelConfig => (
      modelConfig.enabled !== false
      && modelConfig.id === target
      && this.normalizeModelCategory(modelConfig.category, modelConfig.id, { providerFormat: provider.format }) === 'chat'
      && this.isVisionReviewTextModel(modelConfig.id)
    ));
  }

  static findEnabledVisionReviewRouteForModel(providers = [], model = '') {
    const target = String(model || '').trim();
    if (!target || !this.isVisionReviewTextModel(target)) return null;
    const matches = [];
    (Array.isArray(providers) ? providers : []).forEach((provider, providerIndex) => {
      if (!this.providerHasEnabledVisionReviewModel(provider, target)) return;
      matches.push({
        providerId: provider.id,
        model: target,
        score: this.visionReviewModelScore(target, provider, providerIndex, 0)
      });
    });
    matches.sort((left, right) => left.score - right.score);
    return matches[0] || null;
  }

  static findEnabledTextRouteForModel(providers = [], model = '') {
    const target = String(model || '').trim();
    if (!target) return null;
    const matches = [];
    (Array.isArray(providers) ? providers : []).forEach((provider, providerIndex) => {
      if (!this.isTextGenerationProvider(provider)) return;
      const found = this.getProviderModelCatalog(provider).find(modelConfig => (
        modelConfig.enabled !== false
        && modelConfig.id === target
        && this.normalizeModelCategory(modelConfig.category, modelConfig.id, { providerFormat: provider.format }) === 'chat'
      ));
      if (!found) return;
      matches.push({
        providerId: provider.id,
        model: target,
        score: Number(found.priority || providerIndex + 1) + providerIndex * 40
      });
    });
    matches.sort((left, right) => left.score - right.score);
    return matches[0] || null;
  }

  static resolvePptVisionFallbackModels(providers = [], rawFallbackValue = '', primaryRoute = {}) {
    const explicitFallbackModels = this.parseFallbackModelList(rawFallbackValue || '');
    if (explicitFallbackModels.length) {
      const compatible = explicitFallbackModels.filter(item => {
        const provider = this.findTextProvider(providers, item.providerId);
        if (!provider) return false;
        const model = String(item.model || provider?.defaultModel || provider?.model || '').trim();
        return this.isVisionReviewTextModel(model);
      });
      if (compatible.length) return compatible;
    }

    const candidates = [];
    (Array.isArray(providers) ? providers : []).forEach((provider, providerIndex) => {
      if (!this.isTextGenerationProvider(provider)) return;
      const catalog = this.getProviderModelCatalog(provider)
        .filter(model => model.enabled !== false)
        .filter(model => this.normalizeModelCategory(model.category, model.id, { providerFormat: provider.format }) === 'chat')
        .filter(model => this.isVisionReviewTextModel(model.id));
      catalog.forEach((model, modelIndex) => {
        if (provider.id === primaryRoute.providerId && model.id === primaryRoute.model) return;
        const score = this.visionReviewModelScore(model.id, provider, providerIndex, modelIndex);
        if (score === Infinity) return;
        candidates.push({ providerId: provider.id, model: model.id, score });
      });
    });

    candidates.sort((left, right) => left.score - right.score);
    return candidates.slice(0, 3).map(item => ({
      providerId: item.providerId,
      model: item.model
    }));
  }

  static firstRawValue(raw = {}, keys = []) {
    for (const key of keys) {
      const value = String(raw[key] || '').trim();
      if (value) return value;
    }
    return '';
  }

  static isVisionReviewTextModel(model = '') {
    return this.visionReviewModelScore(model) !== Infinity;
  }

  static visionReviewModelScore(model = '', provider = {}, providerIndex = 0, modelIndex = 0) {
    const id = String(model || '').toLowerCase();
    const name = String(provider?.name || '').toLowerCase();
    if (!id) return Infinity;
    if (/deepseek|bge|reranker|embedding|kling|image|video|sora/.test(id)) return Infinity;
    let score = 500 + providerIndex * 40 + modelIndex;
    if (/gpt-5\.4-mini|gpt-5-3-mini|gpt-5-mini|mini/.test(id)) score -= 260;
    if (/gpt-5\.4|gpt-5-4|gpt-5\.5|gpt-5-5|gpt-5\b/.test(id)) score -= 220;
    if (/claude|sonnet|haiku|opus/.test(id)) score -= 170;
    if (/gemini|qwen-vl|vl|vision|omni/.test(id)) score -= 150;
    if (/nano/.test(id)) score -= 30;
    if (/pro/.test(name) || /openai/.test(name)) score -= 10;
    return score;
  }

  static getTextRoutes(raw = {}) {
    const textProviders = this.getTextProviderProfiles(raw);
    const defaultVisionRoute = this.defaultVisionTextRoute(textProviders, raw);
    const pptVisionReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_vision_review_provider_id'],
      modelKeys: ['ppt_vision_review_model']
    });
    const pptAssetReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_asset_review_provider_id', 'ppt_vision_review_provider_id'],
      modelKeys: ['ppt_asset_review_model', 'ppt_vision_review_model']
    });
    const pptPageReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_page_review_provider_id', 'ppt_vision_review_provider_id'],
      modelKeys: ['ppt_page_review_model', 'ppt_vision_review_model']
    });
    const pptMicroReviewRoute = this.resolvePptVisionReviewRoute(raw, defaultVisionRoute, textProviders, {
      providerKeys: ['ppt_micro_review_provider_id', 'ppt_vision_review_provider_id'],
      modelKeys: ['ppt_micro_review_model', 'ppt_vision_review_model']
    });
    const chatFallbackModels = this.parseFallbackModelList(raw.chat_fallback_provider_ids || '');
    const assistantFallbackModels = this.parseFallbackModelList(raw.assistant_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptFallbackModels = this.parseFallbackModelList(raw.ppt_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptStrategistFallbackModels = this.parseFallbackModelList(raw.ppt_strategist_fallback_provider_ids || raw.ppt_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptExecutorFallbackModels = this.parseFallbackModelList(raw.ppt_executor_fallback_provider_ids || raw.ppt_fallback_provider_ids || raw.chat_fallback_provider_ids || '');
    const pptVisionReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_vision_review_fallback_provider_ids, pptVisionReviewRoute);
    const pptAssetReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_asset_review_fallback_provider_ids || raw.ppt_vision_review_fallback_provider_ids, pptAssetReviewRoute);
    const pptPageReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_page_review_fallback_provider_ids || raw.ppt_vision_review_fallback_provider_ids, pptPageReviewRoute);
    const pptMicroReviewFallbackModels = this.resolvePptVisionFallbackModels(textProviders, raw.ppt_micro_review_fallback_provider_ids || raw.ppt_vision_review_fallback_provider_ids, pptMicroReviewRoute);
    const imageAssistantFallbackModels = this.parseFallbackModelList(raw.image_assistant_fallback_provider_ids || '');

    return {
      chat: {
        label: '普通对话',
        providerId: raw.chat_provider_id || 'primary',
        fallbackProviderIds: chatFallbackModels.map(item => item.providerId),
        fallbackModels: chatFallbackModels,
        model: raw.chat_model || 'claude-opus-4-7',
        timeoutMs: this.normalizeTimeout(raw.chat_timeout_ms, 60000, 10000)
      },
      assistant: {
        label: '通用助手',
        providerId: raw.assistant_provider_id || raw.chat_provider_id || 'primary',
        fallbackProviderIds: assistantFallbackModels.map(item => item.providerId),
        fallbackModels: assistantFallbackModels,
        model: raw.assistant_model || raw.chat_model || 'claude-opus-4-7',
        timeoutMs: this.normalizeTimeout(raw.assistant_timeout_ms, 60000, 10000)
      },
      ppt: {
        label: 'PPT Agent',
        providerId: raw.ppt_provider_id || raw.chat_provider_id || 'primary',
        fallbackProviderIds: pptFallbackModels.map(item => item.providerId),
        fallbackModels: pptFallbackModels,
        model: raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
        timeoutMs: this.normalizeTimeout(raw.ppt_timeout_ms, 90000, 10000)
      },
      ppt_strategist: {
        label: 'PPT 策划',
        providerId: raw.ppt_strategist_provider_id || raw.ppt_provider_id || raw.chat_provider_id || 'primary',
        fallbackProviderIds: pptStrategistFallbackModels.map(item => item.providerId),
        fallbackModels: pptStrategistFallbackModels,
        model: raw.ppt_strategist_model || raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
        timeoutMs: this.normalizeTimeout(raw.ppt_strategist_timeout_ms, this.normalizeTimeout(raw.ppt_timeout_ms, 90000, 10000), 10000)
      },
      ppt_executor: {
        label: 'PPT SVG 执行',
        providerId: raw.ppt_executor_provider_id || raw.ppt_provider_id || raw.chat_provider_id || 'primary',
        fallbackProviderIds: pptExecutorFallbackModels.map(item => item.providerId),
        fallbackModels: pptExecutorFallbackModels,
        model: raw.ppt_executor_model || raw.ppt_model || raw.chat_model || 'claude-opus-4-7',
        timeoutMs: this.normalizeTimeout(raw.ppt_executor_timeout_ms, 240000, 10000)
      },
      ppt_vision_review: {
        label: 'PPT 视觉质检',
        providerId: pptVisionReviewRoute.providerId,
        fallbackProviderIds: pptVisionReviewFallbackModels.map(item => item.providerId),
        fallbackModels: pptVisionReviewFallbackModels,
        model: pptVisionReviewRoute.model,
        timeoutMs: this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000)
      },
      ppt_asset_review: {
        label: 'PPT 资源审查',
        providerId: pptAssetReviewRoute.providerId,
        fallbackProviderIds: pptAssetReviewFallbackModels.map(item => item.providerId),
        fallbackModels: pptAssetReviewFallbackModels,
        model: pptAssetReviewRoute.model,
        timeoutMs: this.normalizeTimeout(raw.ppt_asset_review_timeout_ms, this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000), 10000)
      },
      ppt_page_review: {
        label: 'PPT 整页终检',
        providerId: pptPageReviewRoute.providerId,
        fallbackProviderIds: pptPageReviewFallbackModels.map(item => item.providerId),
        fallbackModels: pptPageReviewFallbackModels,
        model: pptPageReviewRoute.model,
        timeoutMs: this.normalizeTimeout(raw.ppt_page_review_timeout_ms, this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000), 10000)
      },
      ppt_micro_review: {
        label: 'PPT 单页微审',
        providerId: pptMicroReviewRoute.providerId,
        fallbackProviderIds: pptMicroReviewFallbackModels.map(item => item.providerId),
        fallbackModels: pptMicroReviewFallbackModels,
        model: pptMicroReviewRoute.model,
        timeoutMs: this.normalizeTimeout(raw.ppt_micro_review_timeout_ms, this.normalizeTimeout(raw.ppt_vision_review_timeout_ms, 90000, 10000), 10000)
      },
      image_assistant: {
        label: '图片助手',
        providerId: raw.image_assistant_provider_id || raw.chat_provider_id || 'primary',
        fallbackProviderIds: imageAssistantFallbackModels.map(item => item.providerId),
        fallbackModels: imageAssistantFallbackModels,
        model: raw.image_assistant_model || 'gpt-5.5',
        timeoutMs: this.normalizeTimeout(raw.image_assistant_timeout_ms, 60000, 10000)
      }
    };
  }

  static resolveTextRoute(runtimeConfig = {}, routeName = 'chat', overrides = {}) {
    const routes = runtimeConfig.textRoutes || {};
    const route = routes[routeName] || routes.chat || {};
    const providers = Array.isArray(runtimeConfig.textProviders) ? runtimeConfig.textProviders : [];
    const primaryId = overrides.providerId || route.providerId || 'primary';
    this.assertConfiguredProviderExists(providers, primaryId, `${route.label || routeName}主用供应商`);
    const fallbackModels = overrides.fallbackModels !== undefined
      ? this.parseFallbackModelList(overrides.fallbackModels)
      : (overrides.fallbackProviderIds !== undefined
          ? this.parseFallbackModelList(overrides.fallbackProviderIds)
          : (Array.isArray(route.fallbackModels)
              ? this.parseFallbackModelList(route.fallbackModels)
              : this.parseFallbackModelList(route.fallbackProviderIds || [])));
    const fallbackIds = fallbackModels.map(item => item.providerId);
    fallbackIds.forEach(id => this.assertConfiguredProviderExists(providers, id, `${route.label || routeName}备用供应商`));
    const selected = [
      this.findTextProvider(providers, primaryId),
      ...fallbackIds
        .filter(id => String(id || '').trim() !== String(primaryId || '').trim())
        .map(id => this.findTextProvider(providers, id))
    ]
      .filter(Boolean)
      .filter(provider => provider.enabled !== false && provider.apiKey && provider.baseUrl);
    const deduped = [];
    const seen = new Set();

    selected.forEach(provider => {
      if (!this.isTextGenerationProvider(provider)) return;
      const key = `${provider.id}|${provider.baseUrl}|${provider.apiKey}|${provider.format}`;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(provider);
    });

    if (!primaryId && deduped.length <= 1) {
      providers
        .filter(provider => provider && provider.enabled !== false && provider.apiKey && provider.baseUrl)
        .filter(provider => this.isTextGenerationProvider(provider))
        .forEach(provider => {
          const key = `${provider.id}|${provider.baseUrl}|${provider.apiKey}|${provider.format}`;
          if (seen.has(key)) return;
          seen.add(key);
          deduped.push(provider);
        });
    }

    if (!deduped.length) {
      const selectedProvider = this.findTextProvider(providers, primaryId);
      if (selectedProvider && !this.isTextGenerationProvider(selectedProvider)) {
        throw new Error(`${route.label || routeName}主用供应商 ${selectedProvider.name || selectedProvider.id} 不是文本模型供应商`);
      }
      throw new Error(`${route.label || routeName}缺少可用文本供应商`);
    }

    return {
      route: routeName,
      label: route.label || routeName,
      model: overrides.model || route.model || deduped[0].defaultModel || runtimeConfig.chatModel || 'claude-opus-4-7',
      modelOverridden: Boolean(overrides.model),
      timeoutMs: this.normalizeTimeout(overrides.timeoutMs || route.timeoutMs || deduped[0].timeoutMs, 60000, 10000),
      providers: deduped,
      candidates: this.resolveModelCandidates(runtimeConfig, routeName, {
        ...overrides,
        category: 'chat',
        providerId: primaryId,
        fallbackProviderIds: fallbackIds,
        fallbackModels,
        model: overrides.model || route.model,
        includePoolProviders: overrides.includePoolProviders === true
      })
    };
  }

  static routeCategory(routeName = '') {
    const normalized = String(routeName || '').trim().toLowerCase();
    if (normalized === 'image' || normalized === 'image_generation' || normalized === 'image_smoke') return 'image';
    if (normalized === 'video' || normalized === 'video_generation') return 'video';
    return 'chat';
  }

  static getProviderModelCatalog(provider = {}) {
    const models = this.normalizeProviderModels(provider.models || [], { providerFormat: provider.format });
    const seen = new Set(models.map(model => model.id));
    const defaultModel = String(provider.defaultModel || provider.model || '').trim();
    if (defaultModel && !seen.has(defaultModel)) {
      models.unshift({
        id: defaultModel,
        name: defaultModel,
        category: this.normalizeModelCategory('', defaultModel, { providerFormat: provider.format }),
        enabled: true,
        priority: 1,
        maxConcurrency: 3,
        timeoutMs: provider.timeoutMs || null
      });
    }
    return models;
  }

  static providerSupportsModelCategory(provider = {}, category = 'chat') {
    if (!provider || provider.enabled === false || !provider.baseUrl || !provider.apiKey) return false;
    const normalizedCategory = this.normalizeModelCategory(category);
    if (normalizedCategory === 'chat') return ['openai', 'anthropic'].includes(provider.format);
    if (normalizedCategory === 'image') return provider.format === 'openai';
    if (normalizedCategory === 'video') {
      if (provider.format === 'kling') return true;
      if (provider.format !== 'openai') return false;
      const modelCatalog = this.getProviderModelCatalog(provider);
      const enabledVideoModels = modelCatalog.filter(model => {
        if (model.enabled === false) return false;
        const category = this.normalizeModelCategory(model.category || '', model.id, { providerFormat: provider.format });
        return category === 'video';
      });
      if (enabledVideoModels.length) {
        return enabledVideoModels.some(model => !this.isKlingVideoModel(model.id));
      }
      const defaultModel = String(provider.defaultModel || provider.model || '').trim();
      return this.isKnownVideoModel(defaultModel) && !this.isKlingVideoModel(defaultModel);
    }
    return false;
  }

  static resolveModelCandidates(runtimeConfig = {}, routeName = 'chat', overrides = {}) {
    const category = this.normalizeModelCategory(overrides.category || this.routeCategory(routeName));
    const providers = Array.isArray(runtimeConfig.textProviders) ? runtimeConfig.textProviders : [];
    const routes = runtimeConfig.textRoutes || {};
    const route = routes[routeName] || {};
    const primaryId = String(overrides.providerId || route.providerId || '').trim();
    this.assertConfiguredProviderExists(providers, primaryId, `${route.label || routeName}主用供应商`);
    const fallbackModels = overrides.fallbackModels !== undefined
      ? this.parseFallbackModelList(overrides.fallbackModels)
      : (overrides.fallbackProviderIds !== undefined
          ? this.parseFallbackModelList(overrides.fallbackProviderIds)
          : (Array.isArray(route.fallbackModels)
              ? this.parseFallbackModelList(route.fallbackModels)
              : this.parseFallbackModelList(route.fallbackProviderIds || [])));
    const fallbackIds = fallbackModels.map(item => item.providerId);
    fallbackIds.forEach(id => this.assertConfiguredProviderExists(providers, id, `${route.label || routeName}备用供应商`));
    const explicitModel = String(overrides.model || route.model || '').trim();
    const routeTimeoutRaw = overrides.timeoutMs || route.timeoutMs || '';
    const timeoutMs = this.normalizeTimeout(routeTimeoutRaw || 0, category === 'image' ? 600000 : 60000, 10000);
    const includePoolProviders = overrides.includePoolProviders !== undefined
      ? this.parseBool(overrides.includePoolProviders, true)
      : (!primaryId && fallbackIds.length === 0);
    const routeEntries = [];
    if (primaryId) {
      routeEntries.push({
        providerId: primaryId,
        model: explicitModel,
        role: 'primary',
        rank: 0
      });
    }
    fallbackModels.forEach((item, index) => {
      const providerId = String(item?.providerId || '').trim();
      if (!providerId) return;
      routeEntries.push({
        providerId,
        model: String(item.model || '').trim(),
        role: 'fallback',
        rank: index + 1
      });
    });

    const modelForRouteEntry = (entry, provider) => {
      if (!entry) return '';
      const directModel = String(entry.model || '').trim();
      if (directModel) return directModel;
      if (entry.role === 'fallback') {
        return String(provider.defaultModel || provider.model || explicitModel || '').trim();
      }
      return String(explicitModel || provider.defaultModel || provider.model || '').trim();
    };

    const routeEntryForModel = (provider, modelId) => routeEntries
      .filter(entry => entry.providerId === provider.id)
      .filter(entry => {
        const expectedModel = modelForRouteEntry(entry, provider);
        return !expectedModel || expectedModel === modelId;
      })
      .sort((left, right) => Number(left.rank || 0) - Number(right.rank || 0))[0] || null;

    const candidates = [];
    const seen = new Set();

    providers.forEach((provider, providerIndex) => {
      if (!this.providerSupportsModelCategory(provider, category)) return;
      const providerRouteEntries = routeEntries.filter(entry => entry.providerId === provider.id);
      if (!includePoolProviders && routeEntries.length && !providerRouteEntries.length) return;
      const modelCatalog = this.getProviderModelCatalog(provider);
      const knownCatalogIds = new Set(modelCatalog.map(model => model.id));
      providerRouteEntries.forEach(entry => {
        const configuredModel = modelForRouteEntry(entry, provider);
        if (!configuredModel) return;
        const existingIndex = modelCatalog.findIndex(model => model.id === configuredModel);
        if (existingIndex >= 0) {
          if (modelCatalog[existingIndex].enabled === false) {
            modelCatalog[existingIndex] = {
              ...modelCatalog[existingIndex],
              enabled: true,
              priority: Math.min(Number(modelCatalog[existingIndex].priority || entry.rank + 1), entry.rank + 1)
            };
          }
          return;
        }
        knownCatalogIds.add(configuredModel);
        modelCatalog.unshift({
          id: configuredModel,
          name: configuredModel,
          category,
          enabled: true,
          priority: entry.rank + 1,
          maxConcurrency: 3,
          timeoutMs: provider.timeoutMs || null
        });
      });

      modelCatalog.forEach((modelConfig, modelIndex) => {
        const modelCategory = this.normalizeModelCategory(modelConfig.category, modelConfig.id, { providerFormat: provider.format });
        if (modelCategory !== category) return;
        if (modelConfig.enabled === false) return;
        const matchedRouteEntry = routeEntryForModel(provider, modelConfig.id);
        if (!includePoolProviders && routeEntries.length && !matchedRouteEntry) return;
        const key = `${provider.id}/${modelConfig.id}`;
        if (seen.has(key)) return;
        seen.add(key);

        const exactLegacyRoute = primaryId
          && provider.id === primaryId
          && explicitModel
          && modelConfig.id === explicitModel;
        const explicitModelAcrossProvider = !matchedRouteEntry && explicitModel && modelConfig.id === explicitModel;
        const priorityBase = Number(modelConfig.priority || modelIndex + 1);
        const routeRank = matchedRouteEntry
          ? Number(matchedRouteEntry.rank || 0)
          : (routeEntries.length ? 50 + providerIndex : providerIndex);
        const routeBoost = matchedRouteEntry
          ? (routeRank === 0 ? -100 : routeRank * 10)
          : (exactLegacyRoute ? -100 : (explicitModelAcrossProvider ? -50 : (routeRank * 10)));
        const candidateFormat = category === 'video'
          ? this.inferVideoProviderFormat(provider, modelConfig.id)
          : provider.format;
        candidates.push({
          route: routeName,
          category,
          providerId: provider.id,
          providerName: provider.name || provider.id,
          provider,
          model: modelConfig.id,
          modelName: modelConfig.name || modelConfig.id,
          qualifiedId: `${provider.id}/${modelConfig.id}`,
          format: candidateFormat,
          priority: routeBoost + (Number.isFinite(priorityBase) ? priorityBase : modelIndex + 1),
          configuredPriority: Number.isFinite(priorityBase) ? priorityBase : modelIndex + 1,
          maxConcurrency: parseInt(modelConfig.maxConcurrency ?? modelConfig.max_concurrency ?? 3, 10) || 3,
          timeoutMs: this.normalizeTimeout(modelConfig.timeoutMs || routeTimeoutRaw || provider.timeoutMs || timeoutMs, timeoutMs, 10000),
          weight: Number(modelConfig.weight || provider.weight || 0),
          role: matchedRouteEntry ? matchedRouteEntry.role : 'pool',
          _orderIndex: candidates.length
        });
      });
    });

    return candidates.sort((left, right) => {
      return Number(left.priority || 0) - Number(right.priority || 0)
        || Number(right.weight || 0) - Number(left.weight || 0)
        || Number(left._orderIndex || 0) - Number(right._orderIndex || 0);
    });
  }

  static resolveModelRoute(runtimeConfig = {}, routeName = 'chat', overrides = {}) {
    const candidates = this.resolveModelCandidates(runtimeConfig, routeName, overrides);
    if (!candidates.length) {
      throw new Error(`${routeName} 缺少可用${this.routeCategory(routeName)}模型`);
    }
    return {
      route: routeName,
      category: this.normalizeModelCategory(overrides.category || this.routeCategory(routeName)),
      label: (runtimeConfig.textRoutes || {})[routeName]?.label || routeName,
      timeoutMs: candidates[0].timeoutMs,
      candidates
    };
  }

  static findTextProvider(providers = [], id = '') {
    const target = String(id || '').trim();
    if (target) {
      return providers.find(provider => provider.id === target) || null;
    }
    return providers.find(provider => provider.enabled !== false) || null;
  }

  static assertConfiguredProviderExists(providers = [], id = '', label = '供应商') {
    const target = String(id || '').trim();
    if (!target) return;
    if (!providers.some(provider => provider.id === target)) {
      throw new Error(`${label} ${target} 不存在或未保存，请重新选择并保存 API 配置`);
    }
  }

  static resolveFeatureProvider(providers = [], id = '', requiredFormat = '', options = {}) {
    if (options.strictExists !== false) {
      this.assertConfiguredProviderExists(providers, id, '功能供应商');
    }
    const selected = this.findTextProvider(providers, id);
    const category = options.category ? this.normalizeModelCategory(options.category) : '';
    const compatible = provider => {
      if (!provider || provider.enabled === false) return false;
      const format = String(requiredFormat || '').trim().toLowerCase();
      if (format && provider.format !== format) return false;
      if (category) return this.providerSupportsModelCategory(provider, category);
      return true;
    };
    if (selected && compatible(selected)) return selected;
    if (selected && options.fallbackOnIncompatible !== true) return null;

    const format = String(requiredFormat || '').trim().toLowerCase();
    if (format) {
      const matching = providers.find(provider => compatible(provider) && provider.format === format);
      if (matching) return matching;
    }

    return providers.find(provider => compatible(provider)) || null;
  }

  static parseFallbackModelList(value = '') {
    const normalizeItem = item => {
      if (!item) return null;
      if (typeof item === 'string') {
        const providerId = item.trim();
        return providerId ? { providerId, model: '' } : null;
      }
      if (typeof item !== 'object') return null;
      const providerId = String(
        item.providerId
          || item.provider_id
          || item.provider
          || item.id
          || item.key
          || ''
      ).trim();
      const model = String(
        item.model
          || item.modelId
          || item.model_id
          || item.modelName
          || item.model_name
          || ''
      ).trim();
      return providerId ? { providerId, model } : null;
    };

    const normalizeList = list => {
      const result = [];
      const seen = new Set();
      (Array.isArray(list) ? list : [list]).forEach(item => {
        const normalized = normalizeItem(item);
        if (!normalized) return;
        const key = `${normalized.providerId}/${normalized.model}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push(normalized);
      });
      return result;
    };

    if (Array.isArray(value)) return normalizeList(value);
    if (value && typeof value === 'object') {
      if (Array.isArray(value.fallbackModels)) return normalizeList(value.fallbackModels);
      if (Array.isArray(value.fallback_models)) return normalizeList(value.fallback_models);
      return normalizeList(value);
    }

    const raw = String(value || '').trim();
    if (!raw) return [];
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeList(parsed);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.fallbackModels)) return normalizeList(parsed.fallbackModels);
          if (Array.isArray(parsed.fallback_models)) return normalizeList(parsed.fallback_models);
          return normalizeList(parsed);
        }
      } catch (error) {
        // Fall through to the legacy comma-separated format.
      }
    }

    return raw
      .split(',')
      .map(item => normalizeItem(item))
      .filter(Boolean);
  }

  static parseIdList(value = '') {
    if (Array.isArray(value)) {
      return this.parseFallbackModelList(value).map(item => item.providerId);
    }
    if (value && typeof value === 'object') {
      return this.parseFallbackModelList(value).map(item => item.providerId);
    }
    const raw = String(value || '').trim();
    if (!raw) return [];
    if (raw.startsWith('[') || raw.startsWith('{')) {
      return this.parseFallbackModelList(raw).map(item => item.providerId);
    }
    return raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  static normalizeTimeout(value, fallback = 60000, min = 1000) {
    const timeout = parseInt(value, 10);
    if (!Number.isFinite(timeout) || timeout <= 0) return fallback;
    return Math.max(timeout, min);
  }

  static normalizePort(value, fallback = 465) {
    const port = parseInt(value, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return fallback;
    return port;
  }

  static normalizePositiveNumber(value, fallback = 0, min = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, number);
  }

	  static parseBool(value, fallback = false) {
	    if (value === undefined || value === null || value === '') return fallback;
	    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
	  }

	  static buildAlipayConfig(raw = {}) {
	    const publicBaseUrl = this.normalizeBaseUrl(raw.site_public_base_url || '', '');
	    const defaultReturnUrl = publicBaseUrl ? `${publicBaseUrl}/user.html?view=credits` : '';
	    const defaultNotifyUrl = publicBaseUrl ? `${publicBaseUrl}/api/pay/alipay/notify` : '';
	    return {
	      enabled: this.parseBool(raw.alipay_enabled, false),
	      appId: String(raw.alipay_app_id || '').trim(),
	      appPrivateKey: String(raw.alipay_app_private_key || '').trim(),
	      publicKey: String(raw.alipay_public_key || '').trim(),
	      gateway: this.normalizeBaseUrl(raw.alipay_gateway || 'https://openapi.alipay.com/gateway.do', 'https://openapi.alipay.com/gateway.do'),
	      returnUrl: this.normalizeBaseUrl(raw.alipay_return_url || defaultReturnUrl, defaultReturnUrl),
	      notifyUrl: this.normalizeBaseUrl(raw.alipay_notify_url || defaultNotifyUrl, defaultNotifyUrl)
	    };
	  }

	  static normalizeRechargeMode(value) {
	    const normalized = String(value || '').trim().toLowerCase();
	    return normalized === 'card_link' ? 'card_link' : 'alipay';
	  }

	  static normalizePublicHttpUrl(value) {
	    const raw = String(value || '').trim();
	    if (!raw) return '';
	    try {
	      const parsed = new URL(raw);
	      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
	    } catch (error) {
	      return '';
	    }
	  }

		  static parseRechargePackages(value) {
		    const fallbackPackages = DEFAULT_RECHARGE_PACKAGES.map(item => ({ ...item }));

    let parsed = null;
    try {
      parsed = JSON.parse(String(value || ''));
    } catch (error) {
      parsed = null;
    }

    if (!Array.isArray(parsed)) return fallbackPackages;

    const normalized = parsed
	      .map((item, index) => {
	        if (!item || typeof item !== 'object') return null;
	        const type = String(item.type || item.kind || '').trim().toLowerCase() === 'vip' ? 'vip' : 'credits';
	        const credits = Number(item.credits ?? item.promoCredits ?? item.newCredits ?? item.amount ?? item.originalCredits ?? 0);
	        const originalCredits = Number(item.originalCredits ?? item.original ?? item.oldCredits ?? item.credits ?? credits);
	        const promoCredits = Number(item.promoCredits ?? item.newCredits ?? item.amount ?? item.credits ?? credits);
	        const vipDays = Number(item.vipDays ?? item.vip_days ?? item.days ?? 30);
		        const normalizedId = String(item.id || item.sku || item.packageId || '').trim() || `${type}-${index + 1}`;
		        return {
		          id: normalizedId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || `${type}-${index + 1}`,
	          type,
	          title: String(item.title || item.name || `活动套餐 ${index + 1}`).trim(),
	          price: String(item.price || item.amountText || '').trim(),
	          originalPrice: String(item.originalPrice || item.oldPrice || item.marketPrice || '').trim(),
	          credits: Number.isFinite(credits) ? Math.max(0, credits) : 0,
	          originalCredits: Number.isFinite(originalCredits) ? Math.max(0, originalCredits) : 0,
	          promoCredits: Number.isFinite(promoCredits) ? Math.max(0, promoCredits) : 0,
		          vipDays: Number.isFinite(vipDays) ? Math.max(0, Math.floor(vipDays)) : 30,
		          benefitText: String(item.benefitText || item.benefit || '').trim(),
		          tag: String(item.tag || item.badge || item.discount || '').trim()
	        };
	      })
	      .filter(item => item && (item.type === 'vip' || item.credits > 0 || item.promoCredits > 0));

    return normalized.length ? normalized : fallbackPackages;
  }

  static normalizeBaseUrl(value, fallback) {
    return String(value || fallback || '').replace(/\/+$/, '');
  }

  static resolvePptMasterRoot(value) {
    const configured = String(value || '').trim();
    const candidates = [
      configured,
      process.env.PPT_MASTER_ROOT,
      appConfig.defaultPptMasterRoot,
      path.join(appConfig.projectRoot, 'external', 'ppt-master')
    ].filter(Boolean);

    for (const candidate of candidates) {
      const resolved = this.resolveProjectPath(candidate);
      if (fs.existsSync(path.join(resolved, 'skills', 'ppt-master', 'scripts'))) {
        return resolved;
      }
    }

    return configured || appConfig.defaultPptMasterRoot;
  }

  static resolvePptMasterPython(value, pptMasterRoot = '') {
    const configured = String(value || '').trim();
    const root = pptMasterRoot || this.resolvePptMasterRoot();
    const candidates = [
      configured,
      process.env.PPT_MASTER_PYTHON,
      appConfig.defaultPptMasterPython,
      path.join(root, 'venv', 'bin', 'python'),
      process.env.PYTHON_BIN,
      'python3',
      'python'
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate === 'python3' || candidate === 'python') return candidate;
      const resolved = this.resolveProjectPath(candidate);
      if (fs.existsSync(resolved)) return resolved;
    }

    return configured || appConfig.defaultPptMasterPython || 'python3';
  }

  static resolveProjectPath(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return '';
    return path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(appConfig.projectRoot, candidate);
  }

  static normalizeOpenAiBaseUrl(value, fallback = 'https://timebackward.com/v1') {
    const normalized = this.normalizeBaseUrl(value, fallback);
    if (!normalized) return '';
    if (/\/v1$/i.test(normalized)) return normalized;
    return `${normalized}/v1`;
  }

  static normalizeKlingBaseUrl(value, fallback = '') {
    return this.normalizeBaseUrl(value, fallback).replace(/\/v1$/i, '');
  }

  static async listProviderModels({ providerId = '', provider = null, overrides = {} } = {}) {
    const runtimeConfig = this.getRuntimeConfig(overrides);
    const normalizedProvider = provider
      ? this.resolveMaskedProviderProfile(provider, runtimeConfig, 0)
      : this.findTextProvider(runtimeConfig.textProviders, providerId);

    if (!normalizedProvider) {
      throw new Error('未找到模型供应商');
    }

    if (!normalizedProvider.baseUrl || !normalizedProvider.apiKey) {
      throw new Error('供应商缺少 Base URL 或 API Key');
    }

    const startedAt = Date.now();
    if (normalizedProvider.format === 'kling') {
      const models = this.normalizeProviderModels([
        'kling-v3',
        'kling-v3-omni',
        'kling-v2-5-turbo'
      ]);
      return {
        ok: true,
        provider_id: normalizedProvider.id,
        provider_name: normalizedProvider.name,
        format: normalizedProvider.format,
        status: 200,
        latency_ms: Date.now() - startedAt,
        count: models.length,
        models
      };
    }

    const response = normalizedProvider.format === 'anthropic'
      ? await axios.get(
          `${this.normalizeBaseUrl(normalizedProvider.baseUrl, '').replace(/\/v1$/i, '')}/v1/models`,
          {
            headers: {
              'x-api-key': normalizedProvider.apiKey,
              'Authorization': `Bearer ${normalizedProvider.apiKey}`,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: normalizedProvider.timeoutMs || 30000
          }
        )
      : await axios.get(
          `${this.normalizeOpenAiBaseUrl(normalizedProvider.baseUrl, '')}/models`,
          {
            headers: {
              'Authorization': `Bearer ${normalizedProvider.apiKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: normalizedProvider.timeoutMs || 30000
          }
        );

    const models = this.extractProviderModels(response.data);
    return {
      ok: true,
      provider_id: normalizedProvider.id,
      provider_name: normalizedProvider.name,
      format: normalizedProvider.format,
      status: response.status,
      latency_ms: Date.now() - startedAt,
      count: models.length,
      models
    };
  }

  static resolveMaskedProviderProfile(provider = {}, runtimeConfig = {}, index = 0) {
    const maskedApiKey = this.isMaskedSecretValue(provider?.apiKey || provider?.api_key || provider?.key || '');
    const normalizedProvider = this.normalizeTextProviderProfile(provider, index);
    if (!maskedApiKey) return normalizedProvider;

    const storedProvider = this.findTextProvider(runtimeConfig.textProviders || [], normalizedProvider.id)
      || this.findMatchingTextProvider(runtimeConfig.textProviders || [], normalizedProvider);
    return {
      ...normalizedProvider,
      apiKey: storedProvider?.apiKey || ''
    };
  }

  static findMatchingTextProvider(providers = [], provider = {}) {
    const normalizedBaseUrl = this.normalizeBaseUrl(provider.baseUrl || '', '');
    const normalizedName = String(provider.name || '').trim();
    return providers.find(candidate => {
      if (!candidate) return false;
      const sameBaseUrl = normalizedBaseUrl
        && this.normalizeBaseUrl(candidate.baseUrl || '', '') === normalizedBaseUrl;
      const sameName = normalizedName && String(candidate.name || '').trim() === normalizedName;
      return sameBaseUrl || sameName;
    }) || null;
  }

  static extractProviderModels(payload) {
    const source = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.data)
        ? payload.data
        : (Array.isArray(payload?.models) ? payload.models : []));

    return this.normalizeProviderModels(source)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  static normalizeTestScope(scope = '') {
    const normalized = String(scope || '').trim().toLowerCase();
    const aliases = {
      provider: 'provider',
      base_provider: 'provider',
      chat: 'chat',
      chat_model: 'chat',
      chat_provider_id: 'chat',
      text: 'chat',
      conversation: 'chat',
      ppt: 'ppt',
      ppt_model: 'ppt',
      ppt_provider_id: 'ppt',
      ppt_agent: 'ppt',
      ppt_strategist: 'ppt_strategist',
      ppt_strategist_model: 'ppt_strategist',
      ppt_strategist_provider_id: 'ppt_strategist',
      ppt_strategy: 'ppt_strategist',
      ppt_planner: 'ppt_strategist',
      ppt_planning: 'ppt_strategist',
      ppt_executor: 'ppt_executor',
      ppt_executor_model: 'ppt_executor',
      ppt_executor_provider_id: 'ppt_executor',
      ppt_execute: 'ppt_executor',
      ppt_exec: 'ppt_executor',
      ppt_svg: 'ppt_executor',
      ppt_vision_review: 'ppt_vision_review',
      ppt_vision_review_model: 'ppt_vision_review',
      ppt_vision_review_provider_id: 'ppt_vision_review',
      ppt_review: 'ppt_vision_review',
      ppt_quality: 'ppt_vision_review',
      ppt_asset_review: 'ppt_asset_review',
      ppt_asset_review_model: 'ppt_asset_review',
      ppt_asset_review_provider_id: 'ppt_asset_review',
      ppt_assets: 'ppt_asset_review',
      ppt_page_review: 'ppt_page_review',
      ppt_page_review_model: 'ppt_page_review',
      ppt_page_review_provider_id: 'ppt_page_review',
      ppt_final_review: 'ppt_page_review',
      ppt_micro_review: 'ppt_micro_review',
      ppt_micro_review_model: 'ppt_micro_review',
      ppt_micro_review_provider_id: 'ppt_micro_review',
      ppt_single_page_review: 'ppt_micro_review',
      assistant: 'assistant',
      assistant_model: 'assistant',
      assistant_provider_id: 'assistant',
      image_assistant: 'image_assistant',
      image_assistant_model: 'image_assistant',
      image_assistant_provider_id: 'image_assistant',
      image_assistant_fallback: 'image_assistant_fallback',
      image: 'image',
      image_model: 'image_smoke',
      image_generation: 'image_smoke',
      image_smoke: 'image_smoke',
      image_provider_id: 'image_smoke',
      image_fallback: 'image_fallback',
      video: 'video',
      video_model: 'video',
      video_generation: 'video',
      video_provider_id: 'video',
      search: 'search',
      all: 'all'
    };
    return aliases[normalized] || normalized;
  }

  static async testScope(scope, overrides = {}) {
    const normalizedScope = this.normalizeTestScope(scope);
    const config = this.getRuntimeConfig(overrides);

    switch (normalizedScope) {
      case 'provider':
        return this.testTextRoute(config, 'chat', '基础服务', { scope: 'provider' });
      case 'chat':
        return this.testTextRouteAllChannels(config, 'chat', '对话模型');
      case 'ppt':
        return this.testTextRouteAllChannels(config, 'ppt', 'PPT 模型');
      case 'ppt_strategist':
        return this.testTextRouteAllChannels(config, 'ppt_strategist', 'PPT 策划模型');
      case 'ppt_executor':
        return this.testTextRouteAllChannels(config, 'ppt_executor', 'PPT 执行模型');
      case 'ppt_vision_review':
        return this.testTextRouteAllChannels(config, 'ppt_vision_review', 'PPT 质检模型');
      case 'ppt_asset_review':
        return this.testTextRouteAllChannels(config, 'ppt_asset_review', 'PPT 资源审查模型');
      case 'ppt_page_review':
        return this.testTextRouteAllChannels(config, 'ppt_page_review', 'PPT 整页终检模型');
      case 'ppt_micro_review':
        return this.testTextRouteAllChannels(config, 'ppt_micro_review', 'PPT 单页微审模型');
      case 'assistant':
        return this.testTextRouteAllChannels(config, 'assistant', '助手模型');
      case 'image_assistant':
        return this.testTextRouteAllChannels(config, 'image_assistant', '图片助手接口');
      case 'image_assistant_fallback':
        return this.testTextRoute(config, 'image_assistant', '图片助手备用接口', { fallbackOnly: true });
      case 'image':
        return this.testImageModelPool(config);
      case 'image_smoke':
        return this.testImageModelPool(config, { realGeneration: true });
      case 'image_fallback':
        return this.testImageEndpoint(config, 'fallback');
      case 'video':
        return this.testVideoModelPool(config);
      case 'search':
        return this.testSearchEndpoint(config);
      case 'all': {
        const scopes = ['provider', 'chat', 'ppt', 'ppt_strategist', 'ppt_executor', 'ppt_vision_review', 'ppt_asset_review', 'ppt_page_review', 'ppt_micro_review', 'assistant', 'image_assistant', 'image', 'video', 'search'];
        const results = [];
        for (const entry of scopes) {
          results.push(await this.testScope(entry, overrides));
        }
        return {
          scope: 'all',
          ok: results.every(item => item.ok),
          message: results.every(item => item.ok) ? '全部检测通过' : '部分检测失败',
          results
        };
      }
      default:
        throw new Error(`不支持的检测类型：${scope}`);
    }
  }

  static textRouteCandidatesForTest(config, routeName, options = {}) {
    const routeConfig = this.resolveTextRoute(config, routeName, {
      includePoolProviders: options.includePoolProviders === true
    });
    const candidates = Array.isArray(routeConfig.candidates) && routeConfig.candidates.length
      ? routeConfig.candidates
      : [];
    if (candidates.length) {
      return {
        routeConfig,
        candidates: options.fallbackOnly ? candidates.slice(1) : candidates
      };
    }

    const providers = options.fallbackOnly ? routeConfig.providers.slice(1) : routeConfig.providers;
    return {
      routeConfig,
      candidates: providers.map((provider, index) => ({
        provider,
        model: (routeConfig.modelOverridden || index === 0)
          ? (routeConfig.model || provider.defaultModel)
          : (provider.defaultModel || routeConfig.model),
        role: index === 0 ? 'primary' : 'fallback',
        timeoutMs: routeConfig.timeoutMs
      }))
    };
  }

  static async testTextRoute(config, routeName, label, options = {}) {
    let routeProbe;
    try {
      routeProbe = this.textRouteCandidatesForTest(config, routeName, options);
    } catch (error) {
      return {
        scope: routeName,
        ok: false,
        message: `${label}检测失败：${error.message}`
      };
    }

    const scope = options.scope || (options.fallbackOnly ? `${routeName}_fallback` : routeName);
    const candidate = routeProbe.candidates[0];
    if (!candidate) {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：未配置备用模型`
      };
    }

    return this.testTextProvider({
      scope,
      label,
      model: candidate.model,
      provider: candidate.provider,
      timeoutMs: candidate.timeoutMs || routeProbe.routeConfig.timeoutMs
    });
  }

  static async testTextRouteAllChannels(config, routeName, label) {
    let routeProbe;
    try {
      routeProbe = this.textRouteCandidatesForTest(config, routeName);
    } catch (error) {
      return {
        scope: routeName,
        ok: false,
        message: `${label}检测失败：${error.message}`,
        results: []
      };
    }

    const results = [];
    for (let index = 0; index < routeProbe.candidates.length; index += 1) {
      const candidate = routeProbe.candidates[index];
      const provider = candidate.provider;
      const role = index === 0 ? '主用' : (candidate.role === 'fallback' ? `备用 ${index}` : `模型池 ${index + 1}`);
      const model = candidate.model;
      results.push(await this.testTextProvider({
        scope: index === 0 ? routeName : `${routeName}_fallback_${index}`,
        label: `${label}${role}`,
        model,
        provider,
        timeoutMs: candidate.timeoutMs || routeProbe.routeConfig.timeoutMs,
        probeMessage: '请只回复 OK'
      }).then(result => ({
        ...result,
        role: index === 0 ? 'primary' : (candidate.role || 'pool'),
        role_label: role
      })));
    }

    const okCount = results.filter(item => item.ok).length;
    const hasManualFallback = results.some(item => item.role === 'fallback');
    return {
      scope: routeName,
      ok: okCount > 0,
      message: okCount > 0
        ? `${label}检测完成：${okCount}/${results.length} 个通道可用`
        : `${label}检测失败：没有可用通道${hasManualFallback ? '' : '（当前没有配置备用模型）'}`,
      results
    };
  }

  static imageRuntimeConfigFromCandidate(config = {}, candidate = {}) {
    const provider = candidate.provider || {};
    return {
      ...config,
      imageProviderId: provider.id || candidate.providerId || '',
      imageProviderName: provider.name || candidate.providerName || '',
      imageProviderFormat: provider.format || candidate.format || 'openai',
      imageBaseUrl: this.normalizeOpenAiBaseUrl(provider.baseUrl || config.imageBaseUrl || ''),
      imageApiKey: provider.apiKey || config.imageApiKey || config.providerApiKey,
      imageModel: candidate.model || config.imageModel,
      imageTimeoutMs: candidate.timeoutMs || config.imageTimeoutMs
    };
  }

  static videoRuntimeConfigFromCandidate(config = {}, candidate = {}) {
    const provider = candidate.provider || {};
    const videoModel = candidate.model || config.videoModel;
    const format = this.inferVideoProviderFormat(
      { ...provider, format: candidate.format || provider.format || config.videoProviderFormat },
      videoModel
    );
    return {
      ...config,
      videoProviderId: provider.id || candidate.providerId || '',
      videoProviderName: provider.name || candidate.providerName || '',
      videoProviderFormat: format,
      videoBaseUrl: format === 'kling'
        ? this.normalizeKlingBaseUrl(provider.baseUrl || config.videoBaseUrl || '', '')
        : this.normalizeOpenAiBaseUrl(provider.baseUrl || config.videoBaseUrl || ''),
      videoApiKey: provider.apiKey || config.videoApiKey || config.providerApiKey,
      videoModel
    };
  }

  static async testImageModelPool(config, options = {}) {
    let routeConfig;
    try {
      routeConfig = this.resolveModelRoute(config, 'image', {
        category: 'image',
        providerId: config.imageProviderId,
        fallbackProviderIds: config.imageFallbackProviderIds,
        fallbackModels: config.imageFallbackModels,
        model: config.imageModel,
        timeoutMs: config.imageTimeoutMs
      });
    } catch (error) {
      return this.testImageEndpoint(config, 'primary', options);
    }

    const candidates = (routeConfig.candidates || []).filter(candidate => candidate.format === 'openai');
    if (!candidates.length) {
      return this.testImageEndpoint(config, 'primary', options);
    }

    const checked = options.realGeneration ? candidates.slice(0, 1) : candidates;
    const results = [];
    for (let index = 0; index < checked.length; index += 1) {
      const candidate = checked[index];
      const candidateConfig = this.imageRuntimeConfigFromCandidate(config, candidate);
      const roleLabel = index === 0 ? '主用' : (candidate.role === 'fallback' ? `备用 ${index}` : `模型池 ${index + 1}`);
      const result = await this.testImageEndpoint(candidateConfig, 'primary', options)
        .catch(error => this.formatProbeError(options.realGeneration ? 'image_smoke' : 'image', `${roleLabel}检测失败`, error));
      results.push({
        ...result,
        provider_id: candidate.providerId || candidate.provider?.id || '',
        provider_name: candidate.providerName || candidate.provider?.name || '',
        role: index === 0 ? 'primary' : (candidate.role || 'pool'),
        role_label: roleLabel,
        model: result.model || candidate.model
      });
    }

    const passed = results.filter(item => item.ok).length;
    return {
      scope: options.realGeneration ? 'image_smoke' : 'image',
      ok: passed > 0,
      message: options.realGeneration
        ? (passed ? '图片真实出图检测通过' : '图片真实出图检测失败')
        : `图片模型池检测完成：${passed}/${results.length} 个候选可用`,
      results
    };
  }

  static async testVideoModelPool(config) {
    let routeConfig;
    try {
      routeConfig = this.resolveModelRoute(config, 'video', {
        category: 'video',
        providerId: config.videoProviderId,
        fallbackProviderIds: config.videoFallbackProviderIds,
        fallbackModels: config.videoFallbackModels,
        model: config.videoModel,
        timeoutMs: 300000
      });
    } catch (error) {
      return this.testVideoEndpoint(config);
    }

    const candidates = routeConfig.candidates || [];
    if (!candidates.length) {
      return this.testVideoEndpoint(config);
    }

    const results = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const candidateConfig = this.videoRuntimeConfigFromCandidate(config, candidate);
      const roleLabel = index === 0 ? '主用' : (candidate.role === 'fallback' ? `备用 ${index}` : `模型池 ${index + 1}`);
      const result = await this.testVideoEndpoint(candidateConfig)
        .catch(error => this.formatProbeError('video', `${roleLabel}检测失败`, error));
      results.push({
        ...result,
        provider_id: candidate.providerId || candidate.provider?.id || '',
        provider_name: candidate.providerName || candidate.provider?.name || '',
        role: index === 0 ? 'primary' : (candidate.role || 'pool'),
        role_label: roleLabel,
        model: result.model || candidate.model
      });
    }

    const passed = results.filter(item => item.ok).length;
    return {
      scope: 'video',
      ok: passed > 0,
      message: `视频模型池检测完成：${passed}/${results.length} 个候选可用`,
      results
    };
  }

  static async testTextProvider({ scope, label, model, provider, timeoutMs, probeMessage = 'Reply with OK' }) {
    if (!provider?.baseUrl || !provider?.apiKey) {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：缺少供应商 Base URL 或 API Key`,
        provider_id: provider?.id || '',
        provider_name: provider?.name || '',
        provider_format: provider?.format || '',
        model
      };
    }

    if (!model) {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：缺少模型名`,
        provider_id: provider.id,
        provider_name: provider.name,
        provider_format: provider.format,
        model
      };
    }

    const startedAt = Date.now();
    const protocol = this.shouldUseAnthropicProtocol(provider, model) ? 'anthropic' : 'openai';
    try {
      const probeTimeoutMs = timeoutMs || provider.timeoutMs || 30000;
      const response = protocol === 'anthropic'
        ? await this.runStreamProbeRequest(signal => axios.post(
            this.anthropicMessagesUrl(provider.baseUrl),
            {
              model,
              system: 'You are a health check endpoint.',
              messages: [
                { role: 'user', content: probeMessage }
              ],
              temperature: 0,
              max_tokens: 128,
              stream: true
            },
            {
              headers: {
                'x-api-key': provider.apiKey,
                'Authorization': `Bearer ${provider.apiKey}`,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
              },
              timeout: 0,
              signal,
              responseType: 'stream'
            }
          ), probeTimeoutMs)
        : await this.runStreamProbeRequest(signal => axios.post(
            `${this.normalizeOpenAiBaseUrl(provider.baseUrl, '')}/chat/completions`,
            {
              model,
              messages: [
                { role: 'system', content: 'You are a health check endpoint.' },
                { role: 'user', content: probeMessage }
              ],
              temperature: 0,
              max_tokens: 128,
              stream: true
            },
            {
              headers: {
                'Authorization': `Bearer ${provider.apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
              },
              timeout: 0,
              signal,
              responseType: 'stream'
            }
          ), probeTimeoutMs);
      const rawBody = await this.collectProbeResponseBody(response.data);
      const body = this.parseTextProbeBody(rawBody);
      const content = this.extractTextProbeContent(body);

      if (!content) {
        return {
          scope,
          ok: false,
          message: `${label}检测失败：模型返回空内容`,
          status: response.status,
          latency_ms: Date.now() - startedAt,
          provider_id: provider.id,
          provider_name: provider.name,
          provider_format: provider.format,
          protocol,
          model
        };
      }

      return {
        scope,
        ok: true,
        message: `${label}可用`,
        status: response.status,
        latency_ms: Date.now() - startedAt,
        provider_id: provider.id,
        provider_name: provider.name,
        provider_format: provider.format,
        protocol,
        model: body?.model || model
      };
    } catch (error) {
      return {
        ...this.formatProbeError(scope, `${label}检测失败`, error),
        provider_id: provider.id,
        provider_name: provider.name,
        provider_format: provider.format,
        protocol,
        model
      };
    }
  }

  static async testTextModel(scope, label, model, config) {
    if (!config.providerBaseUrl || !config.providerApiKey) {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：缺少 AI 服务地址或 API Key`
      };
    }

    if (!model) {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：缺少模型名`
      };
    }

    const startedAt = Date.now();
    try {
      const response = this.isAnthropicModel(model)
        ? await this.runStreamProbeRequest(signal => axios.post(
            this.anthropicMessagesUrl(config.providerBaseUrl),
            {
              model,
              system: 'You are a health check endpoint.',
              messages: [
                { role: 'user', content: 'Reply with OK' }
              ],
              temperature: 0,
              max_tokens: 128,
              stream: true
            },
            {
              headers: {
                'x-api-key': config.providerApiKey,
                'Authorization': `Bearer ${config.providerApiKey}`,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
              },
              timeout: 0,
              signal,
              responseType: 'stream'
            }
          ), 30000)
        : await this.runStreamProbeRequest(signal => axios.post(
            `${config.providerBaseUrl}/chat/completions`,
            {
              model,
              messages: [
                { role: 'system', content: 'You are a health check endpoint.' },
                { role: 'user', content: 'Reply with OK' }
              ],
              temperature: 0,
              max_tokens: 128,
              stream: true
            },
            {
              headers: {
                'Authorization': `Bearer ${config.providerApiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
              },
              timeout: 0,
              signal,
              responseType: 'stream'
            }
          ), 30000);
      const rawBody = await this.collectProbeResponseBody(response.data);
      const body = this.parseTextProbeBody(rawBody);
      const content = this.extractTextProbeContent(body);

      if (!content) {
        return {
          scope,
          ok: false,
          message: `${label}检测失败：模型返回空内容`,
          status: response.status,
          latency_ms: Date.now() - startedAt,
          model
        };
      }

      return {
        scope,
        ok: true,
        message: `${label}可用`,
        status: response.status,
        latency_ms: Date.now() - startedAt,
        model: body?.model || model
      };
    } catch (error) {
      return this.formatProbeError(scope, `${label}检测失败`, error);
    }
  }

  static isAnthropicModel(model = '') {
    return /^claude[-_]/i.test(String(model || ''));
  }

  static isKnownNonTextModel(model = '') {
    const normalized = String(model || '').trim().toLowerCase();
    if (!normalized) return false;
    return this.isKnownImageModel(normalized) || this.isKnownVideoModel(normalized);
  }

  static isKnownImageModel(model = '') {
    const normalized = String(model || '').trim().toLowerCase();
    if (!normalized) return false;
    return /^(gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|midjourney)/i.test(normalized);
  }

  static isKnownVideoModel(model = '') {
    const normalized = String(model || '').trim().toLowerCase();
    if (!normalized) return false;
    return /^(kling-|sora|veo|runway|pika|luma|hailuo|wan-|seedance)/i.test(normalized);
  }

  static isKlingVideoModel(model = '') {
    return /^kling[-_/]/i.test(String(model || '').trim());
  }

  static inferVideoProviderFormat(provider = {}, model = '') {
    const providerFormat = String(provider?.format || '').trim().toLowerCase();
    const selectedModel = String(model || provider?.defaultModel || provider?.model || '').trim();
    if (providerFormat === 'kling') return 'kling';
    if (providerFormat === 'openai') return 'openai';
    if (this.isKlingVideoModel(selectedModel)) return 'kling';

    const enabledVideoModels = Array.isArray(provider?.models) ? provider.models.filter(item => {
      const modelId = typeof item === 'string'
        ? item
        : (item?.id || item?.model || item?.name || '');
      const disabled = item && typeof item === 'object' && (item.enabled === false || item.disabled === true);
      if (disabled) return false;
      const category = item && typeof item === 'object'
        ? this.normalizeModelCategory(item.category || item.type || '', modelId, { providerFormat })
        : this.normalizeModelCategory('', modelId, { providerFormat });
      return category === 'video';
    }) : [];
    if (
      enabledVideoModels.length > 0 &&
      enabledVideoModels.every(item => this.isKlingVideoModel(typeof item === 'string' ? item : (item?.id || item?.model || item?.name || ''))) &&
      (!providerFormat || providerFormat === 'openai')
    ) {
      return 'kling';
    }
    return providerFormat || 'openai';
  }

  static isTextGenerationProvider(provider = {}) {
    if (!provider || provider.enabled === false) return false;
    if (!['openai', 'anthropic'].includes(provider.format)) return false;

    const defaultModel = String(provider.defaultModel || provider.model || '').trim();
    if (defaultModel && this.isKnownNonTextModel(defaultModel)) {
      return false;
    }

    const modelIds = this.normalizeProviderModels(provider.models || [])
      .map(model => model.id)
      .filter(Boolean);
    if (modelIds.length) {
      return !modelIds.every(model => this.isKnownNonTextModel(model));
    }

    return true;
  }

  static anthropicMessagesUrl(baseUrl = '') {
    const normalized = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
    return `${normalized}/v1/messages`;
  }

  static shouldUseAnthropicProtocol(provider = {}, model = '') {
    return provider?.format === 'anthropic' && this.isAnthropicModel(model);
  }

  static parseTextProbeBody(body) {
    if (body && typeof body === 'object') return body;
    if (typeof body !== 'string') return body || {};

    const text = body.trim();
    if (!text) return {};

    if (text.startsWith('data:') || /\ndata:/.test(text)) {
      const chunks = [];
      text.split(/\n\n+/).forEach(event => {
        const data = event
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.replace(/^data:\s?/, ''))
          .join('\n')
          .trim();
        if (!data || data === '[DONE]') return;
        try {
          chunks.push(JSON.parse(data));
        } catch (error) {
          chunks.push({ content: data });
        }
      });
      const content = chunks.map(chunk => this.extractTextProbeContent(chunk)).filter(Boolean).join('');
      return {
        ...(chunks[chunks.length - 1] || {}),
        content: content ? [{ type: 'text', text: content }] : []
      };
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return { content: text };
    }
  }

  static async collectProbeResponseBody(body) {
    if (!body || typeof body !== 'object' || typeof body[Symbol.asyncIterator] !== 'function') {
      return body;
    }

    let text = '';
    for await (const chunk of body) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    return text;
  }

  static streamProbeTimeoutError(timeoutMs) {
    const error = new Error(`文本模型检测连续 ${Math.round((parseInt(timeoutMs, 10) || 30000) / 1000)} 秒无响应`);
    error.code = 'ESOCKETTIMEDOUT';
    return error;
  }

  static async runStreamProbeRequest(requestFactory, timeoutMs = 30000) {
    const safeTimeoutMs = parseInt(timeoutMs, 10) || 30000;
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout = null;
    const timeoutError = this.streamProbeTimeoutError(safeTimeoutMs);
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      if (rejectTimeout) rejectTimeout(timeoutError);
    }, safeTimeoutMs);

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

  static extractTextProbeContent(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map(item => this.extractTextProbeContent(item)).filter(Boolean).join('\n');
    }
    if (typeof value !== 'object') return '';

    if (typeof value.text === 'string') return value.text;
    if (typeof value.reasoning_content === 'string') return value.reasoning_content;
    if (typeof value.reasoning === 'string') return value.reasoning;
    if (typeof value.thinking === 'string') return value.thinking;
    if (value.reasoning !== undefined) return this.extractTextProbeContent(value.reasoning);
    if (value.thinking !== undefined) return this.extractTextProbeContent(value.thinking);
    if (value.content !== undefined) return this.extractTextProbeContent(value.content);
    if (value.message?.content !== undefined) return this.extractTextProbeContent(value.message.content);
    if (value.delta?.text !== undefined) return this.extractTextProbeContent(value.delta.text);
    if (value.delta?.content !== undefined) return this.extractTextProbeContent(value.delta.content);
    if (Array.isArray(value.choices)) {
      return value.choices
        .map(choice => this.extractTextProbeContent(choice.message?.content)
          || this.extractTextProbeContent(choice.message?.reasoning_content)
          || this.extractTextProbeContent(choice.message?.reasoning)
          || this.extractTextProbeContent(choice.delta?.content)
          || this.extractTextProbeContent(choice.delta?.reasoning_content)
          || this.extractTextProbeContent(choice.delta?.reasoning))
        .filter(Boolean)
        .join('');
    }
    return '';
  }

  static async testImageAssistantEndpoint(config, channel = 'primary') {
    const isFallback = channel === 'fallback';
    const scope = isFallback ? 'image_assistant_fallback' : 'image_assistant';
    const label = isFallback ? '图片助手备用接口' : '图片助手主接口';

    if (isFallback && !config.imageAssistantFailoverEnabled) {
      return {
        scope,
        ok: true,
        message: '图片助手备用容灾未启用，跳过检测'
      };
    }

    return this.testTextModel(
      scope,
      label,
      isFallback ? (config.imageAssistantFallbackModel || config.imageAssistantModel) : config.imageAssistantModel,
      {
        ...config,
        providerBaseUrl: isFallback ? config.imageAssistantFallbackBaseUrl : config.imageAssistantBaseUrl,
        providerApiKey: isFallback ? config.imageAssistantFallbackApiKey : config.imageAssistantApiKey
      }
    );
  }

  static async testImageEndpoint(config, channel = 'primary', options = {}) {
    const isFallback = channel === 'fallback';
    const isRealGeneration = options.realGeneration === true;
    const scope = isFallback ? 'image_fallback' : (isRealGeneration ? 'image_smoke' : 'image');
    const label = isFallback ? '图片备用接口' : '图片主接口';
    const baseUrl = isFallback ? config.imageFallbackBaseUrl : config.imageBaseUrl;
    const apiKey = isFallback ? config.imageFallbackApiKey : config.imageApiKey;
    const model = isFallback ? (config.imageFallbackModel || config.imageModel) : config.imageModel;

    if (isFallback && !config.imageFailoverEnabled) {
      return {
        scope,
        ok: true,
        message: '图片备用容灾未启用，跳过检测'
      };
    }

    if (!isFallback && config.imageProviderFormat && config.imageProviderFormat !== 'openai') {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：图片生成需要选择 OpenAI 兼容供应商`
      };
    }

    if (!baseUrl || !apiKey) {
      return {
        scope,
        ok: false,
        message: `${label}检测失败：缺少 Base URL 或 API Key`
      };
    }

    if (isRealGeneration) {
      return this.testImageRealGenerationEndpoint({
        scope,
        label,
        baseUrl,
        apiKey,
        model,
        config
      });
    }

    const response = await axios.post(
      `${baseUrl}/images/generations`,
      {
        model
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );

    if (this.isValidationReachableResponse(response)) {
      return {
        scope,
        ok: true,
        message: `${label}可达，鉴权通过，参数校验生效`,
        status: response.status,
        model,
        base_url: baseUrl
      };
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        scope,
        ok: true,
        message: `${label}可用`,
        status: response.status,
        model,
        base_url: baseUrl
      };
    }

    return {
      scope,
      ok: false,
      message: `${label}检测失败：HTTP ${response.status}`,
      status: response.status,
      detail: this.extractErrorDetail(response.data)
    };
  }

  static async testImageRealGenerationEndpoint({ scope, label, baseUrl, apiKey, model, config }) {
    const startedAt = Date.now();
    try {
      const response = await axios.post(
        `${baseUrl}/images/generations`,
        {
          model,
          prompt: 'A tiny blue circle on a clean white background. Health check image.',
          size: '1024x1024',
          quality: config.imageQuality || 'high',
          n: 1,
          output_format: config.imageOutputFormat || 'png',
          moderation: 'low',
          user: 'admin_config_image_smoke_test'
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: Math.min(Math.max(parseInt(config.imageTimeoutMs, 10) || 120000, 120000), 300000),
          validateStatus: () => true
        }
      );

      const data = response.data;
      const hasImage = Array.isArray(data?.data) && data.data.some(item => item?.b64_json || item?.url);

      if (response.status >= 200 && response.status < 300 && hasImage) {
        return {
          scope,
          ok: true,
          message: `${label}真实出图检测通过`,
          status: response.status,
          latency_ms: Date.now() - startedAt,
          model,
          base_url: baseUrl
        };
      }

      return {
        scope,
        ok: false,
        message: `${label}真实出图检测失败：HTTP ${response.status}`,
        status: response.status,
        latency_ms: Date.now() - startedAt,
        model,
        base_url: baseUrl,
        detail: this.extractErrorDetail(data) || '图片接口未返回可用图片'
      };
    } catch (error) {
      return this.formatProbeError(scope, `${label}真实出图检测失败`, error);
    }
  }

  static async testVideoEndpoint(config) {
    if (!config.videoBaseUrl || !config.videoApiKey) {
      return {
        scope: 'video',
        ok: false,
        message: '视频接口检测失败：缺少视频供应商地址或 API Key'
      };
    }

    if (config.videoProviderFormat === 'kling') {
      const baseUrl = this.normalizeKlingBaseUrl(config.videoBaseUrl, '');
      const response = await axios.get(
        `${baseUrl}/kling/v1/videos/text2video/__aimaster_probe__`,
        {
          headers: {
            'Authorization': `Bearer ${config.videoApiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000,
          validateStatus: () => true
        }
      );

      if ([400, 404, 422].includes(response.status) || this.isValidationReachableResponse(response)) {
        return {
          scope: 'video',
          ok: true,
          message: '视频接口可达，鉴权通过，任务 ID 参数校验生效',
          status: response.status,
          model: config.videoModel || 'kling-v3'
        };
      }

      if (response.status >= 200 && response.status < 300) {
        return {
          scope: 'video',
          ok: true,
          message: '视频接口可用',
          status: response.status,
          model: config.videoModel || 'kling-v3'
        };
      }

      return {
        scope: 'video',
        ok: false,
        message: `视频接口检测失败：HTTP ${response.status}`,
        status: response.status,
        detail: this.extractErrorDetail(response.data)
      };
    }

    if (config.videoProviderFormat && config.videoProviderFormat !== 'openai') {
      return {
        scope: 'video',
        ok: false,
        message: '视频接口检测失败：视频供应商协议不受支持'
      };
    }

    const response = await axios.post(
      `${config.videoBaseUrl}/videos/generations`,
      {
        model: config.videoModel
      },
      {
        headers: {
          'Authorization': `Bearer ${config.videoApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        validateStatus: () => true
      }
    );

    if (this.isValidationReachableResponse(response)) {
      return {
        scope: 'video',
        ok: true,
        message: '视频接口可达，鉴权通过，参数校验生效',
        status: response.status,
        model: config.videoModel
      };
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        scope: 'video',
        ok: true,
        message: '视频接口可用',
        status: response.status,
        model: config.videoModel
      };
    }

    return {
      scope: 'video',
      ok: false,
      message: `视频接口检测失败：HTTP ${response.status}`,
      status: response.status,
      detail: this.extractErrorDetail(response.data)
    };
  }

  static async testSearchEndpoint(config) {
    if (!config.searchBaseUrl || !config.searchApiKey) {
      return {
        scope: 'search',
        ok: false,
        message: '联网检索检测失败：缺少 Tavily 地址或 API Key'
      };
    }

    const startedAt = Date.now();
    try {
      const response = await axios.post(
        `${config.searchBaseUrl}/search`,
        {
          query: 'AI Designer health check',
          topic: 'general',
          include_answer: true,
          max_results: 1
        },
        {
          headers: {
            'Authorization': `Bearer ${config.searchApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      return {
        scope: 'search',
        ok: true,
        message: '联网检索可用',
        status: response.status,
        latency_ms: Date.now() - startedAt
      };
    } catch (error) {
      return this.formatProbeError('search', '联网检索检测失败', error);
    }
  }

  static formatProbeError(scope, prefix, error) {
    if (error.response) {
      const hint = this.probeHttpStatusHint(error.response.status);
      const rawDetail = this.extractErrorDetail(error.response.data);
      return {
        scope,
        ok: false,
        message: `${prefix}：HTTP ${error.response.status}`,
        status: error.response.status,
        detail: [hint, rawDetail].filter(Boolean).join('；'),
        hint
      };
    }

    const hint = this.probeNetworkErrorHint(error);
    return {
      scope,
      ok: false,
      message: `${prefix}：${this.safeProbeErrorMessage(error)}`,
      detail: hint,
      hint
    };
  }

  static safeProbeErrorMessage(error = {}) {
    const message = String(error?.message || '').trim();
    if (!message || /Converting circular structure to JSON/i.test(message)) {
      return error?.code ? `请求失败：${error.code}` : '请求失败';
    }
    return message.slice(0, 240);
  }

  static probeHttpStatusHint(status) {
    const code = Number(status || 0);
    if (code === 400) return '请求参数不被接口接受，请检查模型名和接口协议';
    if (code === 401 || code === 403) return 'API Key 无效或没有这个模型权限';
    if (code === 404) return '接口地址或模型名不存在';
    if (code === 429) return '请求过于频繁，请换备用源或稍后再试';
    if (code === 502) return '接口源暂时不可用，可能是中转站或上游模型出错';
    if (code === 503 || code === 504) return '接口源正在拥堵或超时，请换备用源或稍后再试';
    if (code >= 500) return '接口源服务异常，请换备用源或稍后再试';
    return '';
  }

  static probeNetworkErrorHint(error = {}) {
    if (error.code === 'ECONNABORTED' || /timeout/i.test(String(error.message || ''))) {
      return '接口源响应超时，请换备用源或稍后再试';
    }
    if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
      return '接口源连不上，请检查 Base URL 或网络';
    }
    return '';
  }

  static extractErrorDetail(payload) {
    if (!payload) {
      return '';
    }

    if (typeof payload === 'string') {
      return payload.slice(0, 200);
    }

    if (Buffer.isBuffer(payload)) {
      return payload.toString('utf8').slice(0, 200);
    }

    if (typeof payload !== 'object') {
      return String(payload).slice(0, 200);
    }

    if (typeof payload.pipe === 'function' || typeof payload[Symbol.asyncIterator] === 'function') {
      return '';
    }

    if (payload.error) {
      if (typeof payload.error === 'string') {
        return payload.error.slice(0, 200);
      }
      if (payload.error.message) {
        return String(payload.error.message).slice(0, 200);
      }
    }

    try {
      const seen = new WeakSet();
      return JSON.stringify(payload, (key, value) => {
        if (key === 'socket' || key === 'request' || key === 'client' || key === '_httpMessage') return undefined;
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        if (typeof value === 'function') return undefined;
        return value;
      }).slice(0, 200);
    } catch (error) {
      return '';
    }
  }

  static isValidationReachableResponse(response) {
    if (!response) {
      return false;
    }

    if ([400, 422].includes(response.status)) {
      return true;
    }

    if (response.status === 500) {
      const detail = String(this.extractErrorDetail(response.data) || '').toLowerCase();
      return detail.includes('required') || detail.includes('missing') || detail.includes('invalid');
    }

    return false;
  }
}

RuntimeConfigService.init();

module.exports = RuntimeConfigService;
