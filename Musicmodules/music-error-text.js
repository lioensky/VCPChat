/*
 * 把出错信息整理成能给人看的一句话。
 *
 * 主进程抛回来的错误会带上「Error invoking remote method 'music-xxx': Error: ...」这种前缀，
 * 原样显示在歌词弹窗、混响状态里像一段日志。这里去掉前缀，常见的网络错误换成中文，
 * 剩下的说不清的就用调用方给的那句（比如「歌词搜索失败」）。
 */
(function (global) {
    'use strict';
    const KNOWN = [
        [/ECONNREFUSED|ERR_CONNECTION_REFUSED/i, '连不上服务'],
        [/ETIMEDOUT|timed? ?out|超时/i, '连接超时'],
        [/ENOTFOUND|ERR_NAME_NOT_RESOLVED|getaddrinfo/i, '找不到服务器'],
        [/fetch failed|network|ERR_INTERNET_DISCONNECTED|ECONNRESET/i, '网络连接出错'],
        [/ENOENT|no such file/i, '找不到这个文件'],
        [/EACCES|EPERM|permission denied/i, '没有权限读写这个文件'],
        [/ENOSPC|no space left/i, '磁盘空间不够'],
        [/EBUSY|resource busy|locked/i, '文件被别的程序占用'],
    ];

    const INVOKE_PREFIX_RE = /^Error invoking remote method '[^']*':\s*/i;
    const ERR_PREFIX_RE = /^(?:[A-Z][A-Za-z]*Error|Error):\s*/;
    const CJK_RE = /[一-鿿]/;

    function errorText(err, fallback = '出错了') {
        let msg = typeof err === 'string' ? err : (err && err.message) || '';
        msg = String(msg)
            .replace(INVOKE_PREFIX_RE, '')
            .replace(ERR_PREFIX_RE, '')
            .trim();
        if (!msg) return fallback;
        for (const [re, text] of KNOWN) if (re.test(msg)) return `${fallback}：${text}`;
        // 已经是中文的说明就直接用；纯英文的技术信息不给人看
        return CJK_RE.test(msg) ? msg : fallback;
    }

    global.MusicErrorText = errorText;
    if (typeof module !== 'undefined' && module.exports) module.exports = errorText;
})(typeof window !== 'undefined' ? window : globalThis);
