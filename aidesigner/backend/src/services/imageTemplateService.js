const fs = require('fs');
const path = require('path');

const EXTERNAL_REPO_DIR = path.join(__dirname, '../../../external/awesome-gpt-image-2');
const EXTERNAL_TEMPLATES_PATH = path.join(EXTERNAL_REPO_DIR, 'docs/templates.md');

const TEMPLATE_DEFINITIONS = [
  {
    id: 'poster',
    label: '海报排版',
    description: '活动、旅游、节日、品牌主视觉',
    recommendedSize: '9:16',
    promptPrefix: '请基于平台内置海报与排版模板生成图片。',
    structure: '主视觉、标题文案、副标题、版式、色彩、氛围、社媒传播用途',
    constraints: '主体不要太小；标题与主体不要互相遮挡；底部信息区不要拥挤；不要低端展板风；中文文字必须清晰可读。'
  },
  {
    id: 'product',
    label: '商品电商',
    description: '商品主图、广告图、卖点视觉',
    recommendedSize: '3:4',
    promptPrefix: '请基于平台内置商品与电商模板生成图片。',
    structure: '产品名称、核心卖点、棚拍或生活方式场景、镜头角度、材质细节、灯光、少量促销文案',
    constraints: '产品必须清晰完整；材质真实；文案只保留 1-2 句；不要满屏促销贴；不要让文字遮挡产品。'
  },
  {
    id: 'infographic',
    label: '信息图',
    description: '科普、图鉴、流程、数据说明',
    recommendedSize: '9:16',
    promptPrefix: '请基于平台内置信息可视化模板生成图片。',
    structure: '标题区、3-5 个模块、图标、短标题、1-2 句说明、流程/对比/关系/时间线结构',
    constraints: '模块数量明确；文字短且可读；信息层级清晰；不要过度拥挤；不要生成乱码或无意义小字。'
  },
  {
    id: 'photo',
    label: '写实摄影',
    description: '人像、街景、产品、场景摄影',
    recommendedSize: '4:3',
    promptPrefix: '请基于平台内置摄影写实模板生成图片。',
    structure: '拍摄主题、地点、镜头焦段、景深、光线、情绪、皮肤/材质/胶片颗粒细节',
    constraints: '避免塑料皮肤；保留真实瑕疵和材质纹理；不要过度磨皮；不要多余肢体或畸形结构。'
  },
  {
    id: 'illustration',
    label: '插画艺术',
    description: '封面、社媒插画、奇幻艺术',
    recommendedSize: '1:1',
    promptPrefix: '请基于平台内置插画与艺术模板生成图片。',
    structure: '题材、主角、画风、线条、配色、背景、构图、重点细节、发布用途',
    constraints: '锁定笔触和画风；主体轮廓清晰；背景不要抢主体；避免默认 AI 塑料风。'
  },
  {
    id: 'character',
    label: '人物角色',
    description: '头像、立绘、人设、动作表',
    recommendedSize: '3:4',
    promptPrefix: '请基于平台内置人物与角色模板生成图片。',
    structure: '角色身份、年龄、发型、服饰、配件、性格、姿态、表情、世界观、标志性元素',
    constraints: '角色特征一致；服装材质明确；不要换脸换衣；不要多余肢体；背景服务于角色。'
  },
  {
    id: 'ui',
    label: 'UI 界面',
    description: 'App、网页、控制台、产品截图',
    recommendedSize: '16:9',
    promptPrefix: '请基于平台内置 UI 与界面模板生成图片。',
    structure: '产品类型、平台、核心功能、顶部导航、卡片流、图表或操作区、信息层级、主色与强调色',
    constraints: '高保真 UI 截图；中文文字清晰可读；组件对齐；不要随机拼贴；按钮和图表要有明确层级。'
  },
  {
    id: 'architecture',
    label: '建筑空间',
    description: '室内、建筑、空间效果图',
    recommendedSize: '16:9',
    promptPrefix: '请基于平台内置建筑与空间模板生成图片。',
    structure: '空间类型、功能定位、风格、材质、空间结构、动线、自然采光或人工照明、视角',
    constraints: '使用人眼视角或明确镜头；控制透视变形；材质真实；冷暖光关系明确；不要空间结构混乱。'
  }
];

class ImageTemplateService {
  static getTemplates() {
    return TEMPLATE_DEFINITIONS.map(template => ({
      id: template.id,
      label: template.label,
      description: template.description,
      recommendedSize: template.recommendedSize
    }));
  }

