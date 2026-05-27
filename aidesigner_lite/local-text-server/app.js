/**
 * AI Designer Lite - Local Text Generation Server
 * Pure Node.js, zero npm dependencies.
 *
 * OpenAI-compatible chat completions API for PPT generation.
 *
 * Modes (set via LOCAL_TEXT_MODE env):
 *   "auto"  — auto-detect Ollama, fall back to mock (default)
 *   "ollama"— force Ollama proxy mode
 *   "mock"  — template-based generation, no external LLM needed
 *   "proxy" — forward to any OpenAI-compatible endpoint
 *
 * Endpoints:
 *   GET  /health
 *   POST /v1/chat/completions
 *   GET  /v1/models
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const HOST = process.env.LOCAL_TEXT_HOST || '127.0.0.1';
const PORT = Number(process.env.LOCAL_TEXT_PORT || 18081);
const MODE = process.env.LOCAL_TEXT_MODE || 'auto';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || ''; // auto-detect if empty
const PROXY_URL = process.env.LOCAL_TEXT_PROXY_URL || 'http://127.0.0.1:11434/v1';
const PROXY_MODEL = process.env.LOCAL_TEXT_PROXY_MODEL || 'qwen3:latest';
const MOCK_MODEL = 'local-text-mock';

// Runtime state
let activeMode = 'mock';
let activeModel = MOCK_MODEL;
let ollamaAvailable = false;
let ollamaModels = [];

// ========== Utilities ==========

function json(obj) { return JSON.stringify(obj); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(Buffer.concat(chunks).toString('utf-8')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json(data));
}

function httpGet(urlStr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ========== Ollama Detection ==========

async function detectOllama() {
  try {
    const resp = await httpGet(OLLAMA_URL + '/api/tags', 3000);
    if (resp.status === 200) {
      const data = JSON.parse(resp.body);
      ollamaModels = (data.models || []).map(m => m.name);
      ollamaAvailable = ollamaModels.length > 0;

      if (!ollamaAvailable) {
        console.log('[local-text-server] Ollama is running but has no models yet.');
        return { available: false, model: '', models: [] };
      }

      // Prefer non-reasoning models with good Chinese capability first
      const preferredOrder = [
        'qwen2.5', 'qwen2',
        'llama3.1', 'llama3',
        'mistral', 'gemma3', 'phi4', 'phi3', 'gemma2',
        'qwen3', 'qwq', 'deepseek-r1', 'deepseek-chat',
      ];

      let bestModel = ollamaModels[0];
      for (const prefix of preferredOrder) {
        const match = ollamaModels.find(m => m.startsWith(prefix));
        if (match) { bestModel = match; break; }
      }
      return { available: true, model: OLLAMA_MODEL || bestModel, models: ollamaModels };
    }
  } catch (e) {
    // Ollama not reachable
  }
  ollamaAvailable = false;
  ollamaModels = [];
  return { available: false, model: '', models: [] };
}

// ========== Prompt helpers (for mock mode) ==========

function extractTopic(prompt = '') {
  const text = String(prompt || '');
  const m1 = text.match(/主题[是为]?[「『"]([^」』"]+)[」』"]/);
  if (m1) return m1[1];
  const m2 = text.match(/标题[：:]\s*(.+?)(?:\n|$)/);
  if (m2) return m2[1].trim();
  const m3 = text.match(/#\s+(.+?)(?:\n|$)/);
  if (m3) return m3[1].trim();
  const m4 = text.match(/用户原始需求\s*\n(.+?)(?:\n\n|\n##|\n-|$)/s);
  if (m4) return m4[1].trim().slice(0, 60);
  return 'AI 生成演示文稿';
}

function extractPageCount(prompt = '', fallback = 8) {
  const m = String(prompt || '').match(/(?:页数|页面数量|总页数)[：:]\s*(\d+)/);
  if (m) return Math.max(3, Math.min(30, parseInt(m[1], 10)));
  const m2 = String(prompt || '').match(/(?:约|大约)?\s*(\d{1,2})\s*页/);
  if (m2) return Math.max(3, Math.min(30, parseInt(m2[1], 10)));
  return fallback;
}

function extractStyle(prompt = '') {
  const text = String(prompt || '').toLowerCase();
  if (text.includes('商务') || text.includes('business')) return 'consulting';
  if (text.includes('创意') || text.includes('creative')) return 'google';
  if (text.includes('学术') || text.includes('academic')) return 'academic';
  if (text.includes('极简') || text.includes('minimal')) return 'mckinsey';
  if (text.includes('科技') || text.includes('tech')) return 'general';
  if (text.includes('禅') || text.includes('zen')) return 'zen';
  return 'general';
}

function extractPageNumber(prompt = '') {
  const m = String(prompt || '').match(/生成第\s*(\d+)\s*\/\s*(\d+)\s*页/);
  if (m) return { pageNum: parseInt(m[1], 10), pageCount: parseInt(m[2], 10) };
  return { pageNum: 1, pageCount: 8 };
}

// ========== Mock PPT Content Generators ==========

function generateMockDesignSpec(prompt) {
  const topic = extractTopic(prompt);
  const pageCount = extractPageCount(prompt);
  const style = extractStyle(prompt);
  const styleNames = { consulting: '商务咨询风', google: '创意现代风', academic: '学术论文风', mckinsey: '极简专业风', general: '通用专业风', zen: '禅意东方风' };
  const styleDesc = styleNames[style] || '通用专业风';

  const sections = [
    { title: '封面', subtitle: topic, layout: 'title_slide' },
    { title: '目录', subtitle: '内容概览', layout: 'toc' },
    { title: '背景与目标', subtitle: '项目背景与核心目标', layout: 'content' },
    { title: '核心内容一', subtitle: '关键要点分析', layout: 'content' },
    { title: '核心内容二', subtitle: '深入解读与洞察', layout: 'content' },
    { title: '数据与成果', subtitle: '关键指标与成果展示', layout: 'data' },
    { title: '挑战与对策', subtitle: '面临挑战及应对策略', layout: 'content' },
    { title: '总结与展望', subtitle: '总结回顾与未来规划', layout: 'summary' },
  ];

  const pages = sections.slice(0, Math.min(pageCount, sections.length));
  while (pages.length < pageCount) {
    pages.push({ title: `第 ${pages.length + 1} 部分`, subtitle: '详细内容', layout: 'content' });
  }

  return [
    '# Design Specification & Content Outline', '',
    '## Section I — 全局画布与尺寸',
    '- 画布尺寸: 1280 × 720 (16:9)',
    '- viewBox: "0 0 1280 720"',
    '- 安全区域: 左右 60px, 上下 50px', '',
    '## Section II — 色彩体系',
    '- 主色: #1a56db (深蓝)', '- 辅色: #059669 (翠绿)', '- 强调色: #dc2626 (红)',
    '- 背景色: #ffffff (白)', '- 文字色: #111827 (深灰)', '',
    '## Section III — 字体规范',
    '- 标题: 36-48px, font-weight: 700, 无衬线',
    '- 正文: 18-24px, font-weight: 400',
    '- 注释: 14-16px, 颜色 #6b7280', '',
    '## Section IV — 设计风格',
    `- 风格: ${styleDesc}`,
    '- 布局原则: 清晰层次、充足留白、视觉引导', '',
    '## Section V — 页面结构总览',
    `- 总页数: ${pageCount}`,
    ...pages.map((p, i) => `- 第 ${i + 1} 页: ${p.title} — ${p.subtitle} (${p.layout})`), '',
    '## Section VI — 封面页设计',
    '- 大标题居中或左对齐', '- 副标题在下方', '- 背景使用渐变或几何装饰', '',
    '## Section VII — 内容页设计',
    '- 标题在顶部左侧', '- 内容使用清晰的分点或段落', '- 关键数据使用大号数字突出', '',
    '## Section VIII — 图表与数据可视化',
    '- 柱状图: 用于对比数据', '- 折线图: 用于趋势展示', '- 饼图: 用于占比展示', '',
    '## Section IX — 图标与插图',
    '- 使用简洁线性图标', '- 插图风格统一', '',
    '## Section X — 过渡与动画',
    '- 页面切换: 淡入淡出', '- 内容逐条出现', '',
    '## Section XI — 输出要求',
    '- 每页输出完整 SVG', '- 确保文字在安全区域内', '- 保持风格一致',
  ].join('\n');
}

function generateMockSvg(prompt) {
  const { pageNum, pageCount } = extractPageNumber(prompt);
  const topic = extractTopic(prompt);
  const pageTitles = ['封面', '目录', '背景与目标', '核心内容一', '核心内容二', '数据与成果', '挑战与对策', '总结与展望', '补充内容', '附录'];
  const pageSubs = [topic, '内容概览', '项目背景与核心目标', '关键要点分析', '深入解读与洞察', '关键指标与成果展示', '面临挑战及应对策略', '总结回顾与未来规划', '详细内容', '参考资料'];
  const idx = Math.min(pageNum - 1, pageTitles.length - 1);
  const title = pageTitles[idx];
  const sub = pageSubs[idx] || '详细内容';
  const colors = ['#1a56db', '#059669', '#7c3aed', '#dc2626', '#d97706', '#0891b2', '#4f46e5', '#be185d'];
  const accent = colors[(pageNum - 1) % colors.length];

  if (pageNum === 1) {
    return `<svg viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1e3a5f"/><stop offset="100%" stop-color="#0f172a"/></linearGradient></defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect x="60" y="180" width="8" height="56" rx="4" fill="${accent}"/>
  <text x="88" y="225" font-family="sans-serif" font-size="48" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>
  <text x="88" y="290" font-family="sans-serif" font-size="24" font-weight="400" fill="#94a3b8">${escapeXml(sub)}</text>
  <line x1="88" y1="330" x2="380" y2="330" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <text x="88" y="400" font-family="sans-serif" font-size="16" fill="#64748b">AI Designer · 自动生成</text>
  <circle cx="1100" cy="180" r="180" fill="${accent}" opacity="0.08"/>
  <circle cx="1120" cy="160" r="120" fill="${accent}" opacity="0.05"/>
</svg>`;
  }

  if (pageNum === 2) {
    const items = [];
    for (let i = 3; i <= pageCount; i++) {
      const ti = Math.min(i - 1, pageTitles.length - 1);
      const y = 200 + (i - 3) * 55;
      items.push(`<text x="120" y="${y}" font-family="sans-serif" font-size="18" fill="#64748b">${String(i).padStart(2,'0')}</text>
  <line x1="165" y1="${y-6}" x2="200" y2="${y-6}" stroke="${accent}" stroke-width="2" opacity="0.5"/>
  <text x="215" y="${y}" font-family="sans-serif" font-size="20" font-weight="500" fill="#1e293b">${escapeXml(pageTitles[ti])}</text>`);
    }
    return `<svg viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
  <rect width="1280" height="720" fill="#ffffff"/>
  <rect x="60" y="60" width="1160" height="2" fill="#e5e7eb"/>
  <text x="80" y="130" font-family="sans-serif" font-size="36" font-weight="700" fill="#111827">目录</text>
  <line x1="80" y1="155" x2="280" y2="155" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  ${items.join('\n  ')}
  <rect x="60" y="658" width="1160" height="2" fill="#e5e7eb"/>
  <text x="80" y="695" font-family="sans-serif" font-size="14" fill="#9ca3af">共 ${pageCount} 页</text>
</svg>`;
  }

  const bullets = ['关键要点与核心发现', '数据驱动的决策支持', '行业趋势与市场分析', '实施路径与行动计划'];
  const bulletSvg = bullets.map((b, i) =>
    `<circle cx="110" cy="${232 + i * 52}" r="5" fill="${accent}"/><text x="135" y="${240 + i * 52}" font-family="sans-serif" font-size="20" fill="#374151">${escapeXml(b)}</text>`
  ).join('\n  ');

  return `<svg viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
  <rect width="1280" height="720" fill="#ffffff"/>
  <rect x="60" y="48" width="8" height="48" rx="4" fill="${accent}"/>
  <text x="88" y="86" font-family="sans-serif" font-size="36" font-weight="700" fill="#111827">${escapeXml(title)}</text>
  <line x1="88" y1="110" x2="480" y2="110" stroke="#e5e7eb" stroke-width="1"/>
  <text x="88" y="180" font-family="sans-serif" font-size="18" fill="#6b7280">${escapeXml(sub)}</text>
  ${bulletSvg}
  <rect x="85" y="500" width="500" height="1" fill="#e5e7eb"/>
  <text x="80" y="620" font-family="sans-serif" font-size="14" fill="#9ca3af">${pageNum} / ${pageCount}</text>
  <circle cx="1100" cy="600" r="80" fill="${accent}" opacity="0.05"/>
</svg>`;
}

function generateMockChatResponse(messages) {
  const fullText = messages.map((m) => String(m.content || '')).join('\n\n');
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const userContent = lastUserMsg ? String(lastUserMsg.content || '') : '';

  const isDesignSpec = /design_spec\.md|Design Specification|strategist|策划师/i.test(fullText);
  const isSvgGen = /<svg|viewBox|executor|生成.*SVG|slide.*svg|PAGE:\d+/i.test(fullText);
  const isPptRelated = /ppt|PPT|演示文稿|幻灯片|slide|presentation/i.test(fullText);

  if (isSvgGen || userContent.match(/请生成这一页 SVG/)) {
    const svg = generateMockSvg(fullText);
    const { pageNum } = extractPageNumber(fullText);
    return `<!-- PAGE:${pageNum} FILENAME:${String(pageNum).padStart(2,'0')}_slide_${pageNum}.svg -->\n${svg}`;
  }

  if (isDesignSpec) {
    return generateMockDesignSpec(fullText);
  }

  if (isPptRelated) {
    const topic = extractTopic(fullText);
    return `好的，我来为你规划「${topic}」的演示文稿内容。\n\n## 内容大纲\n1. **封面**\n2. **目录**\n3. **背景介绍**\n4. **核心内容**（3-5章节）\n5. **数据支撑**\n6. **总结展望**\n\n接下来我将逐页生成详细的 SVG 页面。`;
  }

  return `你好，我是 AI Designer 本地文本生成服务（Mock 模式）。\n请提供 PPT 主题或需求，我会生成相应的设计规范和页面内容。`;
}

// ========== Ollama / Remote Proxy ==========

function isSvgGenerationRequest(messages) {
  const fullText = (messages || []).map(m => String(m.content || '')).join('\n\n');
  return /executor|生成.*页.*SVG|slide.*svg|PAGE:\d+|请生成这一页|viewBox/i.test(fullText);
}

function proxyToOllama(reqBody) {
  const useStream = reqBody.stream === true;
  // Detect if model is a reasoning model (qwen3, deepseek-r1, etc.)
  const isReasoningModel = /qwen3|qwq|deepseek.r1|deepseek.reasoner/i.test(activeModel);
  // Reasoning models need extra tokens for internal thinking.
  // Allocate double the requested tokens, min 12000.
  const baseTokens = reqBody.max_tokens || 6000;
  const numPredict = isReasoningModel ? Math.max(baseTokens * 2, 12000) : baseTokens;
  const options = {
    num_ctx: 4096,
    num_predict: numPredict,
  };
  if (isReasoningModel) {
    options.enable_thinking = 0;
  }
  const postData = json({
    model: activeModel,
    messages: reqBody.messages || [],
    temperature: reqBody.temperature ?? 0.7,
    stream: useStream,
    keep_alive: '30m',
    options,
  });

  return new Promise((resolve, reject) => {
    const u = new URL(OLLAMA_URL + '/api/chat');
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 300000,
    }, (res) => {
      if (useStream) {
        // Return the response object for streaming relay
        resolve({ status: res.statusCode, stream: res });
      } else {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve({ status: res.statusCode, body });
          } catch (e) { reject(e); }
        });
      }
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(postData);
    req.end();
  });
}

function relayOllamaStream(ollamaStream, res, reqBody) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let fullContent = '';
    let lastChunk = null;
    let chunkCount = 0;
    let lastHeartbeat = Date.now();

    // Send heartbeats every 15s to keep the stream alive during thinking
    const heartbeatInterval = setInterval(() => {
      if (Date.now() - lastHeartbeat > 15000) {
        res.write(': heartbeat\n\n');
        lastHeartbeat = Date.now();
      }
    }, 15000);

    ollamaStream.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const msg = parsed.message || {};
          let delta = msg.content || '';
          // For reasoning models, thinking tokens may produce empty content.
          // Accumulate thinking as fallback in case final content is empty.
          const thinking = msg.thinking || '';
          if (thinking && !delta) {
            // Send thinking as content to keep the stream alive
            delta = thinking;
          }
          fullContent += delta;
          chunkCount++;
          lastHeartbeat = Date.now();

          // Skip empty deltas (thinking tokens), send only when there's content or done
          if (!delta && !parsed.done) continue;

          const sseData = {
            id: 'chatcmpl-' + Date.now() + '-' + chunkCount,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: parsed.model || activeModel,
            choices: [{
              index: 0,
              delta: { content: delta },
              finish_reason: parsed.done ? (parsed.done_reason === 'length' ? 'length' : 'stop') : null,
            }],
          };
          res.write('data: ' + JSON.stringify(sseData) + '\n\n');
          lastChunk = parsed;
        } catch (e) {
          // skip malformed lines
        }
      }
    });

    ollamaStream.on('end', () => {
      clearInterval(heartbeatInterval);
      if (!fullContent.trim() && lastChunk) {
        fullContent = lastChunk.message?.thinking || lastChunk.thinking || fullContent;
      }
      res.write('data: [DONE]\n\n');
      res.end();
      const fullResp = {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: activeModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: fullContent },
          finish_reason: lastChunk?.done_reason === 'length' ? 'length' : 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      resolve(fullResp);
    });

    ollamaStream.on('error', (err) => {
      clearInterval(heartbeatInterval);
      reject(err);
    });
  });
}

function proxyToOpenAI(reqBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(PROXY_URL + '/chat/completions');
    const client = u.protocol === 'https:' ? https : http;
    const postData = json({
      model: PROXY_MODEL,
      messages: reqBody.messages || [],
      temperature: reqBody.temperature ?? 0.7,
      max_tokens: reqBody.max_tokens || 6000,
      stream: false,
    });
    const req = client.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 300000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
    req.write(postData);
    req.end();
  });
}

function ollamaToOpenAIFormat(ollamaResp) {
  try {
    const data = typeof ollamaResp === 'string' ? JSON.parse(ollamaResp) : ollamaResp;
    // Prefer message.content; if empty and model was thinking, extract thinking as fallback
    let content = data.message?.content || '';
    if (!content && data.message?.thinking) {
      content = data.message.thinking;
    }
    if (!content && data.thinking) {
      content = data.thinking;
    }
    return {
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model || activeModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content,
        },
        finish_reason: data.done ? 'stop' : 'length',
      }],
      usage: {
        prompt_tokens: data.prompt_eval_count || 0,
        completion_tokens: data.eval_count || 0,
        total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
    };
  } catch (e) {
    return null;
  }
}

// ========== HTTP Server ==========

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      mode: activeMode,
      model: activeModel,
      ollama_available: ollamaAvailable,
      ollama_models: ollamaModels,
      proxy_url: activeMode === 'proxy' ? PROXY_URL : (activeMode === 'ollama' ? OLLAMA_URL : null),
    });
    return;
  }

  // List models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const models = [{ id: activeModel, object: 'model', owned_by: 'local-text-server' }];
    if (activeMode === 'mock') {
      models.push({ id: MOCK_MODEL, object: 'model', owned_by: 'local-text-server' });
    }
    sendJson(res, 200, { object: 'list', data: models });
    return;
  }

  // Chat completions
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    try {
      const body = await readBody(req);
      const reqBody = JSON.parse(body);

      if (activeMode === 'ollama') {
        try {
          // For SVG generation requests, force non-streaming so we can
          // validate the response and fall back to mock if needed.
          if (isSvgGenerationRequest(reqBody.messages) && reqBody.stream) {
            reqBody = { ...reqBody, stream: false };
          }
          const result = await proxyToOllama(reqBody);
          if (result.status === 200) {
            if (result.stream) {
              // Streaming mode: relay Ollama ndjson as SSE
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
              });
              await relayOllamaStream(result.stream, res, reqBody);
              return;
            }
            // Non-streaming mode
            const openAiFormat = ollamaToOpenAIFormat(result.body);
            if (openAiFormat) {
              const content = openAiFormat.choices?.[0]?.message?.content || '';
              // If model returned non-SVG text for an SVG generation request, fall back to mock
              if (isSvgGenerationRequest(reqBody.messages) && !/<svg\b/i.test(content)) {
                console.warn('[local-text-server] Ollama returned non-SVG response for executor, falling back to mock SVG');
                sendJson(res, 200, buildChatResponse(generateMockChatResponse(reqBody.messages || []), MOCK_MODEL));
                return;
              }
              sendJson(res, 200, openAiFormat);
            } else {
              throw new Error('Failed to parse Ollama response');
            }
          } else {
            console.warn('[local-text-server] Ollama returned ' + result.status + ', fallback to mock');
            sendJson(res, 200, buildChatResponse(generateMockChatResponse(reqBody.messages || []), MOCK_MODEL));
          }
        } catch (err) {
          console.warn('[local-text-server] Ollama error:', err.message, ', fallback to mock');
          sendJson(res, 200, buildChatResponse(generateMockChatResponse(reqBody.messages || []), MOCK_MODEL));
        }
      } else if (activeMode === 'proxy') {
        try {
          const result = await proxyToOpenAI(reqBody);
          if (result.status >= 200 && result.status < 300) {
            res.writeHead(result.status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(result.body);
          } else {
            console.warn('[local-text-server] Proxy returned ' + result.status + ', fallback to mock');
            sendJson(res, 200, buildChatResponse(generateMockChatResponse(reqBody.messages || []), MOCK_MODEL));
          }
        } catch (err) {
          console.warn('[local-text-server] Proxy error:', err.message, ', fallback to mock');
          sendJson(res, 200, buildChatResponse(generateMockChatResponse(reqBody.messages || []), MOCK_MODEL));
        }
      } else {
        // mock mode
        const content = generateMockChatResponse(reqBody.messages || []);
        if (reqBody.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          // Chunk the content into sentences for realistic streaming
          const sentences = content.replace(/([。！？；\n])/g, '$1|||').split('|||').filter(Boolean);
          for (let i = 0; i < sentences.length; i++) {
            const chunk = {
              id: 'chatcmpl-mock-' + Date.now() + '-' + i,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: MOCK_MODEL,
              choices: [{
                index: 0,
                delta: { content: sentences[i] },
                finish_reason: i === sentences.length - 1 ? 'stop' : null,
              }],
            };
            res.write('data: ' + JSON.stringify(chunk) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        sendJson(res, 200, buildChatResponse(content, MOCK_MODEL));
      }
    } catch (e) {
      console.error('[local-text-server] Error:', e.message);
      sendJson(res, 400, { error: { message: 'Invalid request: ' + e.message, type: 'invalid_request_error' } });
    }
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
});

function buildChatResponse(content, model) {
  return {
    id: 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, message: { role: 'assistant', content: content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function escapeXml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ========== Startup ==========

async function start() {
  console.log('[local-text-server] Starting...');

  // Determine mode
  if (MODE === 'mock') {
    activeMode = 'mock';
    activeModel = MOCK_MODEL;
    console.log('[local-text-server] Mode: mock (forced)');
  } else if (MODE === 'proxy') {
    activeMode = 'proxy';
    activeModel = PROXY_MODEL;
    console.log('[local-text-server] Mode: proxy -> ' + PROXY_URL + ' (' + PROXY_MODEL + ')');
  } else if (MODE === 'ollama') {
    const detected = await detectOllama();
    if (detected.available) {
      activeMode = 'ollama';
      activeModel = detected.model;
      console.log('[local-text-server] Mode: ollama -> ' + OLLAMA_URL + ' (' + activeModel + ')');
      console.log('[local-text-server] Available models: ' + detected.models.join(', '));
    } else {
      console.warn('[local-text-server] Ollama not reachable, falling back to mock');
      activeMode = 'mock';
      activeModel = MOCK_MODEL;
    }
  } else {
    // "auto" mode — try Ollama first
    const detected = await detectOllama();
    if (detected.available) {
      activeMode = 'ollama';
      activeModel = detected.model;
      console.log('[local-text-server] Mode: auto -> ollama detected (' + activeModel + ')');
      console.log('[local-text-server] Available models: ' + detected.models.join(', '));
    } else {
      console.log('[local-text-server] Ollama not detected, using mock mode');
      console.log('[local-text-server] Install Ollama for better PPT quality: https://ollama.com');
      activeMode = 'mock';
      activeModel = MOCK_MODEL;
    }
  }

  server.listen(PORT, HOST, () => {
    console.log('[local-text-server] Listening on http://' + HOST + ':' + PORT);
    console.log('[local-text-server] Model: ' + activeModel);
  });
}

start().catch(err => {
  console.error('[local-text-server] Startup failed:', err);
  process.exit(1);
});
