const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

async function loadJevParser() {
    return import(pathToFileURL(
        path.join(root, 'modules/renderer/jevToolUse.js')
    ).href);
}

test('JEV 显式工具名优先于能力名显示', async () => {
    const { parseJevToolUse } = await loadJevParser();
    const parsed = parseJevToolUse(
        "请使用 {图片生成} 中的 'GPT生图'，生成【一张细节丰富的科幻城市概念图】，并采用[横版高清]画幅。"
    );

    assert.equal(parsed?.capability, '图片生成');
    assert.equal(parsed?.explicitToolName, 'GPT生图');
    assert.equal(parsed?.displayName, 'GPT生图');
});

test('JEV 没有显式工具名时显示能力名', async () => {
    const { parseJevToolUse } = await loadJevParser();
    const parsed = parseJevToolUse(
        '请使用 {联网搜索}，从[美国土豆产能]方向搜索【最近美国土豆是不是打折】。'
    );

    assert.equal(parsed?.capability, '联网搜索');
    assert.equal(parsed?.explicitToolName, '');
    assert.equal(parsed?.displayName, '联网搜索');
});

test('JEV 支持中文引号中的显式工具名', async () => {
    const { parseJevToolUse } = await loadJevParser();

    assert.equal(
        parseJevToolUse('请使用 {联网搜索} 中的 ‘谷歌学术’，搜索【主题】。')?.displayName,
        '谷歌学术'
    );
    assert.equal(
        parseJevToolUse('请使用 {图片生成} 中的 “豆包”，生成【主题】。')?.displayName,
        '豆包'
    );
});

test('缺少 JEV 能力和显式工具语法时不误判为 JEVToolUse', async () => {
    const { parseJevToolUse } = await loadJevParser();

    assert.equal(parseJevToolUse('普通自然语言工具描述'), null);
    assert.equal(parseJevToolUse(''), null);
    assert.equal(parseJevToolUse(null), null);
});

test('主消息渲染器以附加分支渲染 JEV 且保留旧 VCP ToolUse', () => {
    const source = fs.readFileSync(
        path.join(root, 'modules/messageRenderer.js'),
        'utf8'
    );

    assert.match(source, /parseJevToolUse\(extractMarkedField\(content,\s*\/JEV:/);
    assert.match(source, /vcp-jev-tool-use-bubble/);
    assert.match(source, /JEVToolUse:/);
    assert.match(source, /data-vcp-block-type="jev-tool-use"/);

    // 兼容渲染不能替代原有协议分支。
    assert.match(source, /xmlToolNameMatch/);
    assert.match(source, /VCP-ToolUse:/);
    assert.match(source, /data-vcp-block-type="tool-use"/);
});

test('阅读模式同步支持 JEVToolUse 并保留旧 VCP ToolUse', () => {
    const source = fs.readFileSync(
        path.join(root, 'modules/text-viewer.js'),
        'utf8'
    );

    assert.match(source, /parseJevToolUse\(extractMarkedField\(content,\s*\/JEV:/);
    assert.match(source, /vcp-jev-tool-use-bubble/);
    assert.match(source, /isJevToolUse\s*\?\s*'JEVToolUse:'\s*:\s*'VCP-ToolUse:'/);
});

test('JEV 修饰样式复用原 ToolUse 组件而不覆盖旧组件规则', () => {
    const css = fs.readFileSync(
        path.join(root, 'styles/messageRenderer.css'),
        'utf8'
    );

    assert.match(css, /\.vcp-tool-use-bubble\.vcp-jev-tool-use-bubble/);
    assert.match(css, /\.vcp-tool-use-bubble\s*\{/);
});