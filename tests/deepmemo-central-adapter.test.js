'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const deepMemo = require('../VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');

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
});

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