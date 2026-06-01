'use strict';

const http = require('http');

const HOST = process.env.LOCAL_TEXT_HOST || process.env.TEXT_SERVER_HOST || '127.0.0.1';
// Important: do NOT use generic PORT here. Backend also uses PORT=3000 and older
// start scripts accidentally set PORT=18081. The text server is fixed on 18082
// unless LOCAL_TEXT_PORT/TEXT_SERVER_PORT is explicitly provided.
const PORT = Number(process.env.LOCAL_TEXT_PORT || process.env.TEXT_SERVER_PORT || 18082);
const MODEL = process.env.LOCAL_TEXT_MODEL || process.env.CHAT_MODEL || 'local-text-mock';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

function contentFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map(m => {
    if (typeof m?.content === 'string') return m.content;
    if (Array.isArray(m?.content)) return m.content.map(part => part?.text || '').join('\n');
    return '';
  }).filter(Boolean).join('\n');
}

function mockAnswer(prompt) {
  const text = String(prompt || '').slice(0, 1200);
  if (/ppt|slide|svg|演示|幻灯片|页面|deck|presentation/i.test(text)) {
    return [
      '本地 mock 文本服务已接管请求。',
      '这是模板模式结果，用于本地联调流程；如需高质量 PPT 文案和 SVG，请安装 Ollama 并配置 qwen3，或配置真实 OpenAI 兼容文本 API。',
      '',
      '建议结构：',
      '1. 标题页：主题与核心观点。',
      '2. 背景页：问题、场景和目标。',
      '3. 方案页：关键模块和执行路径。',
      '4. 总结页：结论、收益和下一步。'
    ].join('\n');
  }
  return `本地文本 mock 回复：${text || '收到请求。'}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    sendJson(res, 200, { ok: true, service: 'local-text-server', port: PORT, model: MODEL });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'local' }] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readBody(req);
    const prompt = contentFromMessages(body.messages);
    const answer = mockAnswer(prompt);
    sendJson(res, 200, {
      id: `chatcmpl-local-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(answer.length / 4),
        total_tokens: Math.ceil((prompt.length + answer.length) / 4)
      }
    });
    return;
  }

  sendJson(res, 404, { error: { message: 'Not found', path: url.pathname, service: 'local-text-server', port: PORT } });
});

server.listen(PORT, HOST, () => {
  console.log('[local-text-server] Starting...');
  console.log('[local-text-server] Generic PORT is ignored; use LOCAL_TEXT_PORT/TEXT_SERVER_PORT.');
  console.log(`[local-text-server] Listening on http://${HOST}:${PORT}`);
  console.log(`[local-text-server] Model: ${MODEL}`);
});

server.on('error', err => {
  console.error(`[local-text-server] Failed to listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
