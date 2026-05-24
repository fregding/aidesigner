#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectPath = path.resolve(process.argv[2] || '');
const officialPath = path.resolve(process.argv[3] || 'external/ppt-master/examples/ppt169_building_effective_agents');
const pptMasterRoot = path.resolve(process.env.PPT_MASTER_ROOT || 'external/ppt-master');

if (!projectPath || !fs.existsSync(projectPath)) {
  console.error('Usage: node scripts/analyze-pptmaster-quality.js <generated_project_path> [official_example_path]');
  process.exit(2);
}

const rows = [
  ['Metric', 'Generated', 'Official Example'],
  ['Project', projectPath, officialPath],
  ...metricRows(analyzeProject(projectPath), analyzeProject(officialPath))
];

console.log(toMarkdownTable(rows));

function analyzeProject(root) {
  const svgOutput = path.join(root, 'svg_output');
  const svgFinal = path.join(root, 'svg_final');
  const designSpecPath = path.join(root, 'design_spec.md');
  const specLockPath = path.join(root, 'spec_lock.md');
  const exportDir = path.join(root, 'exports');
  const svgs = listFiles(svgFinal).filter(file => file.endsWith('.svg')).length
    ? listFiles(svgFinal).filter(file => file.endsWith('.svg'))
    : listFiles(svgOutput).filter(file => file.endsWith('.svg'));
  const outputSvgs = listFiles(svgOutput).filter(file => file.endsWith('.svg'));
  const svgText = svgs.map(file => safeRead(file)).join('\n');
  const svgOutputText = outputSvgs.map(file => safeRead(file)).join('\n');
  const specLock = safeRead(specLockPath);
  const designSpec = safeRead(designSpecPath);
  const quality = runQualityCheck(root);
  const pptxFiles = listFiles(exportDir).filter(file => file.endsWith('.pptx'));
  const pptxSize = pptxFiles.reduce((total, file) => total + fs.statSync(file).size, 0);

  return {
    slides: svgs.length,
    pptxFiles: pptxFiles.length,
    pptxSize,
    qualityPassed: quality.ok,
    qualityOutput: quality.output,
    gradients: count(svgText, /<(?:linearGradient|radialGradient)\b/gi),
    filters: count(svgText, /<filter\b|filter=(["'])url\(#/gi),
    urlFills: count(svgText, /\b(?:fill|stroke)=(["'])url\(#/gi),
    semanticGroups: count(svgText, /<g\b[^>]*\bid=(["'])[^"']+\1/gi),
    chartMarkers: count(svgOutputText || svgText, /chart-plot-area:/gi),
    imageRefs: count(svgText, /<image\b/gi),
    colors: uniqueMatches(specLock, /#[0-9a-f]{6}\b/gi).length,
    typographyRoles: count(specLock, /^-\s*(?:font_family|code_family|body|title|subtitle|annotation|cover_title|hero_number):/gmi),
    specImages: count(specLock, /^-\s*image(?:_\d+)?:\s*/gmi),
    pendingImages: count(designSpec, /\bPending\b|Pending generation|待生成/gi),
    generatedImages: count(designSpec, /\bGenerated\b/gi),
    needsManualImages: count(designSpec, /Needs-Manual/gi)
  };
}

function metricRows(generated, official) {
  return [
    ['Slides', generated.slides, official.slides],
    ['PPTX files', generated.pptxFiles, official.pptxFiles],
    ['PPTX size', formatBytes(generated.pptxSize), formatBytes(official.pptxSize)],
    ['Quality checker passed', generated.qualityPassed ? 'yes' : 'no', official.qualityPassed ? 'yes' : 'no'],
    ['Gradients', generated.gradients, official.gradients],
    ['Filters / shadows', generated.filters, official.filters],
    ['URL fills/strokes', generated.urlFills, official.urlFills],
    ['Semantic g[id] groups', generated.semanticGroups, official.semanticGroups],
    ['Chart markers', generated.chartMarkers, official.chartMarkers],
    ['Embedded image refs', generated.imageRefs, official.imageRefs],
    ['Spec-lock HEX colors', generated.colors, official.colors],
    ['Typography roles', generated.typographyRoles, official.typographyRoles],
    ['Spec-lock images', generated.specImages, official.specImages],
    ['Pending images in design_spec', generated.pendingImages, official.pendingImages],
    ['Generated images in design_spec', generated.generatedImages, official.generatedImages],
    ['Needs-Manual images', generated.needsManualImages, official.needsManualImages]
  ];
}

function runQualityCheck(root) {
  const script = path.join(pptMasterRoot, 'skills', 'ppt-master', 'scripts', 'svg_quality_checker.py');
  if (!fs.existsSync(script)) {
    return { ok: false, output: 'svg_quality_checker.py not found' };
  }

  const python = process.env.PPT_MASTER_PYTHON ||
    path.join(pptMasterRoot, 'venv', 'bin', 'python');
  const command = fs.existsSync(python) ? python : 'python3';
  const result = spawnSync(command, [script, root, '--format', inferFormat(root)], {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  };
}

function inferFormat(root) {
  const spec = safeRead(path.join(root, 'spec_lock.md')) + '\n' + safeRead(path.join(root, 'design_spec.md'));
  return /1024\s*[×x]\s*768|PPT 4:3|ppt43/i.test(spec) ? 'ppt43' : 'ppt169';
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => path.join(dir, name))
    .filter(file => fs.statSync(file).isFile());
}

function safeRead(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

function count(text, pattern) {
  return (String(text || '').match(pattern) || []).length;
}

function uniqueMatches(text, pattern) {
  return [...new Set(String(text || '').match(pattern) || [])];
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function toMarkdownTable(tableRows) {
  const widths = tableRows[0].map((_, index) => Math.max(...tableRows.map(row => String(row[index] ?? '').length)));
  const render = row => `| ${row.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join(' | ')} |`;
  return [
    render(tableRows[0]),
    render(widths.map(width => '-'.repeat(width))),
    ...tableRows.slice(1).map(render)
  ].join('\n');
}
