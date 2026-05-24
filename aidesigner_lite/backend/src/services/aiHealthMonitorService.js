const RuntimeConfigService = require('./runtimeConfigService');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ROUTING_HINT_MAX_AGE_MS = CHECK_INTERVAL_MS * 2 + 30 * 1000;
const MAX_HEALTH_CANDIDATES_PER_ROUTE = 8;
const TEXT_ROUTES = [
  { scope: 'chat', label: '普通对话', desc: '聊天与基础文本能力' },
  { scope: 'ppt', label: 'PPT Agent', desc: '大纲、设计规范、逐页 SVG 生成' },
  { scope: 'ppt_strategist', label: 'PPT 策划', desc: '页数判断、design_spec/spec_lock 规划' },
  { scope: 'ppt_executor', label: 'PPT 执行', desc: '逐页 SVG 绘制与截断续写' },
  { scope: 'ppt_vision_review', label: 'PPT 质检', desc: '图片资源、整页截图和单页微审' },
  { scope: 'ppt_asset_review', label: 'PPT 资源审查', desc: '联网图片、logo 和 AI 配图错配审查' },
  { scope: 'ppt_page_review', label: 'PPT 整页终检', desc: '整页截图错版、遮挡、错字和叙事关系审查' },
  { scope: 'ppt_micro_review', label: 'PPT 单页微审', desc: '逐页生成后的轻量版面微调审查' },
  { scope: 'assistant', label: '通用助手', desc: '乐米助手通用工作区' },
  { scope: 'image_assistant', label: '图片助手', desc: '图片页提示词整理与方案建议' }
];

let healthTimer = null;
let running = false;
let currentSnapshot = createEmptySnapshot();

class AiHealthMonitorService {
  static startScheduler({ runImmediately = true } = {}) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    if (!runtimeConfig.aiHealthSchedulerEnabled) {
      this.stopScheduler();
      currentSnapshot = {
        ...currentSnapshot,
        scheduler_enabled: false,
        next_check_at: '',
        message: currentSnapshot.checked_at
          ? 'AI 渠道定时巡检已关闭'
          : 'AI 渠道定时巡检已关闭，可手动检测'
      };
      return null;
    }

    if (healthTimer) return healthTimer;

    healthTimer = setInterval(() => {
      this.runCheck({ reason: 'interval' }).catch(error => {
        console.warn('[AiHealth] 定时巡检失败:', error.message);
      });
    }, CHECK_INTERVAL_MS);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();

    if (runImmediately) {
      setImmediate(() => {
        this.runCheck({ reason: 'startup' }).catch(error => {
          console.warn('[AiHealth] 启动巡检失败:', error.message);
        });
      });
    }

