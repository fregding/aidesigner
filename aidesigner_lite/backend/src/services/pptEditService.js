const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const AiService = require('./aiService');
const RuntimeConfigService = require('./runtimeConfigService');
const File = require('../models/File');
const User = require('../models/User');
const appConfig = require('../config/appConfig');
const PptImportEditService = require('./pptImportEditService');

const DEFAULT_PPT_MASTER_ROOT = appConfig.defaultPptMasterRoot;
const DEFAULT_PPT_MASTER_PYTHON = appConfig.defaultPptMasterPython;

class PptEditService {
  static async editTask({ task, instruction, pageIndex }) {
    if (PptImportEditService.isImportedTask(task)) {
      const proposal = await PptImportEditService.createProposal({ task, instruction, pageIndex });
      return PptImportEditService.applyProposal({ task, proposalId: proposal.id });
    }
    const proposal = await this.createProposal({ task, instruction, pageIndex });
    return this.applyProposal({ task, proposalId: proposal.id });
  }

  static getTaskContext(task) {
    if (PptImportEditService.isImportedTask(task)) {
      return PptImportEditService.getTaskContext(task);
    }
    if (!task || task.type !== 'ppt') {
      throw new Error('PPT任务不存在');
    }
    if (task.status !== 'completed') {
      throw new Error('这份 PPT 还没有生成完成，暂时不能修改');
    }
    const resultData = this.safeParseJson(task.result_data, {});
    const params = this.safeParseJson(task.params, {});
    const projectPath = this.resolveProjectPath(resultData);
    if (!projectPath) {
      throw new Error('没有找到这份 PPT 的工程目录');
    }

    const previewSvgs = this.listSvgFiles(projectPath, 'svg_final');
    const outputSvgs = this.listSvgFiles(projectPath, 'svg_output');
    const pageCount = Math.max(previewSvgs.length, outputSvgs.length, resultData.page_count || params.pageCount || 0);
    if (!pageCount) {
      throw new Error('没有找到可编辑页面');
    }

    return { resultData, params, projectPath, pageCount };
  }

  static async createProposal({ task, instruction, pageIndex, baseProposalId }) {
    if (PptImportEditService.isImportedTask(task)) {
      return PptImportEditService.createProposal({ task, instruction, pageIndex, baseProposalId });
    }
    const { resultData, params, projectPath, pageCount } = this.getTaskContext(task);
    const pages = this.resolveTargetPages({ instruction, pageIndex, pageCount });
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const editLog = [];
    const proposalId = this.newProposalId();
    const proposalDir = path.join(projectPath, `edit_proposal_${proposalId}`);
    const baseProposal = baseProposalId ? this.readProposal(projectPath, baseProposalId) : null;
    if (baseProposal && String(baseProposal.task_id || '') !== String(task.id || '')) {
      throw new Error('上一版修改提案不属于当前 PPT');
    }
    fs.mkdirSync(proposalDir, { recursive: true });

    for (const pageNum of pages) {
      const filename = this.pageFilename(pageNum);
      const svgPath = path.join(projectPath, 'svg_output', filename);
      const fallbackPath = path.join(projectPath, 'svg_final', filename);
      const baseProposalPath = baseProposal ? path.join(projectPath, `edit_proposal_${baseProposal.id}`, filename) : '';
      const sourcePath = baseProposalPath && fs.existsSync(baseProposalPath)
        ? baseProposalPath
        : (fs.existsSync(svgPath) ? svgPath : fallbackPath);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`第 ${pageNum} 页不存在`);
      }

      const originalSvg = fs.readFileSync(sourcePath, 'utf-8');
      const editedSvg = await this.generateEditedSvg({
        task,
        runtimeConfig,
        projectPath,
        params,
        resultData,
        pageNum,
        pageCount,
        instruction,
        originalSvg
      });

