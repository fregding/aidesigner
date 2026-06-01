const fs = require('fs');
const path = require('path');

const { db } = require('../models/database');
const User = require('../models/User');
const File = require('../models/File');
const appConfig = require('../config/appConfig');
const ProjectStorageService = require('./projectStorageService');

const FREE_LIMITS = {
  image: 10,
  ppt: 3
};

let cleanupTimer = null;

function safeParseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function toUploadPath(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  try {
    return appConfig.uploadUrlToPath(url);
  } catch (error) {
    return null;
  }
}

function removeFilePath(filePath) {
  if (!filePath) return false;
  try {
    const safePath = appConfig.assertInsideUploadDir(filePath);
    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      fs.unlinkSync(safePath);
      return true;
    }
  } catch (error) {
    return false;
  }
  return false;
}

function removeUploadUrl(url) {
  const filePath = toUploadPath(url);
  return removeFilePath(filePath);
}

function removeUploadDirectoryUrl(url) {
  const dirPath = toUploadPath(url);
  if (!dirPath) return false;
  try {
    const safePath = appConfig.assertInsideUploadDir(dirPath);
    if (fs.existsSync(safePath) && fs.statSync(safePath).isDirectory()) {
      fs.rmSync(safePath, { recursive: true, force: true });
      return true;
    }
  } catch (error) {
    return false;
  }
  return false;
}

function removeFileRecordsForTask(taskId) {
  const files = File.findByTaskId(taskId);
  files.forEach(file => {
    removeFilePath(file.path);
    File.delete(file.id);
  });
  return files.length;
}

function deleteFileRecordsByUrls(userId, urls = []) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  if (!uniqueUrls.length) return 0;

  const find = db.prepare('SELECT id, path FROM files WHERE user_id = ? AND url = ?');
  let removed = 0;
  uniqueUrls.forEach(url => {
    const record = find.get(userId, url);
    if (!record) return;
    removeFilePath(record.path);
    File.delete(record.id);
    removed += 1;
  });
  return removed;
}

function imageUrls(image) {
  if (!image || typeof image !== 'object') return [];
  return [
    image.url,
    image.data_url,
    image.dataUrl,
    image.preview_url,
    image.previewUrl,
    image.thumbnail_url
  ].filter(url => typeof url === 'string' && url.startsWith('/uploads/'));
}

class StorageLimitService {
  static limits() {
    return { ...FREE_LIMITS };
  }

  static hasUnlimitedStorage(user) {
    return User.hasUnlimitedStorage(user);
  }

  static getUserStorageSummary(userId) {
    const user = User.refreshVipStatus(userId);
    const unlimited = this.hasUnlimitedStorage(user);
    return {
      unlimited,
      role: user?.role || 'user',
      vip_expires_at: user?.vip_expires_at || null,
      limits: unlimited
        ? { image: null, ppt: null }
        : this.limits(),
      usage: {
        image: this.countSavedImages(userId),
        ppt: this.countSavedPpts(userId)
      }
    };
  }

  static countSavedImages(userId) {
    const rows = db.prepare(`
      SELECT result_data
      FROM ai_tasks
      WHERE user_id = ?
        AND type = 'image'
        AND status = 'completed'
      ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
    `).all(userId);

    return rows.reduce((total, row) => {
      const resultData = safeParseJson(row.result_data, {});
      const images = Array.isArray(resultData.images) ? resultData.images : [];
      return total + images.length;
    }, 0);
  }

  static countSavedPpts(userId) {
    return db.prepare(`
      SELECT COUNT(*) AS count
      FROM ai_tasks
      WHERE user_id = ?
        AND type = 'ppt'
        AND status = 'completed'
        AND COALESCE(result_url, '') != ''
    `).get(userId).count || 0;
  }

  static enforceForUser(userId) {
    const user = User.refreshVipStatus(userId);
    if (!user || this.hasUnlimitedStorage(user)) {
      return this.getUserStorageSummary(userId);
    }

    this.pruneImages(userId, FREE_LIMITS.image);
    this.prunePpts(userId, FREE_LIMITS.ppt);
    return this.getUserStorageSummary(userId);
  }