    return healthTimer;
  }

  static stopScheduler() {
    if (!healthTimer) return;
    clearInterval(healthTimer);
    healthTimer = null;
  }

  static syncScheduler({ runImmediately = false } = {}) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    if (runtimeConfig.aiHealthSchedulerEnabled) {
      return this.startScheduler({ runImmediately });
    }
    this.stopScheduler();
    currentSnapshot = {
      ...currentSnapshot,
      running: false,
      scheduler_enabled: false,
      next_check_at: '',
      message: currentSnapshot.checked_at
        ? 'AI 渠道定时巡检已关闭'
        : 'AI 渠道定时巡检已关闭，可手动检测'
    };
    return null;
  }

  static getSnapshot() {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    return {
      ...currentSnapshot,
      running,
      scheduler_enabled: Boolean(runtimeConfig.aiHealthSchedulerEnabled),
      next_check_at: runtimeConfig.aiHealthSchedulerEnabled ? currentSnapshot.next_check_at : ''
    };
  }

  static getRoutingHint(scope, { maxAgeMs = ROUTING_HINT_MAX_AGE_MS } = {}) {
    const checkedAt = Date.parse(currentSnapshot.checked_at || '');
    if (!Number.isFinite(checkedAt)) return null;
    if (Date.now() - checkedAt > maxAgeMs) return null;

    const check = (currentSnapshot.checks || []).find(item => item.scope === scope);
    if (!check || check.status === 'down' || !check.failover_enabled) return null;
    if (check.active_role !== 'fallback' || !check.active_channel?.ok) return null;

    return {
      scope,
      status: check.status,
      failover_state: check.failover_state,
      provider_id: check.active_channel.provider_id || '',
      provider_name: check.active_channel.provider_name || '',
      channel: check.active_channel.role || 'fallback',
      model: check.active_channel.model || '',
      checked_at: currentSnapshot.checked_at,
      reason: check.switch_reason || check.message || '主通道异常，优先使用健康备用通道'
    };
  }

  static async refreshNow() {
    return await this.runCheck({ reason: 'manual', force: true });
  }

  static async runCheck({ reason = 'manual' } = {}) {
    if (running) {
      return {
        ...currentSnapshot,
        running: true,
        message: '已有巡检正在执行'
      };
    }

    running = true;
    const startedAt = Date.now();
    currentSnapshot = {
      ...currentSnapshot,
      running: true,
      status: currentSnapshot.status === 'unknown' ? 'checking' : currentSnapshot.status,
      message: '正在检测 AI 渠道连通性...'
    };

    try {
      const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
      const checks = await Promise.all([
        ...TEXT_ROUTES.map(route => this.checkTextRoute(runtimeConfig, route)),
        this.checkImageRoute(runtimeConfig),
        this.checkVideoRoute(runtimeConfig)
      ]);

      currentSnapshot = buildSnapshot({
        reason,
        startedAt,
        schedulerEnabled: runtimeConfig.aiHealthSchedulerEnabled,
        checks
      });
      return currentSnapshot;
    } catch (error) {
      currentSnapshot = buildSnapshot({
        reason,
        startedAt,
        schedulerEnabled: RuntimeConfigService.getRuntimeConfig().aiHealthSchedulerEnabled,
        checks: [],
        error
      });
      return currentSnapshot;
    } finally {
      running = false;
      currentSnapshot = {
        ...currentSnapshot,
        running: false
      };
    }
  }

  static async checkTextRoute(runtimeConfig, route) {
    const startedAt = Date.now();
    let routeConfig;
    try {
      routeConfig = RuntimeConfigService.resolveTextRoute(runtimeConfig, route.scope);
    } catch (error) {
      return makeRouteResult({
        type: 'text',
        scope: route.scope,
        label: route.label,
        desc: route.desc,
        status: 'down',
        message: error.message,
        startedAt,
        channels: []
      });
    }

    const routeCandidates = Array.isArray(routeConfig.candidates) && routeConfig.candidates.length
      ? routeConfig.candidates
      : routeConfig.providers.map((provider, index) => ({
        provider,
        model: (routeConfig.modelOverridden || index === 0)
          ? (routeConfig.model || provider.defaultModel)
          : (provider.defaultModel || routeConfig.model),
        role: index === 0 ? 'primary' : 'fallback',
        timeoutMs: routeConfig.timeoutMs
      }));
    const checkedCandidates = routeCandidates.slice(0, MAX_HEALTH_CANDIDATES_PER_ROUTE);

    const channelResults = await Promise.all(
      checkedCandidates.map((candidate, index) => {
        const provider = candidate.provider || {};
        const role = index === 0 ? 'primary' : (candidate.role || 'pool');
        const model = candidate.model || provider.defaultModel || routeConfig.model;
        return RuntimeConfigService.testTextProvider({
          scope: route.scope,
          label: role === 'primary' ? route.label : `${route.label}${role === 'fallback' ? '备用' : '模型池'}`,
          model,
          provider,
          timeoutMs: Math.min(candidate.timeoutMs || routeConfig.timeoutMs || provider.timeoutMs || 30000, 30000),
          probeMessage: '请只回复 OK'
        }).then(result => normalizeChannelResult(result, provider, {
          role,
          fallbackIndex: role === 'fallback' ? index : 0,
          roleLabel: roleLabelForChannel(role, index),
          model
        }));
      })
    );
    const desc = routeCandidates.length > checkedCandidates.length
      ? `${route.desc} · 巡检前 ${checkedCandidates.length}/${routeCandidates.length} 个候选，运行时仍使用完整模型池`
      : route.desc;

    return makeRedundantRouteResult({
      type: 'text',
      scope: route.scope,
      label: route.label,
      desc,
      startedAt,
      channels: channelResults
    });
  }

  static async checkImageRoute(runtimeConfig) {
    const startedAt = Date.now();
    const candidates = this.resolveHealthCandidates(runtimeConfig, 'image', {
      category: 'image',
      providerId: runtimeConfig.imageProviderId,
      fallbackProviderIds: runtimeConfig.imageFallbackProviderIds,
      fallbackModels: runtimeConfig.imageFallbackModels,
      model: runtimeConfig.imageModel,
      timeoutMs: runtimeConfig.imageTimeoutMs
    }).filter(candidate => candidate.format === 'openai');
    const channels = candidates.length
      ? await Promise.all(candidates.slice(0, MAX_HEALTH_CANDIDATES_PER_ROUTE).map((candidate, index) => {
        const candidateConfig = RuntimeConfigService.imageRuntimeConfigFromCandidate(runtimeConfig, candidate);
        const role = index === 0 ? 'primary' : (candidate.role || 'pool');
        return RuntimeConfigService.testImageEndpoint(candidateConfig, 'primary')
          .then(result => normalizeChannelResult(result, candidate.provider || {}, {
            role,
            fallbackIndex: role === 'fallback' ? index : 0,
            roleLabel: roleLabelForChannel(role, index),
            model: candidate.model
          }))
          .catch(error => normalizeThrownChannelError(error, candidate.providerId, candidate.providerName, {
            role,
            fallbackIndex: role === 'fallback' ? index : 0,
            roleLabel: roleLabelForChannel(role, index),
            model: candidate.model
          }));
      }))
      : await this.checkLegacyImageChannels(runtimeConfig);
    const desc = candidates.length > MAX_HEALTH_CANDIDATES_PER_ROUTE
      ? `只检测图片生成接口连通性，不提交真实出图 · 巡检前 ${MAX_HEALTH_CANDIDATES_PER_ROUTE}/${candidates.length} 个候选`
      : '只检测图片生成接口连通性，不提交真实出图';

    return makeRedundantRouteResult({
      type: 'image',
      scope: 'image',
      label: '图片生成',
      desc,
      startedAt,
      channels
    });
  }

  static async checkVideoRoute(runtimeConfig) {
    const startedAt = Date.now();
    const candidates = this.resolveHealthCandidates(runtimeConfig, 'video', {
      category: 'video',
      providerId: runtimeConfig.videoProviderId,
      fallbackProviderIds: runtimeConfig.videoFallbackProviderIds,
      fallbackModels: runtimeConfig.videoFallbackModels,
      model: runtimeConfig.videoModel,
      timeoutMs: 300000
    });
    const channels = candidates.length
      ? await Promise.all(candidates.slice(0, MAX_HEALTH_CANDIDATES_PER_ROUTE).map((candidate, index) => {
        const candidateConfig = RuntimeConfigService.videoRuntimeConfigFromCandidate(runtimeConfig, candidate);
        const role = index === 0 ? 'primary' : (candidate.role || 'pool');
        return RuntimeConfigService.testVideoEndpoint(candidateConfig)
          .then(result => normalizeChannelResult(result, candidate.provider || {}, {
            role,
            fallbackIndex: role === 'fallback' ? index : 0,
            roleLabel: roleLabelForChannel(role, index),
            model: candidate.model
          }))
          .catch(error => normalizeThrownChannelError(error, candidate.providerId, candidate.providerName, {
            role,
            fallbackIndex: role === 'fallback' ? index : 0,
            roleLabel: roleLabelForChannel(role, index),
            model: candidate.model
          }));
      }))
      : [await RuntimeConfigService.testVideoEndpoint(runtimeConfig)
        .then(result => normalizeChannelResult(result, {
          id: runtimeConfig.videoProviderId,
          name: runtimeConfig.videoProviderName,
          format: runtimeConfig.videoProviderFormat
        }, {
          role: 'primary',
          model: runtimeConfig.videoModel
        }))
        .catch(error => normalizeThrownChannelError(error, 'video', '视频生成', {
          role: 'primary',
          model: runtimeConfig.videoModel
        }))];
    const desc = candidates.length > MAX_HEALTH_CANDIDATES_PER_ROUTE
      ? `只检测视频接口连通性，不提交真实视频任务 · 巡检前 ${MAX_HEALTH_CANDIDATES_PER_ROUTE}/${candidates.length} 个候选`
      : '只检测视频接口连通性，不提交真实视频任务';

    return makeRedundantRouteResult({
      type: 'video',
      scope: 'video',
      label: '视频生成',
      desc,
      startedAt,
      channels
    });
  }

  static resolveHealthCandidates(runtimeConfig, routeName, overrides = {}) {
    try {
      return RuntimeConfigService.resolveModelRoute(runtimeConfig, routeName, overrides).candidates || [];
    } catch (error) {
      return [];
    }
  }

  static async checkLegacyImageChannels(runtimeConfig) {
    const channels = [];
    const primary = await RuntimeConfigService.testImageEndpoint(runtimeConfig, 'primary')
      .then(result => normalizeChannelResult(result, {
        id: runtimeConfig.imageProviderId,
        name: runtimeConfig.imageProviderName,
        format: runtimeConfig.imageProviderFormat
      }, {
        role: 'primary',
        model: runtimeConfig.imageModel
      }))
      .catch(error => normalizeThrownChannelError(error, 'image', '图片生成', {
        role: 'primary',
        model: runtimeConfig.imageModel
      }));
    channels.push(primary);

    if (runtimeConfig.imageFailoverEnabled) {
      const fallback = await RuntimeConfigService.testImageEndpoint(runtimeConfig, 'fallback')
        .then(result => normalizeChannelResult(result, {
          id: 'image_fallback',
          name: '图片备用',
          format: 'openai'
        }, {
          role: 'fallback',
          fallbackIndex: 1,
          model: runtimeConfig.imageFallbackModel || runtimeConfig.imageModel
        }))
        .catch(error => normalizeThrownChannelError(error, 'image_fallback', '图片备用', {
          role: 'fallback',
          fallbackIndex: 1,
          model: runtimeConfig.imageFallbackModel || runtimeConfig.imageModel
        }));
      channels.push(fallback);
    }

    return channels;
  }
}

