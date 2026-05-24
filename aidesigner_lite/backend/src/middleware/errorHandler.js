const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: '文件大小超出限制' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err.message) {
    return res.status(400).json({ error: err.message });
  }

  res.status(500).json({ error: '服务器内部错误' });
};

const notFound = (req, res) => {
  res.status(404).json({ error: '请求的资源不存在' });
};

module.exports = { errorHandler, notFound };
