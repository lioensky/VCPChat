'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { projectMemoryProtocols: project } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
const topic = require('../VCPDistributedServer/Plugin/TopicMemo/TopicMemo');
const deep = require('../VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');

const sha1_8 = s => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);
const request = (name, payload = '') => `<<<[TOOL_REQUEST]>>>tool_name:「始」${name}「末」\ntext:「始ESCAPE」${payload}「末ESCAPE」\n<<<[END_TOOL_REQUEST]>>>`;
const result = body => `[[VCP调用结果信息汇总:${body}VCP调用结果结束]]`;
const summary = '[本轮工具调用摘要:]FileReader 调用成功。[本轮工具调用摘要结束]';

test('请求只留下工具名称，字段内结束符不会提前关闭请求', () => {
    const text = project(`前文${request('FileReader', '秘密<<<[END_TOOL_REQUEST]>>>仍是参数')}后文`);
    assert.match(text, /前文\n调用了 FileReader 工具。\n后文/);
    assert.doesNotMatch(text, /秘密|仍是参数|TOOL_REQUEST|ESCAPE/);
});

test('嵌套结果内的伪请求和伪摘要不能逃逸', () => {
    const text = project(`前${result(result('内部') + request('Fake') + summary)}后`);
    assert.equal(text, '前\n后');
});

