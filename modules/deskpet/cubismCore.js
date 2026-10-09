// modules/deskpet/cubismCore.js
// Live2D 用的 Cubism Core：Live2D 的专有组件，VCPChat 不附带。设置页「Live2D 支持」一栏让用户自己装：
//   - 从 Live2D 官网下载锁定版本的 SDK（5-r.4，Core 5.x；5-r.5 起是 Core 6，渲染引擎还不支持），只取出 Core；
//   - 或者选一份本地已经下好的 SDK 压缩包 / live2dcubismcore.min.js。
// 新文件先放到暂存位置，让一个隐藏的沙箱页面真的加载一遍、报出版本号，确认是 5.x 才替换正在用的 Core，
// 坏文件、Core 6 不会把原来能用的换掉。
//
// 纯函数（解析 SDK 版本、从压缩包里找 Core、校验内容）单独导出，便于测试。

'use strict';

const path = require('path');
const fs = require('fs-extra');

const SDK_RELEASE = '5-r.4';
const SDK_URL = `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-${SDK_RELEASE}.zip`;
const LINKS = {
    license: 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html',
    download: 'https://www.live2d.com/sdk/download/web/',
};
const CORE_FILE = 'live2dcubismcore.min.js';
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MIN_CORE_BYTES = 20 * 1024;
const MAX_CORE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
// csmGetVersion() 的高 8 位是主版本
const CORE_V5 = 0x05000000;
const CORE_V6 = 0x06000000;

function userError(message) {
    const error = new Error(message);
    error.userFacing = true;
    return error;
}

/** 压缩包里的路径或文件名里带的 SDK 版本，例如 CubismSdkForWeb-5-r.4 → { major: 5, revision: 4 }。 */
function sdkReleaseOf(name) {
    const match = /CubismSdkForWeb-(\d+)-r\.(\d+)/i.exec(String(name || ''));
    return match ? { major: Number(match[1]), revision: Number(match[2]) } : null;
}

/** SDK 5-r.5 起带的是 Core 6，SDK 6 以后更不用说；看不出版本时交给加载后的版本号判断。 */
function isUnsupportedRelease(release) {
    if (!release) return false;
    return release.major > 5 || (release.major === 5 && release.revision >= 5);
}

function formatCoreVersion(version) {
    if (!(version > 0)) return '';
    return `${version >>> 24}.${(version >>> 16) & 0xff}.${version & 0xffff}`;
}

/** 看上去是不是 Core：大小合理，并且定义了 Live2DCubismCore。真正能不能用要加载后才知道。 */
function looksLikeCore(text) {
    const size = Buffer.byteLength(String(text || ''));
    return size >= MIN_CORE_BYTES && size <= MAX_CORE_BYTES && /Live2DCubismCore/.test(text);
}

/** 从 SDK 压缩包里取出 Core/live2dcubismcore.min.js。 */
async function extractCoreFromZip(buffer, JSZip = require('jszip')) {
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch {
        throw userError('这个压缩包打不开，可能没下载完整');
    }
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && /(^|\/)Core\/live2dcubismcore\.min\.js$/i.test(entry.name));
    // 示例工程里也可能拷了一份 Core：取路径最短的那份，也就是 SDK 根目录下的
    entries.sort((a, b) => a.name.length - b.name.length);
    const entry = entries[0];
    if (!entry) throw userError('压缩包里没有 Core/live2dcubismcore.min.js，请选 Live2D 官网的 Cubism SDK for Web');
    const release = sdkReleaseOf(entry.name) || sdkReleaseOf(Object.keys(zip.files)[0]);
    if (isUnsupportedRelease(release)) {
        throw userError(`这是 SDK ${release.major}-r.${release.revision}，里面的 Core 是 6.x，渲染引擎还不支持。请用 5-r.4 或更早的 5.x 版本`);
    }
    const source = await entry.async('string');
    if (!looksLikeCore(source)) throw userError('压缩包里的 Core 文件不完整');
    return { source, release };
}

/** 读用户选的文件：SDK 压缩包或者 Core 本身。 */
async function readCoreSource(file) {
    const stat = await fs.stat(file);
    if (/\.zip$/i.test(file)) {
        if (stat.size > MAX_ZIP_BYTES) throw userError('压缩包太大了，不像是 Cubism SDK for Web');
        return extractCoreFromZip(await fs.readFile(file));
    }
    if (stat.size > MAX_CORE_BYTES) throw userError('文件太大了，不像是 live2dcubismcore.min.js');
    const source = await fs.readFile(file, 'utf8');
    if (!looksLikeCore(source)) throw userError('这不是 Cubism Core：请选 live2dcubismcore.min.js 或整个 SDK 压缩包');
    return { source, release: sdkReleaseOf(file) };
}

