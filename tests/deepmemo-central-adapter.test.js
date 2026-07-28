'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const deepMemo = require('../VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');
const originalAxiosPost = axios.post;

function createFacade(searchImpl) {
    return {
        get client() {
            return {
                searchMemories: searchImpl
            };
        }
    };
}

test.beforeEach(() => {
    deepMemo._test.resetForTests();
    axios.post = originalAxiosPost;
});

test.afterEach(() => {
    axios.post = originalAxiosPost;
});

function memoryWindow(index, content = `第${index}条回忆`) {
    return {
        topicId: `topic_${index}`,
        topicName: `主题${index}`,
        messages: [{
            role: index % 2 === 0 ? 'assistant' : 'user',
            speakerName: index % 2 === 0 ? '小克' : '莱恩',
            contentText: content,
            contentRaw: `<p>${content}</p>`
        }]
    };
}

test('旧参数被规范化并通过 maid 调用中央搜索', async () => {
    let capturedRequest;
    let capturedOptions;
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async (request, options) => {
                capturedRequest = request;
                capturedOptions = options;
                return {
                    owner: { ownerId: 'agent_xiaoke' },
                    windows: [{ topicId: 'topic_old' }],
                    formattedResult: '[回忆片段1]:\n主人: 测试\n小克: 成功'
                };
            })
        },
        config: {
            DeepMemoBackend: 'central',
            DeepMemoLegacyFallback: false,
            DeepMemoTimeoutMs: 1234
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '小克',
        KeyWord: '深度回忆',
        windowsize: '7'
    });

    assert.equal(result, '[回忆片段1]:\n主人: 测试\n小克: 成功');
    assert.deepEqual(capturedRequest, {
        query: '深度回忆',
        ownerType: 'agent',
        currentTopicId: undefined,
        excludeCurrentTopic: true,
        windowBefore: 7,
        windowAfter: 7,
        candidateLimit: 50,
        resultLimit: 8,
        maxChars: 60000,
        maid: '小克'
    });
    assert.deepEqual(capturedOptions, { timeoutMs: 1234 });
});

test('可信执行上下文覆盖模型参数并精确排除当前 Topic', async () => {
    let capturedRequest;
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async request => {
                capturedRequest = request;
                return {
                    windows: [{ topicId: 'topic_history' }],
                    formattedResult: '[回忆片段1]:\n可信上下文命中'
                };
            })
        },
        config: {
            DeepMemoExcludeCurrentTopic: true
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '伪造名字',
        owner: { type: 'group', id: 'forged_owner' },
        agentId: 'forged_agent',
        keyword: '系统设计',
        window_size: 6
    }, {
        requestId: 'req_1',
        vcpContext: {
            agentId: 'trusted_agent',
            agentName: '小克',
            topicId: 'trusted_topic',
            ownerType: 'agent'
        }
    });

    assert.equal(result, '[回忆片段1]:\n可信上下文命中');
    assert.equal(capturedRequest.ownerId, 'trusted_agent');
    assert.equal(capturedRequest.ownerType, 'agent');
    assert.equal(capturedRequest.currentTopicId, 'trusted_topic');
    assert.equal(capturedRequest.excludeCurrentTopic, true);
    assert.equal('maid' in capturedRequest, false);
});

test('查询预设与旧 keyword 合并后交给 CDS 解析', async () => {
    let capturedRequest;
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async request => {
                capturedRequest = request;
                return { windows: [], formattedResult: '' };
            })
        },
        config: {
            QueryPreset: '[闲聊],(技术:1.2)',
            DeepMemoResultLimit: 5,
            MaxMemoTokens: 9000
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '小克',
        key_word: 'VCP',
        candidateLimit: 30
    });

    assert.equal(capturedRequest.query, 'VCP,[闲聊],(技术:1.2)');
    assert.equal(capturedRequest.candidateLimit, 30);
    assert.equal(capturedRequest.resultLimit, 5);
    assert.equal(capturedRequest.maxChars, 9000);
    assert.equal(result, '[DeepMemo] 未找到与关键词“VCP”相关的回忆。');
});

test('没有 owner 上下文或 maid 时拒绝请求', async () => {
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async () => {
                throw new Error('不应调用');
            })
        }
    });

    await assert.rejects(
        () => deepMemo.processToolCall({ keyword: '测试' }),
        /缺少可用于定位记忆所有者/
    );
});

test('中央服务不可用且默认禁用旧 EXE 回退时返回清晰错误', async () => {
    deepMemo.initialize({
        services: { chatDataService: null },
        config: {
            DeepMemoBackend: 'central',
            DeepMemoLegacyFallback: false
        },
        logger: {
            warn() {}
        }
    });

    await assert.rejects(
        () => deepMemo.processToolCall({
            maid: '小克',
            keyword: '测试'
        }),
        /中央聊天数据服务搜索失败：VCP-CDS is unavailable/
    );
});