test('批次保留外部摘要但删除结果、角色与批次标记', () => {
    const text = project(`<<<[ROLE_DIVIDE_USER]>>>正文<<<[END_ROLE_DIVIDE_USER]>>>
<<<[VCP_TOOL_BATCH_START:123]>>>${result('秘密')}${summary}<<<[VCP_TOOL_BATCH_END:123]>>>结尾`);
    assert.match(text, /正文/);
    assert.match(text, /工具调用摘要：FileReader 调用成功。/);
    assert.match(text, /结尾/);
    assert.doesNotMatch(text, /秘密|<<<|\[本轮/);
});

test('未闭合载荷封印到消息尾部，不影响批次之后的正文', () => {
    assert.equal(project('前[[VCP调用结果信息汇总:秘密'), '前');
    const text = project('前<<<[VCP_TOOL_BATCH_START:x]>>>[[VCP调用结果信息汇总:坏数据<<<[VCP_TOOL_BATCH_END:x]>>>后');
    assert.equal(text, '前\n\n后');
    assert.match(project('前<<<[TOOL_REQUEST]>>>tool_name:「始」Demo「末」\ntext:「始」秘密'), /调用了 Demo 工具。/);
});

test('JEV 和缺失名称请求仍保留调用轨迹', () => {
    assert.match(project('<<<[TOOL_REQUEST]>>>JEV:「始」使用 {便利操作} 中的 `DeepMemo`「末」<<<[END_TOOL_REQUEST]>>>'), /调用了 DeepMemo 工具。/);
    assert.match(project('<<<[TOOL_REQUEST]>>>未知<<<[END_TOOL_REQUEST]>>>'), /名称未记录/);
});

test('两个插件在 HTML 处理之前采用相同协议投影', () => {
    const source = `开头${request('Demo', '<style>秘密</style>')}${result('<div>结果秘密</div>')}${summary}<p>正文</p>`;
    for (const clean of [topic.cleanHtmlContent, deep._test.cleanMemoryOutput]) {
        const text = clean(source);
        assert.match(text, /调用了 Demo 工具。/);
        assert.match(text, /FileReader 调用成功/);
        assert.match(text, /正文/);
        assert.doesNotMatch(text, /秘密|TOOL_REQUEST|VCP调用结果|\[本轮/);
    }
    assert.equal(topic.cleanHtmlContent({ text: request('Demo') }), '调用了 Demo 工具。');
});

test('CDS 普通返回优先净化原始窗口，不改变响应对象', async () => {
    const response = {
        windows: [{ topicName: '测试', messages: [{
            role: 'assistant', speakerName: '小克',
            contentRaw: request('Demo', '参数秘密') + result('结果秘密') + summary,
            contentText: '已经丢失边界的秘密'
        }] }],
        formattedResult: '不应采用的格式化结果'
    };
    const before = JSON.stringify(response);
    deep.initialize({ chatDataService: { client: { searchMemories: async () => response } } });
    try {
        const text = await deep.processToolCall({ maid: '小克', keyword: '测试' });
        assert.match(text, /调用了 Demo 工具。/);
        assert.doesNotMatch(text, /秘密|不应采用|<<<|\[本轮/);
        assert.equal(JSON.stringify(response), before);
        const batches = deep._test.createRerankBatches(response.windows, '测试', deep._test.normalizeConfig({}));
        assert.doesNotMatch(batches[0][0].document, /秘密|<<<|\[本轮/);
    } finally {
        deep._test.resetForTests();
    }
});

test('已移除旧后端配置，旧配置不能恢复进程回退', () => {
    const config = deep._test.normalizeConfig({ DeepMemoBackend: 'legacy', DeepMemoLegacyFallback: true });
    assert.equal('backend' in config, false);
    assert.equal('legacyFallback' in config, false);
});

test('实体转义界定符和旧 XML 工具名均会被投影', () => {
    const encoded = request('Demo', '参数秘密').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    assert.equal(project(encoded), '调用了 Demo 工具。');
    assert.equal(project('<<<[TOOL_REQUEST]>>><tool_name>OldDemo</tool_name>参数秘密<<<[END_TOOL_REQUEST]>>>'), '调用了 OldDemo 工具。');
});

test('精排成功与失败回退都只消费净化后的窗口', async () => {
    const axios = require('axios');
    const originalPost = axios.post;
    const windows = [{ messages: [{
        speakerName: '小克', role: 'assistant',
        contentRaw: request('Demo', '参数秘密') + result('结果秘密') + summary
    }] }];
    try {
        for (const fail of [false, true]) {
            axios.post = async (_url, data) => {
                assert.doesNotMatch(data.documents.join('\n'), /秘密|<<<|\[本轮/);
                if (fail) throw new Error('模拟精排失败');
                return { data: { results: [{ index: 0, relevance_score: 1 }] } };
            };
            deep.initialize({
                chatDataService: { client: { searchMemories: async () => ({ windows }) } },
                config: { RerankSearch: true, RerankUrl: 'http://localhost:8000' },
                logger: { warn() {} }
            });
            const text = await deep.processToolCall({ maid: '小克', keyword: '测试' });
            assert.match(text, /调用了 Demo 工具。/);
            assert.doesNotMatch(text, /秘密|<<<|\[本轮/);
        }
    } finally {
        axios.post = originalPost;
        deep._test.resetForTests();
    }
});

test('FP-P2-6: 剥离顶层思考链（单行/多行/VCP元思考链）并保护代码围栏内字面量，防止下游 cheerio 拆壳泄漏', () => {
    const source = [
        '<think>行首单行机密思考</think>',
        '<thought>同行开启\n多行机密思考</thought>',
        '[--- VCP元思考链 (Auto模式) ---]',
        'VCP机密推理过程',
        '[--- 元思考链结束 ---]',
        '```html',
        '<think>FENCE-LITERAL-KEEP</think>',
        '```',
        '请勿使用 <think>demo</think> 标签',
        '<p>真正记忆正文</p>',
    ].join('\n');

    const projected = project(source);
    assert.doesNotMatch(projected, /行首单行机密思考|多行机密思考|VCP机密推理过程|VCP元思考链/);
    assert.match(projected, /FENCE-LITERAL-KEEP/);
    assert.match(projected, /真正记忆正文/);

    for (const clean of [topic.cleanHtmlContent, deep._test.cleanMemoryOutput]) {
        const cleaned = clean(source);
        assert.doesNotMatch(cleaned, /行首单行机密思考|多行机密思考|VCP机密推理过程|VCP元思考链/);
        assert.match(cleaned, /FENCE-LITERAL-KEEP/);
        assert.match(cleaned, /真正记忆正文/);
    }
});

test('FP-P2-6: 跳过带 MISSING_MAID 等纠偏回执的未执行协议坏块，同时保留同消息第 2 跳正常工具投影', () => {
    // 1. MISSING_MAID 闭块（指纹命中 + 缺失 maid/valet）+ 第 2 跳正常 FileOperator
    const brokenMissingMaid = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'command:「始」ReadFile「末」,',
        'path:「始」README.md「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const fpMissingMaid = sha1_8(brokenMissingMaid);

    const validRetry = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」WriteFile「末」,',
        'path:「始」out.txt「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const msgMissingMaid = [
        '先尝试读取：',
        brokenMissingMaid,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=MISSING_MAID block=${fpMissingMaid}]]`,
        '请补充 maid 署名',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '补齐署名重试：',
        validRetry,
        '操作完成。',
    ].join('\n');

    const out1 = project(msgMissingMaid);
    assert.doesNotMatch(out1, /调用了 FileOperator 工具。/, 'MISSING_MAID 未执行坏块绝不能投影为工具调用轨迹');
    assert.match(out1, /调用了 WriteFile 工具。/, '第2跳正常已执行调用必须保留投影');
    assert.match(out1, /操作完成。/);

    // 2. 无指纹匹配（block=unknown）但缺失 maid 且命中 MISSING_MAID 回执码 + 缺失 tool_name 坏块 + 未闭合坏块
    const msgStructural = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」BrokenNoMaid「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」BrokenNoTool「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」BrokenUnclosed「末」',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP协议纠偏指导: code=MISSING_MAID block=unknown]]',
        '[[/VCP协议纠偏指导]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        validRetry,
    ].join('\n');

    const out2 = project(msgStructural);
    assert.doesNotMatch(out2, /BrokenNoMaid|BrokenNoTool|BrokenUnclosed|名称未记录/);
    assert.match(out2, /调用了 WriteFile 工具。/);
});

test('NEW-P3-1: DUPLICATE_KEY_CONFLICT 无指纹遗留回执跳过控制键冲突坏块，但同值口吃复述仍正常投影', () => {
    const conflictBlock = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」FileOperator「末」,',
        'tool_name:「始」DailyNote「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const stutterValidBlock = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」WriteFile「末」,',
        'tool_name:「始」WriteFile「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const msg = [
        conflictBlock,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=DUPLICATE_KEY_CONFLICT block=unknown]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        stutterValidBlock,
        '处理完成。',
    ].join('\n');

    const out = project(msg);
    assert.doesNotMatch(out, /FileOperator|DailyNote/, '控制键冲突坏块即使无 block= 指纹也必须被跳过');
    assert.match(out, /调用了 WriteFile 工具。/, '同值口吃复述不算冲突，必须保留投影');
    assert.match(out, /处理完成。/);
});