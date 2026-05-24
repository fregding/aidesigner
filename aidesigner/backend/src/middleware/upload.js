const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const appConfig = require('../config/appConfig');
const { normalizeUploadOriginalName } = require('../utils/uploadName');

const uploadDir = appConfig.uploadDir;

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(uploadDir, req.userId?.toString() || 'anonymous');
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const originalName = normalizeUploadOriginalName(file.originalname, file.originalname || 'upload');
    file.originalname = originalName;
    const ext = path.extname(originalName);
    const filename = `${uuidv4()}${ext}`;
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  const originalName = normalizeUploadOriginalName(file.originalname, file.originalname || '');
  file.originalname = originalName;
  const ext = path.extname(originalName || '').toLowerCase();
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/heic', 'image/heif', 'image/x-heic', 'image/x-heif', 'image/heic-sequence', 'image/heif-sequence',
    'video/mp4', 'video/webm', 'video/quicktime',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/octet-stream'
  ];
  const allowedExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
    '.pdf', '.doc', '.docx',
    '.ppt', '.pptx'
  ];

  const riskyExtensions = new Set(['.html', '.htm', '.xls', '.xlsx', '.xlsm', '.csv', '.epub', '.odt', '.rtf', '.ipynb', '.tex', '.pot', '.potx']);
  if (riskyExtensions.has(ext)) {
    cb(new Error('出于安全考虑，暂不支持上传该文件类型'), false);
    return;
  }

  const extensionAllowed = allowedExtensions.includes(ext);
  const mimeAllowed = allowedTypes.includes(file.mimetype);
  if (extensionAllowed && (mimeAllowed || file.mimetype === 'application/octet-stream')) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件类型'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: appConfig.maxFileSize
  }
});

module.exports = upload;
