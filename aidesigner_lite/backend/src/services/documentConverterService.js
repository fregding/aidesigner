/**
 * Document Converter Service
 * Converts various document formats (PDF, Word, Excel, PPT, Web) to Markdown
 * for use in PPT generation.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile, spawnSync } = require('child_process');

const RuntimeConfigService = require('./runtimeConfigService');
const appConfig = require('../config/appConfig');

const UPLOAD_DIR = appConfig.uploadDir;
const DEFAULT_PPT_MASTER_ROOT = appConfig.defaultPptMasterRoot;
const DEFAULT_PPT_MASTER_PYTHON = appConfig.defaultPptMasterPython;

// Supported document types and their converters
const CONVERTERS = {
  pdf: {
    script: 'pdf_to_md.py',
    extensions: ['.pdf'],
    description: 'PDF文档'
  },
  doc: {
    script: 'doc_to_md.py',
    extensions: ['.docx', '.doc', '.epub', '.odt', '.rtf'],
    description: 'Word文档'
  },
  excel: {
    script: 'excel_to_md.py',
    extensions: ['.xlsx', '.xls', '.csv'],
    description: 'Excel表格'
  },
  ppt: {
    script: 'ppt_to_md.py',
    extensions: ['.pptx', '.ppt'],
    description: 'PPT演示文稿'
  },
  web: {
    script: 'web_to_md.py',
    extensions: ['.url'],
    description: '网页'
  }
};

class DocumentConverterService {
  static CACHE_VERSION = 'v2-libreoffice-docx-text';

  /**
   * Detect the appropriate converter for a file
   */
  static detectConverter(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    for (const [key, converter] of Object.entries(CONVERTERS)) {
      if (converter.extensions.includes(ext)) {
        return key;
      }
    }
    return null;
  }

  /**
   * Get the conversion script path
   */
  static getConverterScript(converterType) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const root = runtimeConfig.pptMasterRoot || DEFAULT_PPT_MASTER_ROOT;
    return path.join(root, 'skills', 'ppt-master', 'scripts', 'source_to_md', CONVERTERS[converterType].script);
  }

  /**
   * Resolve Python interpreter path
   */
  static resolvePython(runtimeConfig) {
    const candidates = [
      runtimeConfig.pptMasterPython || DEFAULT_PPT_MASTER_PYTHON,
      process.env.PYTHON_BIN,
      'python3',
      path.join(DEFAULT_PPT_MASTER_ROOT, 'venv', 'bin', 'python'),
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
      'python'
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
      if (this.pythonVersionAtLeast(candidate, 3, 10)) return candidate;
    }

    return process.env.PYTHON_BIN || 'python3';
  }

  static pythonVersionAtLeast(python, major, minor) {
    try {
      const result = spawnSync(python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
        encoding: 'utf-8',
        timeout: 3000
      });
      if (result.status !== 0) return false;
      const [actualMajor, actualMinor] = String(result.stdout || '').trim().split('.').map(Number);
      return actualMajor > major || (actualMajor === major && actualMinor >= minor);
    } catch (error) {
      return false;
    }
  }

  /**
   * Convert a document to Markdown
   * @param {string} inputPath - Path to the input document
   * @param {Object} options - Conversion options
   * @returns {Promise<{success: boolean, markdown: string, outputPath: string, converter: string}>}
   */
  static async convert(inputPath, options = {}) {
    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const python = this.resolvePython(runtimeConfig);
    const converterType = options.converter || this.detectConverter(inputPath);

    if (!converterType) {
      throw new Error(`Unsupported document format: ${path.extname(inputPath)}`);
    }

    const scriptPath = this.getConverterScript(converterType);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Conversion script not found: ${scriptPath}`);
    }

    const outputDir = options.outputDir || path.join(UPLOAD_DIR, 'converted');
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(
      outputDir,
      path.basename(inputPath, path.extname(inputPath)) + '.md'
    );

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const args = [scriptPath, inputPath, '-o', outputPath];

      if (options.verbose) {
        args.push('-v');
      }

      execFile(
        python,
        args,
        {
          timeout: options.timeoutMs || 120000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout, stderr) => {
          const duration = Date.now() - startTime;
          const detail = [stderr, stdout, error?.message].filter(Boolean).join('\n').trim();

          if (error && !fs.existsSync(outputPath)) {
            if (converterType === 'ppt' && path.extname(inputPath).toLowerCase() === '.pptx') {
              this.fallbackPptxToMarkdown(inputPath, outputPath, python, startTime)
                .then(resolve)
                .catch(fallbackError => {
                  reject(new Error(`Conversion failed: ${detail || 'unknown error'}\nFallback failed: ${fallbackError.message}`));
                });
              return;
            }
            if (converterType === 'doc') {
              this.fallbackWordToMarkdown(inputPath, outputPath, startTime)
                .then(resolve)
                .catch(fallbackError => {
                  reject(new Error(`Conversion failed: ${detail || 'unknown error'}\nFallback failed: ${fallbackError.message}`));
                });
              return;
            }
            reject(new Error(`Conversion failed: ${detail || 'unknown error'}`));
            return;
          }

          try {
            const markdown = fs.readFileSync(outputPath, 'utf-8');

            resolve({
              success: true,
              markdown,
              outputPath,
              converter: converterType,
              duration,
              fileSize: fs.statSync(inputPath).size,
              lineCount: markdown.split('\n').length
            });
          } catch (readError) {
            reject(new Error(`Conversion succeeded but cannot read output: ${readError.message}`));
          }
        }
      );
    });
  }

  static async fallbackWordToMarkdown(inputPath, outputPath, startTime = Date.now()) {
    const inputExt = path.extname(inputPath).toLowerCase();
    const errors = [];

    if (inputExt === '.doc') {
      try {
        return await this.fallbackWordToMarkdownWithLibreOfficeDocx(inputPath, outputPath, startTime);
      } catch (error) {
        errors.push(`LibreOffice docx fallback failed: ${error.message}`);
      }
    }

    try {
      return await this.fallbackWordToMarkdownWithLibreOffice(inputPath, outputPath, startTime);
    } catch (error) {
      errors.push(`LibreOffice fallback failed: ${error.message}`);
    }

    if (process.platform === 'darwin') {
      try {
        return await this.fallbackWordToMarkdownWithTextutil(inputPath, outputPath, startTime);
      } catch (error) {
        errors.push(`textutil fallback failed: ${error.message}`);
      }
    }

    throw new Error([
      `No fallback converter could read ${inputExt || 'document'} file.`,
      'Install pandoc or LibreOffice on Ubuntu 22, e.g. apt install libreoffice pandoc.',
      ...errors
    ].join('\n'));
  }

  static async fallbackWordToMarkdownWithLibreOfficeDocx(inputPath, outputPath, startTime = Date.now()) {
    const soffice = this.resolveLibreOffice();
    if (!soffice) {
      throw new Error('LibreOffice/soffice executable not found');
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const workDir = path.join(
      path.dirname(outputPath),
      `${path.basename(outputPath, path.extname(outputPath))}_lo_docx`
    );
    const profileDir = path.join(workDir, 'profile');
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(profileDir, { recursive: true });

    await new Promise((resolve, reject) => {
      execFile(
        soffice,
        [
          '--headless',
          '--nologo',
          '--nofirststartwizard',
          this.libreOfficeUserInstallationArg(profileDir),
          '--convert-to',
          'docx',
          '--outdir',
          workDir,
          inputPath
        ],
        {
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, HOME: this.resolveWritableHome() }
        },
        (error, stdout = '', stderr = '') => {
          if (error) {
            reject(new Error(stderr || stdout || error.message));
            return;
          }
          resolve();
        }
      );
    });

    const docxPath = this.findConvertedOfficeFile(workDir, inputPath, '.docx');
    if (!docxPath) {
      throw new Error('LibreOffice conversion completed but no docx output was generated');
    }

    const runtimeConfig = RuntimeConfigService.getRuntimeConfig();
    const python = this.resolvePython(runtimeConfig);
    const scriptPath = this.getConverterScript('doc');

    await new Promise((resolve, reject) => {
      execFile(
        python,
        [scriptPath, docxPath, '-o', outputPath],
        {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout = '', stderr = '') => {
          if (error || !fs.existsSync(outputPath)) {
            reject(new Error(stderr || stdout || error?.message || 'docx markdown conversion failed'));
            return;
          }
          resolve();
        }
      );
    });

    const markdown = fs.readFileSync(outputPath, 'utf-8');
    if (!String(markdown || '').trim()) {
      throw new Error('docx markdown conversion output is empty');
    }

    return {
      success: true,
      markdown,
      outputPath,
      converter: 'doc',
      fallback: 'libreoffice-docx',
      duration: Date.now() - startTime,
      fileSize: fs.statSync(inputPath).size,
      lineCount: markdown.split('\n').length
    };
  }

  static async fallbackWordToMarkdownWithLibreOffice(inputPath, outputPath, startTime = Date.now()) {
    const inputExt = path.extname(inputPath).toLowerCase();
    const soffice = this.resolveLibreOffice();
    if (!soffice) {
      throw new Error('LibreOffice/soffice executable not found');
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const workDir = path.join(
      path.dirname(outputPath),
      `${path.basename(outputPath, path.extname(outputPath))}_lo`
    );
    const profileDir = path.join(workDir, 'profile');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });

    await new Promise((resolve, reject) => {
      execFile(
        soffice,
        [
          '--headless',
          '--nologo',
          '--nofirststartwizard',
          this.libreOfficeUserInstallationArg(profileDir),
          '--convert-to',
          'txt:Text',
          '--outdir',
          workDir,
          inputPath
        ],
        {
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, HOME: this.resolveWritableHome() }
        },
        (error, stdout = '', stderr = '') => {
          if (error) {
            reject(new Error(stderr || stdout || error.message));
            return;
          }
          resolve();
        }
      );
    });

    const txtPath = this.findConvertedTextFile(workDir, inputPath);
    if (!txtPath) {
      throw new Error('LibreOffice conversion completed but no txt output was generated');
    }

    return this.markdownFromPlainTextFile({
      inputPath,
      inputExt,
      outputPath,
      txtPath,
      fallback: 'libreoffice',
      startTime
    });
  }

  static async fallbackWordToMarkdownWithTextutil(inputPath, outputPath, startTime = Date.now()) {
    const inputExt = path.extname(inputPath).toLowerCase();
    const textutil = '/usr/bin/textutil';
    if (!fs.existsSync(textutil)) {
      throw new Error('textutil is not available in current environment');
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const txtPath = path.join(
      path.dirname(outputPath),
      `${path.basename(outputPath, path.extname(outputPath))}.txt`
    );

    await new Promise((resolve, reject) => {
      execFile(
        textutil,
        ['-convert', 'txt', inputPath, '-output', txtPath],
        {
          timeout: 90000,
          maxBuffer: 8 * 1024 * 1024
        },
        (error, stdout = '', stderr = '') => {
          if (error) {
            reject(new Error(stderr || stdout || error.message));
            return;
          }
          resolve();
        }
      );
    });

    return this.markdownFromPlainTextFile({
      inputPath,
      inputExt,
      outputPath,
      txtPath,
      fallback: 'textutil',
      startTime
    });
  }

  static markdownFromPlainTextFile({ inputPath, inputExt, outputPath, txtPath, fallback, startTime = Date.now() }) {
    if (!fs.existsSync(txtPath)) {
      throw new Error(`${fallback} conversion completed but no txt output was generated`);
    }

    const rawText = fs.readFileSync(txtPath, 'utf-8');
    const normalizedText = String(rawText || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    if (!normalizedText) {
      throw new Error(`${fallback} output is empty`);
    }

    // Plain-text converters often use form feed as page boundary; keep it as page hints in markdown.
    const pages = normalizedText
      .split('\f')
      .map(part => part.trim())
      .filter(Boolean);

    const docTitle = path.basename(inputPath);
    let markdown = '';
    if (pages.length > 1) {
      markdown = [
        `# 上传文档：${docTitle}`,
        '',
        `> 自动提取方式：${fallback} 兜底（${inputExt || 'document'}）`,
        ''
      ].join('\n');
      pages.forEach((pageText, idx) => {
        markdown += `## Page ${idx + 1}\n\n${pageText}\n\n`;
      });
    } else {
      markdown = [
        `# 上传文档：${docTitle}`,
        '',
        `> 自动提取方式：${fallback} 兜底（${inputExt || 'document'}）`,
        '',
        normalizedText,
        ''
      ].join('\n');
    }

    fs.writeFileSync(outputPath, markdown, 'utf-8');

    return {
      success: true,
      markdown,
      outputPath,
      converter: 'doc',
      fallback,
      duration: Date.now() - startTime,
      fileSize: fs.statSync(inputPath).size,
      lineCount: markdown.split('\n').length
    };
  }

  static resolveLibreOffice() {
    const candidates = [
      process.env.LIBREOFFICE_BIN,
      process.env.SOFFICE_BIN,
      'soffice',
      'libreoffice',
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
      '/snap/bin/libreoffice',
      '/opt/libreoffice/program/soffice',
      '/Applications/LibreOffice.app/Contents/MacOS/soffice'
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
      try {
        const result = spawnSync(candidate, ['--version'], {
          encoding: 'utf-8',
          timeout: 5000
        });
        if (result.status === 0) return candidate;
      } catch (error) {
        // Try the next candidate.
      }
    }
    return '';
  }

  static resolveWritableHome() {
    const candidates = [
      process.env.HOME,
      appConfig.dataDir,
      appConfig.uploadDir,
      '/tmp'
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        fs.mkdirSync(candidate, { recursive: true });
        fs.accessSync(candidate, fs.constants.W_OK);
        return candidate;
      } catch (error) {
        // Try the next writable location.
      }
    }
    return '/tmp';
  }

  static libreOfficeUserInstallationArg(profileDir) {
    fs.mkdirSync(profileDir, { recursive: true });
    return `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
  }

  static cacheVersionPath(outputDir) {
    return path.join(outputDir, '.converter-version');
  }

  static markCacheFresh(outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(this.cacheVersionPath(outputDir), `${this.CACHE_VERSION}\n`, 'utf-8');
  }

  static readCachedMarkdown(outputPath, sourceMtimeMs) {
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).mtimeMs < sourceMtimeMs) {
      return null;
    }
    const outputDir = path.dirname(outputPath);
    const version = fs.existsSync(this.cacheVersionPath(outputDir))
      ? fs.readFileSync(this.cacheVersionPath(outputDir), 'utf-8').trim()
      : '';
    if (version !== this.CACHE_VERSION) {
      return null;
    }
    const markdown = fs.readFileSync(outputPath, 'utf-8');
    return this.isProbablyGarbledMarkdown(markdown) ? null : markdown;
  }

  static isProbablyGarbledMarkdown(markdown = '') {
    const text = String(markdown || '').replace(/\s+/g, '');
    if (text.length < 80) return false;

    const questionCount = (text.match(/\?/g) || []).length;
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const cjkCount = (text.match(/[\u3400-\u9FFF]/g) || []).length;
    const visible = Math.max(1, text.length);
    const repeatedQuestionLines = String(markdown || '')
      .split(/\n+/)
      .filter(line => /^\s*\?{3,}\s*$/.test(line) || /\?{5,}/.test(line))
      .length;

    if (replacementCount / visible > 0.02) return true;
    if (repeatedQuestionLines >= 3 && questionCount / visible > 0.08) return true;
    if (questionCount / visible > 0.22 && cjkCount < 8) return true;
    return false;
  }

  static findConvertedTextFile(workDir, inputPath) {
    if (!fs.existsSync(workDir)) return '';
    const base = path.basename(inputPath, path.extname(inputPath));
    const preferred = [
      path.join(workDir, `${base}.txt`),
      path.join(workDir, `${base}.text`)
    ];
    const direct = preferred.find(file => fs.existsSync(file));
    if (direct) return direct;

    const textFiles = fs.readdirSync(workDir)
      .filter(name => /\.(txt|text)$/i.test(name))
      .map(name => path.join(workDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return textFiles[0] || '';
  }

  static findConvertedOfficeFile(workDir, inputPath, extension) {
    if (!fs.existsSync(workDir)) return '';
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    const base = path.basename(inputPath, path.extname(inputPath));
    const direct = path.join(workDir, `${base}${ext}`);
    if (fs.existsSync(direct)) return direct;

    return fs.readdirSync(workDir)
      .filter(name => name.toLowerCase().endsWith(ext.toLowerCase()))
      .map(name => path.join(workDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
  }

  static async fallbackPptxToMarkdown(inputPath, outputPath, python, startTime = Date.now()) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const script = `
import html
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

input_path, output_path = sys.argv[1], sys.argv[2]

def slide_key(name):
    m = re.search(r"slide(\\d+)\\.xml$", name)
    return int(m.group(1)) if m else 0

def clean_text(value):
    return re.sub(r"\\s+", " ", html.unescape(value or "")).strip()

lines = [f"# Presentation Source: {os.path.basename(input_path)}", ""]
with zipfile.ZipFile(input_path) as archive:
    slide_names = sorted(
        [name for name in archive.namelist() if re.match(r"ppt/slides/slide\\d+\\.xml$", name)],
        key=slide_key
    )
    for index, slide_name in enumerate(slide_names, start=1):
        raw = archive.read(slide_name)
        root = ET.fromstring(raw)
        texts = []
        for node in root.iter():
            if node.tag.endswith("}t") and node.text:
                text = clean_text(node.text)
                if text:
                    texts.append(text)
        lines.extend([f"## Slide {index}", ""])
        if texts:
            seen = set()
            for text in texts:
                if text in seen:
                    continue
                seen.add(text)
                lines.append(f"- {text}")
        else:
            lines.append("- （本页未提取到文本）")
        lines.append("")

with open(output_path, "w", encoding="utf-8") as f:
    f.write("\\n".join(lines).strip() + "\\n")
`;

    await new Promise((resolve, reject) => {
      execFile(
        python,
        ['-c', script, inputPath, outputPath],
        {
          timeout: 60000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout);
        }
      );
    });

    const markdown = fs.readFileSync(outputPath, 'utf-8');
    return {
      success: true,
      markdown,
      outputPath,
      converter: 'ppt',
      fallback: true,
      duration: Date.now() - startTime,
      fileSize: fs.statSync(inputPath).size,
      lineCount: markdown.split('\n').length
    };
  }

  /**
   * Convert document and return markdown content
   * @param {string} inputPath - Path to the input document
   * @param {Object} options - Conversion options
   * @returns {Promise<string>} - Markdown content
   */
  static async convertToMarkdown(inputPath, options = {}) {
    const result = await this.convert(inputPath, options);
    return result.markdown;
  }

  /**
   * Get supported file extensions
   */
  static getSupportedExtensions() {
    const extensions = [];
    for (const converter of Object.values(CONVERTERS)) {
      extensions.push(...converter.extensions);
    }
    return [...new Set(extensions.map(ext => ext.toLowerCase()))];
  }

  /**
   * Get converter info for a file extension
   */
  static getConverterInfo(ext) {
    const extension = ext.toLowerCase();
    for (const [key, converter] of Object.entries(CONVERTERS)) {
      if (converter.extensions.includes(extension)) {
        return {
          type: key,
          script: converter.script,
          extensions: converter.extensions,
          description: converter.description
        };
      }
    }
    return null;
  }

  /**
   * Check if file extension is supported
   */
  static isSupported(filePath) {
    return this.detectConverter(filePath) !== null;
  }
}

module.exports = DocumentConverterService;
