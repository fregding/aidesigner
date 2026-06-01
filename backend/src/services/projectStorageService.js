const fs = require('fs');
const path = require('path');

const { db } = require('../models/database');
const AiTask = require('../models/AiTask');
const File = require('../models/File');
const appConfig = require('../config/appConfig');

const PREVIEW_CACHE_ROOTS = [
  'visual_previews',
  'converted_previews',
  'spreadsheet_previews',
  'assistant_previews'
];
const TASK_SCOPED_ROOTS = new Set(['videos', 'video-audio-normalized']);
const UPLOAD_URL_RE = /\/uploads\/[^\s"'<>\\),\]]+/g;

function safeParseJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string' && /^[\[{]/.test(parsed.trim())) {
      return safeParseJson(parsed, parsed);
    }
    return parsed;
  } catch (error) {
    return fallback;
  }
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function trimUploadUrlCandidate(value) {
  return String(value || '')
    .trim()
    .replace(/[.,;:!?]+$/g, '')
    .replace(/[)\]}]+$/g, '');
}

function normalizeUploadUrl(value) {
  let text = trimUploadUrlCandidate(value);
  if (!text || /^data:/i.test(text)) return '';

  try {
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      text = `${parsed.pathname}${parsed.search || ''}`;
    }
  } catch (error) {
    return '';
  }

  text = text.split('#')[0].split('?')[0];
  return text.startsWith('/uploads/') ? text : '';
}

function extractUploadUrlsFromString(value) {
  const text = String(value || '').trim();
  if (!text) return [];

  const urls = new Set();
  const direct = normalizeUploadUrl(text);
  if (direct) urls.add(direct);

  for (const match of text.matchAll(UPLOAD_URL_RE)) {
    const normalized = normalizeUploadUrl(match[0]);
    if (normalized) urls.add(normalized);
  }

  return [...urls];
}

function collectReferences(value, refs = { values: [], uploadUrls: new Set(), fileIds: new Set() }) {
  if (value === null || value === undefined) return refs;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return refs;
    refs.values.push(text);
    extractUploadUrlsFromString(text).forEach(url => refs.uploadUrls.add(url));
    if (/^[\[{]/.test(text)) {
      const parsed = safeParseJson(text, null);
      if (parsed && parsed !== text) collectReferences(parsed, refs);
    }
    return refs;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectReferences(item, refs));
    return refs;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['fileId', 'file_id', 'sourceFileId', 'source_file_id'].includes(key)) {
        const id = parsePositiveInteger(child);
        if (id) refs.fileIds.add(id);
      }
      collectReferences(child, refs);
    }

    const explicitFileId = parsePositiveInteger(value.fileId || value.file_id || value.sourceFileId || value.source_file_id);
    if (explicitFileId) refs.fileIds.add(explicitFileId);
  }

  return refs;
}

function resolveUploadCleanupPath(value) {
  const text = String(value || '').trim();
  if (!text || /^data:/i.test(text)) return null;

  try {
    const uploadUrl = normalizeUploadUrl(text);
    const safePath = uploadUrl
      ? appConfig.uploadUrlToPath(uploadUrl)
      : appConfig.assertInsideUploadDir(text);
    const uploadRoot = path.resolve(appConfig.uploadDir);
    const resolvedPath = path.resolve(safePath);
    if (resolvedPath === uploadRoot) return null;
    return resolvedPath;
  } catch (error) {
    return null;
  }
}