function createEmptySnapshot() {
  return {
    status: 'unknown',
    ok: false,
    running: false,
    scheduler_enabled: true,
    checked_at: '',
    next_check_at: '',
    interval_ms: CHECK_INTERVAL_MS,
    duration_ms: 0,
    message: '等待首次 AI 渠道巡检',
    summary: {
      total: 0,
      healthy: 0,
      degraded: 0,
      down: 0,
      available_channels: 0,
      total_channels: 0,
      failover_enabled: 0,
      failover_ready: 0,
      failover_active: 0,
      single_channel: 0
    },
    failover_policy: buildFailoverPolicy(true),
    checks: []
  };
}

function buildSnapshot({ reason, startedAt, schedulerEnabled = true, checks, error }) {
  const finishedAt = Date.now();
  const summary = summarizeChecks(checks);
  const status = error
    ? 'down'
    : (summary.total === 0 ? 'down'
    : (summary.down > 0 ? (summary.healthy > 0 || summary.degraded > 0 ? 'degraded' : 'down')
      : (summary.degraded > 0 ? 'degraded' : 'healthy')));
  const message = error
    ? `AI 渠道巡检失败：${error.message}`
    : (status === 'healthy'
      ? 'AI 渠道全部可用'
      : (status === 'degraded' ? '部分 AI 渠道异常，容灾状态需关注' : 'AI 渠道不可用'));

  return {
    status,
    ok: status !== 'down',
    running: false,
    reason,
    checked_at: new Date(finishedAt).toISOString(),
    scheduler_enabled: Boolean(schedulerEnabled),
    next_check_at: schedulerEnabled ? new Date(finishedAt + CHECK_INTERVAL_MS).toISOString() : '',
    interval_ms: CHECK_INTERVAL_MS,
    duration_ms: finishedAt - startedAt,
    message,
    summary,
    failover_policy: buildFailoverPolicy(schedulerEnabled),
    checks
  };
}

