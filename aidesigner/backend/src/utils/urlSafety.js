const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal'
]);

function isPrivateIpv4(address) {
  const parts = address.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16);
    const low = parseInt(hexMapped[2], 16);
    const mappedIpv4 = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff
    ].join('.');
    return isPrivateIpv4(mappedIpv4);
  }

  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff') ||
    normalized.includes('::ffff:127.') ||
    normalized.includes('::ffff:10.') ||
    normalized.includes('::ffff:192.168.')
  );
}

function normalizeHostname(hostname = '') {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isBlockedIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function assertSafeRemoteUrl(rawUrl, { allowedProtocols = ['http:', 'https:'] } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error('URL 格式无效');
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error('URL 协议不允许');
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('URL 主机不允许');
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('URL 指向内网或保留地址');
    }
    return url;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => isBlockedIp(record.address))) {
    throw new Error('URL 解析到内网或保留地址');
  }

  return url;
}

async function lookupPublic(hostname, options, callback) {
  try {
    const normalizedHostname = normalizeHostname(hostname);
    if (!normalizedHostname || BLOCKED_HOSTS.has(normalizedHostname) || normalizedHostname.endsWith('.localhost')) {
      throw new Error('URL 主机不允许');
    }

    if (net.isIP(normalizedHostname)) {
      if (isBlockedIp(normalizedHostname)) {
        throw new Error('URL 指向内网或保留地址');
      }
      callback(null, normalizedHostname, net.isIP(normalizedHostname));
      return;
    }

    const records = await dns.lookup(normalizedHostname, { ...options, all: true, verbatim: true });
    const safeRecords = records.filter(record => !isBlockedIp(record.address));
    if (!safeRecords.length || safeRecords.length !== records.length) {
      throw new Error('URL 解析到内网或保留地址');
    }

    if (options?.all) {
      callback(null, safeRecords);
      return;
    }

    callback(null, safeRecords[0].address, safeRecords[0].family);
  } catch (error) {
    callback(error);
  }
}

function beforeRedirect(options) {
  const protocol = options.protocol || (options.href || '').split(':')[0] + ':';
  if (!['http:', 'https:'].includes(protocol)) {
    throw new Error('URL 协议不允许');
  }
  const hostname = normalizeHostname(options.hostname || options.host || '');
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('URL 主机不允许');
  }
  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    throw new Error('URL 指向内网或保留地址');
  }
}

function safeAxiosOptions() {
  return {
    httpAgent: new http.Agent({ lookup: lookupPublic }),
    httpsAgent: new https.Agent({ lookup: lookupPublic }),
    beforeRedirect
  };
}

module.exports = {
  assertSafeRemoteUrl,
  isBlockedIp,
  safeAxiosOptions
};
