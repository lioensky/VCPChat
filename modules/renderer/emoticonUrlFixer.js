// modules/renderer/emoticonUrlFixer.js

const SERVER_KEY_PATH_REGEX = /^\/pw=([^/]+)\/(images|files)(?:\/|$)/;
const SERVER_KEY_REPLACE_REGEX = /^(https?:\/\/[^/?#]+)\/pw=[^/?#]+(\/(?:images|files)(?:\/|$|[?#]))/i;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MARKDOWN_LINK_REGEX = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
const HTML_IMG_SRC_REGEX = /<img([^>]*?)src=(["'])([^"']+)\2([^>]*?)>/gi;
const HTML_LINK_HREF_REGEX = /<a([^>]*?)href=(["'])([^"']+)\2([^>]*?)>/gi;
const HTML_MEDIA_SRC_REGEX = /<(audio|video|source)([^>]*?)src=(["'])([^"']+)\3([^>]*?)>/gi;
const BARE_SERVER_KEY_URL_REGEX = /https?:\/\/[^\s<>"'()[\]`]+\/pw=[^/\s<>"'()[\]`]+\/(?:images|files)(?:\/[^\s<>"'()[\]`]*)?/gi;

function normalizeNonEmptyString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parseHttpHostname(urlString) {
    const trimmed = normalizeNonEmptyString(urlString);
    if (!trimmed) return '';
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.hostname.toLowerCase();
    } catch {
        return '';
    }
}

/**
 * Rewrites `/pw=<oldKey>/(images|files)/...` on URLs targeting the same VCP host
 * to the active `fileKey`. Third-party hosts and unrelated paths remain untouched.
 */
export function rewriteServerFileKeyInUrl(originalUrl, serverConfig = {}) {
    if (typeof originalUrl !== 'string' || !originalUrl.includes('/pw=')) {
        return originalUrl;
    }

    const trimmedFileKey = normalizeNonEmptyString(serverConfig?.fileKey);
    const serverHostname = parseHttpHostname(serverConfig?.vcpServerUrl);
    if (!trimmedFileKey || !serverHostname) {
        return originalUrl;
    }

    const trimmedUrl = originalUrl.trim();
    if (!trimmedUrl) {
        return originalUrl;
    }

    let parsedTarget;
    try {
        parsedTarget = new URL(trimmedUrl);
    } catch {
        return originalUrl;
    }

    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
        return originalUrl;
    }
    // Reject userinfo before rewriting raw Markdown/HTML: character references in
    // the authority could turn it into a different host when the markup is parsed.
    if (parsedTarget.username || parsedTarget.password || parsedTarget.hostname.toLowerCase() !== serverHostname) {
        return originalUrl;
    }

    const pathMatch = parsedTarget.pathname.match(SERVER_KEY_PATH_REGEX);
    if (!pathMatch) {
        return originalUrl;
    }

    // These characters are legal URL path bytes but delimit Markdown or HTML.
    const encodedFileKey = encodeURIComponent(trimmedFileKey)
        .replace(/['()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    if (pathMatch[1] === trimmedFileKey || pathMatch[1] === encodedFileKey) {
        return originalUrl;
    }

    const rewritten = trimmedUrl.replace(SERVER_KEY_REPLACE_REGEX, `$1/pw=${encodedFileKey}$2`);
    if (rewritten === trimmedUrl) {
        return originalUrl;
    }

    return originalUrl === trimmedUrl
        ? rewritten
        : originalUrl.replace(trimmedUrl, rewritten);
}

/**
 * Rewrites image, link, media, and bare VCP URLs inside prose Markdown / HTML tags.
 * Non-image links and media only run `fixServerKeyUrl` (never fuzzy emoticon repair).
 */
export function fixUrlsInMarkdownText(text, fixers = {}) {
    if (!text || typeof text !== 'string') return text;

    const fixEmoticonUrl = typeof fixers === 'function'
        ? fixers
        : (typeof fixers?.fixEmoticonUrl === 'function' ? fixers.fixEmoticonUrl : value => value);
    const fixServerKeyUrl = typeof fixers === 'function'
        ? (value => value)
        : (typeof fixers?.fixServerKeyUrl === 'function' ? fixers.fixServerKeyUrl : value => value);

    let result = text;

    if (result.includes('![')) {
        result = result.replace(MARKDOWN_IMAGE_REGEX, (match, alt, url) => {
            const fixedUrl = fixEmoticonUrl(url);
            return `![${alt}](${fixedUrl})`;
        });
    }

    if (result.includes('](') && result.includes('/pw=')) {
        result = result.replace(MARKDOWN_LINK_REGEX, (match, label, url) => {
            const fixedUrl = fixServerKeyUrl(url);
            return `[${label}](${fixedUrl})`;
        });
    }

    if (/<img\b/i.test(result)) {
        result = result.replace(HTML_IMG_SRC_REGEX, (match, before, quote, url, after) => {
            const fixedUrl = fixEmoticonUrl(url);
            return `<img${before}src=${quote}${fixedUrl}${quote}${after}>`;
        });
    }

    if (result.includes('/pw=')) {
        if (/<a\b/i.test(result)) {
            result = result.replace(HTML_LINK_HREF_REGEX, (match, before, quote, url, after) => {
                const fixedUrl = fixServerKeyUrl(url);
                return `<a${before}href=${quote}${fixedUrl}${quote}${after}>`;
            });
        }
        if (/<(?:audio|video|source)\b/i.test(result)) {
            result = result.replace(HTML_MEDIA_SRC_REGEX, (match, tag, before, quote, url, after) => {
                const fixedUrl = fixServerKeyUrl(url);
                return `<${tag}${before}src=${quote}${fixedUrl}${quote}${after}>`;
            });
        }
        result = result.replace(BARE_SERVER_KEY_URL_REGEX, (url) => {
            const fixedUrl = fixServerKeyUrl(url);
            return fixedUrl;
        });
    }

    return result;
}

/** Creates one emoticon catalog owner for one renderer or viewer. */
export function createEmoticonUrlFixer(initialOptions = {}) {
let emoticonLibrary = [];
let isInitialized = false;
let electronAPI;
let initializationPromise = null;
let getSettingsFn = typeof initialOptions?.getSettings === 'function' ? initialOptions.getSettings : null;
let loadedSettings = initialOptions?.settings && typeof initialOptions.settings === 'object'
    ? { ...initialOptions.settings }
    : null;

function getServerConfig() {
    const settings = getSettingsFn?.() ?? loadedSettings;
    return {
        vcpServerUrl: normalizeNonEmptyString(settings?.vcpServerUrl),
        fileKey: normalizeNonEmptyString(settings?.fileKey),
    };
}

function setServerConfig(config = {}) {
    if (!config || typeof config !== 'object') return;
    loadedSettings = {
        ...(loadedSettings || {}),
        ...('vcpServerUrl' in config ? { vcpServerUrl: config.vcpServerUrl } : {}),
        ...('fileKey' in config ? { fileKey: config.fileKey } : {}),
    };
}

function fixServerKeyUrl(originalSrc) {
    return rewriteServerFileKeyInUrl(originalSrc, getServerConfig());
}

// A simple string similarity function (Jaro-Winkler might be better, but this is simple)
function getSimilarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
        longer = s2;
        shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) {
        return 1.0;
    }
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();

    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) {
            costs[s2.length] = lastValue;
        }
    }
    return costs[s2.length];
}


function getFilenameStem(filename) {
    if (!filename || typeof filename !== 'string') return null;

    const normalizedFilename = filename.trim().normalize('NFC');
    const extensionIndex = normalizedFilename.lastIndexOf('.');

    // 隐藏文件或无后缀文件直接以完整文件名作为主名。
    if (extensionIndex <= 0) {
        return normalizedFilename.toLowerCase();
    }

    return normalizedFilename.slice(0, extensionIndex).toLowerCase();
}

function normalizePackageName(packageName) {
    return typeof packageName === 'string'
        ? packageName.trim().normalize('NFC').toLowerCase()
        : null;
}

function extractEmoticonInfo(url) {
    let filename = null;
    let packageName = null;

    if (!url) return { filename, filenameStem: null, packageName };

    try {
        // Use URL to handle file:// or http:// protocols
        const decodedPath = decodeURIComponent(new URL(url).pathname);
        // Split path and remove empty segments (e.g., leading slash)
        const parts = decodedPath.split('/').filter(Boolean);
        if (parts.length > 0) {
            filename = parts[parts.length - 1];
        }
        if (parts.length > 1) {
            packageName = parts[parts.length - 2];
        }
    } catch (e) {
        // Fallback for strings that are not full URLs or malformed
        try {
            const decodedUrl = decodeURIComponent(url);
            const parts = decodedUrl.split('/').filter(Boolean);
            if (parts.length > 0) {
                filename = parts[parts.length - 1];
            }
            if (parts.length > 1) {
                packageName = parts[parts.length - 2];
            }
        } catch (e2) {
            // If decoding fails, use the raw url string
            const parts = url.split('/').filter(Boolean);
            if (parts.length > 0) {
                filename = parts[parts.length - 1];
            }
            if (parts.length > 1) {
                packageName = parts[parts.length - 2];
            }
        }
    }
    
    return {
        filename,
        filenameStem: getFilenameStem(filename),
        packageName
    };
}


function initialize(api, options = {}) {
    if (typeof options?.getSettings === 'function') {
        getSettingsFn = options.getSettings;
    }
    if (options?.settings && typeof options.settings === 'object') {
        setServerConfig(options.settings);
    }

    if (initializationPromise) {
        return initializationPromise;
    }

    electronAPI = api;
    initializationPromise = (async () => {
        const libraryTask = typeof electronAPI?.getEmoticonLibrary === 'function'
            ? Promise.resolve().then(() => electronAPI.getEmoticonLibrary())
            : Promise.resolve([]);
        const settingsTask = !getSettingsFn && typeof electronAPI?.loadSettings === 'function'
            ? Promise.resolve().then(() => electronAPI.loadSettings())
            : Promise.resolve(null);

        console.log('[EmoticonFixer] Initializing and fetching library...');
        const [libraryResult, settingsResult] = await Promise.allSettled([libraryTask, settingsTask]);

        if (settingsResult.status === 'fulfilled' && settingsResult.value && typeof settingsResult.value === 'object') {
            setServerConfig(settingsResult.value);
        }

        if (libraryResult.status === 'fulfilled') {
            emoticonLibrary = Array.isArray(libraryResult.value) ? libraryResult.value : [];
            isInitialized = true;
            if (emoticonLibrary.length > 0) {
                console.log(`[EmoticonFixer] Library loaded with ${emoticonLibrary.length} items.`);
            } else {
                console.log('[EmoticonFixer] Library unavailable, fixer running in degraded passthrough mode.');
            }
        } else {
            emoticonLibrary = [];
            isInitialized = true;
            console.warn('[EmoticonFixer] Library fetch failed, skipping emoticon repair.');
        }
    })();

    return initializationPromise;
}

function fixEmoticonUrl(originalSrc) {
    const normalizedSrc = fixServerKeyUrl(originalSrc);

    if (!isInitialized || emoticonLibrary.length === 0) {
        return normalizedSrc; // Library not ready, still keep same-domain fileKey rewrite
    }

    let decodedNormalizedSrc;
    try {
        decodedNormalizedSrc = decodeURIComponent(normalizedSrc);
    } catch {
        return normalizedSrc; // Malformed URI
    }
    // Ordinary images do not need to scan the emoticon catalog.
    if (!decodedNormalizedSrc.includes('表情包')) return normalizedSrc;
    if (emoticonLibrary.some(item => {
        try {
            return decodeURIComponent(fixServerKeyUrl(item.url)) === decodedNormalizedSrc;
        } catch {
            return false;
        }
    })) return normalizedSrc;

    // 3. 文件主名是表情身份，扩展名不参与匹配；分类只用于同名表情消歧。
    const searchInfo = extractEmoticonInfo(normalizedSrc);

    if (!searchInfo.filenameStem) {
        return normalizedSrc;
    }

    const candidates = emoticonLibrary
        .map(item => {
            const info = extractEmoticonInfo(item.url);
            const filename = typeof item.filename === 'string' && item.filename.trim()
                ? item.filename
                : info.filename;

            return {
                item,
                info: {
                    ...info,
                    filename,
                    filenameStem: getFilenameStem(filename)
                }
            };
        })
        .filter(candidate => candidate.info.filenameStem);

    // 4. 首选不含后缀的文件主名完全命中。
    const exactNameMatches = candidates.filter(candidate =>
        candidate.info.filenameStem === searchInfo.filenameStem
    );

    if (exactNameMatches.length === 1) {
        const exactMatch = exactNameMatches[0].item;
        return fixServerKeyUrl(exactMatch.url);
    }

    if (exactNameMatches.length > 1 && searchInfo.packageName) {
        const normalizedSearchPackage = normalizePackageName(searchInfo.packageName);

        // 多个分类存在同名表情时，AI 写出的 xx表情包 是第二优先级。
        const exactPackageMatch = exactNameMatches.find(candidate =>
            normalizePackageName(candidate.info.packageName) === normalizedSearchPackage
        );

        if (exactPackageMatch) {
            return fixServerKeyUrl(exactPackageMatch.item.url);
        }

        let bestPackageMatch = null;
        let highestPackageScore = -1;
        for (const candidate of exactNameMatches) {
            if (!candidate.info.packageName) continue;
            const packageScore = getSimilarity(searchInfo.packageName, candidate.info.packageName);
            if (packageScore > highestPackageScore) {
                highestPackageScore = packageScore;
                bestPackageMatch = candidate.item;
            }
        }

        if (bestPackageMatch) {
            return fixServerKeyUrl(bestPackageMatch.url);
        }
    }

    // 即使同名候选无法精确按分类消歧，也选择分类最接近的一项；
    // 对明确包含“表情包”的 URL，库内有效图片优先于保留必然裂图的原地址。
    if (exactNameMatches.length > 1) {
        let bestExactMatch = exactNameMatches[0];
        let highestPackageScore = -1;

        for (const candidate of exactNameMatches) {
            const packageScore = searchInfo.packageName && candidate.info.packageName
                ? getSimilarity(searchInfo.packageName, candidate.info.packageName)
                : 0;

            if (packageScore > highestPackageScore) {
                highestPackageScore = packageScore;
                bestExactMatch = candidate;
            }
        }

        return fixServerKeyUrl(bestExactMatch.item.url);
    }

    // 5. 主名没有命中，但分类精确命中时，先锁定该表情包，再在包内找最相似文件。
    const normalizedSearchPackage = normalizePackageName(searchInfo.packageName);
    const samePackageCandidates = normalizedSearchPackage
        ? candidates.filter(candidate =>
            normalizePackageName(candidate.info.packageName) === normalizedSearchPackage
        )
        : [];
    const fuzzyCandidates = samePackageCandidates.length > 0
        ? samePackageCandidates
        : candidates;

    let bestMatch = null;
    let highestScore = -1;

    for (const candidate of fuzzyCandidates) {
        const filenameScore = getSimilarity(searchInfo.filenameStem, candidate.info.filenameStem);
        const packageScore = searchInfo.packageName && candidate.info.packageName
            ? getSimilarity(searchInfo.packageName, candidate.info.packageName)
            : 0;
        // 文件主名仍是第一优先级；分类用于全库兜底时辅助选择。
        const score = samePackageCandidates.length > 0
            ? filenameScore
            : (0.8 * filenameScore) + (0.2 * packageScore);

        if (score > highestScore) {
            highestScore = score;
            bestMatch = candidate.item;
        }
    }

    // 6. 明确的表情包 URL 必须兜底到库内项目，不设最低相似度门槛。
    if (bestMatch) {
        return fixServerKeyUrl(bestMatch.url);
    }

    // 理论上只有表情库条目全部无有效文件名时才会到这里。
    return normalizedSrc;
}

    return Object.freeze({
        initialize,
        fixEmoticonUrl,
        fixServerKeyUrl,
        setServerConfig,
        getServerConfig,
        snapshot: () => emoticonLibrary.map(({ url, filename }) => ({ url, filename })),
    });
}