test('数值参数被限制在 CDS 支持范围内', () => {
    const args = deepMemo._test.normalizeArgs({
        keyword: '测试',
        maid: '小克',
        window_size: 999,
        candidateLimit: 0,
        resultLimit: 999,
        maxChars: -1
    });

    assert.equal(args.windowSize, 100);
    assert.equal(args.candidateLimit, 1);
    assert.equal(args.resultLimit, 100);
    assert.equal(args.maxChars, 1);
});

test('中央搜索输出会清除样式脚本并转换为稳定 Markdown', () => {
    const dirty = [
        '<style>@keyframes pulse { 0% { opacity: 0 } 100% { opacity: 1 } } .card { color:red }</style>',
        '<script>alert("不应泄漏")</script>',
        '<div class="card" style="color:red">',
        '<h2>键盘回忆</h2>',
        '<p><strong>莱恩</strong>：VGN&nbsp;键盘</p>',
        '<ul><li>磁悬浮</li><li>星闪</li></ul>',
        '<a href="javascript:alert(1)">危险链接</a>',
        '<a href="https://example.com/vgn">资料</a>',
        '</div>'
    ].join('');

    const cleaned = deepMemo._test.cleanMemoryOutput(dirty);

    assert.match(cleaned, /^## 键盘回忆/m);
    assert.match(cleaned, /\*\*莱恩\*\*：VGN 键盘/);
    assert.match(cleaned, /- 磁悬浮/);
    assert.match(cleaned, /- 星闪/);
    assert.match(cleaned, /危险链接/);
    assert.doesNotMatch(cleaned, /javascript:/i);
    assert.match(cleaned, /\[资料\]\(https:\/\/example\.com\/vgn\)/);
    assert.doesNotMatch(cleaned, /keyframes|opacity|color:red|不应泄漏/i);
});

test('中央搜索输出会移除隐藏节点、媒体和畸形 HTML 噪声', () => {
    const dirty = [
        '<div>可见文本',
        '<span hidden>hidden 泄漏</span>',
        '<span aria-hidden="true">aria 泄漏</span>',
        '<span style="DISPLAY: none !important">display 泄漏</span>',
        '<span style="visibility:hidden">visibility 泄漏</span>',
        '<img src="x" alt="图片泄漏">',
        '<template>template 泄漏</template>',
        '<p>未闭合段落'
    ].join('');

    const cleaned = deepMemo._test.cleanMemoryOutput(dirty);

    assert.match(cleaned, /可见文本/);
    assert.match(cleaned, /未闭合段落/);
    assert.doesNotMatch(cleaned, /泄漏/);
});

test('泄漏到可见文本中的嵌套 keyframes 会被平衡清除', () => {
    const dirty = [
        '[回忆片段1]:',
        '@-webkit-keyframes glow {',
        '  0% { transform: scale(1); }',
        '  50% { content: "}"; transform: scale(1.2); }',
        '  100% { transform: scale(1); }',
        '}',
        '莱恩: VGN 键盘'
    ].join('\n');

    const cleaned = deepMemo._test.cleanMemoryOutput(dirty);

    assert.match(cleaned, /\[回忆片段1\]:/);
    assert.match(cleaned, /莱恩: VGN 键盘/);
    assert.doesNotMatch(cleaned, /keyframes|transform|scale|content/);
});

test('纯文本回忆不会被 HTML 清理流程破坏', () => {
    const plain = '[回忆片段1]:\n莱恩: VGN 键盘\n小克: 已经召回。';

    assert.equal(deepMemo._test.cleanMemoryOutput(plain), plain);
});

test('Rerank 配置限制为每批最多 25 文档和 64000 token', () => {
    const config = deepMemo._test.normalizeConfig({
        RerankSearch: 'True',
        RerankUrl: 'http://localhost:8000/',
        RerankMaxDocumentsPerBatch: 99,
        RerankMaxTokensPerBatch: 999999
    });
    const batches = deepMemo._test.createRerankBatches(
        Array.from({ length: 26 }, (_, index) => memoryWindow(index)),
        '查询',
        config
    );

    assert.equal(config.rerankSearch, true);
    assert.equal(config.rerankMaxDocumentsPerBatch, 25);
    assert.equal(config.rerankMaxTokensPerBatch, 64000);
    assert.deepEqual(batches.map(batch => batch.length), [25, 1]);
});

test('启用 Rerank 时请求三倍 CDS 窗口并按跨批分数全局排序', async () => {
    let capturedRequest;
    const rerankRequests = [];
    const windows = [
        memoryWindow(0, '低相关'),
        memoryWindow(1, '最高相关'),
        memoryWindow(2, '中相关')
    ];
    axios.post = async (url, data, options) => {
        rerankRequests.push({ url, data, options });
        return {
            data: {
                results: data.documents.map((_, index) => ({
                    index,
                    relevance_score: [0.1, 0.9, 0.5][index]
                }))
            }
        };
    };
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async request => {
                capturedRequest = request;
                return {
                    windows,
                    formattedResult: '不应直接使用 CDS 扩大后的格式化结果'
                };
            })
        },
        config: {
            DeepMemoResultLimit: 1,
            MaxMemoTokens: 1000,
            RerankSearch: true,
            RerankUrl: 'http://localhost:8000/',
            RerankApi: 'secret',
            RerankModel: 'test-reranker',
            RerankCandidateMultiplier: 3,
            RerankMaxDocumentsPerBatch: 25,
            RerankMaxTokensPerBatch: 60000
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '小克',
        keyword: '相关回忆'
    });

    assert.equal(capturedRequest.resultLimit, 3);
    assert.equal(capturedRequest.maxChars, 3000);
    assert.equal(rerankRequests.length, 1);
    assert.equal(rerankRequests[0].url, 'http://localhost:8000/v1/rerank');
    assert.equal(rerankRequests[0].data.top_n, 3);
    assert.equal(rerankRequests[0].data.documents.length, 3);
    assert.equal(rerankRequests[0].options.headers.Authorization, 'Bearer secret');
    assert.match(result, /最高相关/);
    assert.doesNotMatch(result, /低相关|中相关|不应直接使用/);
});

