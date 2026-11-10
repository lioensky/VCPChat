'use strict';

// Retired stdio entry. Never read or write AppData from this process.
// Historical implementation: docs/archive/topicsponsor-legacy.js.txt
const error = {
    status: 'error',
    code: 'TOPIC_SPONSOR_STDIO_RETIRED',
    error: 'TopicSponsor stdio入口已退役；请通过manifest注册的topicsponsor-service.js direct宿主服务调用，禁止绕过中央消息队列。',
};
if (require.main === module) {
    console.error(JSON.stringify(error));
    process.exitCode = 1;
} else {
    throw Object.assign(new Error(error.error), { code: error.code });
}