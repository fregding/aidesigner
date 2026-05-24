const STATIC_TERM_REPLACEMENTS = [
  ['GPT-Image-2 Prompt-as-Code', '结构化提示词方法'],
  ['freestylefly/awesome-gpt-image-2', '内置图片模板库'],
  ['awesome-gpt-image-2', '图片模板库'],
  ['gpt-image-2', '内置图片引擎'],
  ['gpt-5.5', '内置创作引擎'],
  ['gpt-4o-mini', '内置创作引擎'],
  ['gpt-4', '内置创作引擎'],
  ['dall-e-3', '内置图片引擎'],
  ['claude-opus-4-7', '内置创作引擎'],
  ['claude-opus-4-6', '内置创作引擎'],
  ['claude-sonnet-4-6', '内置创作引擎'],
  ['sora-1.0-turbo', '内置视频引擎'],
  ['kling-v2-5-turbo', '内置视频引擎'],
  ['kling-v2-1-master', '内置视频引擎'],
  ['kling-v2-master', '内置视频引擎'],
  ['kling-v1-6', '内置视频引擎'],
  ['kling-v1-5', '内置视频引擎'],
  ['kling-v3', '内置视频引擎'],
  ['kling-v1', '内置视频引擎']
];

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacementForRuntimeKey(key = '') {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey.includes('image')) return '内置图片引擎';
  if (normalizedKey.includes('video')) return '内置视频引擎';
  return '内置创作引擎';
}

function collectRuntimeReplacements(runtimeConfig = {}) {
  const replacements = [];

  Object.entries(runtimeConfig || {}).forEach(([key, value]) => {
    if (!/model/i.test(key)) return;
    const term = String(value || '').trim();
    if (!term) return;
    replacements.push([term, replacementForRuntimeKey(key)]);
  });

  return replacements;
}

function uniqueReplacements(runtimeConfig = {}) {
  const seen = new Set();
  return [...STATIC_TERM_REPLACEMENTS, ...collectRuntimeReplacements(runtimeConfig)]
    .filter(([term, replacement]) => {
      const token = `${term}::${replacement}`;
      if (!term || seen.has(token)) return false;
      seen.add(token);
      return true;
    })
    .sort((a, b) => b[0].length - a[0].length);
}

function sanitizePublicText(value, runtimeConfig = {}) {
  if (typeof value !== 'string') return value;

  let text = value;
  uniqueReplacements(runtimeConfig).forEach(([term, replacement]) => {
    text = text.replace(new RegExp(escapeRegExp(term), 'gi'), replacement);
  });

  return text;
}

function sanitizePublicObject(value, runtimeConfig = {}, options = {}) {
  const keysToRemove = options.keysToRemove instanceof Set
    ? options.keysToRemove
    : new Set(options.keysToRemove || []);

  if (typeof value === 'string') {
    return sanitizePublicText(value, runtimeConfig);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizePublicObject(item, runtimeConfig, options));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sanitized = {};
  Object.entries(value).forEach(([key, itemValue]) => {
    if (keysToRemove.has(key)) return;
    sanitized[key] = sanitizePublicObject(itemValue, runtimeConfig, options);
  });
  return sanitized;
}

module.exports = {
  sanitizePublicText,
  sanitizePublicObject
};
