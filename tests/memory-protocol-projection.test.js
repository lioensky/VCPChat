'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectMemoryProtocols: project } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
const topic = require('../VCPDistributedServer/Plugin/TopicMemo/TopicMemo');
const deep = require('../VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');

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