  static pruneImages(userId, limit = FREE_LIMITS.image) {
    const rows = db.prepare(`
      SELECT id, result_data, result_url
      FROM ai_tasks
      WHERE user_id = ?
        AND type = 'image'
        AND status = 'completed'
      ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
    `).all(userId);

    const update = db.prepare(`
      UPDATE ai_tasks
      SET result_data = ?, result_url = ?
      WHERE id = ?
    `);

    let keptCount = 0;
    let removedCount = 0;

    rows.forEach(task => {
      const resultData = safeParseJson(task.result_data, {});
      const images = Array.isArray(resultData.images) ? resultData.images : [];
      if (!images.length) return;

      const keptImages = [];
      const removedImages = [];
      images.forEach(image => {
        if (keptCount < limit) {
          keptImages.push(image);
          keptCount += 1;
        } else {
          removedImages.push(image);
        }
      });

      if (!removedImages.length) return;

      const urlsToRemove = removedImages.flatMap(imageUrls);
      urlsToRemove.forEach(removeUploadUrl);
      deleteFileRecordsByUrls(userId, urlsToRemove);
      removedCount += removedImages.length;

      const nextResultData = {
        ...resultData,
        images: keptImages,
        storage_pruned: true,
        storage_pruned_at: new Date().toISOString(),
        storage_pruned_removed_images: Number(resultData.storage_pruned_removed_images || 0) + removedImages.length
      };
      const resultUrl = keptImages.length
        ? JSON.stringify(keptImages.map(image => image.url || image.data_url || image.dataUrl).filter(Boolean))
        : null;
      update.run(JSON.stringify(nextResultData), resultUrl, task.id);
    });

    return { kept: Math.min(keptCount, limit), removed: removedCount };
  }

  static prunePpts(userId, limit = FREE_LIMITS.ppt) {
    const rows = db.prepare(`
      SELECT *
      FROM ai_tasks
      WHERE user_id = ?
        AND type = 'ppt'
        AND status = 'completed'
        AND COALESCE(result_url, '') != ''
      ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
    `).all(userId);

    const update = db.prepare(`
      UPDATE ai_tasks
      SET result_url = NULL,
          result_data = ?
      WHERE id = ?
    `);

    let removed = 0;
    rows.slice(limit).forEach(task => {
      const resultData = safeParseJson(task.result_data, {});
      const urlsToRemove = [
        task.result_url,
        resultData.download_url,
        resultData.pptx_url,
        ...(Array.isArray(resultData.preview_svgs) ? resultData.preview_svgs : []),
        resultData.workflow_log_url,
        resultData.workflow_state_url,
        resultData.quality_report_url,
        resultData.layout_safety_report_url,
        resultData.chart_calibration_report_url
      ].filter(Boolean);

      try {
        const cleanupPlan = ProjectStorageService.buildTaskCleanupPlan(task);
        ProjectStorageService.removeCleanupPlan(cleanupPlan);
        cleanupPlan.fileIds.forEach(fileId => File.delete(fileId));
      } catch (error) {
        console.warn('[StorageLimit] PPT工程目录清理失败，回退到旧清理逻辑:', task.id, error.message);
        removeFileRecordsForTask(task.id);
      }
      db.prepare('DELETE FROM files WHERE task_id = ?').run(task.id);
      urlsToRemove.forEach(removeUploadUrl);
      if (resultData.project_dir) {
        removeUploadDirectoryUrl(resultData.project_dir);
      }

      const nextResultData = {
        ...resultData,
        download_url: null,
        pptx_url: null,
        preview_svgs: [],
        storage_pruned: true,
        storage_pruned_at: new Date().toISOString(),
        storage_pruned_reason: `普通用户仅保留最新 ${limit} 套 PPT`
      };
      update.run(JSON.stringify(nextResultData), task.id);
      removed += 1;
    });

    return { kept: Math.min(rows.length, limit), removed };
  }

  static enforceForAllFreeUsers() {
    const expiredVip = User.expireVipMemberships();
    const users = db.prepare("SELECT id FROM users WHERE role = 'user'").all();
    const summary = { users: users.length, expiredVip, errors: 0 };
    users.forEach(user => {
      try {
        this.enforceForUser(user.id);
      } catch (error) {
        summary.errors += 1;
        console.warn('[StorageLimit] 清理用户存储失败:', user.id, error.message);
      }
    });
    return summary;
  }

  static startDailyCleanupScheduler() {
    if (cleanupTimer) return cleanupTimer;

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(2, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);

      cleanupTimer = setTimeout(() => {
        try {
          const summary = this.enforceForAllFreeUsers();
          console.log(`[StorageLimit] 02:00 cleanup done: users=${summary.users}, expiredVip=${summary.expiredVip}, errors=${summary.errors}`);
        } catch (error) {
          console.warn('[StorageLimit] 02:00 cleanup failed:', error.message);
        } finally {
          cleanupTimer = null;
          scheduleNext();
        }
      }, next.getTime() - now.getTime());
    };

    scheduleNext();
    return cleanupTimer;
  }
}

module.exports = StorageLimitService;
