const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const AiService = require('./aiService');
const DocumentVisualPreviewService = require('./documentVisualPreviewService');
const RuntimeConfigService = require('./runtimeConfigService');
const File = require('../models/File');
const User = require('../models/User');
const appConfig = require('../config/appConfig');
const { normalizeUploadOriginalName } = require('../utils/uploadName');

const DEFAULT_PPT_MASTER_ROOT = appConfig.defaultPptMasterRoot;
const DEFAULT_PPT_MASTER_PYTHON = appConfig.defaultPptMasterPython;
const SVG_PAGE_DIR = 'svg_output';
const FINAL_PAGE_DIR = 'svg_final';
const NOTES_DIR = 'notes';
const SOURCES_DIR = 'sources';
const EXPORTS_DIR = 'exports';
const IMPORT_MANIFEST = 'import_pages.json';

class PptImportEditService {
  static isImportedTask(taskOrResultData) {
    const resultData = taskOrResultData?.result_data
      ? this.safeParseJson(taskOrResultData.result_data, {})
      : (taskOrResultData || {});
    return resultData?.edit_mode === 'imported_ppt'
      || resultData?.imported_ppt === true
      || resultData?.source_kind === 'uploaded_ppt';
  }

  static async importFileAsTask({ file, task }) {
    if (!file?.path || !fs.existsSync(file.path)) {
      throw new Error('上传的 PPT 文件不存在');
    }
    if (!task?.id || !task?.user_id) {
      throw new Error('导入任务不存在');
    }

    const params = this.safeParseJson(task.params, {});
    const sourceName = normalizeUploadOriginalName(file.original_name || file.filename || '', file.filename || '导入PPT');
    const sourceBaseName = path.basename(sourceName, path.extname(sourceName));
    const title = this.cleanTitle(params.title || params.projectTitle || task.prompt || sourceBaseName || '导入PPT');
    const canvasFormat = await this.detectCanvasFormat(file.path).catch(() => 'ppt169');
    const projectPath = this.createProjectDir({
      userId: task.user_id,
      taskId: task.id,
      title,
      canvasFormat
    });

    this.ensureProjectDirs(projectPath);
    this.writeProjectReadme(projectPath, { title, canvasFormat, sourceName });

    const sourceDir = path.join(projectPath, SOURCES_DIR);
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceExt = path.extname(file.path) || path.extname(sourceName || '') || '.pptx';
    const sourcePath = path.join(sourceDir, `original${sourceExt.toLowerCase()}`);
    fs.copyFileSync(file.path, sourcePath);

    const previewDir = path.join(projectPath, 'source_previews');
    fs.mkdirSync(previewDir, { recursive: true });
    const renderedPages = await DocumentVisualPreviewService.renderOfficeToImages(file.path, previewDir, {
      pageLimit: 120
    });
    if (!renderedPages.length) {
      throw new Error('没有生成 PPT 页面预览，请确认 LibreOffice 或 unoserver 可用');
    }

    const pages = [];
    for (let index = 0; index < renderedPages.length; index += 1) {
      const pageNum = index + 1;
      const pngPath = path.join(projectPath, 'images', `import_page_${String(pageNum).padStart(3, '0')}.png`);
      fs.copyFileSync(renderedPages[index], pngPath);

      const svgPath = path.join(projectPath, SVG_PAGE_DIR, this.pageFilename(pageNum));
      const svg = await this.buildImageBackedSvg({
        imagePath: pngPath,
        canvasFormat,
        pageNum
      });
      fs.writeFileSync(svgPath, svg, 'utf-8');
      fs.copyFileSync(svgPath, path.join(projectPath, FINAL_PAGE_DIR, this.pageFilename(pageNum)));
      const notePath = path.join(projectPath, NOTES_DIR, this.pageFilename(pageNum).replace(/\.svg$/i, '.md'));
      fs.writeFileSync(notePath, `# 第 ${pageNum} 页\n\n从上传 PPT 导入，未修改。\n`, 'utf-8');
      pages.push({
        page: pageNum,
        filename: this.pageFilename(pageNum),
        source: 'imported',
        original_image: appConfig.pathToUploadUrl(pngPath),
        preview_url: appConfig.pathToUploadUrl(svgPath),
        note_title: `第 ${pageNum} 页`,
        status: 'original'
      });
    }

    const sourceMarkdown = await this.convertSourceToMarkdown(file.path, projectPath).catch(error => {
      console.warn('[PptImportEditService] PPT 文本提取失败:', error.message);
      return '';
    });
    const styleProfile = await this.buildStyleProfile({
      task,
      title,
      canvasFormat,
      pages,
      sourceMarkdown,
      projectPath
    }).catch(error => {
      console.warn('[PptImportEditService] 风格摘要生成失败:', error.message);
      return this.fallbackStyleProfile({ title, canvasFormat, pages, sourceMarkdown });
    });

    fs.writeFileSync(path.join(projectPath, 'style_profile.md'), styleProfile, 'utf-8');
    this.writeManifest(projectPath, {
      task_id: task.id,
      user_id: task.user_id,
      title,
      canvas_format: canvasFormat,
      source_file_id: file.id,
      source_name: sourceName,
      source_url: file.url || '',
      source_path: sourcePath,
      page_count: pages.length,
      pages,
      imported_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const exportResult = await this.exportProject({ task, projectPath, title, canvasFormat });
    return this.buildResultData({
      task,
      projectPath,
      title,
      canvasFormat,
      pptxPath: exportResult.pptxPath,
      fileRecord: exportResult.fileRecord,
      sourceFile: { ...file, original_name: sourceName },
      styleProfile,
      message: '已导入原 PPT，可按页修改、加页或删页。'
    });
  }

  static getTaskContext(task) {
    if (!task || task.type !== 'ppt') throw new Error('PPT任务不存在');
    if (task.status !== 'completed') throw new Error('这份 PPT 还没有准备完成，暂时不能修改');
    const resultData = this.safeParseJson(task.result_data, {});
    if (!this.isImportedTask(resultData)) throw new Error('不是导入型 PPT 任务');
    const projectPath = this.resolveProjectPath(resultData);
    if (!projectPath) throw new Error('没有找到这份导入 PPT 的工程目录');
    const manifest = this.readManifest(projectPath);
    const pageCount = Math.max(
      Array.isArray(manifest.pages) ? manifest.pages.length : 0,
      Array.isArray(resultData.preview_svgs) ? resultData.preview_svgs.length : 0,
      resultData.page_count || 0
    );
    if (!pageCount) throw new Error('没有找到可编辑页面');
    return {
      resultData,
      params: this.safeParseJson(task.params, {}),
      projectPath,
      manifest,
      pageCount,
      canvasFormat: manifest.canvas_format || resultData.canvas_format || 'ppt169'
    };
  }

  static async createProposal({ task, instruction, pageIndex, baseProposalId }) {
    const context = this.getTaskContext(task);
    const operation = this.resolveOperation({ instruction, pageIndex, pageCount: context.pageCount });
    const proposalId = this.newProposalId();
    const proposalDir = path.join(context.projectPath, `edit_proposal_${proposalId}`);
    fs.mkdirSync(proposalDir, { recursive: true });

    const generatedFiles = [];
    const pagesForPreview = operation.type === 'delete'
      ? []
      : operation.pages;

    for (const pageNum of pagesForPreview) {
      const sourcePageNum = operation.type === 'insert_after'
        ? Math.max(1, Math.min(context.pageCount, Number(operation.insert_after) || 1))
        : Math.max(1, Math.min(context.pageCount, pageNum));
      const originalSvg = this.readPageSvg(context.projectPath, sourcePageNum);
      const previewImage = this.getPagePreviewImage(context, sourcePageNum);
      const editedSvg = await this.generateEditedSvg({
        task,
        context,
        operation,
        pageNum,
        sourcePageNum,
        instruction,
        originalSvg,
        previewImage
      });
      const filename = this.pageFilename(pageNum);
      const proposalSvgPath = path.join(proposalDir, filename);
      fs.writeFileSync(proposalSvgPath, editedSvg, 'utf-8');
      generatedFiles.push({
        page: pageNum,
        file: filename,
        preview_url: appConfig.pathToUploadUrl(proposalSvgPath)
      });
    }

    const proposal = {
      id: proposalId,
      task_id: task.id,
      instruction,
      operation,
      pages: operation.pages,
      files: generatedFiles,
      preview_svgs: generatedFiles.map(item => item.preview_url),
      summary: this.buildProposalSummary({ instruction, operation }),
      base_proposal_id: baseProposalId || '',
      created_at: new Date().toISOString(),
      status: 'pending',
      imported_ppt: true
    };
    fs.writeFileSync(path.join(proposalDir, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf-8');
    return proposal;
  }

  static async applyProposal({ task, proposalId }) {
    const context = this.getTaskContext(task);
    const proposal = this.readProposal(context.projectPath, proposalId);
    if (String(proposal.task_id || '') !== String(task.id || '')) {
      throw new Error('修改提案不属于当前 PPT');
    }

    const backups = this.createProjectBackup(context.projectPath);
    let manifest = this.readManifest(context.projectPath);
    const operation = proposal.operation || { type: 'replace', pages: proposal.pages || [] };
    const editLog = [];

    try {
      if (operation.type === 'delete') {
        const deleteSet = new Set((operation.pages || []).map(Number));
        manifest.pages = (manifest.pages || []).filter(page => !deleteSet.has(Number(page.page)));
        editLog.push(...Array.from(deleteSet).map(page => ({ page, action: 'delete' })));
      } else if (operation.type === 'insert_after') {
        const insertAfter = Math.max(0, Math.min(Number(operation.insert_after) || 0, manifest.pages.length));
        const proposalFile = (proposal.files || [])[0];
        if (!proposalFile) throw new Error('新增页提案缺少页面文件');
        const insertedPage = {
          page: insertAfter + 1,
          filename: proposalFile.file || this.pageFilename(insertAfter + 1),
          proposal_file: proposalFile.file || this.pageFilename(insertAfter + 1),
          proposal_id: proposal.id,
          source: 'ai_inserted',
          status: 'edited',
          edited_at: new Date().toISOString(),
          instruction: proposal.instruction || ''
        };
        manifest.pages.splice(insertAfter, 0, insertedPage);
        editLog.push({ page: insertAfter + 1, action: 'insert' });
      } else {
        for (const file of proposal.files || []) {
          const pageNum = Number(file.page);
          const index = manifest.pages.findIndex(page => Number(page.page) === pageNum);
          if (index >= 0) {
            manifest.pages[index] = {
              ...manifest.pages[index],
              proposal_file: file.file || this.pageFilename(pageNum),
              proposal_id: proposal.id,
              source: 'ai_replaced',
              status: 'edited',
              edited_at: new Date().toISOString(),
              instruction: proposal.instruction || ''
            };
          }
          editLog.push({ page: pageNum, action: 'replace' });
        }
      }

      this.rewritePagesFromManifest({
        projectPath: context.projectPath,
        manifest,
        proposal
      });

      manifest = this.readManifest(context.projectPath);
      const title = context.resultData.title || context.params.title || manifest.title || task.prompt || '导入PPT';
      const exportResult = await this.exportProject({
        task,
        projectPath: context.projectPath,
        title,
        canvasFormat: manifest.canvas_format || context.canvasFormat
      });
      this.markProposalStatus(context.projectPath, proposal.id, 'applied');

      const nextResult = this.buildResultData({
        task,
        projectPath: context.projectPath,
        title,
        canvasFormat: manifest.canvas_format || context.canvasFormat,
        pptxPath: exportResult.pptxPath,
        fileRecord: exportResult.fileRecord,
        sourceFile: {
          id: manifest.source_file_id,
          original_name: manifest.source_name,
          url: manifest.source_url
        },
        styleProfile: this.readOptional(path.join(context.projectPath, 'style_profile.md'), 6000),
        message: this.applyMessage(operation),
        previousResultData: {
          ...context.resultData,
          edit_history: [
            ...(Array.isArray(context.resultData.edit_history) ? context.resultData.edit_history.slice(-9) : []),
            {
              instruction: proposal.instruction || '',
              proposal_id: proposal.id,
              operation: operation.type || 'replace',
              pages: proposal.pages || [],
              changes: editLog,
              edited_at: new Date().toISOString()
            }
          ]
        }
      });

      return {
        resultData: nextResult,
        message: this.applyMessage(operation),
        pages: manifest.pages.map(page => page.page),
        editLog
      };
    } catch (error) {
      this.restoreProjectBackup(context.projectPath, backups);
      throw error;
    }
  }

  static async restoreCheckpoint({ task, checkpointId, sessionId = '' }) {
    const context = this.getTaskContext(task);
    const checkpoint = this.readCheckpoint(context.projectPath, checkpointId);
    if (String(checkpoint.task_id || '') !== String(task.id || '')) {
      throw new Error('检查点不属于当前 PPT');
    }
    if (sessionId && checkpoint.session_id && checkpoint.session_id !== sessionId) {
      throw new Error('检查点不属于当前会话');
    }

    const redoCheckpoint = this.createCheckpoint({
      task,
      snapshot: {
        projectPath: context.projectPath,
        title: context.resultData.title || task.prompt || '',
        page_count: context.pageCount,
        result_data: context.resultData,
        params: context.params
      },
      session: { session_id: sessionId || checkpoint.session_id || '' },
      label: '回退前',
      reason: 'before_restore'
    });

    this.restoreProjectBackup(context.projectPath, {
      dirs: ['svg_output', 'svg_final', 'notes'].map(dirName => ({
        source: path.join(context.projectPath, 'ppt_copilot_checkpoints', checkpoint.id, dirName),
        target: path.join(context.projectPath, dirName)
      })),
      files: [
        {
          source: path.join(context.projectPath, 'ppt_copilot_checkpoints', checkpoint.id, IMPORT_MANIFEST),
          target: path.join(context.projectPath, IMPORT_MANIFEST)
        }
      ]
    });

    const restoredManifest = this.readManifest(context.projectPath);
    this.renumberProjectPages(context.projectPath, restoredManifest);
    const title = checkpoint.title || context.resultData.title || task.prompt || '导入PPT';
    const exportResult = await this.exportProject({
      task,
      projectPath: context.projectPath,
      title,
      canvasFormat: restoredManifest.canvas_format || context.canvasFormat
    });
    const resultData = this.buildResultData({
      task,
      projectPath: context.projectPath,
      title,
      canvasFormat: restoredManifest.canvas_format || context.canvasFormat,
      pptxPath: exportResult.pptxPath,
      fileRecord: exportResult.fileRecord,
      sourceFile: {
        id: restoredManifest.source_file_id,
        original_name: restoredManifest.source_name,
        url: restoredManifest.source_url
      },
      styleProfile: this.readOptional(path.join(context.projectPath, 'style_profile.md'), 6000),
      message: '已回退到上一版',
      previousResultData: checkpoint.result_data || context.resultData
    });

    return {
      checkpoint,
      redo_checkpoint: redoCheckpoint,
      resultData,
      message: checkpoint.label ? `已回退到「${checkpoint.label}」。` : '已回退到上一版。'
    };
  }

  static createCheckpoint({ task, snapshot, session, label = '检查点', reason = 'manual', proposalId = '' }) {
    try {
      const projectPath = snapshot?.projectPath;
      if (!task?.id || !projectPath) return null;
      const checkpointId = `cp_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
      const checkpointDir = path.join(projectPath, 'ppt_copilot_checkpoints', checkpointId);
      fs.mkdirSync(checkpointDir, { recursive: true });
      ['svg_output', 'svg_final', 'notes'].forEach(dirName => {
        const sourceDir = path.join(projectPath, dirName);
        if (!fs.existsSync(sourceDir)) return;
        fs.cpSync(sourceDir, path.join(checkpointDir, dirName), { recursive: true });
      });
      const manifestPath = path.join(projectPath, IMPORT_MANIFEST);
      if (fs.existsSync(manifestPath)) {
        fs.copyFileSync(manifestPath, path.join(checkpointDir, IMPORT_MANIFEST));
      }
      const checkpoint = {
        id: checkpointId,
        task_id: task.id,
        user_id: task.user_id,
        session_id: session?.session_id || '',
        label,
        reason,
        proposal_id: proposalId || '',
        title: snapshot.title || '',
        page_count: snapshot.page_count || 0,
        result_data: snapshot.result_data || {},
        params: snapshot.params || {},
        project_dir: appConfig.pathToUploadUrl(projectPath),
        imported_ppt: true,
        created_at: new Date().toISOString()
      };
      fs.writeFileSync(path.join(checkpointDir, 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf-8');
      return checkpoint;
    } catch (error) {
      console.warn('[PptImportEditService] 创建检查点失败:', error.message);
      return null;
    }
  }

  static createWorkspaceSnapshot(task, resultDataOverride = null, requestContext = {}) {
    const context = this.getTaskContext(task);
    const resultData = resultDataOverride && typeof resultDataOverride === 'object'
      ? { ...context.resultData, ...resultDataOverride }
      : context.resultData;
    const manifest = this.readManifest(context.projectPath);
    const pages = (manifest.pages || []).map((page, index) => {
      const filename = page.filename || this.pageFilename(index + 1);
      const note = this.readPageNote(context.projectPath, filename);
      const svgPath = path.join(context.projectPath, SVG_PAGE_DIR, filename);
      return {
        index,
        page: index + 1,
        filename,
        has_output_svg: fs.existsSync(svgPath),
        has_final_svg: fs.existsSync(path.join(context.projectPath, FINAL_PAGE_DIR, filename)),
        output_url: fs.existsSync(svgPath) ? appConfig.pathToUploadUrl(svgPath) : '',
        preview_url: fs.existsSync(svgPath) ? appConfig.pathToUploadUrl(svgPath) : '',
        original_image: page.original_image || '',
        note_title: note.title || page.note_title || `第 ${index + 1} 页`,
        note_excerpt: note.excerpt || page.instruction || '从上传 PPT 导入的页面'
      };
    });

    return {
      task_id: task.id,
      user_id: task.user_id,
      status: task.status,
      title: resultData.title || manifest.title || task.prompt || '导入PPT',
      prompt: task.prompt || '',
      params: context.params,
      result_data: resultData,
      projectPath: context.projectPath,
      project_dir: appConfig.pathToUploadUrl(context.projectPath),
      page_count: pages.length,
      pages,
      assets: {
        images: this.listAssets(context.projectPath),
        uploaded: this.normalizeUploadedAssets(requestContext.workspaceFiles || requestContext.assets || [])
      },
      pending_proposals: this.listProposals(context.projectPath),
      edit_history: Array.isArray(resultData.edit_history) ? resultData.edit_history.slice(-10) : [],
      design_spec_excerpt: this.readOptional(path.join(context.projectPath, 'style_profile.md'), 1800),
      spec_lock_excerpt: '导入型 PPT：未修改页面保持原始截图；修改页面以新 SVG 替换；支持加页、删页、按页替换。'
    };
  }

  static async generateEditedSvg({ task, context, operation, pageNum, sourcePageNum, instruction, originalSvg, previewImage }) {
    const styleProfile = this.readOptional(path.join(context.projectPath, 'style_profile.md'), 9000);
    const pageNote = this.readPageNote(context.projectPath, this.pageFilename(sourcePageNum));
    const imageBlock = await this.buildVisionImageBlock(previewImage).catch(() => null);
    const systemPrompt = [
      '你是 PPT 页面重绘助手，正在修改一份上传导入的原始 PPT。',
      '当前系统的策略是：未被修改的页面保持原始截图，只有目标页会被替换为你输出的新 SVG。',
      '你必须输出完整 SVG，不要 Markdown，不要解释。',
      '保持 viewBox、画幅比例和原 PPT 的风格一致；优先保持颜色、字体气质、留白、信息层级和版式节奏。',
      '如果用户要求加页，生成一页与原 PPT 风格一致的新页面。',
      '如果用户要求改页，只改变用户要求的部分，其余信息尽量保留。',
      '禁止输出“无法生成”“占位说明”之类失败页。'
    ].join('\n');

    const userText = [
      `任务标题：${context.resultData.title || context.manifest.title || task.prompt || ''}`,
      `操作类型：${operation.type}`,
      `目标页：第 ${pageNum} 页；参考原页：第 ${sourcePageNum} 页；总页数：${context.pageCount}`,
      `用户要求：${instruction}`,
      '',
      '整套 PPT 风格和内容摘要：',
      styleProfile,
      '',
      `参考页文本摘要：${pageNote.title || ''} ${pageNote.excerpt || ''}`,
      '',
      '当前页 SVG 底稿：',
      this.trimText(originalSvg, 16000)
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: imageBlock
          ? [
            { type: 'text', text: userText },
            imageBlock
          ]
          : userText
      }
    ];

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const model = runtimeConfig.pptExecutorModel || runtimeConfig.pptModel || runtimeConfig.chatModel || 'claude-opus-4-7';
    const response = await AiService.chat({
      userId: task.user_id,
      model,
      messages,
      params: {
        route: 'ppt',
        temperature: 0.18,
        max_tokens: 7600,
        timeout_ms: Math.max(parseInt(runtimeConfig.pptTimeoutMs, 10) || 90000, 90000)
      },
      runtimeConfig,
      allowConfigOverride: true
    });
    const raw = response.choices?.[0]?.message?.content || '';
    User.billTokenUsage(task.user_id, response.usage, {
      source: 'ppt',
      legacyType: 'ppt',
      notePrefix: 'PPT助手乐米导入页修改 token 计费',
      fallback: { messages, content: raw }
    });
    const svg = this.extractSvg(raw);
    if (!svg) throw new Error('AI 没有返回有效 SVG');
    return this.ensureSvgCanvas(svg, context.canvasFormat);
  }

  static async buildVisionImageBlock(imageUrl) {
    if (!imageUrl) return null;
    const imagePath = appConfig.uploadUrlToPath(imageUrl);
    if (!fs.existsSync(imagePath)) return null;
    const buffer = await sharp(imagePath)
      .rotate()
      .resize({ width: 1280, withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    return {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${buffer.toString('base64')}`,
        detail: 'high'
      }
    };
  }

  static resolveOperation({ instruction = '', pageIndex, pageCount }) {
    const text = String(instruction || '').trim();
    const pages = this.resolveTargetPages({ instruction: text, pageIndex, pageCount });
    const destructivePageDelete = /(删除|删掉|去掉|移除|remove|delete)/i.test(text)
      && /(页|幻灯片|slide|slides|整页)/i.test(text)
      && !/(文字|文案|标题|副标题|元素|图片|图标|logo|LOGO|模块|背景|表格|图表)/.test(text);
    if (destructivePageDelete) {
      return { type: 'delete', pages };
    }
    if (/(新增|增加|添加|加一页|加页|插入|补一页|add.*slide|insert.*slide)/i.test(text)) {
      const base = pages.length ? pages[pages.length - 1] : this.normalizePageIndex(pageIndex, pageCount) + 1;
      const insertAfter = /前面|之前|前一页|before/i.test(text) ? Math.max(0, base - 1) : base;
      return { type: 'insert_after', pages: [insertAfter + 1], insert_after: insertAfter };
    }
    return { type: 'replace', pages };
  }

  static rewritePagesFromManifest({ projectPath, manifest, proposal = null }) {
    const outputDir = path.join(projectPath, SVG_PAGE_DIR);
    const finalDir = path.join(projectPath, FINAL_PAGE_DIR);
    const notesDir = path.join(projectPath, NOTES_DIR);
    const tempDir = path.join(projectPath, `.rewrite_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const snapshotOutput = path.join(tempDir, 'snapshot_output');
    const snapshotFinal = path.join(tempDir, 'snapshot_final');
    const snapshotNotes = path.join(tempDir, 'snapshot_notes');
    const nextOutput = path.join(tempDir, SVG_PAGE_DIR);
    const nextFinal = path.join(tempDir, FINAL_PAGE_DIR);
    const nextNotes = path.join(tempDir, NOTES_DIR);
    [snapshotOutput, snapshotFinal, snapshotNotes, nextOutput, nextFinal, nextNotes].forEach(dir => {
      fs.mkdirSync(dir, { recursive: true });
    });

    const proposalDir = proposal?.id ? path.join(projectPath, `edit_proposal_${proposal.id}`) : '';
    const nextPages = [];
    const seenFiles = new Set();
    (manifest.pages || []).forEach(page => {
      const oldFilename = page.filename || this.pageFilename(page.page || 1);
      if (seenFiles.has(oldFilename)) return;
      seenFiles.add(oldFilename);
      const oldOutputPath = path.join(outputDir, oldFilename);
      const oldFinalPath = path.join(finalDir, oldFilename);
      const oldNotePath = path.join(notesDir, String(oldFilename).replace(/\.svg$/i, '.md'));
      if (fs.existsSync(oldOutputPath)) fs.copyFileSync(oldOutputPath, path.join(snapshotOutput, oldFilename));
      if (fs.existsSync(oldFinalPath)) fs.copyFileSync(oldFinalPath, path.join(snapshotFinal, oldFilename));
      if (fs.existsSync(oldNotePath)) fs.copyFileSync(oldNotePath, path.join(snapshotNotes, path.basename(oldNotePath)));
    });
    (manifest.pages || []).forEach((page, index) => {
      const nextPage = index + 1;
      const targetFilename = this.pageFilename(nextPage);
      const useProposalFile = proposalDir
        && page.proposal_id
        && String(page.proposal_id) === String(proposal?.id || '')
        && page.proposal_file;
      const proposalPath = useProposalFile ? path.join(proposalDir, page.proposal_file) : '';
      const oldFilename = page.filename || this.pageFilename(page.page || nextPage);
      const snapshotOutputSource = path.join(snapshotOutput, oldFilename);
      const snapshotFinalSource = path.join(snapshotFinal, oldFilename);
      const oldOutputSnapshot = fs.existsSync(snapshotOutputSource) ? fs.readFileSync(snapshotOutputSource) : null;
      const oldFinalSnapshot = fs.existsSync(snapshotFinalSource) ? fs.readFileSync(snapshotFinalSource) : null;
      const oldNotePathForSnapshot = path.join(snapshotNotes, String(oldFilename).replace(/\.svg$/i, '.md'));
      const oldNoteSnapshot = fs.existsSync(oldNotePathForSnapshot) ? fs.readFileSync(oldNotePathForSnapshot, 'utf-8') : '';
      const sourceSvg = proposalPath && fs.existsSync(proposalPath)
        ? proposalPath
        : (fs.existsSync(snapshotOutputSource)
          ? snapshotOutputSource
          : (fs.existsSync(snapshotFinalSource)
            ? snapshotFinalSource
            : ''));
      const targetOutputPath = path.join(nextOutput, targetFilename);
      const targetFinalPath = path.join(nextFinal, targetFilename);
      const proposalBuffer = proposalPath && fs.existsSync(proposalPath) ? fs.readFileSync(proposalPath) : null;
      const outputBuffer = proposalBuffer || oldOutputSnapshot || oldFinalSnapshot;
      if (!outputBuffer) throw new Error(`第 ${page.page || nextPage} 页文件缺失`);
      fs.writeFileSync(targetOutputPath, outputBuffer);
      const finalBuffer = proposalBuffer || oldFinalSnapshot || outputBuffer;
      fs.writeFileSync(targetFinalPath, finalBuffer);
      const noteContent = proposalBuffer
        ? `# 第 ${nextPage} 页\n\nAI ${page.source === 'ai_inserted' ? '新增' : '替换'}页面：${page.instruction || proposal?.instruction || 'PPT 页面修改'}\n`
        : (oldNoteSnapshot || `# 第 ${nextPage} 页\n\n${page.instruction || 'PPT 页面'}\n`);
      fs.writeFileSync(path.join(nextNotes, targetFilename.replace(/\.svg$/i, '.md')), noteContent, 'utf-8');
      nextPages.push({
        ...page,
        page: nextPage,
        filename: targetFilename,
        preview_url: appConfig.pathToUploadUrl(path.join(outputDir, targetFilename))
      });
    });

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.rmSync(notesDir, { recursive: true, force: true });
    fs.cpSync(nextOutput, outputDir, { recursive: true });
    fs.cpSync(nextFinal, finalDir, { recursive: true });
    fs.cpSync(nextNotes, notesDir, { recursive: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    manifest.pages = nextPages;
    manifest.page_count = nextPages.length;
    manifest.updated_at = new Date().toISOString();
    this.writeManifest(projectPath, manifest);
  }

  static renumberProjectPages(projectPath, manifest) {
    this.rewritePagesFromManifest({ projectPath, manifest, proposal: null });
  }

  static async exportProject({ task, projectPath, title, canvasFormat }) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    await this.runPptMasterScript('svg_to_pptx.py', [projectPath, '-s', 'output', '-f', canvasFormat || 'ppt169'], {
      runtimeConfig,
      timeoutMs: 360000
    });
    const pptxPath = this.findGeneratedPptx(projectPath);
    if (!pptxPath) throw new Error('导出失败，没有生成 PPTX');
    const fileRecord = this.createFileRecord({ task, pptxPath, title });
    return { pptxPath, fileRecord };
  }

  static buildResultData({ task, projectPath, title, canvasFormat, pptxPath, fileRecord, sourceFile, styleProfile, message, previousResultData = {} }) {
    const manifest = this.readManifest(projectPath);
    const previewSvgs = this.listPreviewSvgUrls(projectPath);
    const sourceFileName = normalizeUploadOriginalName(
      sourceFile?.original_name || sourceFile?.originalName || sourceFile?.filename || manifest.source_name || '',
      manifest.source_name || '上传PPT'
    );
    return {
      ...previousResultData,
      status: 'completed',
      stage: 'done',
      progress: 100,
      edit_mode: 'imported_ppt',
      imported_ppt: true,
      source_kind: 'uploaded_ppt',
      title,
      canvas_format: canvasFormat || manifest.canvas_format || 'ppt169',
      page_count: previewSvgs.length,
      preview_svgs: previewSvgs,
      download_url: appConfig.pathToUploadUrl(pptxPath),
      pptx_url: appConfig.pathToUploadUrl(pptxPath),
      file_id: fileRecord?.id || previousResultData.file_id || '',
      project_dir: appConfig.pathToUploadUrl(projectPath),
      source_file_id: sourceFile?.id || manifest.source_file_id || '',
      source_file_name: sourceFileName,
      source_file_url: sourceFile?.url || manifest.source_url || '',
      style_profile: this.trimText(styleProfile || '', 3000),
      message: message || '导入型 PPT 已准备完成',
      updated_at: new Date().toISOString(),
      edit_history: Array.isArray(previousResultData.edit_history) ? previousResultData.edit_history.slice(-10) : []
    };
  }

  static async buildImageBackedSvg({ imagePath, canvasFormat, pageNum }) {
    const { width, height } = this.canvasSize(canvasFormat);
    const metadata = await sharp(imagePath).metadata().catch(() => ({}));
    const imageWidth = metadata.width || width;
    const imageHeight = metadata.height || height;
    const cover = this.containBox(imageWidth, imageHeight, width, height);
    const imageHref = await this.imageDataUri(imagePath);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
      `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
      `<image href="${this.xmlEscape(imageHref)}" x="${cover.x}" y="${cover.y}" width="${cover.width}" height="${cover.height}" preserveAspectRatio="xMidYMid meet"/>`,
      `<text x="${width - 32}" y="${height - 22}" text-anchor="end" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="12" fill="rgba(17,24,39,0.34)">P${pageNum}</text>`,
      '</svg>'
    ].join('\n');
  }

  static async imageDataUri(imagePath) {
    const metadata = await sharp(imagePath).metadata().catch(() => ({}));
    const format = String(metadata.format || path.extname(imagePath).replace(/^\./, '') || 'png').toLowerCase();
    const mime = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : `image/${format || 'png'}`;
    const buffer = fs.readFileSync(imagePath);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  static containBox(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const scale = Math.min(targetWidth / Math.max(1, sourceWidth), targetHeight / Math.max(1, sourceHeight));
    const width = Math.round(sourceWidth * scale * 100) / 100;
    const height = Math.round(sourceHeight * scale * 100) / 100;
    return {
      x: Math.round((targetWidth - width) / 2 * 100) / 100,
      y: Math.round((targetHeight - height) / 2 * 100) / 100,
      width,
      height
    };
  }

  static async detectCanvasFormat(inputPath) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const python = this.resolvePython(runtimeConfig.pptMasterPython || DEFAULT_PPT_MASTER_PYTHON);
    const script = `
import sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
w = int(prs.slide_width)
h = int(prs.slide_height)
ratio = w / h if h else 16/9
print("ppt43" if abs(ratio - 4/3) < abs(ratio - 16/9) else "ppt169")
`;
    const output = await this.execPython(python, script, [inputPath], 30000);
    return /ppt43/.test(output) ? 'ppt43' : 'ppt169';
  }

  static async convertSourceToMarkdown(inputPath, projectPath) {
    const DocumentConverterService = require('./documentConverterService');
    const outputDir = path.join(projectPath, SOURCES_DIR, 'converted_uploads');
    const result = await DocumentConverterService.convert(inputPath, {
      outputDir,
      converter: 'ppt',
      timeoutMs: 120000
    });
    fs.writeFileSync(path.join(projectPath, SOURCES_DIR, 'source.md'), result.markdown, 'utf-8');
    return result.markdown || '';
  }

  static async buildStyleProfile({ task, title, canvasFormat, pages, sourceMarkdown }) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const model = runtimeConfig.pptModel || runtimeConfig.pptExecutorModel || runtimeConfig.chatModel || 'claude-opus-4-7';
    const messages = [
      {
        role: 'system',
        content: [
          '你是 PPT 风格和内容归纳助手。',
          '请为后续按页修改生成一份简洁但有用的风格摘要。',
          '必须覆盖：整体风格、配色、字体气质、版式规律、页面内容大纲、修改时需要保留的规则。',
          '用简体中文 Markdown，直接输出摘要。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `PPT 标题：${title}`,
          `画幅：${canvasFormat}`,
          `页数：${pages.length}`,
          '提取到的 PPT 文本：',
          this.trimText(sourceMarkdown || '', 12000)
        ].join('\n')
      }
    ];
    const response = await AiService.chat({
      userId: task.user_id,
      model,
      messages,
      params: {
        route: 'ppt',
        temperature: 0.22,
        max_tokens: 1800,
        timeout_ms: Math.max(parseInt(runtimeConfig.pptTimeoutMs, 10) || 90000, 45000)
      },
      runtimeConfig,
      allowConfigOverride: true
    });
    const raw = response.choices?.[0]?.message?.content || '';
    User.billTokenUsage(task.user_id, response.usage, {
      source: 'ppt',
      legacyType: 'ppt',
      notePrefix: 'PPT助手乐米导入风格摘要 token 计费',
      fallback: { messages, content: raw }
    });
    return raw.trim() || this.fallbackStyleProfile({ title, canvasFormat, pages, sourceMarkdown });
  }

  static fallbackStyleProfile({ title, canvasFormat, pages, sourceMarkdown }) {
    return [
      `# 导入 PPT 风格摘要`,
      '',
      `- 标题：${title || '导入PPT'}`,
      `- 画幅：${canvasFormat || 'ppt169'}`,
      `- 页数：${pages?.length || 0}`,
      '- 修改策略：未被点名的页面保持原始截图；被修改页面按原页视觉节奏重绘；新增页沿用整套 PPT 的配色、字体、留白和标题层级。',
      '',
      '## 内容摘录',
      this.trimText(sourceMarkdown || '暂未提取到文本。', 3000)
    ].join('\n');
  }

  static readPageSvg(projectPath, pageNum) {
    const filename = this.pageFilename(pageNum);
    const outputPath = path.join(projectPath, SVG_PAGE_DIR, filename);
    const finalPath = path.join(projectPath, FINAL_PAGE_DIR, filename);
    if (fs.existsSync(outputPath)) return fs.readFileSync(outputPath, 'utf-8');
    if (fs.existsSync(finalPath)) return fs.readFileSync(finalPath, 'utf-8');
    throw new Error(`第 ${pageNum} 页不存在`);
  }

  static getPagePreviewImage(context, pageNum) {
    const page = context.manifest.pages?.[pageNum - 1] || {};
    return page.original_image || page.preview_url || context.resultData.preview_svgs?.[pageNum - 1] || '';
  }

  static createProjectDir({ userId, taskId, title, canvasFormat }) {
    const safeTitle = this.slugTitle(title || '导入PPT');
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(appConfig.uploadDir, 'ppt', String(userId), `${taskId}_${safeTitle}_${canvasFormat || 'ppt169'}_${date}`);
    fs.mkdirSync(dir, { recursive: true });
    return appConfig.assertInsideUploadDir(dir);
  }

  static ensureProjectDirs(projectPath) {
    [SVG_PAGE_DIR, FINAL_PAGE_DIR, 'images', NOTES_DIR, 'templates', SOURCES_DIR, EXPORTS_DIR].forEach(dirName => {
      fs.mkdirSync(path.join(projectPath, dirName), { recursive: true });
    });
  }

  static writeProjectReadme(projectPath, { title, canvasFormat, sourceName }) {
    fs.writeFileSync(path.join(projectPath, 'README.md'), [
      `# ${title || '导入PPT'}`,
      '',
      `- Canvas format: ${canvasFormat || 'ppt169'}`,
      `- Source: ${sourceName || 'uploaded ppt'}`,
      '- Mode: imported PPT page replacement',
      '',
      'This project preserves unmodified imported pages as image-backed SVG slides.'
    ].join('\n'), 'utf-8');
  }

  static createProjectBackup(projectPath) {
    const backupRoot = path.join(projectPath, 'edit_backups', `apply_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(backupRoot, { recursive: true });
    const dirs = [];
    ['svg_output', 'svg_final', 'notes'].forEach(dirName => {
      const source = path.join(projectPath, dirName);
      const target = path.join(backupRoot, dirName);
      if (fs.existsSync(source)) {
        fs.cpSync(source, target, { recursive: true });
        dirs.push({ source: target, target: source });
      }
    });
    const files = [];
    const manifestPath = path.join(projectPath, IMPORT_MANIFEST);
    if (fs.existsSync(manifestPath)) {
      const target = path.join(backupRoot, IMPORT_MANIFEST);
      fs.copyFileSync(manifestPath, target);
      files.push({ source: target, target: manifestPath });
    }
    return { dirs, files };
  }

  static restoreProjectBackup(projectPath, backup) {
    if (!backup) return;
    (backup.dirs || []).forEach(item => {
      if (!item.source || !fs.existsSync(item.source)) return;
      fs.rmSync(item.target, { recursive: true, force: true });
      fs.cpSync(item.source, item.target, { recursive: true });
    });
    (backup.files || []).forEach(item => {
      if (!item.source || !fs.existsSync(item.source)) return;
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.copyFileSync(item.source, item.target);
    });
  }

  static readCheckpoint(projectPath, checkpointId) {
    const safeId = String(checkpointId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
    if (!safeId) throw new Error('检查点不存在');
    const checkpointPath = path.join(projectPath, 'ppt_copilot_checkpoints', safeId, 'checkpoint.json');
    if (!fs.existsSync(checkpointPath)) throw new Error('检查点不存在或已过期');
    const checkpoint = this.safeParseJson(fs.readFileSync(checkpointPath, 'utf-8'), null);
    if (!checkpoint?.id) throw new Error('检查点数据无效');
    return checkpoint;
  }

  static readManifest(projectPath) {
    const manifestPath = path.join(projectPath, IMPORT_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      return {
        title: path.basename(projectPath),
        canvas_format: 'ppt169',
        pages: this.listPreviewSvgUrls(projectPath).map((url, index) => ({
          page: index + 1,
          filename: this.pageFilename(index + 1),
          preview_url: url
        }))
      };
    }
    return this.safeParseJson(fs.readFileSync(manifestPath, 'utf-8'), { pages: [] });
  }

  static writeManifest(projectPath, manifest) {
    fs.writeFileSync(path.join(projectPath, IMPORT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  }

  static readProposal(projectPath, proposalId) {
    const safeId = String(proposalId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) throw new Error('修改提案不存在');
    const proposalPath = path.join(projectPath, `edit_proposal_${safeId}`, 'proposal.json');
    if (!fs.existsSync(proposalPath)) throw new Error('修改提案不存在或已过期');
    const proposal = this.safeParseJson(fs.readFileSync(proposalPath, 'utf-8'), null);
    if (!proposal?.id) throw new Error('修改提案数据无效');
    return proposal;
  }

  static markProposalStatus(projectPath, proposalId, status) {
    try {
      const proposal = this.readProposal(projectPath, proposalId);
      proposal.status = status;
      proposal.updated_at = new Date().toISOString();
      fs.writeFileSync(path.join(projectPath, `edit_proposal_${proposal.id}`, 'proposal.json'), `${JSON.stringify(proposal, null, 2)}\n`, 'utf-8');
    } catch (error) {
      console.warn('[PptImportEditService] 修改提案状态更新失败:', error.message);
    }
  }

  static listProposals(projectPath) {
    if (!fs.existsSync(projectPath)) return [];
    return fs.readdirSync(projectPath)
      .filter(name => /^edit_proposal_/.test(name))
      .map(name => {
        const proposalPath = path.join(projectPath, name, 'proposal.json');
        if (!fs.existsSync(proposalPath)) return null;
        const proposal = this.safeParseJson(fs.readFileSync(proposalPath, 'utf-8'), null);
        if (!proposal?.id) return null;
        return {
          id: proposal.id,
          status: proposal.status || 'pending',
          pages: Array.isArray(proposal.pages) ? proposal.pages : [],
          summary: proposal.summary || '',
          created_at: proposal.created_at || '',
          preview_svgs: Array.isArray(proposal.preview_svgs) ? proposal.preview_svgs : []
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  static listPreviewSvgUrls(projectPath) {
    const dir = path.join(projectPath, SVG_PAGE_DIR);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => /\.svg$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(name => appConfig.pathToUploadUrl(path.join(dir, name)));
  }

  static listAssets(projectPath) {
    const imageDir = path.join(projectPath, 'images');
    if (!fs.existsSync(imageDir)) return [];
    return fs.readdirSync(imageDir)
      .filter(name => /\.(png|jpe?g|webp|gif|svg)$/i.test(name))
      .sort()
      .slice(0, 60)
      .map(name => ({ name, url: appConfig.pathToUploadUrl(path.join(imageDir, name)) }));
  }

  static normalizeUploadedAssets(assets = []) {
    if (!Array.isArray(assets)) return [];
    return assets
      .filter(item => item && item.url)
      .slice(-12)
      .map(item => ({
        kind: this.trimText(item.kind || item.type || 'file', 40),
        name: this.trimText(item.name || item.filename || '上传文件', 160),
        url: this.trimText(item.url || '', 600),
        mimeType: this.trimText(item.mimeType || item.mime_type || '', 120),
        size: Number(item.size) || 0
      }));
  }

  static readPageNote(projectPath, filename) {
    const notePath = path.join(projectPath, NOTES_DIR, filename.replace(/\.svg$/i, '.md'));
    const content = this.readOptional(notePath, 1600);
    if (!content) return { title: '', excerpt: '' };
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const heading = lines.find(line => /^#{1,6}\s+/.test(line));
    const title = (heading || lines[0] || '').replace(/^#{1,6}\s+/, '').replace(/^\d+[.、]\s*/, '').trim();
    const excerpt = lines.filter(line => line !== heading).join(' ').replace(/[#*_`>|-]/g, '').replace(/\s+/g, ' ').trim();
    return { title: this.trimText(title, 80), excerpt: this.trimText(excerpt, 260) };
  }

  static resolveProjectPath(resultData = {}) {
    if (resultData.project_dir) {
      try {
        const p = appConfig.uploadUrlToPath(resultData.project_dir);
        if (fs.existsSync(p)) return p;
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
    const numericPatterns = [/第\s*(\d{1,3})\s*页/g, /P\s*0?(\d{1,3})\b/gi, /slide\s*0?(\d{1,3})\b/gi];
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
    if (/封面/.test(text) && pageCount >= 1) pages.add(1);
    if (/(最后一页|末页)/.test(text) && pageCount >= 1) pages.add(pageCount);
    if (pages.size > 0) return [...pages].sort((a, b) => a - b);
    if (/整份|全部|所有页|全局|整体/i.test(text)) {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }
    const explicitIndex = parseInt(pageIndex, 10);
    if (Number.isFinite(explicitIndex) && explicitIndex >= 0 && explicitIndex < pageCount) return [explicitIndex + 1];
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

  static normalizePageIndex(pageIndex, pageCount) {
    const parsed = parseInt(pageIndex, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < pageCount) return parsed;
    return 0;
  }

  static ensureSvgCanvas(svg, canvasFormat) {
    const { width, height } = this.canvasSize(canvasFormat);
    let next = String(svg || '').trim();
    if (!/viewBox=/i.test(next)) {
      next = next.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`);
    }
    if (!/width=/i.test(next.slice(0, next.indexOf('>') + 1))) {
      next = next.replace(/<svg\b/i, `<svg width="${width}"`);
    }
    if (!/height=/i.test(next.slice(0, next.indexOf('>') + 1))) {
      next = next.replace(/<svg\b/i, `<svg height="${height}"`);
    }
    return next;
  }

  static canvasSize(canvasFormat = 'ppt169') {
    return canvasFormat === 'ppt43'
      ? { width: 1024, height: 768 }
      : { width: 1280, height: 720 };
  }

  static pageFilename(pageNum) {
    return `${String(pageNum).padStart(2, '0')}_slide_${pageNum}.svg`;
  }

  static newProposalId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  static buildProposalSummary({ instruction, operation }) {
    if (operation.type === 'delete') return `准备删除 ${operation.pages.map(page => `第 ${page} 页`).join('、')}`;
    if (operation.type === 'insert_after') return `准备新增第 ${operation.pages[0]} 页：${this.trimText(instruction, 90)}`;
    return `准备替换 ${operation.pages.map(page => `第 ${page} 页`).join('、')}：${this.trimText(instruction, 90)}`;
  }

  static applyMessage(operation) {
    if (operation.type === 'delete') return '已删除指定页面，并重新导出 PPTX。';
    if (operation.type === 'insert_after') return '已插入新页面，并重新导出 PPTX。';
    return '已替换指定页面，并重新导出 PPTX。';
  }

  static createFileRecord({ task, pptxPath, title }) {
    try {
      const originalName = normalizeUploadOriginalName(`${String(title || 'imported-ppt').slice(0, 80)}.pptx`, 'imported-ppt.pptx');
      return File.create({
        userId: task.user_id,
        taskId: task.id,
        filename: path.basename(pptxPath),
        originalName,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: fs.statSync(pptxPath).size,
        path: pptxPath,
        url: appConfig.pathToUploadUrl(pptxPath)
      });
    } catch (error) {
      console.warn('[PptImportEditService] 文件记录创建失败:', error.message);
      return null;
    }
  }

  static async runPptMasterScript(scriptName, args, { runtimeConfig, timeoutMs = 120000 } = {}) {
    const { execFile } = require('child_process');
    const root = runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    const python = this.resolvePython(runtimeConfig.pptMasterPython || DEFAULT_PPT_MASTER_PYTHON);
    const scriptPath = path.join(root, 'skills', 'ppt-master', 'scripts', scriptName);
    if (!fs.existsSync(scriptPath)) throw new Error(`找不到脚本: ${scriptPath}`);
    return new Promise((resolve, reject) => {
      execFile(python, [scriptPath, ...args], { cwd: root, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error([stdout, stderr, error.message].filter(Boolean).join('\n') || `${scriptName} 执行失败`));
          return;
        }
        resolve([stdout, stderr].filter(Boolean).join('\n').trim());
      });
    });
  }

  static resolvePython(pythonPath) {
    if (pythonPath && fs.existsSync(pythonPath)) return pythonPath;
    return 'python3';
  }

  static execPython(python, script, args, timeoutMs) {
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
      execFile(python, ['-c', script, ...args], {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      });
    });
  }

  static findGeneratedPptx(projectPath) {
    const exportDir = path.join(projectPath, EXPORTS_DIR);
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

  static cleanTitle(value) {
    return String(value || '导入PPT').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '导入PPT';
  }

  static slugTitle(value) {
    return this.cleanTitle(value)
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'imported_ppt';
  }

  static xmlEscape(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

module.exports = PptImportEditService;
