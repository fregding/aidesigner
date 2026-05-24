const fs = require('fs');
const path = require('path');
const { db } = require('../models/database');
const appConfig = require('../config/appConfig');
const { normalizeUploadOriginalName } = require('../utils/uploadName');

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function uploadUrl(filePath) {
  return appConfig.pathToUploadUrl(filePath);
}

function pathFromUploadUrl(value) {
  if (!value) return '';
  if (String(value).startsWith('/uploads/')) {
    return appConfig.uploadUrlToPath(value);
  }
  return appConfig.assertInsideUploadDir(value);
}

function projectDirsFromDb() {
  const rows = db.prepare(`
    SELECT id, prompt, params, result_data
    FROM ai_tasks
    WHERE type = 'ppt'
      AND result_data IS NOT NULL
      AND (
        result_data LIKE '%"edit_mode":"imported_ppt"%'
        OR result_data LIKE '%"imported_ppt":true%'
      )
  `).all();

  return rows.map(row => {
    const params = safeJsonParse(row.params, {}) || {};
    const result = safeJsonParse(row.result_data, {}) || {};
    let projectPath = '';
    try {
      if (result.project_dir) projectPath = pathFromUploadUrl(result.project_dir);
    } catch (error) {}
    if (!projectPath && Array.isArray(result.preview_svgs) && result.preview_svgs[0]) {
      try {
        projectPath = path.dirname(path.dirname(pathFromUploadUrl(result.preview_svgs[0])));
      } catch (error) {}
    }
    return {
      taskId: row.id,
      title: params.title || result.title || row.prompt || '',
      projectPath,
      params,
      result
    };
  }).filter(item => item.projectPath && fs.existsSync(item.projectPath));
}

function projectDirsFromDisk() {
  const pptRoot = path.join(appConfig.uploadDir, 'ppt');
  if (!fs.existsSync(pptRoot)) return [];
  const projects = [];
  for (const userDir of fs.readdirSync(pptRoot)) {
    const userPath = path.join(pptRoot, userDir);
    if (!fs.statSync(userPath).isDirectory()) continue;
    for (const projectName of fs.readdirSync(userPath)) {
      const projectPath = path.join(userPath, projectName);
      if (!fs.statSync(projectPath).isDirectory()) continue;
      const manifestPath = path.join(projectPath, 'import_pages.json');
      if (!fs.existsSync(manifestPath)) continue;
      const taskId = Number(String(projectName).match(/^(\d+)_/)?.[1] || 0);
      projects.push({ taskId, title: '', projectPath, params: {}, result: {} });
    }
  }
  return projects;
}

function imageMime(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function inlineSvgImages(projectPath, dirName) {
  const svgDir = path.join(projectPath, dirName);
  if (!fs.existsSync(svgDir)) return 0;
  let changed = 0;
  for (const name of fs.readdirSync(svgDir)) {
    if (!/\.svg$/i.test(name)) continue;
    const svgPath = path.join(svgDir, name);
    let content = fs.readFileSync(svgPath, 'utf-8');
    const next = content.replace(/(<image\b[^>]*\bhref=")(?!data:)([^"]+)("[^>]*>)/gi, (match, prefix, href, suffix) => {
      const decodedHref = href.replace(/&amp;/g, '&');
      const imagePath = path.resolve(svgDir, decodedHref);
      if (!fs.existsSync(imagePath)) return match;
      const data = fs.readFileSync(imagePath).toString('base64');
      return `${prefix}data:${imageMime(imagePath)};base64,${data}${suffix}`;
    });
    if (next !== content) {
      fs.writeFileSync(svgPath, next, 'utf-8');
      changed += 1;
    }
  }
  return changed;
}

function cleanTitleFromProject(project) {
  const manifestPath = path.join(project.projectPath, 'import_pages.json');
  const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf-8'), {}) || {};
  const sourceName = normalizeUploadOriginalName(
    manifest.source_name || project.result?.source_file_name || project.params?.sourceFileName || '',
    manifest.source_name || project.title || '导入PPT'
  );
  const sourceBase = path.basename(sourceName, path.extname(sourceName));
  let title = normalizeUploadOriginalName(
    project.title || manifest.title || sourceBase || '',
    sourceBase || '导入PPT'
  ).replace(/\.(ppt|pptx|pot|potx)$/i, '');
  if (sourceBase && title && sourceBase.startsWith(title) && sourceBase.length > title.length + 4) {
    title = sourceBase;
  }
  if (sourceBase && /[_\-\s]$/.test(title)) {
    title = sourceBase;
  }
  return {
    manifest,
    sourceName,
    title: title || sourceBase || '导入PPT'
  };
}

