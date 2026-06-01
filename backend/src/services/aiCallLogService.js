const crypto = require('crypto');
const { db } = require('../models/database');

const AI_CALL_LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ai_call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    route TEXT,
    category TEXT,
    user_id TEXT,
    provider_id TEXT,
    provider_name TEXT,
    provider_format TEXT,
    model TEXT,
    role TEXT,
    qualified_id TEXT,
    stream_mode TEXT,
    status TEXT DEFAULT 'running' CHECK(status IN ('running', 'success', 'failed')),
    attempt INTEGER DEFAULT 1,
    latency_ms INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    error_code TEXT,
    http_status INTEGER,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE INDEX IF NOT EXISTS idx_ai_call_logs_created ON ai_call_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_call_logs_status ON ai_call_logs(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_call_logs_route ON ai_call_logs(route, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_call_logs_provider ON ai_call_logs(provider_id, model, created_at DESC);
`;

class AiCallLogService {
  static initialized = false;

  static init() {
    if (this.initialized) return;
    db.exec(AI_CALL_LOG_TABLE_SQL);
    this.initialized = true;
  }

  static newRequestId(route = 'ai') {
    const prefix = String(route || 'ai').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 24) || 'ai';
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  }

  static start({ requestId, route, userId, candidate = {}, attempt = 1, streamMode = '' } = {}) {
    try {
      this.ensureSchema();
      const provider = candidate.provider || {};
      const info = {
        request_id: requestId || this.newRequestId(route),
        route: String(route || candidate.route || '').trim(),
        category: String(candidate.category || '').trim(),
        user_id: userId === undefined || userId === null ? '' : String(userId),
        provider_id: String(candidate.providerId || provider.id || '').trim(),
        provider_name: String(candidate.providerName || provider.name || '').trim(),
        provider_format: String(candidate.format || provider.format || '').trim(),
        model: String(candidate.model || provider.defaultModel || provider.model || '').trim(),
        role: String(candidate.role || '').trim(),
        qualified_id: String(candidate.qualifiedId || '').trim(),
        stream_mode: this.normalizeStreamMode(streamMode),
        attempt: parseInt(attempt, 10) || 1,
        created_at: this.nowSql()
      };
      const result = db.prepare(`
        INSERT INTO ai_call_logs (
          request_id, route, category, user_id,
          provider_id, provider_name, provider_format,
          model, role, qualified_id, stream_mode, attempt, status, created_at
        )
        VALUES (
          @request_id, @route, @category, @user_id,
          @provider_id, @provider_name, @provider_format,
          @model, @role, @qualified_id, @stream_mode, @attempt, 'running', @created_at
        )
      `).run(info);
      return result.lastInsertRowid;
    } catch (error) {
      console.warn('[AiCallLogService] start failed:', error.message);
      return null;
    }
  }

  static finish(logId, { status = 'success', startedAt = 0, result = null, error = null } = {}) {
    if (!logId) return;
    try {
      this.init();
      const usage = result?.usage || result?.data?.usage || {};
      const responseStatus = error?.response?.status;
      const latencyMs = startedAt ? Math.max(0, Date.now() - startedAt) : null;
      const payload = {
        id: logId,
        status: status === 'failed' ? 'failed' : 'success',
        latency_ms: latencyMs,
        prompt_tokens: this.safeInt(usage.prompt_tokens ?? usage.input_tokens),
        completion_tokens: this.safeInt(usage.completion_tokens ?? usage.output_tokens),
        total_tokens: this.safeInt(usage.total_tokens),
        error_code: error?.code ? String(error.code).slice(0, 80) : '',
        http_status: Number.isFinite(Number(responseStatus)) ? Number(responseStatus) : null,
        error_message: error?.message ? String(error.message).slice(0, 500) : '',
        completed_at: this.nowSql()
      };
      db.prepare(`
        UPDATE ai_call_logs
        SET status = @status,
            latency_ms = @latency_ms,
            prompt_tokens = @prompt_tokens,
            completion_tokens = @completion_tokens,
            total_tokens = @total_tokens,
            error_code = @error_code,
            http_status = @http_status,
            error_message = @error_message,
            completed_at = @completed_at
        WHERE id = @id
      `).run(payload);
    } catch (finishError) {
      console.warn('[AiCallLogService] finish failed:', finishError.message);
    }
  }

  static safeInt(value) {
    const number = parseInt(value, 10);
    return Number.isFinite(number) ? number : null;
  }

  static normalizeStreamMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['stream', 'streaming', 'true', '1'].includes(normalized)) return 'stream';
    if (['non_stream', 'non-stream', 'nostream', 'false', '0'].includes(normalized)) return 'non_stream';
    return '';
  }

  static ensureSchema() {
    this.init();
    const columns = db.prepare('PRAGMA table_info(ai_call_logs)').all().map(row => row.name);
    if (!columns.includes('stream_mode')) {
      db.exec('ALTER TABLE ai_call_logs ADD COLUMN stream_mode TEXT');
    }
  }

  static nowSql() {
    const d = new Date();
    const pad = value => String(value).padStart(2, '0');
    return [
      d.getFullYear(),
      pad(d.getMonth() + 1),
      pad(d.getDate())
    ].join('-') + ' ' + [
      pad(d.getHours()),
      pad(d.getMinutes()),
      pad(d.getSeconds())
    ].join(':');
  }

  static list({ limit = 80, route = '', status = '' } = {}) {
    this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 80, 300));
    const conditions = [];
    const params = {};
    if (route) {
      conditions.push('route = @route');
      params.route = String(route);
    }
    if (status) {
      conditions.push('status = @status');
      params.status = String(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`
      SELECT *
      FROM ai_call_logs
      ${where}
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ${safeLimit}
    `).all(params);
  }

  static summary({ minutes = 1440 } = {}) {
    this.ensureSchema();
    const windowMinutes = Math.max(1, Math.min(parseInt(minutes, 10) || 1440, 10080));
    const sinceModifier = `-${windowMinutes} minutes`;
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) AS avg_latency_ms,
        SUM(COALESCE(total_tokens, 0)) AS total_tokens
      FROM ai_call_logs
      WHERE datetime(created_at) >= datetime('now', 'localtime', ?)
    `).get(sinceModifier);
    const byRoute = db.prepare(`
      SELECT route, COUNT(*) AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) AS avg_latency_ms
      FROM ai_call_logs
      WHERE datetime(created_at) >= datetime('now', 'localtime', ?)
      GROUP BY route
      ORDER BY total DESC
      LIMIT 12
    `).all(sinceModifier);
    const byModel = db.prepare(`
      SELECT provider_name, provider_id, model, COUNT(*) AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             AVG(CASE WHEN status = 'success' THEN latency_ms ELSE NULL END) AS avg_latency_ms
      FROM ai_call_logs
      WHERE datetime(created_at) >= datetime('now', 'localtime', ?)
      GROUP BY provider_id, model
      ORDER BY total DESC
      LIMIT 12
    `).all(sinceModifier);
    return {
      window_minutes: windowMinutes,
      totals,
      by_route: byRoute,
      by_model: byModel
    };
  }

  static markInterruptedRunningCalls(message = '后端服务重启后，AI 调用已中断') {
    this.ensureSchema();
    const completedAt = this.nowSql();
    const result = db.prepare(`
      UPDATE ai_call_logs
      SET status = 'failed',
          completed_at = @completed_at,
          latency_ms = CASE
            WHEN latency_ms IS NULL THEN MAX(0, CAST((julianday(@completed_at) - julianday(created_at)) * 86400000 AS INTEGER))
            ELSE latency_ms
          END,
          error_code = CASE
            WHEN COALESCE(error_code, '') = '' THEN 'PROCESS_INTERRUPTED'
            ELSE error_code
          END,
          error_message = CASE
            WHEN COALESCE(error_message, '') = '' THEN @message
            ELSE error_message
          END
      WHERE status = 'running'
    `).run({
      completed_at: completedAt,
      message: String(message || '').slice(0, 500)
    });
    return result.changes || 0;
  }
}

AiCallLogService.init();

module.exports = AiCallLogService;
