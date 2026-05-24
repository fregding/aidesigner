/**
 * BaseAgent - 通用智能体核心框架
 * 核心循环: Reason → Act → Observe → Loop
 *
 * 支持:
 * - 多轮对话上下文
 * - 工具注册与执行
 * - 进度追踪与阶段管理
 * - 错误恢复策略
 */

const { EventEmitter } = require('events');

const MAX_ITERATIONS = 50;
const DEFAULT_TIMEOUT_MS = 120000;

class BaseAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'BaseAgent';
    this.maxIterations = options.maxIterations || MAX_ITERATIONS;
    this.defaultTimeout = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.tools = new Map();
    this.toolMetadata = new Map();
    this.context = {};
    this.history = [];
    this.iteration = 0;
    this.state = 'idle'; // idle, reasoning, acting, done, error
  }

  /**
   * 注册工具
   * @param {string} name - 工具名称
   * @param {Function|Object} fn - 工具函数，或 { handler, ...metadata }
   * @param {Object} metadata - 工具描述信息
   */
  registerTool(name, fn, metadata = {}) {
    if (fn && typeof fn === 'object' && typeof fn.handler === 'function') {
      this.tools.set(name, fn.handler);
      this.toolMetadata.set(name, this._normalizeToolMetadata(name, fn));
      return;
    }

    this.tools.set(name, fn);
    this.toolMetadata.set(name, this._normalizeToolMetadata(name, metadata));
  }

  /**
   * 注册多个工具
   * @param {Object} toolMap - { toolName: fn }
   */
  registerTools(toolMap) {
    for (const [name, fn] of Object.entries(toolMap)) {
      this.registerTool(name, fn);
    }
  }

  /**
   * 注册工具描述，不覆盖已有工具函数。
   * @param {Object} metadataMap - { toolName: metadata }
   */
  registerToolDescriptions(metadataMap = {}) {
    for (const [name, metadata] of Object.entries(metadataMap)) {
      this.toolMetadata.set(name, this._normalizeToolMetadata(name, metadata));
    }
  }

  /**
   * 获取已注册工具描述，可用于提示词、调试面板或执行日志。
   */
  getToolDescriptions() {
    return [...this.tools.keys()].map(name => (
      this.toolMetadata.get(name) || this._normalizeToolMetadata(name, {})
    ));
  }

  /**
   * 获取系统提示词（子类重写）
   */
  getSystemPrompt() {
    return `你是一个 AI 助手。`;
  }

  /**
   * 分析当前状态，决定下一步行动（子类重写）
   * @returns {{ action: string, params: Object, reasoning: string } | null}
   */
  async reason() {
    return null;
  }

  /**
   * 执行工具调用
   * @param {string} action - 工具名
   * @param {Object} params - 参数
   */
  async act(action, params = {}) {
    const tool = this.tools.get(action);
    if (!tool) {
      throw new Error(`未知工具: ${action}`);
    }

    this.state = 'acting';
    this.emit('acting', { action, params });

    const startTime = Date.now();
    try {
      const result = await Promise.race([
        tool({ params, context: this.context, agent: this }),
        this._timeoutPromise(this.defaultTimeout)
      ]);

      const duration = Date.now() - startTime;
      this.context.lastResult = result;
      this.context.lastAction = action;
      this.history.push({
        iteration: this.iteration,
        action,
        params,
        result,
        duration,
        timestamp: new Date().toISOString()
      });

      this.emit('actionComplete', { action, result, duration });
      return result;
    } catch (error) {
      this.state = 'error';
      this.context.lastError = error;
      this.history.push({
        iteration: this.iteration,
        action,
        params,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      this.emit('actionError', { action, error: error.message });
      throw error;
    }
  }

  /**
   * 观察结果，决定是否继续（子类重写）
   * @param {*} result - 上一步执行结果
   * @returns {{ continue: boolean, reason: string }}
   */
  observe(result) {
    return { continue: false, reason: '默认完成' };
  }

  /**
   * 核心循环：Reason → Act → Observe → Loop
   */
  async run(initialContext = {}) {
    this.context = { ...initialContext };
    this.history = [];
    this.iteration = 0;
    this.state = 'reasoning';

    this.emit('start', { context: this.context });

    try {
      while (this.iteration < this.maxIterations) {
        this.iteration++;

        // 1. Reason
        this.state = 'reasoning';
        this.emit('reasoning', { iteration: this.iteration });

        const plan = await this.reason();
        if (!plan) {
          this.state = 'done';
          this.emit('done', { reason: 'reasoning返回null，任务完成', history: this.history });
          return this.history;
        }

        const { action, params, reasoning } = plan;

        // 2. Act
        let result;
        try {
          result = await this.act(action, params);
        } catch (error) {
          // 尝试恢复或跳过
          const recovery = await this.handleError(action, error);
          if (recovery === 'skip') {
            this.emit('actionSkipped', { action, error: error.message });
            continue;
          } else if (recovery === 'retry' && plan.retryCount < 3) {
            plan.retryCount = (plan.retryCount || 0) + 1;
            continue;
          } else {
            throw error;
          }
        }

        // 3. Observe
        const observation = await this.observe(result);
        this.emit('observation', { iteration: this.iteration, result, observation });

        if (!observation.continue) {
          this.state = 'done';
          this.emit('done', { reason: observation.reason, history: this.history });
          return this.history;
        }
      }

      this.state = 'done';
      this.emit('done', { reason: '达到最大迭代次数', history: this.history });
      return this.history;
    } catch (error) {
      this.state = 'error';
      this.emit('error', { error: error.message, history: this.history });
      throw error;
    }
  }

  /**
   * 错误处理策略（子类可重写）
   */
  async handleError(action, error) {
    console.warn(`[${this.name}] 工具 ${action} 执行失败: ${error.message}`);
    return 'skip'; // 默认：跳过失败的步骤继续
  }

  /**
   * 添加对话消息到历史
   */
  addMessage(role, content) {
    this.history.push({ type: 'message', role, content, timestamp: new Date().toISOString() });
  }

  /**
   * 获取对话历史（用于发送给 LLM）
   */
  getConversationHistory() {
    return this.history
      .filter(h => h.type === 'message')
      .map(h => ({ role: h.role, content: h.content }));
  }

  /**
   * 超时 Promise
   */
  _timeoutPromise(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`操作超时 (${ms}ms)`)), ms);
    });
  }

  /**
   * 带超时的执行
   */
  async execWithTimeout(fn, ms = this.defaultTimeout) {
    return Promise.race([fn(), this._timeoutPromise(ms)]);
  }

  _normalizeToolMetadata(name, metadata = {}) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    return {
      name,
      userDescription: source.userDescription || source.description || '',
      modelDescription: source.modelDescription || source.userDescription || source.description || '',
      inputSchema: source.inputSchema || source.parameters || null,
      required: Boolean(source.required),
      category: source.category || ''
    };
  }
}

module.exports = BaseAgent;
