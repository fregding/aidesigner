const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { assertSafeRemoteUrl, safeAxiosOptions } = require('../utils/urlSafety');

const SIMPLE_ICONS_CDN = 'https://cdn.simpleicons.org';
const SIMPLE_ICONS_JSDELIVR = 'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons';
const DEVICON_CDN = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons';

const MAX_LOGO_BYTES = 1024 * 1024;
const DEFAULT_LOGO_SIZE = 640;

const TECH_LOGOS = [
  {
    key: 'go',
    label: 'Go',
    simpleIcon: 'go',
    devicon: 'go',
    color: '00ADD8',
    initials: 'Go',
    patterns: [/\bgolang\b/i, /(?:^|[\s,，、/|;；:：()（）[\]【】])go(?:$|[\s,，、/|;；:：()（）[\]【】])/i, /go\s*(?:语言|后端|服务|工程|开发|框架)/i, /(?:语言|后端|服务|框架|技术栈)\s*go\b/i]
  },
  {
    key: 'websocket',
    label: 'WebSocket',
    simpleIcon: 'websocket',
    color: '111111',
    initials: 'WS',
    patterns: [/\bweb\s*socket\b/i, /\bwebsocket\b/i, /websocket\s*(?:协议|通信|实时|接口)/i]
  },
  {
    key: 'gin',
    label: 'Gin',
    color: '00ADD8',
    initials: 'Gin',
    patterns: [/\bgin\b(?=.*(?:go|golang|框架|后端|web|api|服务))/i]
  },
  {
    key: 'gorm',
    label: 'GORM',
    color: '00ADD8',
    initials: 'GORM',
    patterns: [/\bgorm\b/i]
  },
  {
    key: 'echo',
    label: 'Echo',
    color: '00ADD8',
    initials: 'Echo',
    patterns: [/\becho\b(?=.*(?:go|golang|框架|后端|web|api|服务))/i]
  },
  {
    key: 'postgresql',
    label: 'PostgreSQL',
    simpleIcon: 'postgresql',
    devicon: 'postgresql',
    color: '4169E1',
    initials: 'PG',
    patterns: [/\bpostgresql\b/i, /\bpostgres\b/i, /\bpsql\b/i]
  },
  {
    key: 'redis',
    label: 'Redis',
    simpleIcon: 'redis',
    devicon: 'redis',
    color: 'FF4438',
    initials: 'Re',
    patterns: [/\bredis\b/i]
  },
  {
    key: 'react',
    label: 'React',
    simpleIcon: 'react',
    devicon: 'react',
    color: '61DAFB',
    initials: 'Rx',
    patterns: [/\breact(?:\.js)?\b/i, /\breactjs\b/i]
  },
  {
    key: 'k6',
    label: 'k6',
    simpleIcon: 'k6',
    color: '7D64FF',
    initials: 'k6',
    patterns: [/\bk6\b/i, /\bgrafana\s*k6\b/i]
  },
  {
    key: 'vite',
    label: 'Vite',
    simpleIcon: 'vite',
    devicon: 'vitejs',
    color: '646CFF',
    initials: 'Vi',
    patterns: [/\bvite\b/i, /\bvitejs\b/i]
  },
  {
    key: 'typescript',
    label: 'TypeScript',
    simpleIcon: 'typescript',
    devicon: 'typescript',
    color: '3178C6',
    initials: 'TS',
    patterns: [/\btypescript\b/i, /\bts\b(?=.*(?:前端|类型|工程|技术栈|react|vite))/i]
  },
  {
    key: 'javascript',
    label: 'JavaScript',
    simpleIcon: 'javascript',
    devicon: 'javascript',
    color: 'F7DF1E',
    initials: 'JS',
    patterns: [/\bjavascript\b/i, /\bjs\b(?=.*(?:前端|脚本|工程|技术栈|react|vite|node))/i]
  },
  {
    key: 'nodejs',
    label: 'Node.js',
    simpleIcon: 'nodedotjs',
    devicon: 'nodejs',
    color: '5FA04E',
    initials: 'Nd',
    patterns: [/\bnode\.?js\b/i, /\bnodejs\b/i]
  },
  {
    key: 'vue',
    label: 'Vue.js',
    simpleIcon: 'vuedotjs',
    devicon: 'vuejs',
    color: '4FC08D',
    initials: 'Vue',
    patterns: [/\bvue(?:\.js)?\b/i, /\bvuejs\b/i]
  },
  {
    key: 'nextjs',
    label: 'Next.js',
    simpleIcon: 'nextdotjs',
    devicon: 'nextjs',
    color: '000000',
    initials: 'Nx',
    patterns: [/\bnext\.?js\b/i, /\bnextjs\b/i]
  },
  {
    key: 'tailwindcss',
    label: 'Tailwind CSS',
    simpleIcon: 'tailwindcss',
    devicon: 'tailwindcss',
    color: '06B6D4',
    initials: 'Tw',
    patterns: [/\btailwind(?:\s*css)?\b/i]
  },
  {
    key: 'docker',
    label: 'Docker',
    simpleIcon: 'docker',
    devicon: 'docker',
    color: '2496ED',
    initials: 'Do',
    patterns: [/\bdocker\b/i, /容器(?:化)?/i]
  },
  {
    key: 'kubernetes',
    label: 'Kubernetes',
    simpleIcon: 'kubernetes',
    devicon: 'kubernetes',
    color: '326CE5',
    initials: 'K8s',
    patterns: [/\bkubernetes\b/i, /\bk8s\b/i]
  },
  {
    key: 'mysql',
    label: 'MySQL',
    simpleIcon: 'mysql',
    devicon: 'mysql',
    color: '4479A1',
    initials: 'My',
    patterns: [/\bmysql\b/i]
  },
  {
    key: 'mongodb',
    label: 'MongoDB',
    simpleIcon: 'mongodb',
    devicon: 'mongodb',
    color: '47A248',
    initials: 'Mo',
    patterns: [/\bmongodb\b/i, /\bmongo\b/i]
  },
  {
    key: 'nginx',
    label: 'NGINX',
    simpleIcon: 'nginx',
    devicon: 'nginx',
    color: '009639',
    initials: 'Nx',
    patterns: [/\bnginx\b/i]
  },
  {
    key: 'python',
    label: 'Python',
    simpleIcon: 'python',
    devicon: 'python',
    color: '3776AB',
    initials: 'Py',
    patterns: [/\bpython\b/i]
  },
  {
    key: 'java',
    label: 'Java',
    simpleIcon: 'openjdk',
    devicon: 'java',
    color: 'EA2D2E',
    initials: 'Java',
    patterns: [/\bjava\b/i, /\bopenjdk\b/i]
  },
  {
    key: 'spring',
    label: 'Spring',
    simpleIcon: 'spring',
    devicon: 'spring',
    color: '6DB33F',
    initials: 'Sp',
    patterns: [/\bspring(?:\s*boot)?\b/i]
  },
  {
    key: 'kafka',
    label: 'Apache Kafka',
    simpleIcon: 'apachekafka',
    color: '231F20',
    initials: 'Kf',
    patterns: [/\bkafka\b/i, /\bapache\s*kafka\b/i]
  },
  {
    key: 'rabbitmq',
    label: 'RabbitMQ',
    simpleIcon: 'rabbitmq',
    devicon: 'rabbitmq',
    color: 'FF6600',
    initials: 'MQ',
    patterns: [/\brabbitmq\b/i, /\brabbit\s*mq\b/i]
  },
  {
    key: 'elasticsearch',
    label: 'Elasticsearch',
    simpleIcon: 'elasticsearch',
    devicon: 'elasticsearch',
    color: '005571',
    initials: 'ES',
    patterns: [/\belasticsearch\b/i, /\belastic\s*search\b/i]
  },
  {
    key: 'git',
    label: 'Git',
    simpleIcon: 'git',
    devicon: 'git',
    color: 'F05032',
    initials: 'Git',
    patterns: [/\bgit\b/i]
  },
  {
    key: 'linux',
    label: 'Linux',
    simpleIcon: 'linux',
    devicon: 'linux',
    color: 'FCC624',
    initials: 'Ln',
    patterns: [/\blinux\b/i]
  },
  {
    key: 'fastapi',
    label: 'FastAPI',
    simpleIcon: 'fastapi',
    devicon: 'fastapi',
    color: '009688',
    initials: 'FA',
    patterns: [/\bfastapi\b/i, /\bfast\s*api\b/i]
  },
  {
    key: 'flask',
    label: 'Flask',
    simpleIcon: 'flask',
    devicon: 'flask',
    color: '000000',
    initials: 'Fl',
    patterns: [/\bflask\b/i]
  },
  {
    key: 'django',
    label: 'Django',
    simpleIcon: 'django',
    devicon: 'django',
    color: '092E20',
    initials: 'Dj',
    patterns: [/\bdjango\b/i]
  },
  {
    key: 'graphql',
    label: 'GraphQL',
    simpleIcon: 'graphql',
    devicon: 'graphql',
    color: 'E10098',
    initials: 'GQL',
    patterns: [/\bgraphql\b/i, /\bgraph\s*ql\b/i]
  }
];

