import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const service = (await import('../modules/services/minerU/minerUService.js')).default;
const protocol = (await import('../modules/services/minerU/minerUProtocol.js')).default;

const PAPER_ID = 'paper_0123456789abcdef';
const DUP_ID = 'paper_duplicate0000000';

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

function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            let value;
            try {
                value = predicate();
            } catch (error) {
                clearInterval(timer);
                reject(error);
                return;
            }
            if (value) {
                clearInterval(timer);
                resolve(value);
            } else if (Date.now() - started > timeout) {
                clearInterval(timer);
                reject(new Error('waitFor timeout'));
            }
        }, interval);
        timer.unref?.();
    });
}

function setup() {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-mineru-stress-'));
    const toolboxRoot = path.join(sandbox, 'VCPToolBox');
    const appDataRoot = path.join(sandbox, 'AppData');
    const pluginDir = path.join(toolboxRoot, 'Plugin', 'MinerUParser');
    writeJson(path.join(pluginDir, 'plugin-manifest.json'), { name: 'MinerUParser', version: '0.4.0' });
    fs.writeFileSync(path.join(pluginDir, 'config.env'), 'MINERU_TOKEN=stress-token\nMODEL_VERSION=vlm\n');
    fs.writeFileSync(path.join(toolboxRoot, 'config.env'), 'PORT=6005\nImage_Key=imgkey\nFile_Key=filekey\n');
    const target = binaryName();
    assert.ok(target, 'test platform must be supported');
    const binPath = path.join(pluginDir, 'bin', `MinerUParser-${target[0]}${target[1]}`);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '');
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);

    service._test.reset();
    service._test.reinitialize({ appDataRoot, projectRoot: path.join(sandbox, 'VCPChat') });
    service.saveConfig({ toolboxRoot, workers: 2 });

    const pdfDir = path.join(sandbox, 'pdfs');
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdf = name => {
        const file = path.join(pdfDir, name);
        fs.writeFileSync(file, '%PDF-1.4 stress');
        return file;
    };
    return { sandbox, toolboxRoot, appDataRoot, pluginDir, pdf };
}

function writePaper(toolboxRoot, leaf, paperId, { title = 'Paper', state = 'indexed', index } = {}) {
    const dir = path.join(toolboxRoot, 'file', 'mineru', leaf);
    fs.mkdirSync(dir, { recursive: true });
    if (index !== null) {
        writeJson(path.join(dir, 'index.json'), index ?? {
            paper_id: paperId,
            title,
            file_name: 'demo.pdf',
            pages: 2,
            text_chars: 10,
            image_count: 0,
            table_count: 0,
            formula_count: 0,
            outline: [],
            images: [],
        });
    }
    writeJson(path.join(dir, 'state.json'), {
        paper_id: paperId,
        state,
        file_name: 'demo.pdf',
        created_at: '2026-10-26T00:00:00Z',
        updated_at: '2026-10-26T00:00:00Z',
    });
    return dir;
}