function summarizeChecks(checks = []) {
  return checks.reduce((summary, check) => {
    summary.total += 1;
    if (check.status === 'healthy') summary.healthy += 1;
    else if (check.status === 'degraded') summary.degraded += 1;
    else summary.down += 1;
    summary.available_channels += check.available_channels || 0;
    summary.total_channels += check.total_channels || 0;
    if (check.failover_enabled) summary.failover_enabled += 1;
    else summary.single_channel += 1;
    if (check.failover_ready) summary.failover_ready += 1;
    if (check.failover_state === 'active_failover') summary.failover_active += 1;
    return summary;
  }, {
    total: 0,
    healthy: 0,
    degraded: 0,
    down: 0,
    available_channels: 0,
    total_channels: 0,
    failover_enabled: 0,
    failover_ready: 0,
    failover_active: 0,
    single_channel: 0
  });
}

function makeRedundantRouteResult({ type, scope, label, desc, startedAt, channels }) {
  const normalizedChannels = (channels || []).map((channel, index) => ({
    ...channel,
    priority: index + 1,
    role_label: channel.role_label || roleLabelForChannel(channel.role, index)
  }));
  const available = normalizedChannels.filter(channel => channel.ok);
  const primary = normalizedChannels.find(channel => channel.role === 'primary') || normalizedChannels[0] || null;
  const fallbacks = normalizedChannels.filter(channel => channel.role !== 'primary');
  const healthyFallbacks = fallbacks.filter(channel => channel.ok);
  const activeChannel = primary?.ok ? primary : (healthyFallbacks[0] || available[0] || null);
  const failoverEnabled = fallbacks.length > 0;
  const failoverReady = healthyFallbacks.length > 0;
  let status = 'down';
  let message = `${label}不可用`;
  let failoverState = 'down';
  let switchReason = '';
  let nextAction = '检查主通道配置和供应商状态';

  if (!normalizedChannels.length) {
    message = `${label}未配置可检测通道`;
    failoverState = 'unconfigured';
    nextAction = '先在后台配置主通道';
  } else if (primary?.ok && !failoverEnabled) {
    status = 'healthy';
    message = `${label}主通道可用，未配置备用`;
    failoverState = type === 'video' ? 'monitor_only' : 'single';
    nextAction = type === 'video' ? '当前仅监控视频接口连通性' : '需要更高可用性时配置备用通道';
  } else if (primary?.ok && available.length === normalizedChannels.length) {
    status = 'healthy';
    message = `${label}主用正常，备用可接管`;
    failoverState = 'normal';
    nextAction = '无需处理';
  } else if (primary?.ok && available.length > 0) {
    status = 'degraded';
    message = failoverEnabled ? `${label}主用正常，但部分备用异常` : `${label}主通道可用`;
    failoverState = failoverEnabled ? 'fallback_impaired' : 'single';
    nextAction = failoverEnabled ? '修复异常备用通道，避免主用故障时无接管' : '可配置备用通道提升可用性';
  } else if (!primary?.ok && healthyFallbacks.length > 0) {
    status = 'degraded';
    message = `${label}主用异常，当前由备用接管`;
    failoverState = 'active_failover';
    switchReason = primary?.message || '主通道检测失败';
    nextAction = '运行时会优先使用健康备用，同时等待主用恢复';
  } else if (!primary?.ok && available.length > 0) {
    status = 'degraded';
    message = `${label}主用异常，存在可用通道`;
    failoverState = 'active_failover';
    switchReason = primary?.message || '主通道检测失败';
    nextAction = '检查通道配置顺序，确认可用通道是否可作为备用';
  } else {
    switchReason = primary?.message || available[0]?.message || '';
  }

  return makeRouteResult({
    type,
    scope,
    label,
    desc,
    status,
    message,
    startedAt,
    channels: normalizedChannels,
    primary,
    fallbacks,
    activeChannel,
    failoverEnabled,
    failoverReady,
    failoverState,
    switchReason,
    nextAction
  });
}