const TECH_CONTEXT_PATTERN = /技术栈|tech\s*stack|架构|前端|后端|数据库|缓存|接口|api|框架|组件|中间件|微服务|开发|工程|服务端|客户端|性能测试|压测|实时通信|websocket|postgres|redis|react|vite|typescript|docker|kubernetes|k8s/i;
const VISUAL_INTENT_PATTERN = /logo|logos|icon|icons|图标|标志|标识|品牌|技术栈图|技术栈卡片|架构图标/i;

const WEB_IMAGE_NEED_RULES = [
  {
    key: 'warehouse_robot',
    kind: 'product_scene',
    label: '仓储搬运机器人场景',
    query: 'warehouse autonomous mobile robot',
    filename: 'web_scene_warehouse_robot.jpg',
    purpose: '仓储/物流/搬运机器人真实场景图',
    orientation: 'landscape',
    priority: 98,
    patterns: [/仓储|仓库|物流|搬运机器人|移动机器人|agv|amr|warehouse|logistics/i]
  },
  {
    key: 'robot_navigation',
    kind: 'product_device',
    label: '机器人视觉导航/SLAM',
    query: 'autonomous robot lidar navigation',
    filename: 'web_scene_robot_navigation.jpg',
    purpose: '机器人视觉 SLAM / 路径规划配图',
    orientation: 'landscape',
    priority: 96,
    patterns: [/slam|路径规划|视觉导航|激光雷达|lidar|机器人导航|robot navigation/i]
  },
  {
    key: 'smart_factory',
    kind: 'industry_scene',
    label: '智能制造车间',
    query: 'smart factory production line',
    filename: 'web_scene_smart_factory.jpg',
    purpose: '工厂/车间/智能制造场景图',
    orientation: 'landscape',
    priority: 90,
    patterns: [/车间|工厂|制造|产线|工业|智能制造|factory|manufacturing/i]
  },
  {
    key: 'industrial_robot',
    kind: 'product_device',
    label: '工业机器人设备',
    query: 'industrial robot arm factory',
    filename: 'web_device_industrial_robot.jpg',
    purpose: '工业机器人/机械臂/自动化设备图',
    orientation: 'landscape',
    priority: 88,
    patterns: [/机械臂|工业机器人|自动化设备|robot arm|industrial robot/i]
  },
  {
    key: 'data_center',
    kind: 'infrastructure',
    label: '数据中心/算力基础设施',
    query: 'data center server racks',
    filename: 'web_scene_data_center.jpg',
    purpose: '云计算/算力/服务器/数据中心场景图',
    orientation: 'landscape',
    priority: 84,
    patterns: [/数据中心|服务器|云计算|算力|机房|server|data center|cloud infrastructure/i]
  },
  {
    key: 'ai_team',
    kind: 'people_scene',
    label: '工程团队协作',
    query: 'engineering team collaboration office',
    filename: 'web_scene_engineering_team.jpg',
    purpose: '团队协作/项目管理/产品研发场景图',
    orientation: 'landscape',
    priority: 62,
    patterns: [/团队|协作|会议|研发团队|项目管理|工程师|team collaboration|workshop/i]
  },
  {
    key: 'laboratory',
    kind: 'research_scene',
    label: '科研实验室',
    query: 'research laboratory technology',
    filename: 'web_scene_laboratory.jpg',
    purpose: '科研/实验/技术验证场景图',
    orientation: 'landscape',
    priority: 72,
    patterns: [/实验室|科研|实验|测试平台|验证平台|laboratory|research/i]
  },
  {
    key: 'hospital_technology',
    kind: 'industry_scene',
    label: '医疗科技场景',
    query: 'hospital medical technology',
    filename: 'web_scene_medical_technology.jpg',
    purpose: '医疗/医院/医学科技场景图',
    orientation: 'landscape',
    priority: 76,
    patterns: [/医疗|医院|医学|临床|健康|medical|hospital|healthcare/i]
  },
  {
    key: 'classroom',
    kind: 'education_scene',
    label: '教育课堂场景',
    query: 'university classroom lecture',
    filename: 'web_scene_classroom.jpg',
    purpose: '教育/课堂/培训/高校场景图',
    orientation: 'landscape',
    priority: 70,
    patterns: [/教育|课堂|课程|培训|高校|大学|教学|classroom|university|education/i]
  },
  {
    key: 'drone_agriculture',
    kind: 'industry_scene',
    label: '智慧农业/无人机',
    query: 'agriculture drone field',
    filename: 'web_scene_agriculture_drone.jpg',
    purpose: '智慧农业/无人机/田间巡检场景图',
    orientation: 'landscape',
    priority: 78,
    patterns: [/农业|农田|无人机|巡检|智慧农业|drone|agriculture/i]
  },
  {
    key: 'renewable_energy',
    kind: 'industry_scene',
    label: '新能源场景',
    query: 'solar panels wind farm',
    filename: 'web_scene_renewable_energy.jpg',
    purpose: '新能源/光伏/风电/能源转型场景图',
    orientation: 'landscape',
    priority: 76,
    patterns: [/新能源|光伏|风电|能源|储能|碳中和|solar|wind farm|renewable/i]
  },
  {
    key: 'electric_vehicle',
    kind: 'product_scene',
    label: '新能源汽车/充电',
    query: 'electric vehicle charging station',
    filename: 'web_scene_electric_vehicle.jpg',
    purpose: '新能源汽车/充电桩/智能驾驶场景图',
    orientation: 'landscape',
    priority: 76,
    patterns: [/新能源汽车|电动车|充电桩|智能驾驶|自动驾驶|electric vehicle|ev charging/i]
  },
  {
    key: 'cybersecurity',
    kind: 'infrastructure',
    label: '网络安全/运维监控',
    query: 'cybersecurity operations center',
    filename: 'web_scene_cybersecurity.jpg',
    purpose: '网络安全/运维/监控中心场景图',
    orientation: 'landscape',
    priority: 74,
    patterns: [/网络安全|安全运营|攻防|漏洞|风控|监控中心|cybersecurity|security operation/i]
  },
  {
    key: 'finance',
    kind: 'industry_scene',
    label: '金融/交易场景',
    query: 'financial trading screens',
    filename: 'web_scene_finance.jpg',
    purpose: '金融/交易/投资/数据看板场景图',
    orientation: 'landscape',
    priority: 68,
    patterns: [/金融|投资|证券|银行|交易|风控|finance|trading|banking/i]
  },
  {
    key: 'chip',
    kind: 'product_device',
    label: '芯片/半导体',
    query: 'semiconductor chip close up',
    filename: 'web_device_chip.jpg',
    purpose: '芯片/半导体/硬件设备配图',
    orientation: 'landscape',
    priority: 82,
    patterns: [/芯片|半导体|集成电路|gpu|cpu|npu|semiconductor|chip/i]
  },
  {
    key: 'mobile_device',
    kind: 'product_device',
    label: '移动设备/产品实拍',
    query: 'smartphone device close up',
    filename: 'web_device_smartphone.jpg',
    purpose: '手机/移动终端/产品设备图',
    orientation: 'landscape',
    priority: 64,
    patterns: [/手机|移动端|终端设备|智能硬件|smartphone|mobile device/i]
  }
];