  static findTemplate(templateId) {
    if (!templateId) return null;
    if (templateId === 'auto') return null;
    return TEMPLATE_DEFINITIONS.find(template => template.id === templateId) || null;
  }

  static inferTemplateType(prompt) {
    const text = String(prompt || '').toLowerCase();
    if (this.shouldPreservePrompt(text)) {
      return '';
    }

    const rules = [
      {
        id: 'ui',
        tokens: ['ui', '界面', '网页', '网站', 'app', 'dashboard', '控制台', '看板', '产品截图', '登陆页', '登录页']
      },
      {
        id: 'product',
        tokens: ['商品', '产品', '电商', '主图', '详情页', '广告图', '卖点', '包装', '促销', '瓶装', '护肤品', '饮料', '耳机', '手机']
      },
      {
        id: 'infographic',
        tokens: ['信息图', '图解', '科普', '图鉴', '流程图', '关系图', '时间线', '数据', '知识卡片', '百科', '拆解图', '结构图']
      },
      {
        id: 'architecture',
        tokens: ['建筑', '室内', '空间', '客厅', '办公室', '展厅', '店铺', '餐厅', '民宿', '酒店', '装修', '效果图']
      },
      {
        id: 'character',
        tokens: ['角色', '人设', '立绘', '头像', '表情包', '动作表', '设定图', '二次元人物', '游戏角色']
      },
      {
        id: 'photo',
        tokens: ['写真', '摄影', '照片', '人像', '街拍', '棚拍', '真实', '写实', '镜头', '胶片', '35mm', '50mm', '85mm']
      },
      {
        id: 'poster',
        tokens: ['海报', '封面', '宣传图', '活动', '旅游', '节日', '电影', '主视觉', '小红书封面', '社媒', 'banner']
      },
      {
        id: 'illustration',
        tokens: ['插画', '绘本', '漫画', '水彩', '厚涂', '扁平', '奇幻', '艺术风格', '画风']
      }
    ];

    let best = { id: '', score: 0 };
    for (const rule of rules) {
      const score = rule.tokens.reduce((total, token) => total + (text.includes(token.toLowerCase()) ? 1 : 0), 0);
      if (score > best.score) {
        best = { id: rule.id, score };
      }
    }

    if (best.score > 0) return best.id;

    if (/(猫|狗|动物|风景|城市|女孩|男孩|人物|场景|照片)/.test(text)) {
      return 'photo';
    }

    return '';
  }

  static shouldPreservePrompt(prompt) {
    const text = String(prompt || '').toLowerCase();
    return /变清晰|更清晰|高清|超清|清晰化|提高清晰度|清晰度|增强画质|画质增强|图像增强|图片增强|修复|去噪|降噪|锐化|无损放大|放大|upscale|enhance|sharpen|denoise|restore/.test(text);
  }

  static enhancePrompt(prompt, templateId) {
    return this.buildPromptEnhancement(prompt, templateId).prompt;
  }

  static buildPromptEnhancement(prompt, templateId) {
    const inferredTemplateId = templateId === 'auto' || !templateId ? this.inferTemplateType(prompt) : templateId;
    const template = this.findTemplate(inferredTemplateId);
    const cleanPrompt = String(prompt || '').trim();
    if (!template || !cleanPrompt) {
      return {
        prompt: cleanPrompt,
        templateType: '',
        templateLabel: ''
      };
    }

    const enhancedPrompt = [
      template.promptPrefix,
      `用户原始需求：${cleanPrompt}`,
      `系统自动识别任务类型：${template.label}`,
      `结构要求：${template.structure}`,
      `输出比例建议：${template.recommendedSize}`,
      `质量与防坑约束：${template.constraints}`,
      '最终画面要具有结构化提示词驱动的稳定控制感，稳定、可读、可复用，避免只堆砌空泛风格词。'
    ].join('\n');

    return {
      prompt: enhancedPrompt,
      templateType: template.id,
      templateLabel: template.label
    };
  }

  static getSourceInfo() {
    const exists = fs.existsSync(EXTERNAL_TEMPLATES_PATH);
    return {
      source: 'built-in-image-template-library',
      available: exists,
      updatedAt: exists ? fs.statSync(EXTERNAL_TEMPLATES_PATH).mtime.toISOString() : null
    };
  }
}

module.exports = ImageTemplateService;
