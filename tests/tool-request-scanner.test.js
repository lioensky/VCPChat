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

test('字段未闭合时仍使用请求结束标记完成工具请求', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    const text = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」Demo「末」,
replace:「始ESCAPE」<div>streaming
<<<[END_TOOL_REQUEST]>>>
AFTER`;

    const scan = scanToolRequestEnd(text, TOOL_REQUEST_START_MARKER.length);

    assert.equal(scan.status, 'complete');
    assert.equal(scan.field.recoveredFromUnclosedField, true);
    assert.equal(scan.requestMarkerStart, text.indexOf('<<<[END_TOOL_REQUEST]>>>'));
    assert.equal(text.slice(scan.endIndex).trim(), 'AFTER');
});

test('容错识别左右二至四个尖括号的工具请求结束标记', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        scanToolRequestEnd
    } = await loadScanner();

    for (const endMarker of [
        '<<[END_TOOL_REQUEST]>>',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<<[END_TOOL_REQUEST]>>>>',
        '<<<<[END_TOOL_REQUEST]>>',
        '<<[END_TOOL_REQUEST]>>>>'
    ]) {
        const text = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」Demo「末」
${endMarker}
AFTER`;

        const scan = scanToolRequestEnd(text, TOOL_REQUEST_START_MARKER.length);

        assert.equal(scan.status, 'complete', endMarker);
        assert.equal(text.slice(scan.endIndex).trim(), 'AFTER', endMarker);
        assert.equal(text.slice(scan.requestMarkerStart, scan.endIndex), endMarker);
    }
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

test('流式中间帧将未闭合工具请求从协议入口严格隔离到流尾', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        findEarliestUnclosedToolBlock
    } = await loadScanner();

    const source = `允许渲染的普通正文

${TOOL_REQUEST_START_MARKER}
tool_name:「始」WriteFile「末」,
content:「始ESCAPE」<style>
.message-item { display: none !important; }
</style>
<script>window.__toolPayloadExecuted = true;</script>`;

    const block = findEarliestUnclosedToolBlock(source);

    assert.equal(block?.type, 'tool-request');
    assert.equal(block?.prefix, '允许渲染的普通正文\n\n');
    assert.equal(block?.content.startsWith(TOOL_REQUEST_START_MARKER), true);
    assert.match(block?.content || '', /<style>/);
    assert.match(block?.content || '', /<script>/);
});

test('流式中间帧将未闭合工具返回从协议入口严格隔离到流尾', async () => {
    const {
        TOOL_RESULT_START_MARKER,
        findEarliestUnclosedToolBlock
    } = await loadScanner();

    const source = `工具前正文
${TOOL_RESULT_START_MARKER}
- 工具名称: ArbitraryFileTool
- 返回内容: <style>body { opacity: 0; }</style>
<script>window.__resultPayloadExecuted = true;</script>`;

    const block = findEarliestUnclosedToolBlock(source);

    assert.equal(block?.type, 'tool-result');
    assert.equal(block?.prefix, '工具前正文\n');
    assert.equal(block?.content.startsWith(TOOL_RESULT_START_MARKER), true);
    assert.match(block?.content || '', /body \{ opacity: 0; \}/);
});

test('流式工具隔离选择源码中最早的未闭合协议入口', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_RESULT_START_MARKER,
        findEarliestUnclosedToolBlock
    } = await loadScanner();

    const source = `${TOOL_RESULT_START_MARKER}
返回内容中包含请求协议示例：
${TOOL_REQUEST_START_MARKER}
<style>.leak { all: unset; }</style>`;

    const block = findEarliestUnclosedToolBlock(source);

    assert.equal(block?.type, 'tool-result');
    assert.equal(block?.startIndex, 0);
    assert.equal(block?.content, source);
});

test('完整工具请求与完整工具返回不会被流式未闭合扫描器重复封印', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        TOOL_REQUEST_END_MARKER,
        TOOL_RESULT_START_MARKER,
        TOOL_RESULT_END_MARKER,
        findEarliestUnclosedToolBlock
    } = await loadScanner();

    const source = `${TOOL_REQUEST_START_MARKER}
tool_name:「始」Demo「末」
${TOOL_REQUEST_END_MARKER}
${TOOL_RESULT_START_MARKER}
- 工具名称: Demo
- 返回内容: <style>.payload { color: red; }</style>
${TOOL_RESULT_END_MARKER}
最终正文`;

    assert.equal(findEarliestUnclosedToolBlock(source), null);
});

test('反引号包裹的工具请求示例不建立流式严格隔离边界', async () => {
    const {
        TOOL_REQUEST_START_MARKER,
        findEarliestUnclosedToolBlock
    } = await loadScanner();

    const source = `协议文档示例：\`${TOOL_REQUEST_START_MARKER}\`
后续普通正文包含 <style>.assistant-island { color: blue; }</style>`;

    assert.equal(findEarliestUnclosedToolBlock(source), null);
});

test('消息渲染器必须把工具请求结束扫描器显式接入流式投影', () => {
    const rendererSource = fs.readFileSync(
        path.join(root, 'modules/messageRenderer.js'),
        'utf8'
    );

    assert.match(
        rendererSource,
        /import\s*\{[\s\S]*?\bfindToolRequestEnd\b[\s\S]*?\}\s*from\s*['"]\.\/renderer\/toolRequestScanner\.js['"]/,
        'messageRenderer 必须导入 findToolRequestEnd，避免首个工具块触发未定义引用'
    );
    assert.match(
        rendererSource,
        /findToolRequestEnd:\s*\(text,\s*startIndex\)\s*=>\s*findToolRequestEnd\(text,\s*startIndex\)/,
        'StreamProjection 必须获得 ESCAPE 感知的工具请求结束扫描能力'
    );
});