const CITY_VISUALS = [
  ['北京', 'Beijing skyline'],
  ['上海', 'Shanghai skyline'],
  ['广州', 'Guangzhou skyline'],
  ['深圳', 'Shenzhen skyline'],
  ['杭州', 'Hangzhou West Lake skyline'],
  ['重庆', 'Chongqing skyline'],
  ['成都', 'Chengdu skyline'],
  ['武汉', 'Wuhan skyline'],
  ['南京', 'Nanjing skyline'],
  ['西安', 'Xi an city wall'],
  ['苏州', 'Suzhou city canal'],
  ['厦门', 'Xiamen skyline'],
  ['香港', 'Hong Kong skyline'],
  ['纽约', 'New York skyline'],
  ['伦敦', 'London skyline'],
  ['东京', 'Tokyo skyline'],
  ['巴黎', 'Paris city landmark']
];

const PERSON_VISUALS = [
  ['乔布斯', 'Steve Jobs portrait'],
  ['史蒂夫·乔布斯', 'Steve Jobs portrait'],
  ['马斯克', 'Elon Musk portrait'],
  ['埃隆·马斯克', 'Elon Musk portrait'],
  ['图灵', 'Alan Turing portrait'],
  ['Alan Turing', 'Alan Turing portrait'],
  ['爱因斯坦', 'Albert Einstein portrait'],
  ['牛顿', 'Isaac Newton portrait'],
  ['达尔文', 'Charles Darwin portrait'],
  ['居里夫人', 'Marie Curie portrait'],
  ['马云', 'Jack Ma portrait'],
  ['任正非', 'Ren Zhengfei portrait'],
  ['雷军', 'Lei Jun portrait']
];

