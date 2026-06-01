const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const DocumentConverterService = require('./documentConverterService');
const appConfig = require('../config/appConfig');

class SpreadsheetPreviewService {
  static CACHE_VERSION = 'v1-structured-spreadsheet-preview';

  static getOutputDir(userId, fileId) {
    return path.join(appConfig.uploadDir, 'spreadsheet_previews', String(userId), String(fileId));
  }

  static getCachePath(outputDir) {
    return path.join(outputDir, 'preview.json');
  }

  static isSpreadsheet(filePath = '') {
    return ['.xlsx', '.xls', '.csv'].includes(path.extname(String(filePath || '')).toLowerCase());
  }

  static async buildPreview(file, userId, options = {}) {
    if (file?.path) {
      file = { ...file, path: appConfig.assertInsideUploadDir(file.path) };
    }

    if (!file?.path || !fs.existsSync(file.path)) {
      throw new Error('文件不存在');
    }
    if (!this.isSpreadsheet(file.path || file.original_name || file.filename)) {
      throw new Error('这个文件不是表格文件');
    }

    const outputDir = this.getOutputDir(userId, file.id);
    fs.mkdirSync(outputDir, { recursive: true });

    const cachePath = this.getCachePath(outputDir);
    const sourceStat = fs.statSync(file.path);
    if (options.force !== true && fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (
          cached?.cacheVersion === this.CACHE_VERSION &&
          Number(cached?.sourceMtimeMs || 0) >= sourceStat.mtimeMs
        ) {
          return cached;
        }
      } catch (error) {
        // Ignore stale or invalid cache.
      }
    }

    const inputPath = await this.prepareInput(file.path, outputDir);
    const runtimeConfig = require('./runtimeConfigService').getRuntimeConfig();
    const python = DocumentConverterService.resolvePython(runtimeConfig);
    const outputPath = cachePath;
    const script = this.getPythonScript();

    await new Promise((resolve, reject) => {
      execFile(
        python,
        [
          '-c',
          script,
          inputPath,
          outputPath,
          String(Math.max(1, Math.min(400, Number(options.maxRows) || 120))),
          String(Math.max(1, Math.min(80, Number(options.maxCols) || 36))),
          String(Math.max(1, Math.min(24, Number(options.maxSheets) || 12)))
        ],
        {
          timeout: 90000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
        (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(stdout)
      );
    });

    const result = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    result.cacheVersion = this.CACHE_VERSION;
    result.sourceMtimeMs = sourceStat.mtimeMs;
    result.fileName = file.original_name || file.filename || path.basename(file.path);
    result.fileSize = file.size || sourceStat.size;
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    return result;
  }

  static async prepareInput(inputPath, outputDir) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext !== '.xls') return inputPath;

    const office = this.findExecutable([
      'soffice',
      'libreoffice',
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/usr/bin/libreoffice',
      '/usr/local/bin/libreoffice',
      '/opt/homebrew/bin/libreoffice'
    ]);
    if (!office) {
      throw new Error('当前环境缺少 LibreOffice，暂时无法预览旧版 xls 文件');
    }

