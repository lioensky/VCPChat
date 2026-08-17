const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

async function loadScanner() {
    const source = fs.readFileSync(
        path.join(root, 'modules/renderer/toolRequestScanner.js'),
        'utf8'
    );
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    return import(moduleUrl);
}

test('ESCAPE 字段内的工具结束标记文本不会提前闭合请求', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    const text = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」ScriptoriumCollaborator「末」,
replace:「始ESCAPE」<script>
const literal = "${TOOL_REQUEST_END_MARKER}";
const protocolExample = "other:「始」not-a-real-field「末」";
</script>「末ESCAPE」
${TOOL_REQUEST_END_MARKER}

### 后续正文
不会被吞`;

    const contentStart = TOOL_REQUEST_START_MARKER.length;
    const scan = scanToolRequestEnd(text, contentStart);

    assert.equal(scan.status, 'complete');
    assert.equal(scan.endIndex, text.indexOf(TOOL_REQUEST_END_MARKER, text.indexOf('「末ESCAPE」')) + TOOL_REQUEST_END_MARKER.length);
    assert.equal(text.slice(scan.endIndex).trimStart(), '### 后续正文\n不会被吞');
});

test('只有合法字段声明中的始标记才改变扫描状态', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    const text = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」Demo「末」,
content:「始ESCAPE」
普通正文提到「始」和「始ESCAPE」都不是新字段。
const sample = 'fake:「始」value「末」';
这里还有 ${TOOL_REQUEST_END_MARKER} 字面示例。
「末ESCAPE」
${TOOL_REQUEST_END_MARKER}
TAIL`;

    const scan = scanToolRequestEnd(text, TOOL_REQUEST_START_MARKER.length);

    assert.equal(scan.status, 'complete');
    assert.equal(text.slice(scan.endIndex).trim(), 'TAIL');
});

test('未闭合字段与字段闭合但请求未闭合返回不同状态', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    const incompleteField = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」Demo「末」,
replace:「始ESCAPE」<div>streaming`;

    const fieldScan = scanToolRequestEnd(
        incompleteField,
        TOOL_REQUEST_START_MARKER.length
    );

    assert.equal(fieldScan.status, 'incomplete-field');
    assert.equal(fieldScan.endIndex, -1);
    assert.equal(fieldScan.field.fieldName, 'replace');
    assert.equal(fieldScan.field.endMarker, '「末ESCAPE」');

    const incompleteRequest = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」Demo「末」`;

    const requestScan = scanToolRequestEnd(
        incompleteRequest,
        TOOL_REQUEST_START_MARKER.length
    );

    assert.equal(requestScan.status, 'incomplete-request');
    assert.equal(requestScan.endIndex, -1);
    assert.equal(requestScan.field, undefined);
});

test('多个长工具请求被逐个替换且保留最终 Markdown 正文', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        replaceToolRequestBlocks
    } = await loadScanner();

    const longCanvasSource = `<div class="island">
<style>
.island { width: 100%; height: 180px; }
</style>
<canvas></canvas>
<script>
(() => {
    const render = () => {
        for (let i = 0; i < 100; i++) {
            requestAnimationFrame(render);
        }
    };
    const fakeEnd = "${TOOL_REQUEST_END_MARKER}";
    render();
})();
</script>
</div>`;

    const first = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」ScriptoriumCollaborator「末」,
command:「始」GetSource「末」
${TOOL_REQUEST_END_MARKER}`;

    const second = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」ScriptoriumCollaborator「末」,
command:「始」SubmitSourcePr「末」,
target:「始」标题「末」,
replace:「始ESCAPE」${longCanvasSource}「末ESCAPE」
${TOOL_REQUEST_END_MARKER}`;

    const finalMarkdown = `主人，后续正文仍在。

### 读后感

- 第一项
- 第二项`;

    const source = `${first}
<<<[ROLE_DIVIDE_USER]>>>
[本轮工具调用摘要:]
调用成功。
[本轮工具调用摘要结束]
<<<[END_ROLE_DIVIDE_USER]>>>

${second}

${finalMarkdown}`;

    const matches = [];
    const replaced = replaceToolRequestBlocks(source, (fullMatch, content) => {
        matches.push({ fullMatch, content });
        return '<TOOL />';
    });

    assert.equal(matches.length, 2);
    assert.match(matches[1].content, /requestAnimationFrame\(render\)/);
    assert.match(matches[1].content, /fakeEnd/);
    assert.equal(replaced.includes(longCanvasSource), false);
    assert.equal(replaced.endsWith(finalMarkdown), true);
    assert.match(replaced, /### 读后感/);
});

test('兼容同一行逗号字段、花括号字段与大小写混合 ESCAPE', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    const text = `${TOOL_REQUEST_START_MARKER}
maid:「始」Nova「末」, tool_name:{始}Demo{末}, replace:{始EsCaPe}<div>ok</div>{末escape}
${TOOL_REQUEST_END_MARKER}
AFTER`;

    const scan = scanToolRequestEnd(text, TOOL_REQUEST_START_MARKER.length);

    assert.equal(scan.status, 'complete');
    assert.equal(text.slice(scan.endIndex).trim(), 'AFTER');
});

test('畸形成对括号不会被识别为字段边界', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    const text = `${TOOL_REQUEST_START_MARKER}
content:「始ESCAPE」
示例 bad:{始」 不应改变字段状态。
「末ESCAPE」
${TOOL_REQUEST_END_MARKER}
SAFE`;

    const scan = scanToolRequestEnd(text, TOOL_REQUEST_START_MARKER.length);

    assert.equal(scan.status, 'complete');
    assert.equal(text.slice(scan.endIndex).trim(), 'SAFE');
});

test('反引号包裹的协议示例不会被当作真实工具请求', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        replaceToolRequestBlocks
    } = await loadScanner();

    const source = `示例：\`${TOOL_REQUEST_START_MARKER}\`
正文
\`${TOOL_REQUEST_END_MARKER}\``;

    let calls = 0;
    const replaced = replaceToolRequestBlocks(source, () => {
        calls += 1;
        return '<TOOL />';
    });

    assert.equal(calls, 0);
    assert.equal(replaced, source);
});

test('工具请求与前后普通正文直接相邻时，替换结果自动补充边界换行', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        replaceToolRequestBlocks
    } = await loadScanner();

    const source =
        `前置正文${TOOL_REQUEST_START_MARKER}` +
        `tool_name:「始」Demo「末」,command:「始」Run「末」` +
        `${TOOL_REQUEST_END_MARKER}后置正文`;

    const replaced = replaceToolRequestBlocks(source, () => '<TOOL />');

    assert.equal(replaced, '前置正文\n<TOOL />\n后置正文');
});

test('工具请求开始标记后紧接字段声明时仍能识别并补充边界换行', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        replaceToolRequestBlocks
    } = await loadScanner();

    const source =
        `前置${TOOL_REQUEST_START_MARKER}` +
        `tool_name:「始」Demo「末」,command:「始」Run「末」` +
        `${TOOL_REQUEST_END_MARKER}后置`;

    let calls = 0;
    const replaced = replaceToolRequestBlocks(source, (fullMatch, content) => {
        calls += 1;
        assert.match(content, /tool_name:「始」Demo「末」/);
        return '<TOOL />';
    });

    assert.equal(calls, 1);
    assert.equal(replaced, '前置\n<TOOL />\n后置');
});