function uploadRelativeParts(safePath) {
  const uploadRoot = path.resolve(appConfig.uploadDir);
  const resolvedPath = path.resolve(safePath);
  const relative = path.relative(uploadRoot, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  return relative.split(path.sep).filter(Boolean);
}

function pathBelongsToContext(safePath, context = {}) {
  const userId = String(context.userId || '').trim();
  const taskIds = context.taskIds || new Set();
  const parts = uploadRelativeParts(safePath);
  if (!parts.length || !userId) return false;

  if (parts[0] === userId) return true;
  if (parts[0] === 'ppt' && parts[1] === userId) return true;
  if (PREVIEW_CACHE_ROOTS.includes(parts[0]) && parts[1] === userId) return true;
  if (parts[0] === 'documents' && parts[1] === userId) return true;
  if (TASK_SCOPED_ROOTS.has(parts[0]) && taskIds.has(parts[1])) return true;
  return false;
}

function createPlan({ userId, taskIds = [] } = {}) {
  return {
    userId: String(userId || ''),
    taskIds: new Set(taskIds.map(id => String(id || '')).filter(Boolean)),
    files: new Map(),
    paths: new Map(),
    warnings: []
  };
}

function addPathToPlan(plan, value, reason) {
  const safePath = resolveUploadCleanupPath(value);
  if (!safePath) return false;

  const context = { userId: plan.userId, taskIds: plan.taskIds };
  if (!pathBelongsToContext(safePath, context)) {
    plan.warnings.push({ path: safePath, reason: 'out_of_scope' });
    return false;
  }

  const existing = plan.paths.get(safePath);
  if (existing) {
    existing.reasons.add(reason);
  } else {
    plan.paths.set(safePath, {
      path: safePath,
      reasons: new Set([reason])
    });
  }
  return true;
}

function addFilePreviewCacheDirs(plan, file) {
  const fileId = parsePositiveInteger(file?.id);
  const userId = parsePositiveInteger(file?.user_id);
  if (!fileId || !userId) return;

  PREVIEW_CACHE_ROOTS.forEach(rootName => {
    addPathToPlan(
      plan,
      path.join(appConfig.uploadDir, rootName, String(userId), String(fileId)),
      `${rootName}:${fileId}`
    );
  });
}

function addFileToPlan(plan, file) {
  if (!file) return;
  const fileId = parsePositiveInteger(file.id);
  if (fileId && !plan.files.has(fileId)) {
    plan.files.set(fileId, file);
  }
  addPathToPlan(plan, file.path, `file:${fileId || 'path'}`);
  addPathToPlan(plan, file.url, `file-url:${fileId || 'url'}`);
  addFilePreviewCacheDirs(plan, file);
}

function findFilesByIds(userId, ids) {
  const uniqueIds = [...new Set([...ids].map(parsePositiveInteger).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const find = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?');
  return uniqueIds
    .map(id => find.get(id, userId))
    .filter(Boolean);
}

function findFilesByUploadUrls(userId, uploadUrls) {
  const uniqueUrls = [...new Set([...uploadUrls].map(normalizeUploadUrl).filter(Boolean))];
  if (!uniqueUrls.length) return [];

  const files = new Map();
  const findByUrl = db.prepare('SELECT * FROM files WHERE user_id = ? AND url = ?');
  const findByPath = db.prepare('SELECT * FROM files WHERE user_id = ? AND path = ?');

  uniqueUrls.forEach(uploadUrl => {
    const byUrl = findByUrl.get(userId, uploadUrl);
    if (byUrl) files.set(byUrl.id, byUrl);

    const safePath = resolveUploadCleanupPath(uploadUrl);
    if (safePath) {
      const byPath = findByPath.get(userId, safePath);
      if (byPath) files.set(byPath.id, byPath);
    }
  });

  return [...files.values()];
}

function addExistingChildrenByPrefix(plan, dirPath, prefix, reason) {
  try {
    const safeDir = appConfig.assertInsideUploadDir(dirPath);
    if (!fs.existsSync(safeDir) || !fs.statSync(safeDir).isDirectory()) return;
    fs.readdirSync(safeDir)
      .filter(name => name.startsWith(prefix))
      .forEach(name => addPathToPlan(plan, path.join(safeDir, name), reason));
  } catch (error) {
    plan.warnings.push({ path: dirPath, reason: error.message });
  }
}

function addTaskGeneratedPaths(plan, task) {
  const taskId = String(task?.id || '');
  const userId = String(task?.user_id || '');
  if (!taskId || !userId) return;

  addExistingChildrenByPrefix(
    plan,
    path.join(appConfig.uploadDir, 'ppt', userId),
    `${taskId}_`,
    `ppt-project:${taskId}`
  );
  addPathToPlan(plan, path.join(appConfig.uploadDir, 'videos', taskId), `video:${taskId}`);
  addPathToPlan(plan, path.join(appConfig.uploadDir, 'video-audio-normalized', taskId), `video-audio:${taskId}`);

  const userDir = path.join(appConfig.uploadDir, userId);
  addExistingChildrenByPrefix(plan, userDir, `${taskId}_`, `generated-image:${taskId}`);
  addPathToPlan(plan, path.join(userDir, `${taskId}.json`), `generated-json:${taskId}`);
  addExistingChildrenByPrefix(plan, path.join(userDir, 'previews'), `${taskId}_`, `generated-image-preview:${taskId}`);
}

function addTaskReferencesToPlan(plan, task) {
  const refs = collectReferences(task.result_url);
  collectReferences(safeParseJson(task.result_data, null), refs);
  collectReferences(safeParseJson(task.params, null), refs);
  const resultData = safeParseJson(task.result_data, {}) || {};
  const params = safeParseJson(task.params, {}) || {};

  refs.values.forEach(value => addPathToPlan(plan, value, `task-reference:${task.id}`));
  refs.uploadUrls.forEach(url => addPathToPlan(plan, url, `task-upload-url:${task.id}`));

  findFilesByIds(task.user_id, refs.fileIds).forEach(file => addFileToPlan(plan, file));
  findFilesByUploadUrls(task.user_id, refs.uploadUrls).forEach(file => addFileToPlan(plan, file));

  [
    resultData.file_id,
    resultData.fileId,
    resultData.source_file_id,
    resultData.sourceFileId,
    params.source_file_id,
    params.sourceFileId
  ].map(parsePositiveInteger)
    .filter(Boolean)
    .forEach(fileId => refs.fileIds.add(fileId));

  findFilesByIds(task.user_id, refs.fileIds).forEach(file => addFileToPlan(plan, file));
}

function addTaskToPlan(plan, task) {
  if (!task) return;
  plan.taskIds.add(String(task.id));
  File.findByTaskId(task.id).forEach(file => addFileToPlan(plan, file));
  addTaskReferencesToPlan(plan, task);
  addTaskGeneratedPaths(plan, task);
}

function finalizePlan(plan) {
  return {
    userId: plan.userId,
    taskIds: [...plan.taskIds],
    fileIds: [...plan.files.keys()],
    paths: [...plan.paths.values()]
      .map(item => ({ path: item.path, reasons: [...item.reasons] }))
      .sort((a, b) => b.path.length - a.path.length),
    warnings: plan.warnings
  };
}

function pathSize(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) return stat.size || 0;
    return fs.readdirSync(targetPath).reduce((total, name) => total + pathSize(path.join(targetPath, name)), 0);
  } catch (error) {
    return 0;
  }
}

function deleteFileRowsByIds(fileIds) {
  const ids = [...new Set(fileIds.map(parsePositiveInteger).filter(Boolean))];
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...ids).changes;
}

