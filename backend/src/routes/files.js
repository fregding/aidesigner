const express = require('express');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const File = require('../models/File');
const StorageLimitService = require('../services/storageLimitService');
const ProjectStorageService = require('../services/projectStorageService');
const DocumentConverterService = require('../services/documentConverterService');
const DocumentVisualPreviewService = require('../services/documentVisualPreviewService');
const SpreadsheetPreviewService = require('../services/spreadsheetPreviewService');
const AiService = require('../services/aiService');
const appConfig = require('../config/appConfig');
const { normalizeUploadOriginalName } = require('../utils/uploadName');

const router = express.Router();

function publicFileUrl(url) {
  if (!url || !appConfig.signedUploadsEnabled || typeof url !== 'string' || !url.startsWith('/uploads/')) {
    return url;
  }
  return appConfig.signUploadUrl(url, { ttlSeconds: 3600 });
}

function publicFileUrls(urls) {
  if (!Array.isArray(urls)) return urls;
  return urls.map(publicFileUrl);
}

function normalizeUploadUrlForSigning(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  try {
    if (/^https?:\/\//i.test(text)) {
      const parsed = new URL(text);
      text = parsed.pathname;
    }
  } catch (error) {
    return '';
  }
  text = text.split('?')[0];
  return text.startsWith('/uploads/') ? text : '';
}

function uploadUrlBelongsToUser(uploadUrl, userId) {
  const normalizedUserId = String(userId || '');
  if (!normalizedUserId) return false;
  const relative = String(uploadUrl || '')
    .split('?')[0]
    .replace(/^\/uploads\//, '')
    .split('/')
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch (error) {
        return segment;
      }
    })
    .join('/');

  return (
    relative.startsWith(`${normalizedUserId}/`) ||
    relative.startsWith(`ppt/${normalizedUserId}/`) ||
    relative.startsWith(`documents/${normalizedUserId}/`) ||
    relative.startsWith(`converted_previews/${normalizedUserId}/`)
  );
}

function resolveStoredFilePath(file) {
  if (!file?.path) return '';
  return appConfig.assertInsideUploadDir(file.path);
}

function fileWithSafePath(file) {
  return {
    ...file,
    path: resolveStoredFilePath(file)
  };
}

function isHeicUploadFile(file) {
  if (!file) return false;
  const mimeType = AiService.normalizeReferenceMimeType(file.mimetype || '');
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  return AiService.isHeicMimeType(mimeType) || ext === '.heic' || ext === '.heif';
}

async function normalizeUploadedHeicFile(file) {
  if (!isHeicUploadFile(file)) {
    return { converted: false, file };
  }

  const sourcePath = appConfig.assertInsideUploadDir(file.path);
  const sourceExt = path.extname(file.originalname || file.filename || '').toLowerCase();
  const sourceMimeType = AiService.isHeicMimeType(file.mimetype)
    ? file.mimetype
    : (sourceExt === '.heif' ? 'image/heif' : 'image/heic');
  const sourceBuffer = fs.readFileSync(sourcePath);
  const converted = await AiService.convertHeicBufferToPng({
    buffer: sourceBuffer,
    mimeType: sourceMimeType,
    filename: file.originalname || file.filename || 'reference-image.heic'
  }, file.originalname || file.filename || 'reference-image');

  const outputFilename = `${path.parse(file.filename || converted.filename || 'reference-image').name}.png`;
  const outputPath = appConfig.assertInsideUploadDir(path.join(path.dirname(sourcePath), outputFilename));
  fs.writeFileSync(outputPath, converted.buffer);
  fs.rmSync(sourcePath, { force: true });

  file.filename = outputFilename;
  file.path = outputPath;
  file.mimetype = 'image/png';
  file.size = converted.buffer.length;

  return {
    converted: true,
    convertedFrom: sourceMimeType,
    file
  };
}