      const proposalSvgPath = path.join(proposalDir, filename);
      const preparedSvg = this.prepareProposalSvgAssets({
        svg: editedSvg,
        projectPath,
        proposalDir,
        resultData,
        instruction
      });
      fs.writeFileSync(proposalSvgPath, preparedSvg, 'utf-8');
      await this.runQualityCheck(proposalSvgPath, runtimeConfig, params.canvasFormat || params.canvas_format || 'ppt169');
      editLog.push({ page: pageNum, file: filename, preview_url: appConfig.pathToUploadUrl(proposalSvgPath) });
    }

    const proposal = {
      id: proposalId,
      task_id: task.id,
      instruction,
      pages,
      files: editLog,
      preview_svgs: editLog.map(item => item.preview_url),
      summary: this.buildProposalSummary({ instruction, pages }),
      base_proposal_id: baseProposal?.id || '',
      created_at: new Date().toISOString(),
      status: 'pending'
    };
    fs.writeFileSync(path.join(proposalDir, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf-8');
    return proposal;
  }

  static async applyProposal({ task, proposalId }) {
    if (PptImportEditService.isImportedTask(task)) {
      return PptImportEditService.applyProposal({ task, proposalId });
    }
    const { resultData, params, projectPath } = this.getTaskContext(task);
    const proposal = this.readProposal(projectPath, proposalId);
    if (String(proposal.task_id || '') !== String(task.id || '')) {
      throw new Error('修改提案不属于当前 PPT');
    }
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const editLog = [];
    const backups = [];

    let finalize = '';
    let exportResult = '';
    let pptxPath = '';
    try {
      for (const file of proposal.files || []) {
        const pageNum = parseInt(file.page, 10);
        const filename = file.file || this.pageFilename(pageNum);
        const svgPath = path.join(projectPath, 'svg_output', filename);
        const proposalSvgPath = path.join(projectPath, `edit_proposal_${proposal.id}`, filename);
        if (!fs.existsSync(proposalSvgPath)) {
          throw new Error(`修改提案缺少第 ${pageNum} 页文件`);
        }

        fs.mkdirSync(path.dirname(svgPath), { recursive: true });
        const hadOutputFile = fs.existsSync(svgPath);
        backups.push({
          svgPath,
          hadOutputFile,
          content: hadOutputFile ? fs.readFileSync(svgPath, 'utf-8') : null
        });
        if (hadOutputFile) {
          const backupDir = path.join(projectPath, 'edit_backups');
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(svgPath, path.join(backupDir, `${Date.now()}_${filename}`));
        }
        fs.copyFileSync(proposalSvgPath, svgPath);
        editLog.push({ page: pageNum, file: filename });
      }

      await this.runQualityCheck(projectPath, runtimeConfig, params.canvasFormat || params.canvas_format || 'ppt169');
      finalize = await this.runPptMasterScript('finalize_svg.py', [projectPath], { runtimeConfig, timeoutMs: 300000 });
      exportResult = await this.runPptMasterScript('svg_to_pptx.py', [projectPath, '-s', 'final'], { runtimeConfig, timeoutMs: 360000 });
      pptxPath = this.findGeneratedPptx(projectPath);
      if (!pptxPath) {
        throw new Error('修改后导出失败，没有生成 PPTX');
      }
    } catch (error) {
      this.restoreBackups(backups);
      try {
        await this.runPptMasterScript('finalize_svg.py', [projectPath], { runtimeConfig, timeoutMs: 300000 });
      } catch (restoreError) {
        console.warn('[PptEditService] 编辑失败后恢复 svg_final 失败:', restoreError.message);
      }
      throw error;
    }

    const nextResult = {
      ...resultData,
      status: 'completed',
      stage: 'done',
      progress: 100,
      download_url: appConfig.pathToUploadUrl(pptxPath),
      pptx_url: appConfig.pathToUploadUrl(pptxPath),
      file_id: this.createFileRecord({ task, pptxPath, title: resultData.title || params.title || task.prompt || 'ai-ppt' })?.id || resultData.file_id,
      preview_svgs: this.listPreviewSvgUrls(projectPath),
      project_dir: appConfig.pathToUploadUrl(projectPath),
      edited_at: new Date().toISOString(),
      edit_history: [
        ...(Array.isArray(resultData.edit_history) ? resultData.edit_history.slice(-9) : []),
        {
          instruction: proposal.instruction,
          proposal_id: proposal.id,
          pages: proposal.pages,
          edited_at: new Date().toISOString()
        }
      ]
    };
    this.markProposalStatus(projectPath, proposal.id, 'applied');

    return {
      resultData: nextResult,
      message: proposal.pages.length === 1
        ? `已应用第 ${proposal.pages[0]} 页的修改，并重新导出 PPTX。`
        : `已应用 ${proposal.pages.length} 页修改，并重新导出 PPTX。`,
      pages: proposal.pages,
      editLog,
      finalize: this.trimText(finalize, 600),
      export: this.trimText(exportResult, 600)
    };
  }

  static async generateEditedSvg({ task, runtimeConfig, projectPath, params, resultData, pageNum, pageCount, instruction, originalSvg }) {
    const designSpec = this.readOptional(path.join(projectPath, 'design_spec.md'), 18000);
    const specLock = this.readOptional(path.join(projectPath, 'spec_lock.md'), 12000);
    const sourceBrief = this.readOptional(path.join(projectPath, 'sources', 'source.md'), 7000);
    const imageAssets = this.listProjectImageAssets(projectPath, resultData)
      .map(item => `- ${item.href}（文件名：${item.name}；${item.description || '项目图片资产'}）`)
      .join('\n');

    const systemPrompt = [
      '你是 PPT SVG 编辑助手。用户已经打开了一份由 ppt-master 生成的 PPT，现在要求你只修改指定页面。',
      '你必须输出完整可用 SVG，不要输出解释，不要输出 Markdown 代码块。',
      '保持原 canvas/viewBox、页码、合法字体、合法颜色、图片 href 习惯和整体风格。',
      '只按用户指令修改必要区域，未被要求的内容和布局尽量保持不变。',
      '禁止输出占位失败页，禁止删除重要信息，禁止引用不存在的图片。',
      '如果需要使用项目里的图片，只能使用“可用图片资产”中列出的 href，必须逐字复制 href，不要改文件名、不要猜测 images/ 路径。',
      '当前编辑提案 SVG 会在提案目录运行质量检查；引用项目图片时优先使用 ../images/文件名，禁止使用不存在的 images/文件名。',
      '',
      `当前任务标题：${resultData.title || params.title || task.prompt || ''}`,
      `当前页：第 ${pageNum}/${pageCount} 页`,
      '',
      'design_spec 摘要：',
      this.trimText(designSpec, 9000),
      '',
      'spec_lock 摘要：',
      this.trimText(specLock, 7000),
      imageAssets ? `\n可用图片资产：\n${this.trimText(imageAssets, 3000)}` : '',
      sourceBrief ? `\n原始资料摘要：\n${this.trimText(sourceBrief, 4000)}` : ''
    ].filter(Boolean).join('\n');

    const userMessage = [
      `用户修改要求：${instruction}`,
      '',
      '请基于下面原始 SVG 直接产出修改后的完整 SVG：',
      this.trimText(originalSvg, 24000)
    ].join('\n');

    const model = runtimeConfig.pptExecutorModel || runtimeConfig.pptModel || runtimeConfig.chatModel || 'claude-opus-4-7';
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];
    const response = await AiService.chat({
      userId: task.user_id,
      model,
      messages,
      params: {
        route: 'ppt',
        temperature: 0.16,
        max_tokens: 7600,
        timeout_ms: Math.max(parseInt(runtimeConfig.pptTimeoutMs, 10) || 90000, 90000)
      },
      allowConfigOverride: true
    });
    const raw = response.choices?.[0]?.message?.content || '';
    User.billTokenUsage(task.user_id, response.usage, {
      source: 'ppt',
      legacyType: 'ppt',
      notePrefix: 'PPT助手乐米页面修改 token 计费',
      fallback: { messages, content: raw }
    });
    const svg = this.extractSvg(raw);
    if (!svg) {
      throw new Error('AI 没有返回有效 SVG');
    }
    return svg;
  }

  static prepareProposalSvgAssets({ svg = '', projectPath = '', proposalDir = '', resultData = {}, instruction = '' } = {}) {
    let nextSvg = String(svg || '');
    const hrefs = this.extractSvgImageHrefs(nextSvg)
      .filter(href => href && !/^data:/i.test(href) && !/^(https?:)?\/\//i.test(href));
    if (!hrefs.length) return nextSvg;

    const imageAssets = this.listProjectImageAssets(projectPath, resultData);
    hrefs.forEach(href => {
      const resolved = this.resolveProjectImageHref({
        href,
        projectPath,
        proposalDir,
        imageAssets,
        instruction
      });
      if (!resolved || resolved.href === href) return;
      nextSvg = this.replaceSvgHref(nextSvg, href, resolved.href);
    });
    return nextSvg;
  }

  static extractSvgImageHrefs(svg = '') {
    const hrefs = [];
    const pattern = /<image\b[^>]*(?:href|xlink:href)\s*=\s*(['"])(.*?)\1/gi;
    let match;
    while ((match = pattern.exec(String(svg || ''))) !== null) {
      hrefs.push(match[2] || '');
    }
    return hrefs;
  }

  static replaceSvgHref(svg = '', fromHref = '', toHref = '') {
    if (!fromHref || !toHref || fromHref === toHref) return svg;
    return String(svg || '').replace(new RegExp(this.escapeRegExp(fromHref), 'g'), toHref);
  }

  static resolveProjectImageHref({ href = '', projectPath = '', proposalDir = '', imageAssets = [], instruction = '' } = {}) {
    const normalizedHref = String(href || '').replace(/\\/g, '/').trim();
    if (!normalizedHref || !projectPath || !proposalDir) return null;

    const directPath = path.resolve(proposalDir, normalizedHref);
    if (this.isInsidePath(directPath, proposalDir) && fs.existsSync(directPath)) {
      return { href: normalizedHref, path: directPath };
    }

    if (/^(?:\.\.\/)?images\//i.test(normalizedHref)) {
      const projectImagePath = path.resolve(projectPath, normalizedHref.replace(/^\.\.\//, ''));
      if (this.isInsidePath(projectImagePath, path.join(projectPath, 'images')) && fs.existsSync(projectImagePath)) {
        return { href: path.relative(proposalDir, projectImagePath).split(path.sep).join('/'), path: projectImagePath };
      }
    }

    const match = this.findBestImageAssetMatch({
      href: normalizedHref,
      assets: imageAssets,
      instruction
    });
    if (!match?.path || !fs.existsSync(match.path)) return null;
    return {
      href: path.relative(proposalDir, match.path).split(path.sep).join('/'),
      path: match.path
    };
  }

  static findBestImageAssetMatch({ href = '', assets = [], instruction = '' } = {}) {
    if (!Array.isArray(assets) || !assets.length) return null;
    const hrefBase = path.basename(String(href || '')).toLowerCase();
    const hrefStem = this.normalizeAssetMatchText(path.basename(hrefBase, path.extname(hrefBase)));
    const instructionText = this.normalizeAssetMatchText(instruction);

    let best = null;
    let bestScore = -1;
    assets.forEach(asset => {
      const name = String(asset.name || '').toLowerCase();
      const stem = this.normalizeAssetMatchText(path.basename(name, path.extname(name)));
      let score = 0;
      if (name === hrefBase) score += 100;
      if (this.sharedLongNumberScore(name, hrefBase)) score += 70;
      if (stem && hrefStem && stem === hrefStem) score += 80;
      if (stem && hrefStem && (stem.includes(hrefStem) || hrefStem.includes(stem))) score += 55;
      const shared = this.sharedTokenScore(stem, hrefStem);
      score += shared * 12;
      const description = this.normalizeAssetMatchText(asset.description || '');
      if (instructionText && (instructionText.includes(stem) || (description && instructionText.includes(description)))) score += 18;
      if (score > bestScore) {
        best = asset;
        bestScore = score;
      }
    });
    return bestScore > 0 ? best : null;
  }

  static sharedLongNumberScore(a = '', b = '') {
    const extract = value => String(value || '').match(/\d{10,}/g) || [];
    const aNumbers = new Set(extract(a));
    return extract(b).some(number => aNumbers.has(number));
  }

  static listProjectImageAssets(projectPath = '', resultData = {}) {
    const imageDir = path.join(projectPath, 'images');
    const byName = new Map();
    const addAsset = (asset = {}) => {
      const candidateName = asset.filename
        || path.basename(asset.relativePath || asset.svgHref || asset.url || asset.path || '');
      if (!candidateName || !/\.(png|jpe?g|webp|gif|svg)$/i.test(candidateName)) return;
      const candidatePath = asset.path && fs.existsSync(asset.path)
        ? asset.path
        : path.join(imageDir, candidateName);
      if (!fs.existsSync(candidatePath)) return;
      const name = path.basename(candidatePath);
      if (byName.has(name)) return;
      byName.set(name, {
        name,
        path: candidatePath,
        href: `../images/${name}`,
        description: asset.description || asset.origin || ''
      });
    };

    if (Array.isArray(resultData.image_assets)) {
      resultData.image_assets.forEach(addAsset);
    }
    if (fs.existsSync(imageDir)) {
      fs.readdirSync(imageDir)
        .filter(name => /\.(png|jpe?g|webp|gif|svg)$/i.test(name))
        .forEach(name => addAsset({ filename: name, description: '项目 images/ 目录中的图片' }));
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  static normalizeAssetMatchText(value = '') {
    return String(value || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
      .trim();
  }

  static sharedTokenScore(a = '', b = '') {
    const tokens = value => String(value || '')
      .split(/(?=[a-z0-9])|(?<=[a-z0-9])|(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])/)
      .map(item => item.trim())
      .filter(Boolean);
    const aTokens = new Set(tokens(a));
    const bTokens = new Set(tokens(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let shared = 0;
    aTokens.forEach(token => {
      if (bTokens.has(token)) shared += 1;
    });
    return shared;
  }

  static isInsidePath(filePath, rootPath) {
    const relative = path.relative(rootPath, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  static escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  static resolveProjectPath(resultData = {}) {
    if (resultData.project_dir) {
      try {
        const p = appConfig.uploadUrlToPath(resultData.project_dir);
        if (fs.existsSync(p)) return p;
      } catch (error) {}
    }
    if (resultData.workflow_state_url) {
      try {
        const statePath = appConfig.uploadUrlToPath(resultData.workflow_state_url);
        const projectPath = path.dirname(statePath);
        if (fs.existsSync(projectPath)) return projectPath;
      } catch (error) {}
    }
    const firstPreview = Array.isArray(resultData.preview_svgs) ? resultData.preview_svgs[0] : '';
    if (firstPreview) {
      try {
        const svgPath = appConfig.uploadUrlToPath(firstPreview);
        const projectPath = path.dirname(path.dirname(svgPath));
        if (fs.existsSync(projectPath)) return projectPath;
      } catch (error) {}
    }
    return '';
  }

  static resolveTargetPages({ instruction = '', pageIndex, pageCount }) {
    const text = String(instruction || '');
    const pages = new Set();
    const numericPatterns = [
      /第\s*(\d{1,3})\s*页/g,
      /P\s*0?(\d{1,3})\b/gi,
      /slide\s*0?(\d{1,3})\b/gi
    ];
    numericPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const page = parseInt(match[1], 10);
        if (page >= 1 && page <= pageCount) pages.add(page);
      }
    });
    const chinesePagePattern = /第\s*([一二两三四五六七八九十百零〇]{1,6})\s*页/g;
    let chineseMatch;
    while ((chineseMatch = chinesePagePattern.exec(text)) !== null) {
      const page = this.parseChinesePageNumber(chineseMatch[1]);
      if (page >= 1 && page <= pageCount) pages.add(page);
    }

    if (pages.size > 0) return [...pages].sort((a, b) => a - b);

    const explicitIndex = parseInt(pageIndex, 10);
    if (/当前页|这一页|这页/i.test(text) && Number.isFinite(explicitIndex) && explicitIndex >= 0 && explicitIndex < pageCount) {
      return [explicitIndex + 1];
    }

    if (/整份|全部|所有页|全局|整体/i.test(text)) {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }

    if (Number.isFinite(explicitIndex) && explicitIndex >= 0 && explicitIndex < pageCount) {
      return [explicitIndex + 1];
    }
    return [1];
  }

  static parseChinesePageNumber(value) {
    const text = String(value || '').replace(/两/g, '二').replace(/〇/g, '零').trim();
    if (!text) return 0;
    const digits = {
      零: 0,
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9
    };
    if (/^[零一二三四五六七八九]+$/.test(text)) {
      return text.split('').reduce((num, char) => num * 10 + digits[char], 0);
    }
    if (text.includes('百')) {
      const [hundredsPart, rest = ''] = text.split('百');
      const hundreds = hundredsPart ? (digits[hundredsPart] || 0) : 1;
      return hundreds * 100 + this.parseChinesePageNumber(rest);
    }
    if (text.includes('十')) {
      const [tensPart, onesPart = ''] = text.split('十');
      const tens = tensPart ? (digits[tensPart] || 0) : 1;
      const ones = onesPart ? (digits[onesPart] || 0) : 0;
      return tens * 10 + ones;
    }
    return digits[text] || 0;
  }

  static createFileRecord({ task, pptxPath, title }) {
    try {
      return File.create({
        userId: task.user_id,
        taskId: task.id,
        filename: path.basename(pptxPath),
        originalName: `${String(title || 'ai-ppt').slice(0, 80)}.pptx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: fs.statSync(pptxPath).size,
        path: pptxPath,
        url: appConfig.pathToUploadUrl(pptxPath)
      });
    } catch (error) {
      console.warn('[PptEditService] 文件记录创建失败:', error.message);
      return null;
    }
  }

  static readProposal(projectPath, proposalId) {
    const safeId = String(proposalId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) throw new Error('修改提案不存在');
    const proposalPath = path.join(projectPath, `edit_proposal_${safeId}`, 'proposal.json');
    if (!fs.existsSync(proposalPath)) {
      throw new Error('修改提案不存在或已过期');
    }
    const proposal = this.safeParseJson(fs.readFileSync(proposalPath, 'utf-8'), null);
    if (!proposal?.id || !Array.isArray(proposal.files)) {
      throw new Error('修改提案数据无效');
    }
    return proposal;
  }

  static markProposalStatus(projectPath, proposalId, status) {
    try {
      const proposal = this.readProposal(projectPath, proposalId);
      proposal.status = status;
      proposal.updated_at = new Date().toISOString();
      const proposalPath = path.join(projectPath, `edit_proposal_${proposal.id}`, 'proposal.json');
      fs.writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf-8');
    } catch (error) {
      console.warn('[PptEditService] 修改提案状态更新失败:', error.message);
    }
  }

  static newProposalId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  static buildProposalSummary({ instruction, pages }) {
    const target = pages.length === 1
      ? `第 ${pages[0]} 页`
      : `${pages.length} 页`;
    return `准备修改 ${target}：${this.trimText(instruction, 120)}`;
  }

  static restoreBackups(backups = []) {
    backups.slice().reverse().forEach(backup => {
      try {
        if (!backup?.svgPath) return;
        if (backup.hadOutputFile) {
          fs.writeFileSync(backup.svgPath, backup.content || '', 'utf-8');
        } else if (fs.existsSync(backup.svgPath)) {
          fs.unlinkSync(backup.svgPath);
        }
      } catch (error) {
        console.warn('[PptEditService] 编辑失败回滚页面失败:', error.message);
      }
    });
  }

  static async runQualityCheck(projectPath, runtimeConfig, canvasFormat) {
    await this.runPptMasterScript('svg_quality_checker.py', [projectPath, '--format', canvasFormat], {
      runtimeConfig,
      timeoutMs: 180000
    });
  }

  static async runPptMasterScript(scriptName, args, { runtimeConfig, timeoutMs = 120000 } = {}) {
    const root = runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const python = this.resolvePython(runtimeConfig.pptMasterPython || DEFAULT_PPT_MASTER_PYTHON);
    const scriptPath = path.join(root, 'skills', 'ppt-master', 'scripts', scriptName);
    if (!fs.existsSync(scriptPath)) throw new Error(`找不到脚本: ${scriptPath}`);

    return new Promise((resolve, reject) => {
      execFile(python, [scriptPath, ...args], { cwd: root, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = [stdout, stderr, error.message].filter(Boolean).join('\n');
          reject(new Error(message || `${scriptName} 执行失败`));
          return;
        }
        resolve([stdout, stderr].filter(Boolean).join('\n').trim());
      });
    });
  }

  static resolvePython(pythonPath) {
    if (!pythonPath) return 'python3';
    if (fs.existsSync(pythonPath)) return pythonPath;
    return 'python3';
  }

  static listSvgFiles(projectPath, dirName) {
    const dir = path.join(projectPath, dirName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.svg')).sort();
  }

  static listPreviewSvgUrls(projectPath) {
    const dirName = fs.existsSync(path.join(projectPath, 'svg_final')) ? 'svg_final' : 'svg_output';
    return this.listSvgFiles(projectPath, dirName).map(name => appConfig.pathToUploadUrl(path.join(projectPath, dirName, name)));
  }

  static pageFilename(pageNum) {
    return `${String(pageNum).padStart(2, '0')}_slide_${pageNum}.svg`;
  }

  static findGeneratedPptx(projectPath) {
    const exportDir = path.join(projectPath, 'exports');
    if (!fs.existsSync(exportDir)) return null;
    const files = fs.readdirSync(exportDir)
      .filter(name => name.endsWith('.pptx'))
      .map(name => path.join(exportDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.find(file => !path.basename(file).includes('_svg')) || files[0] || null;
  }

  static extractSvg(raw = '') {
    const cleaned = String(raw || '').replace(/^```(?:svg|xml)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const match = cleaned.match(/<svg[\s\S]*?<\/svg>/i);
    return match ? match[0] : '';
  }

  static readOptional(filePath, maxChars = 10000) {
    try {
      if (!fs.existsSync(filePath)) return '';
      return this.trimText(fs.readFileSync(filePath, 'utf-8'), maxChars);
    } catch (error) {
      return '';
    }
  }

  static trimText(value = '', max = 1000) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n...[trimmed ${text.length - max} chars]`;
  }

  static safeParseJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }
}

module.exports = PptEditService;
