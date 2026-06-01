const crypto = require('crypto');
const AiCallLogService = require('./aiCallLogService');

const DEFAULT_QUEUE_TIMEOUT_MS = 8000;
const DEFAULT_COOLDOWN_MS = 30000;
const STICKY_TTL_MS = 2 * 60 * 60 * 1000;

class AiRouterService {
  static activeCounts = new Map();
  static stickyAssignments = new Map();
  static cooldowns = new Map();

  static candidateKey(candidate = {}) {
    const provider = candidate.provider || {};
    const id = String(candidate.qualifiedId || `${candidate.providerId || provider.id || ''}/${candidate.model || ''}`).trim();
    const baseUrl = String(provider.baseUrl || candidate.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(provider.apiKey || candidate.apiKey || '').trim();
    const configDigest = crypto
      .createHash('sha1')
      .update(`${baseUrl}\n${apiKey}`)
      .digest('hex')
      .slice(0, 10);
    return `${id}@${configDigest}`;
  }

  static activeCount(candidate = {}) {
    return this.activeCounts.get(this.candidateKey(candidate)) || 0;
  }

  static maxConcurrency(candidate = {}) {
    const value = parseInt(candidate.maxConcurrency ?? candidate.max_concurrency, 10);
    if (!Number.isFinite(value) || value <= 0) return Infinity;
    return value;
  }

  static isAtConcurrencyLimit(candidate = {}) {
    return this.activeCount(candidate) >= this.maxConcurrency(candidate);
  }

  static acquire(candidate = {}) {
    const key = this.candidateKey(candidate);
    if (!key || this.isAtConcurrencyLimit(candidate)) return null;
    this.activeCounts.set(key, this.activeCount(candidate) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.activeCounts.get(key) || 0) - 1);
      if (next > 0) this.activeCounts.set(key, next);
      else this.activeCounts.delete(key);
    };
  }

  static stickyKey({ route = '', userId = '', messages = [], params = {} } = {}) {
    const explicit = params?.sticky_key
      || params?.stickyKey
      || params?.conversation_id
      || params?.conversationId
      || params?.session_id
      || params?.sessionId
      || params?.thread_id
      || params?.threadId;
    if (explicit) return `${route || 'ai'}:${String(userId || 'anonymous')}:${String(explicit).slice(0, 160)}`;

    const firstUserMessages = (Array.isArray(messages) ? messages : [])
      .filter(message => message && message.role !== 'system')
      .slice(0, 4)
      .map(message => {
        const content = typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content || '');
        return `${message.role || 'user'}:${content.slice(0, 800)}`;
      })
      .join('\n');
    if (!firstUserMessages) return '';
    const digest = crypto.createHash('sha1').update(firstUserMessages).digest('hex').slice(0, 20);
    return `${route || 'ai'}:${String(userId || 'anonymous')}:${digest}`;
  }

  static cleanupState() {
    const now = Date.now();
    for (const [key, value] of this.stickyAssignments.entries()) {
      if (!value || now - (value.updatedAt || 0) > STICKY_TTL_MS) {
        this.stickyAssignments.delete(key);
      }
    }
    for (const [key, expiresAt] of this.cooldowns.entries()) {
      if (!expiresAt || expiresAt <= now) this.cooldowns.delete(key);
    }
  }

  static cooldownRemaining(candidate = {}) {
    const key = this.candidateKey(candidate);
    const expiresAt = this.cooldowns.get(key) || 0;
    return Math.max(0, expiresAt - Date.now());
  }

  static markCooldown(candidate = {}, error, cooldownMs = DEFAULT_COOLDOWN_MS) {
    const key = this.candidateKey(candidate);
    if (!key) return;
    const status = error?.response?.status;
    const code = String(error?.code || '').toUpperCase();
    const longer = [401, 403, 404].includes(status) ? 5 * 60 * 1000 : cooldownMs;
    const timeoutLike = ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code);
    this.cooldowns.set(key, Date.now() + (timeoutLike ? Math.max(cooldownMs, 60000) : longer));
  }

  static clearRoutingState({ sticky = true, cooldown = true } = {}) {
    if (sticky) this.stickyAssignments.clear();
    if (cooldown) this.cooldowns.clear();
  }

  static orderCandidates(candidates = [], stickyKey = '') {
    this.cleanupState();
    const normalized = (Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && candidate.provider && candidate.model)
      .map((candidate, index) => ({
        ...candidate,
        _orderIndex: Number.isInteger(candidate._orderIndex) ? candidate._orderIndex : index
      }));
    const sticky = stickyKey ? this.stickyAssignments.get(stickyKey) : null;

    return normalized.sort((left, right) => {
      const leftKey = this.candidateKey(left);
      const rightKey = this.candidateKey(right);
      const leftSticky = sticky?.candidateKey && sticky.candidateKey === leftKey ? -100000 : 0;
      const rightSticky = sticky?.candidateKey && sticky.candidateKey === rightKey ? -100000 : 0;
      const leftCooldown = this.cooldownRemaining(left) > 0 ? 10000 : 0;
      const rightCooldown = this.cooldownRemaining(right) > 0 ? 10000 : 0;
      const leftPriority = Number(left.priority ?? 100);
      const rightPriority = Number(right.priority ?? 100);
      return (leftSticky + leftCooldown + leftPriority) - (rightSticky + rightCooldown + rightPriority)
        || (Number(right.weight || 0) - Number(left.weight || 0))
        || left._orderIndex - right._orderIndex;
    });
  }

  static async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  static async waitForAvailable(candidates = [], queueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(0, queueTimeoutMs);
    while (Date.now() < deadline) {
      const available = candidates.find(candidate => !this.isAtConcurrencyLimit(candidate) && this.cooldownRemaining(candidate) <= 0);
      if (available) return available;
      await this.sleep(250);
    }
    return null;
  }

  static async withCandidate({
    route = 'ai',
    userId = '',
    messages = [],
    params = {},
    candidates = [],
    streamMode = '',
    queueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS,
    isRetryable = () => true,
    onAttempt = null
  }, handler) {
    const stickyKey = this.stickyKey({ route, userId, messages, params });
    let ordered = this.orderCandidates(candidates, stickyKey);
    if (!ordered.length) {
      throw new Error(`${route} 没有可用模型候选`);
    }

    let lastError = null;
    let attempted = 0;
    const requestId = AiCallLogService.newRequestId(route || 'ai');

    while (ordered.length) {
      const immediatelyAvailable = ordered.filter(candidate => this.cooldownRemaining(candidate) <= 0 && !this.isAtConcurrencyLimit(candidate));
      const nextCandidate = immediatelyAvailable[0] || await this.waitForAvailable(ordered, queueTimeoutMs);
      if (!nextCandidate) {
        const error = new Error(`${route} 所有模型都达到并发上限，请稍后重试`);
        error.code = 'AI_MODEL_POOL_BUSY';
        error.candidates = ordered.map(candidate => ({
          id: this.candidateKey(candidate),
          active: this.activeCount(candidate),
          maxConcurrency: this.maxConcurrency(candidate) === Infinity ? null : this.maxConcurrency(candidate)
        }));
        throw error;
      }

      ordered = ordered.filter(candidate => this.candidateKey(candidate) !== this.candidateKey(nextCandidate));
      const release = this.acquire(nextCandidate);
      if (!release) continue;
      attempted += 1;
      const attemptStartedAt = Date.now();
      const callLogId = AiCallLogService.start({
        requestId,
        route,
        userId,
        candidate: nextCandidate,
        attempt: attempted,
        streamMode
      });

      try {
        if (onAttempt) onAttempt(nextCandidate, { attempt: attempted });
        const result = await handler(nextCandidate, { attempt: attempted });
        AiCallLogService.finish(callLogId, {
          status: 'success',
          startedAt: attemptStartedAt,
          result
        });
        if (stickyKey) {
          this.stickyAssignments.set(stickyKey, {
            candidateKey: this.candidateKey(nextCandidate),
            updatedAt: Date.now(),
            route
          });
        }
        return result;
      } catch (error) {
        lastError = error;
        AiCallLogService.finish(callLogId, {
          status: 'failed',
          startedAt: attemptStartedAt,
          error
        });
        const retryable = isRetryable(error, nextCandidate);
        if (retryable) this.markCooldown(nextCandidate, error);
        if (!ordered.length || !retryable) {
          throw error;
        }
      } finally {
        release();
      }
    }

    throw lastError || new Error(`${route} 模型路由失败`);
  }

  static snapshot() {
    this.cleanupState();
    return {
      active: Object.fromEntries(this.activeCounts.entries()),
      sticky_count: this.stickyAssignments.size,
      cooldown_count: this.cooldowns.size
    };
  }
}

module.exports = AiRouterService;