router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const uploadNormalization = await normalizeUploadedHeicFile(req.file);
    const originalName = normalizeUploadOriginalName(req.file.originalname, req.file.filename || '上传文件');
    const url = appConfig.pathToUploadUrl(req.file.path);

    const file = File.create({
      userId: req.userId,
      taskId: req.body.taskId || null,
      filename: req.file.filename,
      originalName,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      url
    });

    DocumentVisualPreviewService.enqueueUploadPreview(file, req.userId).catch(error => {
      console.warn('上传文件视觉预览预热失败:', error.message);
    });

    res.json({
      message: '文件上传成功',
      file: {
        id: file.id,
        filename: file.filename,
        original_name: file.original_name,
        mime_type: file.mime_type,
        size: file.size,
        url: publicFileUrl(file.url),
        created_at: file.created_at,
        converted_from: uploadNormalization.converted ? uploadNormalization.convertedFrom : null
      }
    });
  } catch (error) {
    console.error('文件上传错误:', error);
    if (req.file?.path) {
      try {
        const safePath = appConfig.assertInsideUploadDir(req.file.path);
        if (fs.existsSync(safePath)) fs.rmSync(safePath, { force: true });
      } catch (cleanupError) {
        console.warn('清理失败上传文件出错:', cleanupError.message);
      }
    }
    const statusCode = /HEIC|HEIF/.test(error.message || '') ? 400 : 500;
    res.status(statusCode).json({ error: statusCode === 400 ? error.message : '文件上传失败' });
  }
});

router.get('/', auth, (req, res) => {
  try {
    const { limit, offset } = req.query;

    const files = File.findByUserId(req.userId, {
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });

    const totalSize = File.getTotalSize(req.userId);
    const totalCount = File.countByUser(req.userId);
    const storage = StorageLimitService.getUserStorageSummary(req.userId);

    res.json({
      files: files.map(f => ({
        id: f.id,
        filename: f.filename,
        original_name: f.original_name,
        mime_type: f.mime_type,
        size: f.size,
        size_formatted: formatFileSize(f.size),
        url: publicFileUrl(f.url),
        task_id: f.task_id,
        created_at: f.created_at
      })),
      pagination: {
        total: totalCount,
        total_size: totalSize,
        total_size_formatted: formatFileSize(totalSize)
      },
      storage
    });
  } catch (error) {
    console.error('获取文件列表错误:', error);
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

router.get('/signed-url', auth, (req, res) => {
  try {
    const uploadUrl = normalizeUploadUrlForSigning(req.query.url || req.query.path);
    if (!uploadUrl) {
      return res.status(400).json({ error: '文件链接无效' });
    }
    if (!uploadUrlBelongsToUser(uploadUrl, req.userId)) {
      return res.status(403).json({ error: '无权访问此文件' });
    }

    const filePath = appConfig.uploadUrlToPath(uploadUrl);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: '文件不存在或已被清理' });
    }

    res.json({
      url: publicFileUrl(uploadUrl)
    });
  } catch (error) {
    console.error('刷新文件链接错误:', error);
    res.status(500).json({ error: '刷新文件链接失败' });
  }
});

router.get('/:id', auth, (req, res) => {
  try {
    const file = File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问此文件' });
    }

    res.json({
      file: {
        id: file.id,
        filename: file.filename,
        original_name: file.original_name,
        mime_type: file.mime_type,
        size: file.size,
        size_formatted: formatFileSize(file.size),
        url: publicFileUrl(file.url),
        task_id: file.task_id,
        created_at: file.created_at
      }
    });
  } catch (error) {
    console.error('获取文件详情错误:', error);
    res.status(500).json({ error: '获取文件详情失败' });
  }
});