class ProjectStorageService {
  static buildTaskCleanupPlan(task) {
    const plan = createPlan({ userId: task?.user_id, taskIds: [task?.id] });
    addTaskToPlan(plan, task);
    return finalizePlan(plan);
  }

  static buildFileCleanupPlan(file) {
    const plan = createPlan({ userId: file?.user_id, taskIds: file?.task_id ? [file.task_id] : [] });
    addFileToPlan(plan, file);
    return finalizePlan(plan);
  }

  static buildUserCleanupPlan(userId) {
    const tasks = db.prepare('SELECT * FROM ai_tasks WHERE user_id = ?').all(userId);
    const taskIds = tasks.map(task => task.id);
    const plan = createPlan({ userId, taskIds });

    tasks.forEach(task => addTaskToPlan(plan, task));
    db.prepare('SELECT * FROM files WHERE user_id = ?').all(userId).forEach(file => addFileToPlan(plan, file));

    const userKey = String(userId);
    addPathToPlan(plan, path.join(appConfig.uploadDir, userKey), `user-root:${userKey}`);
    addPathToPlan(plan, path.join(appConfig.uploadDir, 'ppt', userKey), `user-ppt-root:${userKey}`);
    addPathToPlan(plan, path.join(appConfig.uploadDir, 'documents', userKey), `user-documents-root:${userKey}`);
    PREVIEW_CACHE_ROOTS.forEach(rootName => {
      addPathToPlan(plan, path.join(appConfig.uploadDir, rootName, userKey), `user-cache:${rootName}`);
    });

    return finalizePlan(plan);
  }

  static removeCleanupPlan(plan) {
    const paths = Array.isArray(plan?.paths) ? plan.paths : [];
    const summary = {
      removed: 0,
      skipped: 0,
      removed_bytes: 0,
      errors: []
    };

    paths.forEach(item => {
      const safePath = appConfig.assertInsideUploadDir(item.path || item);
      try {
        if (!fs.existsSync(safePath)) {
          summary.skipped += 1;
          return;
        }
        summary.removed_bytes += pathSize(safePath);
        fs.rmSync(safePath, { recursive: true, force: true });
        summary.removed += 1;
      } catch (error) {
        summary.errors.push({ path: safePath, error: error.message });
      }
    });

    if (summary.errors.length) {
      const error = new Error(`有 ${summary.errors.length} 个上传资源删除失败`);
      error.cleanup = summary;
      throw error;
    }

    return summary;
  }

  static deleteTaskForUser(taskId, userId) {
    const task = AiTask.findByIdForUser(taskId, userId);
    if (!task) return null;

    const plan = this.buildTaskCleanupPlan(task);
    const cleanup = this.removeCleanupPlan(plan);
    const transaction = db.transaction(() => {
      deleteFileRowsByIds(plan.fileIds);
      db.prepare('DELETE FROM files WHERE task_id = ?').run(task.id);
      db.prepare('DELETE FROM ai_tasks WHERE id = ? AND user_id = ?').run(task.id, userId);
    });
    transaction();

    return { task, cleanup, plan };
  }

  static deleteAdminRecord(recordId) {
    const task = AiTask.findById(recordId);
    if (!task) return null;

    const plan = this.buildTaskCleanupPlan(task);
    const cleanup = this.removeCleanupPlan(plan);
    const transaction = db.transaction(() => {
      deleteFileRowsByIds(plan.fileIds);
      db.prepare('DELETE FROM files WHERE task_id = ?').run(task.id);
      db.prepare('DELETE FROM ai_tasks WHERE id = ?').run(task.id);
    });
    transaction();

    return { task, cleanup, plan };
  }

  static deleteFileForUser(fileId, userId) {
    const file = File.findById(fileId);
    if (!file) return null;
    if (String(file.user_id) !== String(userId)) {
      const error = new Error('无权删除此文件');
      error.statusCode = 403;
      throw error;
    }

    const plan = this.buildFileCleanupPlan(file);
    const cleanup = this.removeCleanupPlan(plan);
    File.delete(file.id);
    return { file, cleanup, plan };
  }

  static deleteUserStorage(userId) {
    const plan = this.buildUserCleanupPlan(userId);
    const cleanup = this.removeCleanupPlan(plan);
    return { cleanup, plan };
  }
}

module.exports = ProjectStorageService;
