/**
 * AI Designer Lite - local image server
 * Pure Node.js implementation, no npm install, no Python, no venv.
 *
 * It exposes an OpenAI-compatible subset:
 *   GET  /health
 *   POST /v1/images/generations
 *   POST /v1/images/edits
 *
 * This is a CPU-safe local generator placeholder. It verifies the full image pipeline
 * without requiring NVIDIA GPU / Stable Diffusion WebUI. Later it can be replaced by
 * a real model provider while keeping the same backend endpoint.
 */

const http = require('http');
const zlib = require('zlib');

const HOST = process.env.LOCAL_IMAGE_HOST || '127.0.0.1';
const PORT = Number(process.env.LOCAL_IMAGE_PORT || 18080);
const API_KEY = process.env.LOCAL_IMAGE_API_KEY || 'local-dev-key';
const MODEL = process.env.LOCAL_IMAGE_MODEL_ID || 'local-cpu-safe-image';
const MAX_N = Math.max(1, Math.min(Number(process.env.LOCAL_IMAGE_MAX_N || 1), 4));

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })());
  let c = 0xFFFFFFFF;
  for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function parseSize(size) {
  const raw = String(size || '512x512').toLowerCase().trim();
  const ratio = {
    '1:1': [512, 512],
    '4:3': [640, 480],
    '3:4': [480, 640],
    '16:9': [768, 432],
    '9:16': [432, 768],
  };
  if (ratio[raw]) return ratio[raw];
  const m = raw.replace('*', 'x').match(/^(\d+)x(\d+)$/);
  if (!m) return [512, 512];
  return [
    Math.max(128, Math.min(Number(m[1]), 1024)),
    Math.max(128, Math.min(Number(m[2]), 1024)),
  ];
}

function hashText(text) {
  let h = 2166136261 >>> 0;
  for (const ch of Buffer.from(String(text || 'empty'), 'utf8')) {
    h ^= ch;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function makePng(prompt, size, index) {
  const [width, height] = parseSize(size);
  const seed = (hashText(prompt) + index * 9973) >>> 0;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      let r = 70 + ((x * 3 + y + seed) % 155);
      let g = 90 + ((x + y * 2 + (seed >>> 3)) % 145);
      let b = 120 + ((x * 2 + y * 3 + (seed >>> 7)) % 120);
      if (x > width * 0.12 && x < width * 0.88 && y > height * 0.18 && y < height * 0.82) {
        r = Math.floor(r * 0.35 + 245 * 0.65);
        g = Math.floor(g * 0.35 + 247 * 0.65);
        b = Math.floor(b * 0.35 + 251 * 0.65);
      }
      const off = 1 + x * 3;
      row[off] = r & 255;
      row[off + 1] = g & 255;
      row[off + 2] = b & 255;
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolor
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const text = Buffer.from('Prompt\0' + String(prompt || '').slice(0, 500), 'utf8');
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 20 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!API_KEY) return true;
  return req.headers.authorization === `Bearer ${API_KEY}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        backend: 'node-stdlib',
        model: MODEL,
        device: 'CPU-safe local generator',
        note: 'No Python, no Docker, no GPU required. This validates the image pipeline.',
        time: Math.floor(Date.now() / 1000),
      });
    }

    if (!checkAuth(req)) {
      return sendJson(res, 401, { error: { message: 'Invalid local image API key' } });
    }

    if (req.method === 'POST' && (req.url === '/v1/images/generations' || req.url === '/v1/images/edits')) {
      const raw = await readBody(req);
      let payload = {};
      try {
        const text = raw.toString('utf8').trim();
        payload = text.startsWith('{') ? JSON.parse(text) : {};
      } catch (_) {
        payload = {};
      }

      const prompt = String(payload.prompt || 'AI Designer local image').trim();
      const size = payload.size || '512x512';
      const n = Math.max(1, Math.min(Number(payload.n || 1), MAX_N));
      const data = [];
      for (let i = 0; i < n; i++) {
        data.push({ b64_json: makePng(prompt, size, i).toString('base64') });
      }

      return sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data,
        model: payload.model || MODEL,
        backend: 'node-stdlib',
      });
    }

    return sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    return sendJson(res, 500, { error: { message: err && err.message ? err.message : String(err) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log('==================================================');
  console.log('AI Designer Lite local image server is running.');
  console.log(`URL: http://${HOST}:${PORT}`);
  console.log(`Health: http://${HOST}:${PORT}/health`);
  console.log(`Model: ${MODEL}`);
  console.log('==================================================');
});