router.get('/:id/preview', auth, async (req, res) => {
  try {
    const file = File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问此文件' });
    }

    const safePath = resolveStoredFilePath(file);
    if (!fs.existsSync(safePath)) {
      return res.status(404).json({ error: '文件已丢失，请联系客服' });
    }

    const converter = DocumentConverterService.detectConverter(safePath || file.original_name || file.filename);
    if (!converter) {
      return res.status(400).json({ error: '这个文件暂不支持在线预览' });
    }

    const outputDir = appConfig.assertInsideUploadDir(path.join(appConfig.uploadDir, 'converted_previews', String(req.userId), String(file.id)));
    const outputPath = appConfig.assertInsideUploadDir(path.join(outputDir, `${path.basename(safePath, path.extname(safePath))}.md`));
    let markdown = '';
    let result = null;
    const sourceStat = fs.statSync(safePath);
    const cachedMarkdown = DocumentConverterService.readCachedMarkdown(outputPath, sourceStat.mtimeMs);

    if (cachedMarkdown !== null) {
      markdown = cachedMarkdown;
      result = {
        converter,
        duration: 0,
        fileSize: file.size,
        lineCount: markdown.split('\n').length
      };
    } else {
      result = await DocumentConverterService.convert(safePath, {
        outputDir,
        converter,
        timeoutMs: 120000
      });
      markdown = result.markdown;
      DocumentConverterService.markCacheFresh(outputDir);
    }

    const textQualityWarning = DocumentConverterService.isProbablyGarbledMarkdown(markdown)
      ? '文档文本提取疑似乱码，已隐藏文字预览。请优先查看页面预览，或上传 docx/pdf 获取更稳定的文本抽取。'
      : '';

    res.json({
      message: '文件预览已生成',
      data: {
        converter: result.converter || converter,
        fileName: file.original_name || file.filename,
        fileSize: result.fileSize || file.size,
        lineCount: result.lineCount || markdown.split('\n').length,
        duration: result.duration || 0,
        markdown: textQualityWarning ? '' : markdown,
        preview: textQualityWarning ? '' : markdown.slice(0, 12000),
        hasMore: !textQualityWarning && markdown.length > 12000,
        text_quality_warning: textQualityWarning,
        wordCount: markdown.length
      }
    });
  } catch (error) {
    console.error('文件预览错误:', error);
    res.status(500).json({ error: '文件预览失败: ' + error.message });
  }
});

router.get('/:id/visual-preview', auth, async (req, res) => {
  try {
    const file = File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问此文件' });
    }

    const result = await DocumentVisualPreviewService.buildPreview(fileWithSafePath(file), req.userId, {
      force: req.query.force === '1'
    });

    res.json({
      message: '文件视觉预览已生成',
      data: {
        type: result.type,
        images: publicFileUrls(result.images),
        cached: result.cached,
        source: result.source || ''
      }
    });
  } catch (error) {
    console.error('文件视觉预览错误:', error);
    res.status(500).json({ error: '文件视觉预览失败: ' + error.message });
  }
});

router.get('/:id/spreadsheet-preview', auth, async (req, res) => {
  try {
    const file = File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问此文件' });
    }

    const result = await SpreadsheetPreviewService.buildPreview(fileWithSafePath(file), req.userId, {
      force: req.query.force === '1',
      maxRows: req.query.maxRows,
      maxCols: req.query.maxCols
    });

    res.json({
      message: '表格预览已生成',
      data: result
    });
  } catch (error) {
    console.error('表格预览错误:', error);
    res.status(500).json({ error: '表格预览失败: ' + error.message });
  }
});

router.get('/download/:id', auth, (req, res) => {
  try {
    const file = File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问此文件' });
    }

    const safePath = resolveStoredFilePath(file);
    if (!fs.existsSync(safePath)) {
      return res.status(404).json({ error: '文件已丢失，请联系客服' });
    }

    res.download(safePath, file.original_name);
  } catch (error) {
    console.error('下载文件错误:', error);
    res.status(500).json({ error: '下载文件失败' });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const file = File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    if (file.user_id !== req.userId) {
      return res.status(403).json({ error: '无权删除此文件' });
    }

    const deleted = ProjectStorageService.deleteFileForUser(file.id, req.userId);
    res.json({
      message: '文件删除成功',
      removed_files: deleted.cleanup.removed,
      skipped_files: deleted.cleanup.skipped,
      removed_bytes: deleted.cleanup.removed_bytes
    });
  } catch (error) {
    console.error('删除文件错误:', error);
    res.status(error.statusCode || 500).json({ error: '删除文件失败: ' + (error.message || '未知错误') });
  }
});

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
