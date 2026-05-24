const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

function resolvePromptPath(name) {
  const promptName = String(name || '').trim();
  if (!promptName) return path.join(PROMPTS_DIR, '__missing__.txt');
  if (path.isAbsolute(promptName)) return promptName;

  const extension = path.extname(promptName);
  if (extension) {
    return path.join(PROMPTS_DIR, promptName);
  }

  return path.join(PROMPTS_DIR, `${promptName}.txt`);
}

function resolveExistingPromptPath(name) {
  const promptName = String(name || '').trim();
  if (!promptName) return '';

  const directPath = resolvePromptPath(promptName);
  if (fs.existsSync(directPath)) return directPath;

  if (path.extname(promptName)) return directPath;

  const candidates = [
    `${promptName}.txt`,
    `${promptName}.md`,
    `${promptName}.prompt.md`,
    `${promptName}.agent.md`
  ].map(item => path.join(PROMPTS_DIR, item));

  return candidates.find(candidate => fs.existsSync(candidate)) || directPath;
}

function parseFrontMatter(raw = '') {
  const content = String(raw || '');
  if (!content.startsWith('---')) {
    return { data: {}, body: content };
  }

  const lines = content.split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return { data: {}, body: content };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex < 0) {
    return { data: {}, body: content };
  }

  const data = {};
  lines.slice(1, endIndex).forEach(line => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!match) return;
    data[match[1]] = parseFrontMatterValue(match[2]);
  });

  return {
    data,
    body: lines.slice(endIndex + 1).join('\n').trim()
  };
}

function parseFrontMatterValue(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map(item => parseFrontMatterValue(item.trim()))
      .filter(item => item !== '');
  }
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return trimmed;
}

function loadPromptDocument(name) {
  const filePath = resolveExistingPromptPath(name);
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      relativePath: path.relative(PROMPTS_DIR, filePath),
      data: {},
      body: ''
    };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFrontMatter(raw);
  return {
    filePath,
    relativePath: path.relative(PROMPTS_DIR, filePath),
    data: parsed.data,
    body: parsed.body.trim()
  };
}

function loadPrompt(name) {
  return loadPromptDocument(name).body;
}

function loadPromptSet(names) {
  return names
    .map(loadPrompt)
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  PROMPTS_DIR,
  loadPrompt,
  loadPromptDocument,
  loadPromptSet,
  parseFrontMatter,
  resolveExistingPromptPath,
  resolvePromptPath
};