function makeRouteResult({
  type,
  scope,
  label,
  desc,
  status,
  message,
  startedAt,
  channels,
  primary = null,
  fallbacks = [],
  activeChannel = null,
  failoverEnabled = false,
  failoverReady = false,
  failoverState = 'unknown',
  switchReason = '',
  nextAction = ''
}) {
  const availableChannels = channels.filter(channel => channel.ok).length;
  return {
    type,
    scope,
    label,
    desc,
    status,
    ok: status !== 'down',
    message,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    available_channels: availableChannels,
    total_channels: channels.length,
    failover_enabled: Boolean(failoverEnabled),
    failover_ready: Boolean(failoverReady),
    failover_state: failoverState,
    strategy: buildRouteStrategy(type, failoverEnabled),
    switch_reason: switchReason,
    next_action: nextAction,
    active_role: activeChannel?.role || '',
    active_channel: activeChannel || null,
    primary: primary || null,
    fallbacks,
    healthy_fallback_channels: fallbacks.filter(channel => channel.ok).length,
    channels
  };
}

function normalizeChannelResult(result, provider = {}, extra = {}) {
  const role = extra.role || 'primary';
  return {
    role,
    role_label: extra.roleLabel || roleLabelForChannel(role, extra.fallbackIndex || 0),
    ok: Boolean(result?.ok),
    status: result?.ok ? 'healthy' : 'down',
    provider_id: result?.provider_id || provider.id || '',
    provider_name: result?.provider_name || provider.name || '',
    format: result?.format || provider.format || '',
    model: result?.model || extra.model || '',
    http_status: result?.status || null,
    latency_ms: result?.latency_ms || null,
    message: result?.message || (result?.ok ? '可用' : '检测失败'),
    detail: result?.detail || ''
  };
}