test('调用参数 rerank=true 可在全局默认关闭时请求精排', async () => {
    let capturedRequest;
    let rerankCalls = 0;
    axios.post = async (_url, data) => {
        rerankCalls++;
        return {
            data: {
                results: data.documents.map((_, index) => ({
                    index,
                    relevance_score: index
                }))
            }
        };
    };
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async request => {
                capturedRequest = request;
                return {
                    windows: [memoryWindow(0), memoryWindow(1), memoryWindow(2)],
                    formattedResult: '不应使用'
                };
            })
        },
        config: {
            DeepMemoResultLimit: 1,
            RerankSearch: false,
            RerankUrl: 'http://localhost:8000'
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '小克',
        keyword: '显式启用',
        rerank: 'true'
    });

    assert.equal(capturedRequest.resultLimit, 3);
    assert.equal(rerankCalls, 1);
    assert.match(result, /第2条回忆/);
});

test('调用参数 rerank=false 可在全局默认开启时强制跳过精排', async () => {
    let capturedRequest;
    let rerankCalls = 0;
    axios.post = async () => {
        rerankCalls++;
        throw new Error('不应调用 Rerank');
    };
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async request => {
                capturedRequest = request;
                return {
                    windows: [memoryWindow(0)],
                    formattedResult: '[回忆片段1]:\nCDS 原始排名'
                };
            })
        },
        config: {
            DeepMemoResultLimit: 1,
            RerankSearch: true,
            RerankUrl: 'http://localhost:8000'
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '小克',
        keyword: '显式禁用',
        rerank: false
    });

    assert.equal(capturedRequest.resultLimit, 1);
    assert.equal(rerankCalls, 0);
    assert.equal(result, '[回忆片段1]:\nCDS 原始排名');
});

test('任一 Rerank 批次失败时按最终限制回退 CDS 原始排名', async () => {
    const warnings = [];
    axios.post = async () => {
        throw new Error('rerank unavailable');
    };
    deepMemo.initialize({
        services: {
            chatDataService: createFacade(async () => ({
                windows: [
                    memoryWindow(0, 'CDS 第一名'),
                    memoryWindow(1, 'CDS 第二名'),
                    memoryWindow(2, 'CDS 第三名')
                ],
                formattedResult: '不应泄漏三倍候选'
            }))
        },
        config: {
            DeepMemoResultLimit: 1,
            MaxMemoTokens: 1000,
            RerankSearch: true,
            RerankUrl: 'http://localhost:8000'
        },
        logger: {
            warn(message) {
                warnings.push(message);
            }
        }
    });

    const result = await deepMemo.processToolCall({
        maid: '小克',
        keyword: '回退测试'
    });

    assert.match(result, /CDS 第一名/);
    assert.doesNotMatch(result, /CDS 第二名|CDS 第三名|不应泄漏/);
    assert.ok(warnings.some(message => message.includes('Rerank failed')));
});