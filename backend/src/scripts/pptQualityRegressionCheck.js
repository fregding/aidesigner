const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const PptAgent = require('../agents/PptAgent');
const RuntimeConfigService = require('../services/runtimeConfigService');

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-quality-regression-'));
  try {
    const projectPath = path.join(tmpRoot, 'project');
    const svgDir = path.join(projectPath, 'svg_output');
    const imageDir = path.join(projectPath, 'images');
    fs.mkdirSync(svgDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });

    const imagePath = path.join(imageDir, 'proof.png');
    await sharp({
      create: {
        width: 12,
        height: 12,
        channels: 4,
        background: { r: 0, g: 118, b: 168, alpha: 1 }
      }
    }).png().toFile(imagePath);

    const svgPath = path.join(svgDir, '01_slide_1.svg');
    const rawSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
      '<rect width="1280" height="720" fill="#fff"/>',
      '<image href="../images/proof.png" x="20" y="20" width="120" height="120"/>',
      '</svg>'
    ].join('');
    fs.writeFileSync(svgPath, rawSvg);

    const agent = new PptAgent();
    agent.projectPath = projectPath;
    agent.params = { canvasFormat: 'ppt169' };

    const inlined = agent._inlineSvgExternalImagesForPreview(rawSvg, svgPath);
    assert.match(inlined, /href="data:image\/png;base64,/);
    assert.ok(!inlined.includes('../images/proof.png'));

    const outputPng = path.join(tmpRoot, 'preview.png');
    await agent._renderSvgPagePreview(svgPath, outputPng);
    const rendered = await sharp(outputPng).metadata();
    assert.strictEqual(rendered.width, 1280);
    assert.strictEqual(rendered.height, 720);

    assert.strictEqual(agent._aiVisualReviewPageFailed({ severity: 'warning', passed: false }), false);
    assert.strictEqual(agent._aiVisualReviewPageFailed({ severity: 'ok', passed: false }), false);
    assert.strictEqual(agent._aiVisualReviewPageFailed({ severity: 'fail', passed: true }), true);
    assert.strictEqual(agent._aiVisualReviewPageFailed({ passed: false }), true);
    assert.strictEqual(agent._aiPageVisualReviewRequired(), false);

    const visionRaw = {
      text_provider_profiles: JSON.stringify([
        {
          id: 'deepseek',
          name: 'DeepSeek',
          format: 'openai',
          baseUrl: 'https://deepseek.example/v1',
          apiKey: 'sk-test',
          defaultModel: 'deepseek-v4-pro',
          models: [{ id: 'deepseek-v4-pro', category: 'chat', enabled: true }]
        },
        {
          id: 'vision',
          name: 'Vision',
          format: 'openai',
          baseUrl: 'https://vision.example/v1',
          apiKey: 'sk-test',
          defaultModel: 'gpt-5.4-mini',
          models: [{ id: 'gpt-5.4-mini', category: 'chat', enabled: true }]
        }
      ]),
      ppt_page_review_provider_id: 'deepseek',
      ppt_page_review_model: 'deepseek-v4-pro'
    };
    const providers = RuntimeConfigService.getTextProviderProfiles(visionRaw);
    const defaultVisionRoute = RuntimeConfigService.defaultVisionTextRoute(providers, visionRaw);
    const pageReviewRoute = RuntimeConfigService.resolvePptVisionReviewRoute(visionRaw, defaultVisionRoute, providers, {
      providerKeys: ['ppt_page_review_provider_id'],
      modelKeys: ['ppt_page_review_model']
    });
    assert.strictEqual(pageReviewRoute.providerId, 'vision');
    assert.strictEqual(pageReviewRoute.model, 'gpt-5.4-mini');

    console.log('PPT quality regression checks passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
