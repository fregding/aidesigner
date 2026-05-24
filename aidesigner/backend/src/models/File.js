const { db } = require('./database');

class File {
  static buildAdminWhere({ userId = '', type = '', search = '' } = {}) {
    const where = [];
    const params = [];
    const typeExpr = `
      CASE
        WHEN f.mime_type LIKE 'image/%' THEN 'image'
        WHEN f.mime_type LIKE 'video/%' THEN 'video'
        WHEN f.mime_type IN (
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ) THEN 'document'
        ELSE 'other'
      END
    `;

    if (userId) {
      where.push('f.user_id = ?');
      params.push(userId);
    }
    if (type && ['image', 'video', 'document', 'other'].includes(type)) {
      where.push(`${typeExpr} = ?`);
      params.push(type);
    }
    if (search) {
      where.push(`(
        f.filename LIKE ?
        OR f.original_name LIKE ?
        OR f.mime_type LIKE ?
        OR u.username LIKE ?
        OR u.email LIKE ?
      )`);
      const keyword = `%${search}%`;
      params.push(keyword, keyword, keyword, keyword, keyword);
    }

    return {
      whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params
    };
  }

  static findById(id) {
    const stmt = db.prepare('SELECT * FROM files WHERE id = ?');
    return stmt.get(id);
  }

  static findAll({ limit = 50, offset = 0, userId = '', type = '', search = '' } = {}) {
    const { whereSql, params } = this.buildAdminWhere({ userId, type, search });
    const stmt = db.prepare(`
      SELECT f.*,
             u.username as owner_username,
             u.email as owner_email,
             u.role as owner_role
      FROM files f
      LEFT JOIN users u ON u.id = f.user_id
      ${whereSql}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(...params, limit, offset);
  }

  static findByUserId(userId, { limit = 50, offset = 0 } = {}) {
    const stmt = db.prepare('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?');
    return stmt.all(userId, limit, offset);
  }

  static findByTaskId(taskId) {
    const stmt = db.prepare('SELECT * FROM files WHERE task_id = ?');
    return stmt.all(taskId);
  }

  static create({ userId, taskId, filename, originalName, mimeType, size, path, url }) {
    const stmt = db.prepare(`
      INSERT INTO files (user_id, task_id, filename, original_name, mime_type, size, path, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(userId, taskId || null, filename, originalName, mimeType, size, path, url);
    return this.findById(result.lastInsertRowid);
  }

  static delete(id) {
    const file = this.findById(id);
    if (!file) return false;

    const stmt = db.prepare('DELETE FROM files WHERE id = ?');
    stmt.run(id);
    return file;
  }

  static getTotalSize(userId) {
    const stmt = db.prepare('SELECT SUM(size) as total FROM files WHERE user_id = ?');
    const result = stmt.get(userId);
    return result.total || 0;
  }

  static getTotalSizeAll({ userId = '', type = '', search = '' } = {}) {
    const { whereSql, params } = this.buildAdminWhere({ userId, type, search });
    const stmt = db.prepare(`
      SELECT SUM(f.size) as total
      FROM files f
      LEFT JOIN users u ON u.id = f.user_id
      ${whereSql}
    `);
    const result = stmt.get(...params);
    return result.total || 0;
  }

  static countByUser(userId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM files WHERE user_id = ?');
    return stmt.get(userId).count;
  }

  static countAll({ userId = '', type = '', search = '' } = {}) {
    const { whereSql, params } = this.buildAdminWhere({ userId, type, search });
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM files f
      LEFT JOIN users u ON u.id = f.user_id
      ${whereSql}
    `);
    return stmt.get(...params).count;
  }
}

module.exports = File;