class PptWebVisualAssetService {
  static getTechLogoDefinitions() {
    return TECH_LOGOS.map(item => ({ ...item }));
  }

  static detectTechLogos(text, { max = 12 } = {}) {
    const value = String(text || '');
    if (!value.trim()) return [];

    const hasTechContext = TECH_CONTEXT_PATTERN.test(value);
    const hasVisualIntent = VISUAL_INTENT_PATTERN.test(value);
    if (!hasTechContext && !hasVisualIntent) return [];

    const found = [];
    for (const logo of TECH_LOGOS) {
      if (!this.matchesLogo(logo, value)) continue;
      found.push({ ...logo });
      if (found.length >= max) break;
    }

    return found;
  }

  static findBestTechLogo(text) {
    const value = String(text || '');
    if (!value.trim()) return null;
    return TECH_LOGOS.find(logo => this.matchesLogo(logo, value)) || null;
  }

  static matchesLogo(logo, text) {
    const value = String(text || '');
    return (logo.patterns || []).some(pattern => pattern.test(value));
  }

  static isLogoLikeRequest(text) {
    return VISUAL_INTENT_PATTERN.test(String(text || ''));
  }

  static detectWebImageNeeds({ text = '', pageTitles = [], max = 4 } = {}) {
    const combined = [
      text,
      ...(Array.isArray(pageTitles) ? pageTitles : [])
    ].filter(Boolean).join('\n');
    if (!combined.trim() || max <= 0) return [];

    const candidates = [];
    const add = item => {
      if (!item?.key || candidates.some(existing => existing.key === item.key)) return;
      candidates.push(item);
    };

    WEB_IMAGE_NEED_RULES.forEach(rule => {
      if (!(rule.patterns || []).some(pattern => pattern.test(combined))) return;
      add(this.webImageNeedFromRule(rule));
    });

    CITY_VISUALS.forEach(([name, query]) => {
      if (!combined.includes(name)) return;
      add({
        key: `city_${this.slugify(name)}`,
        kind: 'place',
        label: `${name}城市/地点图`,
        query,
        filename: `web_place_${this.slugify(name)}.jpg`,
        purpose: `${name}城市、园区或地点视觉素材`,
        orientation: 'landscape',
        priority: 66
      });
    });

    PERSON_VISUALS.forEach(([name, query]) => {
      if (!new RegExp(this.escapeRegExp(name), 'i').test(combined)) return;
      add({
        key: `person_${this.slugify(name)}`,
        kind: 'person',
        label: `${name}人物图`,
        query,
        filename: `web_person_${this.slugify(name)}.jpg`,
        purpose: `${name}人物/历史节点视觉素材`,
        orientation: 'portrait',
        priority: 86
      });
    });

    return candidates
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, max);
  }

  static webImageNeedFromRule(rule) {
    return {
      key: rule.key,
      kind: rule.kind || 'web_image',
      label: rule.label,
      query: rule.query,
      filename: rule.filename,
      purpose: rule.purpose || rule.label,
      type: 'Photography',
      acquireVia: 'web',
      status: 'Pending',
      reference: rule.query,
      description: rule.purpose || rule.label || rule.query,
      orientation: rule.orientation || 'landscape',
      priority: rule.priority || 0
    };
  }

  static safeLogoFilename(logo, preferredFilename = '') {
    const preferred = String(preferredFilename || '').trim();
    const ext = path.extname(preferred).toLowerCase();
    const rawBase = ext ? path.basename(preferred, ext) : preferred;
    const base = this.slugify(rawBase || `web_logo_${logo.key}`);
    return `${base || `web_logo_${logo.key}`}.png`;
  }

  static async sourceTechLogo({ logo, outputDir, filename, size = DEFAULT_LOGO_SIZE }) {
    if (!logo?.key) throw new Error('缺少 logo 定义');
    if (!outputDir) throw new Error('缺少输出目录');

    fs.mkdirSync(outputDir, { recursive: true });
    const safeFilename = this.safeLogoFilename(logo, filename);
    const outputPath = path.join(outputDir, safeFilename);

    if (fs.existsSync(outputPath)) {
      return this.buildLogoResult({
        logo,
        outputPath,
        filename: safeFilename,
        provider: 'local-cache',
        sourceUrl: '',
        fallbackGenerated: false
      });
    }

    const candidates = this.logoCandidateUrls(logo);
    const failures = [];
    for (const candidate of candidates) {
      try {
        const { buffer, contentType, finalUrl } = await this.fetchRemoteAsset(candidate.url, {
          maxBytes: MAX_LOGO_BYTES,
          accept: 'image/svg+xml,image/*,*/*;q=0.8'
        });
        await this.writeLogoBufferAsPng(buffer, outputPath, {
          size,
          contentType
        });
        return this.buildLogoResult({
          logo,
          outputPath,
          filename: safeFilename,
          provider: candidate.provider,
          sourceUrl: finalUrl || candidate.url,
          fallbackGenerated: false
        });
      } catch (error) {
        failures.push(`${candidate.provider}: ${error.message}`);
      }
    }

    await this.writeFallbackLogoPng(logo, outputPath, { size });
    return this.buildLogoResult({
      logo,
      outputPath,
      filename: safeFilename,
      provider: 'local-fallback',
      sourceUrl: '',
      fallbackGenerated: true,
      warning: failures.join('; ')
    });
  }

  static logoCandidateUrls(logo) {
    const urls = [];
    if (logo.simpleIcon) {
      urls.push({
        provider: 'simple-icons-cdn',
        url: `${SIMPLE_ICONS_CDN}/${encodeURIComponent(logo.simpleIcon)}/${logo.color || '111111'}`
      });
      urls.push({
        provider: 'simple-icons-jsdelivr',
        url: `${SIMPLE_ICONS_JSDELIVR}/${encodeURIComponent(logo.simpleIcon)}.svg`
      });
    }
    if (logo.devicon) {
      urls.push({
        provider: 'devicon-original',
        url: `${DEVICON_CDN}/${encodeURIComponent(logo.devicon)}/${encodeURIComponent(logo.devicon)}-original.svg`
      });
      urls.push({
        provider: 'devicon-plain',
        url: `${DEVICON_CDN}/${encodeURIComponent(logo.devicon)}/${encodeURIComponent(logo.devicon)}-plain.svg`
      });
    }
    return urls;
  }

  static async fetchRemoteAsset(url, { maxBytes = MAX_LOGO_BYTES, accept = 'image/*,*/*;q=0.8' } = {}) {
    const safeUrl = await assertSafeRemoteUrl(url, { allowedProtocols: ['http:', 'https:'] });
    const response = await axios.get(safeUrl.toString(), {
      ...safeAxiosOptions(),
      responseType: 'arraybuffer',
      timeout: 12000,
      maxRedirects: 3,
      maxContentLength: maxBytes,
      headers: {
        'User-Agent': 'AI Designer PPT Web Visual Asset Fetcher/1.0',
        Accept: accept
      },
      validateStatus: status => status >= 200 && status < 400
    });

    const buffer = Buffer.from(response.data || []);
    if (!buffer.length) throw new Error('远程资源为空');
    if (buffer.length > maxBytes) throw new Error('远程资源过大');

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && !/^image\//.test(contentType) && !/xml|svg|octet-stream|text\/plain/.test(contentType)) {
      throw new Error(`远程资源不是图片: ${contentType}`);
    }

    return {
      buffer,
      contentType,
      finalUrl: response.request?.res?.responseUrl || safeUrl.toString()
    };
  }

  static async writeLogoBufferAsPng(buffer, outputPath, { size = DEFAULT_LOGO_SIZE } = {}) {
    await sharp(buffer, { density: 384 })
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png({ compressionLevel: 9 })
      .toFile(outputPath);
  }

  static async writeFallbackLogoPng(logo, outputPath, { size = DEFAULT_LOGO_SIZE } = {}) {
    const color = /^([0-9a-f]{6})$/i.test(String(logo.color || ''))
      ? `#${logo.color}`
      : '#2563EB';
    const text = this.escapeXml(logo.initials || logo.label || logo.key || 'AI');
    const label = this.escapeXml(logo.label || logo.key || 'Logo');
    const fontSize = text.length > 3 ? 120 : 150;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="${color}"/>
  <circle cx="${Math.round(size * 0.76)}" cy="${Math.round(size * 0.24)}" r="${Math.round(size * 0.16)}" fill="#FFFFFF" opacity="0.16"/>
  <text x="50%" y="49%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#FFFFFF">${text}</text>
  <text x="50%" y="72%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="44" font-weight="600" fill="#FFFFFF" opacity="0.82">${label}</text>
</svg>`;
    await sharp(Buffer.from(svg), { density: 256 })
      .resize(size, size, { fit: 'contain' })
      .png({ compressionLevel: 9 })
      .toFile(outputPath);
  }

  static buildLogoResult({ logo, outputPath, filename, provider, sourceUrl, fallbackGenerated, warning = '' }) {
    return {
      key: logo.key,
      label: logo.label,
      filename,
      path: outputPath,
      sourceUrl,
      provider,
      fallbackGenerated: Boolean(fallbackGenerated),
      warning,
      description: `${logo.label || logo.key} 技术栈图标`
    };
  }

  static slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  static escapeXml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  static escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = PptWebVisualAssetService;
