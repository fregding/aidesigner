const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile, spawnSync } = require('child_process');

const DocumentConverterService = require('./documentConverterService');
const AiTask = require('../models/AiTask');
const appConfig = require('../config/appConfig');

class DocumentVisualPreviewService {
  static CACHE_VERSION = 'v3-office-png-preview';

  static getOutputDir(userId, fileId) {
    return path.join(appConfig.uploadDir, 'visual_previews', String(userId), String(fileId));
  }

  static getCacheVersionPath(outputDir) {
    return path.join(outputDir, '.version');
  }

  static isCacheFresh(outputDir) {
    try {
      return fs.readFileSync(this.getCacheVersionPath(outputDir), 'utf-8').trim() === this.CACHE_VERSION;
    } catch (error) {
      return false;
    }
  }

  static markCacheFresh(outputDir) {
    fs.writeFileSync(this.getCacheVersionPath(outputDir), this.CACHE_VERSION);
  }

  static listCachedPreviews(outputDir, sourceMtimeMs) {
    if (!fs.existsSync(outputDir)) return [];
    return fs.readdirSync(outputDir)
      .filter(name => /^(?:slide|page|quicklook)_\d+\.(?:svg|png|jpg|jpeg|webp)$/i.test(name))
      .map(name => path.join(outputDir, name))
      .filter(filePath => fs.statSync(filePath).mtimeMs >= sourceMtimeMs)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  static toUrls(filePaths) {
    return filePaths.map(filePath => appConfig.pathToUploadUrl(filePath));
  }

  static isOfficePreviewFile(filePath = '') {
    return ['.ppt', '.pptx', '.pot', '.potx'].includes(path.extname(String(filePath || '')).toLowerCase());
  }

  static safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  static getGeneratedTaskPreview(file, userId) {
    if (!file?.task_id) return null;
    const task = AiTask.findByIdForUser(file.task_id, userId);
    const resultData = this.safeJsonParse(task?.result_data, {});
    const previewSvgs = Array.isArray(resultData.preview_svgs)
      ? resultData.preview_svgs.filter(Boolean)
      : [];
    if (!previewSvgs.length) return null;
    return {
      type: 'ppt',
      images: previewSvgs,
      cached: true,
      source: 'task'
    };
  }

  static getGeneratedProjectPreview(file) {
    const filePath = appConfig.assertInsideUploadDir(String(file?.path || ''));
    const normalizedUploadDir = path.resolve(appConfig.uploadDir);
    const normalizedPath = path.resolve(filePath);
    if (!normalizedPath.startsWith(normalizedUploadDir + path.sep)) return null;
    if (!normalizedPath.includes(`${path.sep}ppt${path.sep}`) || !normalizedPath.includes(`${path.sep}exports${path.sep}`)) return null;

    const projectDir = path.dirname(path.dirname(normalizedPath));
    for (const folder of ['svg_final', 'svg_output']) {
      const previewDir = path.join(projectDir, folder);
      if (!fs.existsSync(previewDir)) continue;
      const slides = fs.readdirSync(previewDir)
        .filter(name => /\.svg$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map(name => path.join(previewDir, name));
      if (slides.length) {
        return {
          type: 'ppt',
          images: this.toUrls(slides),
          cached: true,
          source: folder
        };
      }
    }

    return null;
  }

  static async buildPreview(file, userId, options = {}) {
    if (file?.path) {
      file = { ...file, path: appConfig.assertInsideUploadDir(file.path) };
    }

    const taskPreview = this.getGeneratedTaskPreview(file, userId);
    if (taskPreview && options.force !== true) return taskPreview;

    const projectPreview = this.getGeneratedProjectPreview(file);
    if (projectPreview && options.force !== true) return projectPreview;

    if (!file?.path || !fs.existsSync(file.path)) {
      throw new Error('文件不存在');
    }

    const ext = path.extname(file.path).toLowerCase();
    const outputDir = this.getOutputDir(userId, file.id);
    fs.mkdirSync(outputDir, { recursive: true });
    const sourceMtimeMs = fs.statSync(file.path).mtimeMs;
    const cached = this.isCacheFresh(outputDir) ? this.listCachedPreviews(outputDir, sourceMtimeMs) : [];
    if (cached.length > 0 && options.force !== true) {
      const cachedSource = ['.ppt', '.pptx'].includes(ext) && cached.some(filePath => /\.svg$/i.test(filePath))
        ? 'pptx-fallback'
        : 'cache';
      return {
        type: this.previewTypeFromExt(ext),
        images: this.toUrls(cached),
        cached: true,
        source: cachedSource
      };
    }

    this.clearPreviewOutput(outputDir);

    if (['.ppt', '.pptx', '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.csv'].includes(ext)) {
      const officePages = await this.renderOfficeToImages(file.path, outputDir).catch(() => []);
      if (officePages.length) {
        this.markCacheFresh(outputDir);
        return { type: this.previewTypeFromExt(ext), images: this.toUrls(officePages), cached: false, source: 'office' };
      }
      if (options.officeOnly === true) {
        throw new Error('未生成 Office PNG 预览，请确认 unoserver 或 LibreOffice 可用');
      }
    }

    if (['.pptx'].includes(ext)) {
      const slides = await this.renderPptxToSvg(file.path, outputDir);
      this.markCacheFresh(outputDir);
      return { type: 'ppt', images: this.toUrls(slides), cached: false, source: 'pptx-fallback' };
    }

    if (ext === '.pdf') {
      const pages = await this.renderPdfToPng(file.path, outputDir);
      this.markCacheFresh(outputDir);
      return { type: 'pdf', images: this.toUrls(pages), cached: false, source: 'pdf' };
    }

    if (['.xlsx', '.xls', '.csv', '.docx', '.doc', '.odt', '.rtf'].includes(ext)) {
      const thumbnail = await this.renderQuickLookThumbnail(file.path, outputDir);
      this.markCacheFresh(outputDir);
      return { type: 'thumbnail', images: this.toUrls([thumbnail]), cached: false, source: 'quicklook' };
    }

    throw new Error('这个文件暂不支持视觉预览');
  }

  static previewTypeFromExt(ext) {
    if (ext === '.pdf') return 'pdf';
    if (['.ppt', '.pptx', '.pot', '.potx'].includes(ext)) return 'ppt';
    return 'thumbnail';
  }

  static clearPreviewOutput(outputDir) {
    if (!fs.existsSync(outputDir)) return;
    for (const name of fs.readdirSync(outputDir)) {
      if (
        /^(?:slide|page|quicklook)_\d+\.(?:svg|png|jpg|jpeg|webp)$/i.test(name) ||
        name === '.version' ||
        name === 'office_pdf' ||
        name === 'media'
      ) {
        fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
      }
    }
  }

  static enqueueUploadPreview(file, userId) {
    if (!appConfig.officePreview.autoRenderOnUpload) return Promise.resolve(null);
    if (!this.isOfficePreviewFile(file?.path || file?.original_name || file?.filename)) return Promise.resolve(null);

    this.officePreviewQueue = (this.officePreviewQueue || Promise.resolve())
      .catch(() => null)
      .then(() => this.warmUploadPreview(file, userId));
    return this.officePreviewQueue;
  }

  static async warmUploadPreview(file, userId) {
    try {
      const result = await this.buildPreview(file, userId, {
        officeOnly: true,
        force: false
      });
      console.log(`[OfficePreview] 已生成上传PPT截图缓存: file=${file.id}, pages=${result.images.length}, source=${result.source || ''}`);
      return result;
    } catch (error) {
      console.warn(`[OfficePreview] 上传PPT截图缓存生成失败: file=${file?.id || ''}, ${error.message}`);
      return null;
    }
  }

  static async renderPptxToSvg(inputPath, outputDir) {
    const runtimeConfig = require('./runtimeConfigService').getRuntimeConfig();
    const python = DocumentConverterService.resolvePython(runtimeConfig);
    const script = `
import base64
import html
import os
import re
import sys
from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

input_path, output_dir = sys.argv[1], sys.argv[2]
out = Path(output_dir)
media_dir = out / "media"
media_dir.mkdir(parents=True, exist_ok=True)

prs = Presentation(input_path)
slide_w = int(prs.slide_width) or 12192000
slide_h = int(prs.slide_height) or 6858000
view_w = 1280
view_h = max(1, round(view_w * slide_h / slide_w))
sx = view_w / slide_w
sy = view_h / slide_h

def esc(value):
    return html.escape(str(value or ""), quote=True)

def emu(value, scale):
    try:
        return round(int(value or 0) * scale, 2)
    except Exception:
        return 0

def color_from(obj, fallback):
    try:
        fill = obj.fill
        if getattr(fill, "type", None) is not None and fill.fore_color and fill.fore_color.rgb:
            return "#" + str(fill.fore_color.rgb)
    except Exception:
        pass
    return fallback

def line_color(shape):
    try:
        if shape.line and shape.line.color and shape.line.color.rgb:
            return "#" + str(shape.line.color.rgb)
    except Exception:
        pass
    return "rgba(0,0,0,0.14)"

def text_color(run):
    try:
        if run.font.color and run.font.color.rgb:
            return "#" + str(run.font.color.rgb)
    except Exception:
        pass
    return "#111827"

def font_size(run):
    try:
        if run.font.size:
            return max(10, round(run.font.size.pt * 1.35, 1))
    except Exception:
        pass
    return 24

def shape_box(shape):
    return (
        emu(getattr(shape, "left", 0), sx),
        emu(getattr(shape, "top", 0), sy),
        max(1, emu(getattr(shape, "width", 0), sx)),
        max(1, emu(getattr(shape, "height", 0), sy)),
    )

def render_text(shape):
    if not getattr(shape, "has_text_frame", False):
        return ""
    x, y, w, h = shape_box(shape)
    chunks = [f'<g transform="translate({x},{y})">']
    cy = 0
    for paragraph in shape.text_frame.paragraphs:
        runs = [r for r in paragraph.runs if (r.text or "").strip()]
        if not runs:
            cy += 22
            continue
        first = runs[0]
        size = font_size(first)
        cy += size * 1.15
        line_parts = []
        dx = 0
        for run in runs:
            text = (run.text or "").replace("\\n", " ").strip()
            if not text:
                continue
            weight = "700" if run.font.bold else "500"
            style = "italic" if run.font.italic else "normal"
            line_parts.append(
                f'<tspan dx="{dx}" font-size="{size}" font-weight="{weight}" font-style="{style}" fill="{text_color(run)}">{esc(text)}</tspan>'
            )
            dx = 4
        if line_parts:
            chunks.append(f'<text x="0" y="{round(cy, 2)}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">{"".join(line_parts)}</text>')
        cy += size * 0.25
        if cy > h + 40:
            break
    chunks.append("</g>")
    return "".join(chunks)

def render_picture(shape, slide_index, image_index):
    x, y, w, h = shape_box(shape)
    ext = getattr(shape.image, "ext", "png") or "png"
    mime_ext = "jpeg" if ext.lower() in ("jpg", "jpeg") else ext.lower()
    if mime_ext not in ("png", "jpeg", "gif", "webp", "bmp"):
        mime_ext = "png"
    href = "data:image/" + mime_ext + ";base64," + base64.b64encode(shape.image.blob).decode("ascii")
    return f'<image href="{esc(href)}" x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="xMidYMid slice"/>'

def render_table(shape):
    if not getattr(shape, "has_table", False):
        return ""
    x, y, w, h = shape_box(shape)
    rows = list(shape.table.rows)
    cols = list(shape.table.columns)
    if not rows or not cols:
        return ""
    row_h = h / len(rows)
    col_w = w / len(cols)
    chunks = [f'<g transform="translate({x},{y})">']
    for r, row in enumerate(rows):
        for c, cell in enumerate(row.cells):
            cx = round(c * col_w, 2)
            cy = round(r * row_h, 2)
            chunks.append(f'<rect x="{cx}" y="{cy}" width="{round(col_w,2)}" height="{round(row_h,2)}" fill="rgba(255,255,255,0.92)" stroke="rgba(17,24,39,0.18)" stroke-width="1"/>')
            text = " ".join((cell.text or "").split())[:80]
            if text:
                chunks.append(f'<text x="{cx + 6}" y="{cy + min(row_h - 4, 18)}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="14" fill="#111827">{esc(text)}</text>')
    chunks.append("</g>")
    return "".join(chunks)

def render_shape(shape, slide_index, image_counter):
    parts = []
    try:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            for child in shape.shapes:
                parts.append(render_shape(child, slide_index, image_counter))
            return "".join(parts)
    except Exception:
        pass
    try:
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            image_counter[0] += 1
            return render_picture(shape, slide_index, image_counter[0])
    except Exception:
        pass

    x, y, w, h = shape_box(shape)
    has_text = getattr(shape, "has_text_frame", False) and (shape.text or "").strip()
    has_table = getattr(shape, "has_table", False)
    if has_table:
        return render_table(shape)

    fill = color_from(shape, "rgba(255,255,255,0)")
    stroke = line_color(shape)
    if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.LINE:
        parts.append(f'<line x1="{x}" y1="{y}" x2="{x + w}" y2="{y + h}" stroke="{stroke}" stroke-width="2"/>')
    elif fill != "rgba(255,255,255,0)" or stroke != "rgba(0,0,0,0.14)":
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1"/>')
    if has_text:
        parts.append(render_text(shape))
    return "".join(parts)

for index, slide in enumerate(prs.slides, start=1):
    bg = "#ffffff"
    try:
        fill = slide.background.fill
        if getattr(fill, "type", None) is not None and fill.fore_color and fill.fore_color.rgb:
            bg = "#" + str(fill.fore_color.rgb)
    except Exception:
        pass
    image_counter = [0]
    body = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view_w} {view_h}" width="{view_w}" height="{view_h}">']
    body.append(f'<rect width="{view_w}" height="{view_h}" fill="{bg}"/>')
    for shape in slide.shapes:
        body.append(render_shape(shape, index, image_counter))
    body.append("</svg>")
    (out / f"slide_{index:03d}.svg").write_text("\\n".join(body), encoding="utf-8")
print(len(prs.slides))
`;

    await this.execPython(python, script, [inputPath, outputDir], 90000);
    const slides = fs.readdirSync(outputDir)
      .filter(name => /^slide_\d+\.svg$/i.test(name))
      .sort()
      .map(name => path.join(outputDir, name));
    if (!slides.length) throw new Error('未生成幻灯片预览');
    return slides;
  }

  static async renderOfficeToImages(inputPath, outputDir, options = {}) {
    const unoserverPdf = await this.renderOfficeToPdfWithUnoserver(inputPath, outputDir).catch(error => {
      console.warn('[OfficePreview] unoserver 转换失败，尝试 LibreOffice CLI:', error.message);
      return '';
    });
    if (unoserverPdf) {
      return this.renderPdfToPng(unoserverPdf, outputDir, options);
    }

    const office = this.findExecutable([
      'soffice',
      'libreoffice',
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/bin/libreoffice',
      '/usr/local/bin/libreoffice',
      '/opt/homebrew/bin/libreoffice'
    ]);
    if (!office) return [];

    const convertDir = path.join(outputDir, 'office_pdf');
    const profileDir = path.join(convertDir, 'profile');
    fs.rmSync(convertDir, { recursive: true, force: true });
    fs.mkdirSync(convertDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });

    await new Promise((resolve, reject) => {
      execFile(
        office,
        [
          '--headless',
          '--nologo',
          '--nofirststartwizard',
          DocumentConverterService.libreOfficeUserInstallationArg(profileDir),
          '--convert-to',
          'pdf',
          '--outdir',
          convertDir,
          inputPath
        ],
        {
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, HOME: DocumentConverterService.resolveWritableHome() }
        },
        (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(stdout)
      );
    });

    const pdf = fs.readdirSync(convertDir)
      .filter(name => /\.pdf$/i.test(name))
      .map(name => path.join(convertDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!pdf) return [];
    return this.renderPdfToPng(pdf, outputDir, options);
  }

  static async renderOfficeToPdfWithUnoserver(inputPath, outputDir) {
    const config = appConfig.officePreview || {};
    if (config.unoserverEnabled === false) return '';

    const host = String(config.host || '127.0.0.1');
    const port = Number(config.port || 2003);
    const canReachServer = await this.isTcpPortOpen(host, port, 1200);
    if (!canReachServer) return '';

    const unoconvert = this.findExecutable([
      config.unoconvertBin,
      'unoconvert',
      'unoconverter',
      path.join(process.env.HOME || '', '.local/bin/unoconvert'),
      '/usr/local/bin/unoconvert',
      '/opt/homebrew/bin/unoconvert'
    ]);
    if (!unoconvert) return '';

    const convertDir = path.join(outputDir, 'office_pdf');
    fs.rmSync(convertDir, { recursive: true, force: true });
    fs.mkdirSync(convertDir, { recursive: true });

    const outputPdf = path.join(convertDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
    const args = [
      '--host', host,
      '--port', String(port),
      '--host-location', String(config.hostLocation || 'local'),
      '--convert-to', 'pdf',
      inputPath,
      outputPdf
    ];

    await new Promise((resolve, reject) => {
      execFile(
        unoconvert,
        args,
        { timeout: 120000, maxBuffer: 12 * 1024 * 1024 },
        (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(stdout)
      );
    });

    return fs.existsSync(outputPdf) ? outputPdf : '';
  }

  static isTcpPortOpen(host, port, timeoutMs = 1200) {
    return new Promise(resolve => {
      const socket = new net.Socket();
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  }

  static async renderPdfToPng(inputPath, outputDir, options = {}) {
    const pageLimit = Number.isFinite(Number(options.pageLimit))
      ? Math.max(1, Math.min(240, Number(options.pageLimit)))
      : this.pageLimit();
    const pdftoppm = this.findExecutable(['pdftoppm', '/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm']);
    if (pdftoppm) {
      await new Promise((resolve, reject) => {
        execFile(
          pdftoppm,
          ['-png', '-r', '132', '-f', '1', '-l', String(pageLimit), inputPath, path.join(outputDir, 'page')],
          { timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)
        );
      });
      const pages = fs.readdirSync(outputDir)
        .filter(name => /^page-\d+\.png$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((name, index) => {
          const src = path.join(outputDir, name);
          const dest = path.join(outputDir, `page_${String(index + 1).padStart(3, '0')}.png`);
          fs.renameSync(src, dest);
          return dest;
        });
      if (pages.length) return pages;
    }

    const runtimeConfig = require('./runtimeConfigService').getRuntimeConfig();
    const python = DocumentConverterService.resolvePython(runtimeConfig);
    const script = `
import fitz
import sys
from pathlib import Path
doc = fitz.open(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
count = min(len(doc), int(sys.argv[3]))
for i in range(count):
    page = doc.load_page(i)
    pix = page.get_pixmap(matrix=fitz.Matrix(1.8, 1.8), alpha=False)
    pix.save(out / f"page_{i + 1:03d}.png")
print(count)
`;
    await this.execPython(python, script, [inputPath, outputDir, String(pageLimit)], 90000);
    const pages = fs.readdirSync(outputDir)
      .filter(name => /^page_\d+\.png$/i.test(name))
      .sort()
      .map(name => path.join(outputDir, name));
    if (!pages.length) throw new Error('未生成 PDF 预览');
    return pages;
  }

  static async renderQuickLookThumbnail(inputPath, outputDir) {
    const qlmanage = this.findExecutable(['qlmanage', '/usr/bin/qlmanage']);
    if (!qlmanage) {
      throw new Error('当前系统不支持 QuickLook 预览');
    }

    await new Promise((resolve, reject) => {
      execFile(
        qlmanage,
        ['-t', '-s', '1280', '-o', outputDir, inputPath],
        { timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)
      );
    });

    const png = fs.readdirSync(outputDir)
      .filter(name => name.toLowerCase().endsWith('.png'))
      .map(name => path.join(outputDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!png) throw new Error('QuickLook 未生成预览');
    const target = path.join(outputDir, 'quicklook_001.png');
    if (png !== target) {
      fs.copyFileSync(png, target);
    }
    return target;
  }

  static execPython(python, script, args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(
        python,
        ['-c', script, ...args],
        {
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)
      );
    });
  }

  static findExecutable(candidates) {
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.includes(path.sep)) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      const result = spawnSync('which', [candidate], { encoding: 'utf-8', timeout: 2000 });
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return '';
  }

  static pageLimit() {
    return Math.max(1, Math.min(120, Number(appConfig.officePreview?.pageLimit) || 24));
  }
}

DocumentVisualPreviewService.officePreviewQueue = Promise.resolve();

module.exports = DocumentVisualPreviewService;
