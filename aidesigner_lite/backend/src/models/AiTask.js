const { db } = require('./database');

class AiTask {
  static findById(id) {
    const stmt = db.prepare('SELECT * FROM ai_tasks WHERE id = ?');
    return stmt.get(id);
  }

  static findByIdForUser(id, userId) {
    const stmt = db.prepare('SELECT * FROM ai_tasks WHERE id = ? AND user_id = ?');
    return stmt.get(id, userId);
  }

  static findByUserId(userId, { type, status, limit = 20, offset = 0 } = {}) {
    let query = 'SELECT * FROM ai_tasks WHERE user_id = ?';
    const params = [userId];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  static create({ userId, type, prompt, params }) {
    const stmt = db.prepare(`
      INSERT INTO ai_tasks (user_id, type, prompt, params, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(userId, type, prompt, JSON.stringify(params));
    return this.findById(result.lastInsertRowid);
  }

  static findRecentFailedReferenceEdit(userId, requestSignature, minutes = 15) {
    if (!requestSignature) return null;

    const stmt = db.prepare(`
      SELECT *
      FROM ai_tasks
      WHERE user_id = ?
        AND type = 'image'
        AND status = 'failed'
        AND json_extract(params, '$._requestSignature') = ?
        AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(userId, requestSignature, `-${Math.max(parseInt(minutes, 10) || 15, 1)} minutes`);
  }

  static findCompletedImageTasksForPreviewMigration({ limit = 50, afterId = 0, includeConverted = false } = {}) {
    let query = `
      SELECT *
      FROM ai_tasks
      WHERE id > ?
        AND type = 'image'
        AND status = 'completed'
        AND result_data IS NOT NULL
    `;

    if (!includeConverted) {
      query += `
        AND (
          result_data LIKE '%"data_url"%'
          OR result_data NOT LIKE '%"preview_url"%'
        )
      `;
    }

    query += `
      ORDER BY id ASC
      LIMIT ?
    `;

    const stmt = db.prepare(query);
    return stmt.all(
      Math.max(parseInt(afterId, 10) || 0, 0),
      Math.max(parseInt(limit, 10) || 50, 1)
    );
  }

  static update(id, data) {
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        if (key === 'params' || key === 'result_data') {
          fields.push(`${key} = ?`);
          values.push(JSON.stringify(value));
        } else {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
    }

    if (fields.length === 0) return false;

    values.push(id);
    const stmt = db.prepare(`UPDATE ai_tasks SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.findById(id);
  }

  static updateStatus(id, status, additionalData = {}) {
    const data = { status, ...additionalData };
    if (status === 'completed' || status === 'failed') {
      data.completed_at = new Date().toISOString();
    }
    return this.update(id, data);
  }

  static deleteForUser(id, userId) {
    const task = this.findByIdForUser(id, userId);
    if (!task) return null;
    const stmt = db.prepare('DELETE FROM ai_tasks WHERE id = ? AND user_id = ?');
    stmt.run(id, userId);
    return task;
  }

  static renameForUser(id, userId, title) {
    const task = this.findByIdForUser(id, userId);
    if (!task) return null;
    const safeTitle = String(title || '').trim().slice(0, 80);
    if (!safeTitle) return null;

    const parseJson = value => {
      if (!value) return {};
      if (typeof value === 'object') return value;
      try {
        return JSON.parse(value);
      } catch (error) {
        return {};
      }
    };

    const params = { ...parseJson(task.params), title: safeTitle };
    const resultData = { ...parseJson(task.result_data), title: safeTitle };
    const stmt = db.prepare(`
      UPDATE ai_tasks
      SET params = ?, result_data = ?, prompt = ?
      WHERE id = ? AND user_id = ?
    `);
    stmt.run(JSON.stringify(params), JSON.stringify(resultData), safeTitle, id, userId);
    return this.findByIdForUser(id, userId);
  }

  static markInterruptedProcessingTasks() {
    const message = '任务已中断：后端服务重启后，后台进程已停止';
    const resultData = {
      status: 'failed',
      stage: 'interrupted',
      progress: 0,
      message,
      error: message
    };

    const stmt = db.prepare(`
      UPDATE ai_tasks
      SET status = 'failed',
          error_message = ?,
          result_data = ?,
          completed_at = ?
      WHERE status = 'processing'
    `);
    const result = stmt.run(message, JSON.stringify(resultData), new Date().toISOString());
    return result.changes;
  }

  static countByUser(userId) {
    const stmt = db.prepare('SELECT type, status, COUNT(*) as count FROM ai_tasks WHERE user_id = ? GROUP BY type, status');
    return stmt.all(userId);
  }
}

module.exports = AiTask;
