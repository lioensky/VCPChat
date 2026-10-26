import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const service = (await import('../modules/services/minerU/minerUService.js')).default;
const protocol = (await import('../modules/services/minerU/minerUProtocol.js')).default;

const PAPER_ID = 'paper_0123456789abcdef';

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function binaryName() {
    const targets = {
        'win32:x64': ['x86_64-pc-windows-msvc', '.exe'],
        'win32:arm64': ['aarch64-pc-windows-msvc', '.exe'],
        'linux:x64': ['x86_64-unknown-linux-gnu', ''],
        'linux:arm64': ['aarch64-unknown-linux-gnu', ''],
        'darwin:x64': ['x86_64-apple-darwin', ''],
        'darwin:arm64': ['aarch64-apple-darwin', ''],
    };
    return targets[`${process.platform}:${process.arch}`];
}

test('MinerU service scans assets, serves images, and reads mapped PDFs', async t => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-mineru-service-'));
    const toolboxRoot = path.join(sandbox, 'VCPToolBox');
    const appDataRoot = path.join(sandbox, 'AppData');
    const pluginDir = path.join(toolboxRoot, 'Plugin', 'MinerUParser');
    const leaf = `Demo Paper__${PAPER_ID}`;
    const fileDir = path.join(toolboxRoot, 'file', 'mineru', leaf);
    const imageDir = path.join(toolboxRoot, 'image', 'mineru', leaf, 'images');
    const imagePath = path.join(imageDir, 'a.png');
    const pdfPath = path.join(sandbox, 'demo.pdf');

    writeJson(path.join(pluginDir, 'plugin-manifest.json'), { name: 'MinerUParser', version: '0.4.0' });
    fs.writeFileSync(path.join(pluginDir, 'config.env'), 'MINERU_TOKEN=test-token\nMODEL_VERSION=vlm\n');
    fs.writeFileSync(path.join(toolboxRoot, 'config.env'), 'PORT=6005\nImage_Key=imgkey\nFile_Key=filekey\n');
    const target = binaryName();
    assert.ok(target, 'test platform must be supported');
    const binPath = path.join(pluginDir, 'bin', `MinerUParser-${target[0]}${target[1]}`);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '');
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);

    const markdown = '# Demo Paper\n\nBody paragraph.\n\n![Fig 1](images/a.png)\n';
    writeJson(path.join(fileDir, 'index.json'), {
        paper_id: PAPER_ID,
        title: 'Demo Paper',
        file_name: 'demo.pdf',
        asset_dir: leaf,
        source_path: null,
        pages: 2,
        text_chars: markdown.length,
        image_count: 1,
        table_count: 0,
        formula_count: 0,
        md_path: '',
        render_url: '',
        outline: [{ level: 1, text: 'Demo Paper', page_idx: 0 }],
        images: [{ rel: 'images/a.png', url: '', caption: 'Fig 1', page_idx: 0 }],
        errors: [],
        warnings: ['demo warning'],
        created_at: '2026-10-26T00:00:00Z',
    });
    writeJson(path.join(fileDir, 'state.json'), {
        paper_id: PAPER_ID,
        state: 'indexed',
        file_name: 'demo.pdf',
        created_at: '2026-10-26T00:00:00Z',
        updated_at: '2026-10-26T00:00:00Z',
    });
    fs.writeFileSync(path.join(fileDir, 'full.md'), markdown);
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    fs.writeFileSync(pdfPath, '%PDF-1.4 test');

    // 旧目录：同一 paper_id 的第二份资产
    const legacyDir = path.join(toolboxRoot, 'file', 'mineru', PAPER_ID);
    writeJson(path.join(legacyDir, 'state.json'), {
        paper_id: PAPER_ID,
        state: 'indexed',
        file_name: 'demo.pdf',
        created_at: '2026-10-20T00:00:00Z',
        updated_at: '2026-10-20T00:00:00Z',
    });

    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

    service.initialize({ appDataRoot, projectRoot: path.join(sandbox, 'VCPChat') });
    const saved = service.saveConfig({ toolboxRoot, workers: 9 });
    assert.equal(saved.workers, 5);
    const status = service.getStatus();
    assert.equal(status.ok, true);
    assert.equal(status.toolboxRoot, toolboxRoot);
    assert.equal(status.tokenConfigured, true);
    assert.equal(status.version, '0.4.0');

    const records = service.scanLibrary(true);
    assert.equal(records.length, 1);
    assert.equal(records[0].paperId, PAPER_ID);
    assert.equal(records[0].group, 'indexed');
    assert.equal(records[0].duplicateDirs.length, 1);
    assert.equal(records[0].pdfAvailable, false);
    assert.equal(records[0].imageDir, path.dirname(imageDir));

    const detail = service.getPaperDetail(PAPER_ID);
    assert.equal(detail.hasMarkdown, true);
    assert.equal(detail.markdownSource, 'full.md');
    assert.equal(detail.index.outline.length, 1);
    assert.equal(detail.index.images[0].rel, 'images/a.png');
    assert.equal(detail.index.warnings[0], 'demo warning');

    const resolvedImage = service.resolveImagePath(PAPER_ID, 'images/a.png');
    assert.equal(fs.realpathSync(resolvedImage), fs.realpathSync(imagePath));
    assert.throws(() => service.resolveImagePath(PAPER_ID, '../a.png'), /不能包含 \.\./);
    assert.throws(() => service.resolveAssetDir(PAPER_ID, 'Other__paper_ffffffffffffffff'), /不匹配/);
    assert.equal(service.resolveAssetDir(PAPER_ID, leaf), fileDir);

    const url = protocol.imageUrl(PAPER_ID, 'images/a.png');
    assert.deepEqual(protocol.parseAssetUrl(url), { paperId: PAPER_ID, rel: 'images/a.png' });
    assert.equal(protocol.parseAssetUrl('vcp-mineru://image/paper_x/../../secret.png'), null);

    const mapping = service.setPdfMapping(PAPER_ID, pdfPath);
    assert.equal(mapping.pdfPath, pdfPath);
    const withPdf = service.getPaperDetail(PAPER_ID);
    assert.equal(withPdf.pdfAvailable, true);
    assert.equal(withPdf.pdfName, 'demo.pdf');
    const pdf = service.readPdf(PAPER_ID);
    assert.equal(pdf.available, true);
    assert.equal(pdf.size, Buffer.byteLength('%PDF-1.4 test'));
    assert.equal(pdf.data.toString(), '%PDF-1.4 test');
    service.clearPdfMapping(PAPER_ID);
    assert.equal(service.getPaperDetail(PAPER_ID).pdfAvailable, false);
});
