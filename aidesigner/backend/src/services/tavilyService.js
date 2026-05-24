const IMAGE_PROXY_PATH = '/api/ai/reference-image';
const axios = require('axios');
const RuntimeConfigService = require('./runtimeConfigService');
const { assertSafeRemoteUrl, safeAxiosOptions } = require('../utils/urlSafety');

class TavilyService {
  static isConfigured() {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    return Boolean(runtimeConfig.searchApiKey);
  }

  static async search({
    query,
    topic = 'general',
    includeImages = false,
    maxResults = 5
  }) {
    if (!query) {
      return this.emptyResult();
    }
    const safeQuery = this.normalizeQuery(query);

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();

    if (!runtimeConfig.searchApiKey) {
      return {
        ...this.emptyResult(),
        query: safeQuery,
        configured: false
      };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      const response = await fetch(`${runtimeConfig.searchBaseUrl}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${runtimeConfig.searchApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: safeQuery,
          topic,
          search_depth: 'basic',
          include_answer: true,
          include_images: includeImages,
          include_image_descriptions: includeImages,
          include_favicon: true,
          include_raw_content: false,
          auto_parameters: false,
          max_results: maxResults
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Tavily request failed with ${response.status}`);
      }

      const data = await response.json();

      const images = includeImages
        ? await this.normalizeImages(Array.isArray(data.images) ? data.images : [])
        : [];

      return {
        configured: true,
        query: data.query || safeQuery,
        answer: data.answer || '',
        results: Array.isArray(data.results) ? data.results : [],
        images,
        responseTime: data.response_time || null,
        requestId: data.request_id || null
      };
    } catch (error) {
      console.error('Tavily search error:', error.message);
      return {
        ...this.emptyResult(),
        query: safeQuery,
        configured: true,
        error: error.message
      };
    }
  }

  static normalizeQuery(query) {
    return String(query || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 380);
  }

  static emptyResult() {
    return {
      configured: false,
      query: '',
      answer: '',
      results: [],
      images: [],
      responseTime: null,
      requestId: null,
      error: null
    };
  }

  static async normalizeImages(images) {
    const unique = [];
    const seen = new Set();

    for (const item of images) {
      const normalized = typeof item === 'string'
        ? { url: item, title: '', description: '' }
        : item;

      if (!normalized || !normalized.url || seen.has(normalized.url)) {
        continue;
      }

      seen.add(normalized.url);
      unique.push(normalized);
    }

    const checked = await Promise.all(
      unique.slice(0, 8).map(async item => {
        const ok = await this.isUsableImage(item.url);
        return ok
          ? {
              url: this.buildProxyUrl(item.url),
              original_url: item.url,
              title: item.title || '',
              description: item.description || item.title || '参考图片'
            }
          : null;
      })
    );

    return checked.filter(Boolean).slice(0, 6);
  }

  static async isUsableImage(url) {
    if (!url || !/^https?:\/\//i.test(url)) {
      return false;
    }

    try {
      const safeUrl = await assertSafeRemoteUrl(url, { allowedProtocols: ['http:', 'https:'] });
      const response = await axios.get(safeUrl.toString(), {
        ...safeAxiosOptions(),
        responseType: 'stream',
        timeout: 8000,
        maxRedirects: 3,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });

      const contentType = String(response.headers['content-type'] || '').split(';')[0];
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }

      return response.status >= 200 && response.status < 300 && contentType.startsWith('image/');
    } catch (error) {
      return false;
    }
  }

  static buildProxyUrl(url) {
    return `${IMAGE_PROXY_PATH}?url=${encodeURIComponent(url)}`;
  }
}

module.exports = TavilyService;