function normalizeThrownChannelError(error, providerId, providerName, extra = {}) {
  const role = extra.role || 'primary';
  return {
    role,
    role_label: extra.roleLabel || roleLabelForChannel(role, extra.fallbackIndex || 0),
    ok: false,
    status: 'down',
    provider_id: providerId || '',
    provider_name: providerName || '',
    format: '',
    model: extra.model || '',
    http_status: error?.response?.status || null,
    latency_ms: null,
    message: error?.message || '检测失败',
    detail: ''
  };
}

function buildFailoverPolicy(schedulerEnabled) {
  return {
    scheduler_enabled: Boolean(schedulerEnabled),
    interval_ms: CHECK_INTERVAL_MS,
    routing_hint_max_age_ms: ROUTING_HINT_MAX_AGE_MS,
    request_strategy: '主用异常且备用健康时，运行时优先走健康备用；巡检过期时恢复按配置顺序请求',
    retry_strategy: '请求失败时会继续尝试后续备用通道，适用于超时、限流、网络错误、5xx、鉴权或模型不可用等供应商异常'
  };
}

function buildRouteStrategy(type, failoverEnabled) {
  if (failoverEnabled) {
    return '模型池自动路由：按优先级和并发选择候选，主用失败或排队过久时继续尝试后续候选';
  }
  if (type === 'video') {
    return '仅连通性监控：当前视频生成未配置备用通道，不会自动切换';
  }
  return '单通道运行：未配置备用通道，主用异常时无法自动接管';
}

function roleLabelForChannel(role = 'primary', index = 0) {
  if (role === 'primary') return '主用';
  if (role === 'fallback') return `备用 ${Math.max(1, index)}`;
  return `模型池 ${Math.max(1, index + 1)}`;
}

module.exports = AiHealthMonitorService;