function updateManifest(project) {
  const manifestPath = path.join(project.projectPath, 'import_pages.json');
  if (!fs.existsSync(manifestPath)) return { title: '', sourceName: '', pageCount: 0 };
  const { manifest, title, sourceName } = cleanTitleFromProject(project);
  manifest.title = title;
  manifest.source_name = sourceName;
  manifest.updated_at = new Date().toISOString();
  if (Array.isArray(manifest.pages)) {
    manifest.pages = manifest.pages.map((page, index) => ({
      ...page,
      page: index + 1,
      filename: page.filename || `${String(index + 1).padStart(2, '0')}_slide_${index + 1}.svg`,
      original_image: page.original_image || uploadUrl(path.join(project.projectPath, 'images', `import_page_${String(index + 1).padStart(3, '0')}.png`)),
      preview_url: page.preview_url || uploadUrl(path.join(project.projectPath, 'svg_output', `${String(index + 1).padStart(2, '0')}_slide_${index + 1}.svg`))
    }));
    manifest.page_count = manifest.pages.length;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(path.join(project.projectPath, 'README.md'), [
    `# ${title}`,
    '',
    `- Canvas format: ${manifest.canvas_format || 'ppt169'}`,
    `- Source: ${sourceName || 'uploaded ppt'}`,
    '- Mode: imported PPT page replacement',
    '',
    'This project preserves unmodified imported pages as image-backed SVG slides.'
  ].join('\n'), 'utf-8');
  return { title, sourceName, pageCount: manifest.page_count || 0 };
}

function updateTask(project, info) {
  if (!project.taskId) return false;
  const row = db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(project.taskId);
  if (!row) return false;
  const params = safeJsonParse(row.params, {}) || {};
  const result = safeJsonParse(row.result_data, {}) || {};
  const previewSvgs = fs.readdirSync(path.join(project.projectPath, 'svg_output'))
    .filter(name => /\.svg$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => uploadUrl(path.join(project.projectPath, 'svg_output', name)));
  const nextParams = {
    ...params,
    title: info.title,
    sourceFileName: info.sourceName
  };
  const nextResult = {
    ...result,
    title: info.title,
    source_file_name: info.sourceName,
    page_count: previewSvgs.length || info.pageCount || result.page_count || 0,
    preview_svgs: previewSvgs.length ? previewSvgs : result.preview_svgs,
    updated_at: new Date().toISOString()
  };
  db.prepare('UPDATE ai_tasks SET prompt = ?, params = ?, result_data = ? WHERE id = ?')
    .run(info.title, JSON.stringify(nextParams), JSON.stringify(nextResult), project.taskId);
  return true;
}

function updateFileNames() {
  const rows = db.prepare('SELECT id, original_name FROM files').all();
  let changed = 0;
  const stmt = db.prepare('UPDATE files SET original_name = ? WHERE id = ?');
  for (const row of rows) {
    const fixed = normalizeUploadOriginalName(row.original_name, row.original_name || '上传文件');
    if (fixed && fixed !== row.original_name) {
      stmt.run(fixed, row.id);
      changed += 1;
    }
  }
  return changed;
}

function main() {
  const byPath = new Map();
  [...projectDirsFromDb(), ...projectDirsFromDisk()].forEach(item => {
    byPath.set(item.projectPath, { ...(byPath.get(item.projectPath) || {}), ...item });
  });

  let svgChanged = 0;
  let projectsChanged = 0;
  let taskChanged = 0;
  for (const project of byPath.values()) {
    const outputChanged = inlineSvgImages(project.projectPath, 'svg_output');
    const finalChanged = inlineSvgImages(project.projectPath, 'svg_final');
    svgChanged += outputChanged + finalChanged;
    const info = updateManifest(project);
    projectsChanged += 1;
    if (updateTask(project, info)) taskChanged += 1;
  }
  const fileChanged = updateFileNames();
  console.log(JSON.stringify({
    projects: projectsChanged,
    svg_files_inlined: svgChanged,
    tasks_updated: taskChanged,
    file_names_repaired: fileChanged
  }, null, 2));
}

main();