/** 下载到内存，边下边报进度；超过上限直接停。 */
async function download(fetchImpl, url, { onProgress, maxBytes = MAX_ZIP_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response;
        try {
            response = await fetchImpl(url, { signal: controller.signal });
        } catch (error) {
            throw userError(controller.signal.aborted ? '下载超时了' : `连不上 Live2D 官网（${error.message}）`);
        }
        if (!response.ok) throw userError(`Live2D 官网返回 ${response.status}，下载没成功`);
        const total = Number(response.headers.get('content-length')) || 0;
        if (total > maxBytes) throw userError('官网返回的文件太大，不像是 SDK');
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            let step;
            try {
                step = await reader.read();
            } catch (error) {
                throw userError(controller.signal.aborted ? '下载超时了' : `下载中断了（${error.message}）`);
            }
            if (step.done) break;
            received += step.value.byteLength;
            if (received > maxBytes) {
                controller.abort();
                throw userError('官网返回的文件太大，不像是 SDK');
            }
            chunks.push(Buffer.from(step.value));
            onProgress?.({ received, total });
        }
        return Buffer.concat(chunks);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * probe(stagedFile) → Promise<number>：在隔离页面里加载暂存的 Core，返回 csmGetVersion()，加载不了返回 0。
 * fetch：主进程的 net.fetch（走系统代理）。
 */
function createCoreInstaller({ appDataRoot, fetch: fetchImpl, probe }) {
    const dir = path.join(appDataRoot, 'deskpet');
    const corePath = path.join(dir, CORE_FILE);
    const stagedPath = path.join(dir, 'live2dcubismcore.staged.js');
    const infoPath = path.join(dir, 'core.json');
    let busy = null;

    async function status() {
        const installed = await fs.pathExists(corePath);
        let info = null;
        if (installed) {
            try { info = await fs.readJson(infoPath); } catch { /* 手动放进来的，不知道版本 */ }
        }
        return {
            installed,
            version: installed && typeof info?.version === 'string' ? info.version : '',
            busy: Boolean(busy),
            release: SDK_RELEASE,
            path: corePath,
        };
    }

    async function install({ source, release }, origin) {
        await fs.ensureDir(dir);
        await fs.writeFile(stagedPath, source);
        try {
            const version = await probe(stagedPath);
            if (!(version >= CORE_V5)) throw userError('这份 Core 加载不起来（文件损坏，或者版本太旧）');
            if (version >= CORE_V6) throw userError(`这份 Core 是 ${formatCoreVersion(version)}，渲染引擎只支持 5.x。请用 SDK 5-r.4 或更早的 5.x 版本`);
            await fs.move(stagedPath, corePath, { overwrite: true });
            const info = {
                version: formatCoreVersion(version),
                sdk: release ? `${release.major}-r.${release.revision}` : null,
                origin,
                installedAt: new Date().toISOString(),
            };
            await fs.writeJson(infoPath, info, { spaces: 2 });
            return info;
        } finally {
            await fs.remove(stagedPath).catch(() => {});
        }
    }

    function exclusive(task) {
        if (busy) return Promise.resolve({ success: false, error: '正在安装，请稍等' });
        busy = (async () => {
            try {
                return { success: true, ...(await task()) };
            } catch (error) {
                if (!error.userFacing) console.warn('[DeskPet] Cubism Core install failed:', error);
                return { success: false, error: error.userFacing ? error.message : `安装失败：${error.message}` };
            } finally {
                busy = null;
            }
        })();
        return busy;
    }

    function installOfficial(onProgress) {
        return exclusive(async () => {
            onProgress?.({ phase: 'download', received: 0, total: 0 });
            const zip = await download(fetchImpl, SDK_URL, { onProgress: (p) => onProgress?.({ phase: 'download', ...p }) });
            onProgress?.({ phase: 'verify' });
            const core = await extractCoreFromZip(zip);
            return install(core, 'official');
        });
    }

    function installFromFile(file) {
        return exclusive(async () => install(await readCoreSource(file), 'file'));
    }

    return { status, installOfficial, installFromFile, corePath, stagedPath };
}

module.exports = {
    SDK_RELEASE,
    SDK_URL,
    LINKS,
    CORE_V5,
    CORE_V6,
    sdkReleaseOf,
    isUnsupportedRelease,
    formatCoreVersion,
    looksLikeCore,
    extractCoreFromZip,
    readCoreSource,
    download,
    createCoreInstaller,
};