test('job queue enforces concurrency and survives queued/running cancellation', async t => {
    const { sandbox, pdf } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const calls = [];
    const pending = [];
    let running = 0;
    let maxRunning = 0;
    service._test.setCommandRunner((request, { onChild } = {}) => {
        const child = {
            pid: 9000 + calls.length,
            killed: false,
            kill(signal) { this.killed = true; this.signal = signal; },
        };
        onChild?.(child);
        calls.push({ request, child });
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        return new Promise(resolve => {
            pending.push({ request, child, finish: value => { running -= 1; resolve(value); } });
        });
    });

    const items = [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf')];
    const jobs = service.startParse(items, { workers: 2, modelVersion: 'vlm' });
    assert.equal(jobs.length, 4);
    assert.equal(calls.length, 2, 'workers=2 must start exactly two jobs');
    assert.equal(service._test.activeJobCount(), 2);

    // 排队任务取消：不占用进程，也不改变并发
    service.cancelJob(jobs[2].id);
    assert.equal(service.listJobs().find(job => job.id === jobs[2].id).state, 'cancelled');
    assert.equal(calls.length, 2);

    // 运行中任务取消：子进程收到 SIGTERM，但槽位要等进程退出后才释放
    service.cancelJob(jobs[0].id);
    assert.equal(calls[0].child.killed, true);
    assert.equal(calls[0].child.signal, 'SIGTERM');
    assert.equal(calls.length, 2, '取消后不得立刻启动下一个任务');
    assert.equal(service._test.activeJobCount(), 2, '取消中的进程仍占用槽位');

    pending[0].finish({ ok: false, error: 'killed' });
    await waitFor(() => calls.length === 3);
    assert.equal(maxRunning, 2, '实际并发不得超过 workers');

    pending[1].finish({ ok: true, data: { paper_id: 'paper_timeout000000' } });
    pending[2].finish({ ok: false, error: 'done' });
    await waitFor(() => service._test.activeJobCount() === 0);

    assert.ok(maxRunning <= 2, `并发峰值 ${maxRunning} 超过上限`);
    const states = service.listJobs().map(job => job.state);
    assert.ok(states.includes('cancelled'));
    assert.equal(states.filter(state => state === 'starting' || state === 'running' || state === 'polling').length, 0);
});

test('cancelAll stops queued and running work without starting replacements', async t => {
    const { sandbox, pdf } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const calls = [];
    const pending = [];
    service._test.setCommandRunner((request, { onChild } = {}) => {
        const child = { pid: 9200 + calls.length, killed: false, kill() { this.killed = true; } };
        onChild?.(child);
        calls.push({ request, child });
        return new Promise(resolve => pending.push(resolve));
    });

    const jobs = service.startParse(
        [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf')],
        { workers: 2 },
    );
    assert.equal(calls.length, 2);

    service.cancelAll();
    const all = service.listJobs();
    assert.equal(all.length, 4);
    assert.ok(all.every(job => job.state === 'cancelled'));
    assert.ok(calls.every(call => call.child.killed));

    for (const resolve of pending) resolve({ ok: false, error: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls.length, 2, 'cancelAll 后不得再启动排队任务');
    await waitFor(() => service._test.activeJobCount() === 0);
    assert.equal(service.listJobs().filter(job => job.state === 'queued').length, 0);
});

test('job creation validates input, clamps workers and enforces MAX_JOBS', async t => {
    const { sandbox, pdf } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    service._test.setCommandRunner(async () => ({ ok: false, error: 'noop' }));
    assert.throws(() => service.startParse([], {}), /没有可解析/);
    assert.throws(() => service.startParse([path.join(sandbox, 'missing.pdf')], {}), /没有可解析/);

    const one = pdf('one.pdf');
    const created = service.startParse([one, one, { path: one, title: 'dup' }], { workers: 99 });
    assert.equal(created.length, 1, '重复路径必须去重');
    assert.equal(service.getStatus().config.workers, 5, 'workers 必须收敛到 5');
    service.cancelAll();
    await waitFor(() => service.listJobs().every(job => (
        ['cancelled', 'failed', 'done', 'timeout'].includes(job.state)
    )));
    service._test.reset();

    service._test.setCommandRunner(async () => ({ ok: false, error: 'noop' }));
    const ids = Array.from({ length: 501 }, (_, index) => `paper_${String(index).padStart(16, '0')}`);
    assert.throws(() => service.continuePapers(ids), /500/);
});

test('library scan survives oversized, malformed and duplicate assets', async t => {
    const { sandbox, toolboxRoot } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    // 120 份同一 paper_id 的资产目录
    for (let index = 0; index < 120; index += 1) {
        writePaper(toolboxRoot, `Dup ${index}__${DUP_ID}`, DUP_ID, { title: `Dup ${index}` });
    }
    // 超大 index.json：超过 16MB 后必须跳过解析，但目录仍应被识别
    const hugeDir = writePaper(toolboxRoot, `Huge__paper_huge0000000000`, 'paper_huge0000000000', {
        index: null,
        title: 'Huge',
    });
    fs.writeFileSync(
        path.join(hugeDir, 'index.json'),
        `{"paper_id":"paper_huge0000000000","title":"Huge","pad":"${'x'.repeat(17 * 1024 * 1024)}"}`,
        'utf8',
    );
    // 50 个损坏 JSON 目录不得中断扫描
    for (let index = 0; index < 50; index += 1) {
        const paperId = `paper_broken${String(index).padStart(8, '0')}`;
        const dir = path.join(toolboxRoot, 'file', 'mineru', `Broken ${index}__${paperId}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.json'), '{"broken":', 'utf8');
        fs.writeFileSync(path.join(dir, 'state.json'), 'not json at all', 'utf8');
    }
    // paper_id 非法的目录必须被忽略
    writePaper(toolboxRoot, 'Invalid__not-a-paper', 'not-a-paper');

    const started = Date.now();
    const records = service.scanLibrary(true);
    const elapsed = Date.now() - started;
    const dup = records.find(record => record.paperId === DUP_ID);
    assert.ok(dup, '重复 paper_id 应合并为一条记录');
    assert.equal(dup.duplicateDirs.length, 119);
    const huge = records.find(record => record.paperId === 'paper_huge0000000000');
    assert.ok(huge, '超大 index.json 的目录仍应可见');
    assert.equal(huge.hasIndex, false, '超大 index 不解析，但目录仍保留');
    assert.equal(huge.group, 'indexed', 'state.json 仍可给出状态');
    assert.equal(huge.pages, 0, '超大 index 不参与解析');
    assert.ok(!records.some(record => record.paperId === 'not-a-paper'));
    assert.ok(elapsed < 8000, `扫描 170+ 目录耗时 ${elapsed}ms，疑似阻塞`);

    // 超大 index 的详情读取不能抛出
    const detail = service.getPaperDetail('paper_huge0000000000');
    assert.equal(detail.paper.paperId, 'paper_huge0000000000');
    assert.equal(detail.index.title, 'Huge');
    assert.deepEqual(detail.index.outline, []);
    assert.deepEqual(detail.index.images, []);
});

test('asset protocol rejects malformed and traversal inputs', async t => {
    const { sandbox, toolboxRoot } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const leaf = `Demo__${PAPER_ID}`;
    writePaper(toolboxRoot, leaf, PAPER_ID);
    const imageDir = path.join(toolboxRoot, 'image', 'mineru', leaf, 'images');
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'ok.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    const rejectedUrls = [
        'not a url',
        'vcp-mineru://other/paper_x/a.png',
        'vcp-mineru://image/paper_x/',
        'vcp-mineru://image/paper_x?x=1',
        'vcp-mineru://user:pass@image/paper_x/a.png',
        'vcp-mineru://image/paper_x/%E0%A4%A',
        'vcp-mineru://image/paper_x/%00/a.png',
        'vcp-mineru://image/nope/a.png',
        `vcp-mineru://image/${PAPER_ID}/../../../secret.png`,
        `vcp-mineru://image/${PAPER_ID}/%2e%2e/%2e%2e/secret.png`,
        `vcp-mineru://image/${PAPER_ID}/%5C..%5Csecret.png`,
    ];
    for (const url of rejectedUrls) {
        let parsed;
        assert.doesNotThrow(() => { parsed = protocol.parseAssetUrl(url); }, `解析不应抛出: ${url}`);
        if (parsed) {
            assert.throws(() => service.resolveImagePath(parsed.paperId, parsed.rel), undefined, `必须拒绝: ${url}`);
        }
    }

    // 合法路径仍可读取
    assert.equal(
        fs.realpathSync(service.resolveImagePath(PAPER_ID, 'images/ok.png')),
        fs.realpathSync(path.join(imageDir, 'ok.png')),
    );
    assert.equal(fs.realpathSync(service.resolveImagePath(PAPER_ID, 'images\\ok.png')), fs.realpathSync(path.join(imageDir, 'ok.png')));
    assert.throws(() => service.resolveImagePath(PAPER_ID, 'C:/windows/win.ini'), /盘符/);
    assert.throws(() => service.resolveImagePath(PAPER_ID, '/absolute.png'), /不存在|越界/);
    assert.throws(() => service.resolveImagePath(PAPER_ID, 'images/../../secret.png'), /\.\./);

    // 超长 URL 也必须快速拒绝，不能抛异常
    const longUrl = `vcp-mineru://image/${PAPER_ID}/${'a/'.repeat(50000)}x.png`;
    const longParsed = protocol.parseAssetUrl(longUrl);
    if (longParsed) {
        assert.throws(() => service.resolveImagePath(longParsed.paperId, longParsed.rel), /不存在|越界/);
    }
});

test('PDF mapping ignores missing files and rejects invalid ids', async t => {
    const { sandbox, toolboxRoot, pdf } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    writePaper(toolboxRoot, `Demo__${PAPER_ID}`, PAPER_ID);
    assert.equal(service.readPdf(PAPER_ID).available, false);
    assert.throws(() => service.readPdf('bad-id'), /格式不正确/);
    assert.throws(() => service.setPdfMapping(PAPER_ID, path.join(sandbox, 'missing.pdf')), /存在的 PDF/);

    const real = pdf('with space 中文.pdf');
    const mapping = service.setPdfMapping(PAPER_ID, real);
    assert.equal(mapping.pdfName, 'with space 中文.pdf');
    const data = service.readPdf(PAPER_ID);
    assert.equal(data.available, true);
    assert.equal(data.data.toString(), '%PDF-1.4 stress');

    // 超过 128MB 的 PDF 不应被整体读入主进程
    const hugePdf = path.join(sandbox, 'huge.pdf');
    fs.writeFileSync(hugePdf, '%PDF-1.4');
    fs.truncateSync(hugePdf, 129 * 1024 * 1024);
    service.setPdfMapping(PAPER_ID, hugePdf);
    assert.throws(() => service.readPdf(PAPER_ID), /128MB.*打开 PDF/);

    // 手工写入失效映射后，读取必须回落到“不可用”而不是抛异常
    writeJson(path.join(sandbox, 'AppData', 'MinerU', 'pdf-map.json'), {
        [PAPER_ID]: path.join(sandbox, 'gone.pdf'),
    });
    service.clearPdfMapping('paper_ffffffffffffffff');
    service.scanLibrary(true);
    assert.equal(service.readPdf(PAPER_ID).available, false);
});

test('toolbox root cannot change while jobs are active', async t => {
    const { sandbox, toolboxRoot, pdf } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const otherRoot = path.join(sandbox, 'OtherToolbox');
    writeJson(path.join(otherRoot, 'Plugin', 'MinerUParser', 'plugin-manifest.json'), { name: 'MinerUParser' });

    const pending = [];
    service._test.setCommandRunner((request, { onChild } = {}) => {
        onChild?.({ pid: 9300, kill() {} });
        return new Promise(resolve => pending.push(resolve));
    });
    service.startParse([pdf('busy.pdf')], { workers: 1 });
    assert.throws(() => service.saveConfig({ toolboxRoot: otherRoot }), /正在运行|排队/);

    service.cancelAll();
    for (const resolve of pending) resolve({ ok: false, error: 'cancelled' });
    await waitFor(() => service._test.activeJobCount() === 0);
    assert.doesNotThrow(() => service.saveConfig({ toolboxRoot: otherRoot }));
});

test('unwritable AppData does not block startup', async t => {
    const { sandbox, toolboxRoot } = setup();
    service._test.reset();
    t.after(() => {
        service._test.reset();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    const badAppData = path.join(sandbox, 'bad-app-data');
    fs.mkdirSync(badAppData, { recursive: true });
    fs.writeFileSync(path.join(badAppData, 'MinerU'), 'not a directory', 'utf8');

    assert.doesNotThrow(() => {
        service._test.reinitialize({ appDataRoot: badAppData, projectRoot: path.join(sandbox, 'VCPChat') });
    });
    const status = service.getStatus();
    assert.equal(status.ok, true, '配置目录异常不应影响插件环境探测');
    assert.throws(() => service.saveConfig({ toolboxRoot, workers: 2 }));
});
