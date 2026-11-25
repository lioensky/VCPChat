/**
 * local-search-controller.js  ——  平台分发入口
 *
 * 上游原实现（Everything HTTP）逐字节保留在 local-search-controller-win.js。
 * Linux / macOS 走 fd-rdd HTTP 双源聚合实现 local-search-controller-linux.js。
 * 两者均为 stdio 插件：读 stdin 的 JSON 请求，向 stdout 输出 JSON 结果。
 */
"use strict";

const impl = (process.platform === 'linux' || process.platform === 'darwin')
    ? './local-search-controller-linux.js'
    : './local-search-controller-win.js';

require(impl);
