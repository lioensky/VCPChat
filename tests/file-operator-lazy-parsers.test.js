const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const pluginPath = path.resolve(__dirname, '../VCPDistributedServer/Plugin/FileOperator/FileOperator.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const pluginRequire = createRequire(pluginPath);
const parserIds = ['pdf-parse', 'mammoth', 'exceljs'];

function loadPlugin({ failParser = false } = {}) {
    const requests = [];
    const buffer = Buffer.from('hello\nworld');
    const parsers = {
        'pdf-parse': async input => {
            assert.equal(input, buffer);
            return { text: 'pdf text' };
        },
        mammoth: { async extractRawText({ buffer: input }) {
            assert.equal(input, buffer);
            return { value: 'word text' };
        } },
        exceljs: { Workbook: class {
            constructor() {
                this.xlsx = { load: async input => assert.equal(input, buffer) };
                this.csv = { read: async stream => {
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    assert.deepEqual(Buffer.concat(chunks), buffer);
                } };
            }
            eachSheet(callback) {
                callback({ name: 'Sheet1', eachRow(options, visit) {
                    visit({ values: [undefined, 'a', 'b'] }, 1);
                } }, 1);
            }
        } }
    };
    const fakeFs = {
        existsSync: () => false,
        promises: {
            stat: async () => ({ size: buffer.length, mtime: new Date(0) }),
            readFile: async () => buffer
        }
    };
    const context = {
        module: { exports: {} },
        __dirname: path.dirname(pluginPath),
        process: { env: {}, platform: process.platform, cwd: () => process.cwd() },
        Buffer, console,
        require(id) {
            if (parserIds.includes(id)) {
                requests.push(id);
                if (failParser) throw new Error(`parser unavailable: ${id}`);
                return parsers[id];
            }
            if (id === 'fs') return fakeFs;
            return pluginRequire(id);
        }
    };
    vm.runInNewContext(source, context, { filename: pluginPath });
    return { plugin: context.module.exports, requests };
}

const fixture = extension => path.resolve(__dirname, `lazy-parser-fixture${extension}`);

test('plugin import, initialize, plain text and media reads do not load document parsers', async () => {
    const { plugin, requests } = loadPlugin();
    assert.deepEqual(requests, []);
    await plugin.initialize({});
    const text = await plugin.readFile(fixture('.txt'), 'utf8', 'head:1');
    assert.equal(text.success, true);
    assert.equal(text.data.content[1].text, 'hello');
    assert.equal(text.data.isExtracted, false);
    const image = await plugin.readFile(fixture('.png'));
    assert.equal(image.success, true);
    assert.match(image.data.content[1].image_url.url, /^data:image\/png;base64,/);
    assert.deepEqual(requests, []);
});

for (const [extension, parser, expected] of [
    ['.pdf', 'pdf-parse', 'pdf text'],
    ['.PDF', 'pdf-parse', 'pdf text'],
    ['.docx', 'mammoth', 'word text'],
    ['.xlsx', 'exceljs', '--- Sheet: Sheet1 ---\na\tb\n'],
    ['.xls', 'exceljs', '--- Sheet: Sheet1 ---\na\tb\n'],
    ['.csv', 'exceljs', '--- Sheet: Sheet1 ---\na\tb\n']
]) {
    test(`${extension} reads request only ${parser} and preserve extracted output`, async () => {
        const { plugin, requests } = loadPlugin();
        assert.deepEqual(requests, []);
        const result = await plugin.readFile(fixture(extension));
        assert.equal(result.success, true, result.error);
        assert.equal(result.data.isExtracted, true);
        assert.equal(result.data.content[1].text, expected);
        assert.deepEqual(requests, [parser]);
    });
}

test('parser load failures use the existing read error contract without breaking text reads', async () => {
    const { plugin, requests } = loadPlugin({ failParser: true });
    for (const extension of ['.pdf', '.docx', '.xlsx']) {
        const result = await plugin.readFile(fixture(extension));
        assert.equal(result.success, false);
        assert.match(result.error, /^Failed to read or process file: parser unavailable:/);
    }
    assert.deepEqual(requests, parserIds);
    assert.equal((await plugin.readFile(fixture('.txt'))).success, true);
});