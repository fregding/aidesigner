function looksMojibake(value) {
  return /[ÃÂ]|(?:å|æ|ç|è|é|ä|ö|ü)[\x80-\xBF]|[\u0080-\u009F]/.test(String(value || ''));
}

function scoreReadableName(value) {
  const text = String(value || '');
  if (!text) return -100;
  let score = 0;
  score += (text.match(/[\u4e00-\u9fff]/g) || []).length * 3;
  score += (text.match(/[A-Za-z0-9_.()（）\-\s]/g) || []).length;
  score -= (text.match(/[ÃÂ�\u0080-\u009F]/g) || []).length * 8;
  score -= (text.match(/[åæçèéäöü]/g) || []).length * 2;
  return score;
}

function decodeMaybeMojibake(value) {
  const text = String(value || '');
  if (!text) return text;

  const candidates = [text];
  try {
    candidates.push(Buffer.from(text, 'latin1').toString('utf8'));
  } catch (error) {}

  try {
    candidates.push(Buffer.from(text, 'binary').toString('utf8'));
  } catch (error) {}

  return candidates
    .filter(Boolean)
    .sort((a, b) => scoreReadableName(b) - scoreReadableName(a))[0] || text;
}

function normalizeUploadOriginalName(value, fallback = '上传文件') {
  const text = String(value || '').trim();
  const normalized = looksMojibake(text) ? decodeMaybeMojibake(text) : text;
  return String(normalized || fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) || fallback;
}

module.exports = {
  decodeMaybeMojibake,
  looksMojibake,
  normalizeUploadOriginalName
};