    const convertDir = path.join(outputDir, 'converted_xlsx');
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
          'xlsx',
          '--outdir',
          convertDir,
          inputPath
        ],
        {
          timeout: 90000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, HOME: DocumentConverterService.resolveWritableHome() }
        },
        (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(stdout)
      );
    });

    const converted = fs.readdirSync(convertDir)
      .filter(name => /\.xlsx$/i.test(name))
      .map(name => path.join(convertDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!converted) {
      throw new Error('旧版 xls 转换失败');
    }
    return converted;
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

  static getPythonScript() {
    return String.raw`
import csv
import json
import math
import sys
from datetime import date, datetime, time
from pathlib import Path

input_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
max_rows = int(sys.argv[3])
max_cols = int(sys.argv[4])
max_sheets = int(sys.argv[5])

def empty(value):
    return value is None or (isinstance(value, str) and value.strip() == "")

def display_value(value):
    if empty(value):
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, time):
        return value.strftime("%H:%M:%S")
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return str(int(value))
        return f"{value:g}"
    return str(value)

def column_letter(index):
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters or "A"

def trim_matrix(values):
    max_width = 0
    last_row = -1
    for row_index, row in enumerate(values):
        row_width = 0
        for col_index, value in enumerate(row):
            if not empty(value):
                row_width = col_index + 1
        if row_width:
            last_row = row_index
            max_width = max(max_width, row_width)
    if last_row < 0 or max_width <= 0:
        return []
    return [row[:max_width] + [""] * max(0, max_width - len(row)) for row in values[:last_row + 1]]

def sheet_from_values(name, values, start_row=1, start_col=1, total_rows=None, total_cols=None):
    matrix = trim_matrix(values)
    actual_rows = len(matrix)
    actual_cols = max((len(row) for row in matrix), default=0)
    limited_rows = matrix[:max_rows]
    limited_rows = [row[:max_cols] for row in limited_rows]
    row_count = total_rows or actual_rows
    col_count = total_cols or actual_cols
    return {
        "name": name,
        "rowOffset": start_row,
        "colOffset": start_col,
        "rowCount": row_count,
        "columnCount": col_count,
        "rowsTruncated": actual_rows > max_rows,
        "columnsTruncated": actual_cols > max_cols,
        "colHeaders": [column_letter(start_col + i) for i in range(min(actual_cols, max_cols))],
        "rowHeaders": [start_row + i for i in range(len(limited_rows))],
        "rows": [[display_value(cell) for cell in row] for row in limited_rows],
    }

def read_csv(path):
    last_error = None
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            with path.open("r", encoding=encoding, newline="") as handle:
                rows = list(csv.reader(handle))
            return {
                "type": "csv",
                "sheets": [sheet_from_values(path.stem or "CSV", rows)],
                "activeSheet": 0,
            }
        except Exception as error:
            last_error = error
    raise last_error

def read_workbook(path):
    from openpyxl import load_workbook
    workbook = load_workbook(path, data_only=True, read_only=False)
    sheets = []
    for worksheet in workbook.worksheets:
        if worksheet.sheet_state != "visible":
            continue
        min_row = min_col = None
        max_row = max_col = None
        for row in worksheet.iter_rows():
            for cell in row:
                if empty(cell.value):
                    continue
                min_row = cell.row if min_row is None else min(min_row, cell.row)
                max_row = cell.row if max_row is None else max(max_row, cell.row)
                min_col = cell.column if min_col is None else min(min_col, cell.column)
                max_col = cell.column if max_col is None else max(max_col, cell.column)
        if min_row is None:
            sheets.append({
                "name": worksheet.title,
                "rowOffset": 1,
                "colOffset": 1,
                "rowCount": 0,
                "columnCount": 0,
                "rowsTruncated": False,
                "columnsTruncated": False,
                "colHeaders": [],
                "rowHeaders": [],
                "rows": [],
            })
        else:
            rows = []
            for row_index in range(min_row, max_row + 1):
                rows.append([worksheet.cell(row_index, col_index).value for col_index in range(min_col, max_col + 1)])
            sheets.append(sheet_from_values(
                worksheet.title,
                rows,
                min_row,
                min_col,
                max_row - min_row + 1,
                max_col - min_col + 1,
            ))
        if len(sheets) >= max_sheets:
            break
    return {
        "type": "workbook",
        "sheets": sheets,
        "activeSheet": 0,
        "sheetCount": len(workbook.worksheets),
        "visibleSheetCount": len([sheet for sheet in workbook.worksheets if sheet.sheet_state == "visible"]),
    }

if input_path.suffix.lower() == ".csv":
    result = read_csv(input_path)
else:
    result = read_workbook(input_path)

output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
`;
  }
}

module.exports = SpreadsheetPreviewService;
