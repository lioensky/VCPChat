// modules/renderer/emoticonUrlFixer.js

/** Creates one emoticon catalog owner for one renderer or viewer. */
export function createEmoticonUrlFixer() {
let emoticonLibrary = [];
let isInitialized = false;
let electronAPI;
let initializationPromise = null;

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


function getExtension(filename) {
    const name = typeof filename === 'string' ? filename.trim().normalize('NFC').toLowerCase() : '';
    const extensionIndex = name.lastIndexOf('.');
    return extensionIndex > 0 ? name.slice(extensionIndex) : '';
}

function toPackageStemKey(packageName, filename) {
    const stem = getFilenameStem(filename);
    const pkg = normalizePackageName(packageName);
    if (!stem || !pkg) return null;
    return `${pkg}/${stem}`;
}

// 表情库数组按引用缓存索引；主进程刷新后换新数组，索引自然重建。
let libraryIndexSource = null;
let libraryIndex = null;

function getLibraryIndex() {
    if (libraryIndexSource !== emoticonLibrary) {
        const byPackageStem = new Map();
        for (const item of emoticonLibrary) {
            const info = extractEmoticonInfo(item.url);
            const filename = (typeof item.filename === 'string' && item.filename.trim())
                ? item.filename
                : info.filename;
            const key = toPackageStemKey(item.category || info.packageName, filename);
            if (!key) continue;
            if (!byPackageStem.has(key)) byPackageStem.set(key, []);
            byPackageStem.get(key).push({ item, extension: getExtension(filename) });
        }
        libraryIndexSource = emoticonLibrary;
        libraryIndex = byPackageStem;
    }
    return libraryIndex;
}

// 库内存在哪些分类；用于判断一段 URL 的包名是否值得跨包兜底。
let libraryPackageSource = null;
let libraryPackageSet = null;

function getLibraryPackageSet() {
    if (libraryPackageSource !== emoticonLibrary) {
        const packages = new Set();
        for (const item of emoticonLibrary) {
            const info = extractEmoticonInfo(item.url);
            const pkg = normalizePackageName(item.category || info.packageName);
            if (pkg) packages.add(pkg);
        }
        libraryPackageSource = emoticonLibrary;
        libraryPackageSet = packages;
    }
    return libraryPackageSet;
}

function subscribeToLibraryUpdates() {
    if (typeof electronAPI?.onEmoticonLibraryUpdated !== 'function') return;

    electronAPI.onEmoticonLibraryUpdated(async () => {
        try {
            const library = await electronAPI.getEmoticonLibrary();
            if (Array.isArray(library) && library.length > 0) {
                emoticonLibrary = library;
                console.log(`[EmoticonFixer] Library refreshed with ${library.length} items.`);
            }
        } catch (error) {
            console.warn(`[EmoticonFixer] Refresh failed: ${error.message || error}`);
        }
    });
}

function initialize(api) {
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = new Promise(async (resolve, reject) => {
        electronAPI = api;
        try {
            console.log('[EmoticonFixer] Initializing and fetching library...');
            const library = await electronAPI.getEmoticonLibrary();
            emoticonLibrary = Array.isArray(library) ? library : [];
            isInitialized = true;
            subscribeToLibraryUpdates();
            if (emoticonLibrary.length > 0) {
                console.log(`[EmoticonFixer] Library loaded with ${emoticonLibrary.length} items.`);
            } else {
                console.log('[EmoticonFixer] Library unavailable, fixer running in degraded passthrough mode.');
            }
            resolve();
        } catch (error) {
            emoticonLibrary = [];
            isInitialized = true;
            console.warn(`[EmoticonFixer] Library fetch failed, skipping URL repair: ${error.message || error}`);
            resolve();
        }
    });

    return initializationPromise;
}

function fixEmoticonUrl(originalSrc) {
    if (!isInitialized || emoticonLibrary.length === 0) {
        return originalSrc; // Not ready, pass through
    }

    // 1. Check if it's likely an emoticon URL by looking for "表情包"
    try {
        if (!decodeURIComponent(originalSrc).includes('表情包')) {
            return originalSrc;
        }
    } catch (e) {
        return originalSrc; // Malformed URI
    }

    // 2. 文件主名是表情身份，扩展名不参与匹配；分类只用于同名表情消歧。
    const searchInfo = extractEmoticonInfo(originalSrc);

    if (!searchInfo.filenameStem) {
        console.log(`[EmoticonFixer] Could not extract filename from "${originalSrc}". Passing through.`);
        return originalSrc;
    }

    // 3. host 无关的同包同主名快速命中。库里存的是 settings.vcpServerUrl 的 host，
    //    AI 写出的常是 localhost，比整条 URL 会让每条正常表情都掉进后面的猜测分支。
    //    扩展名不参与身份，只在包内同主名多后缀（如 生气.jpeg / 生气.png）时用于消歧。
    const packageStemKey = toPackageStemKey(searchInfo.packageName, searchInfo.filename);
    if (packageStemKey) {
        const samePackageMatches = getLibraryIndex().get(packageStemKey);
        if (samePackageMatches && samePackageMatches.length > 0) {
            const wantedExtension = getExtension(searchInfo.filename);
            const preferred = samePackageMatches.find(candidate => candidate.extension === wantedExtension)
                || samePackageMatches[0];
            if (preferred.item.url !== originalSrc) {
                console.log(`[EmoticonFixer] Normalized emoticon URL to library form. Original: "${originalSrc}", Canonical: "${preferred.item.url}"`);
            }
            return preferred.item.url;
        }
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

    const normalizedSearchPackage = normalizePackageName(searchInfo.packageName);

    // 4.5 包名不在库且主名也没有精确命中：跨包兜底只会拿一张无关的图顶替原地址
    //     （新拷贝但尚未入库的表情包、AI 编造的路径都走这里），保留原 URL 更诚实。
    if (exactNameMatches.length === 0 && normalizedSearchPackage && !getLibraryPackageSet().has(normalizedSearchPackage)) {
        console.log(`[EmoticonFixer] Package "${searchInfo.packageName}" is absent from the library and no filename matched; keeping original URL.`);
        return originalSrc;
    }

    if (exactNameMatches.length === 1) {
        const exactMatch = exactNameMatches[0].item;
        console.log(`[EmoticonFixer] Fixed URL by exact filename stem. Original: "${originalSrc}", Match: "${exactMatch.url}"`);
        return exactMatch.url;
    }

    if (exactNameMatches.length > 1 && searchInfo.packageName) {
        // 多个分类存在同名表情时，AI 写出的 xx表情包 是第二优先级。
        const exactPackageMatch = exactNameMatches.find(candidate =>
            normalizePackageName(candidate.info.packageName) === normalizedSearchPackage
        );

        if (exactPackageMatch) {
            console.log(`[EmoticonFixer] Fixed URL by exact filename stem and package. Original: "${originalSrc}", Match: "${exactPackageMatch.item.url}"`);
            return exactPackageMatch.item.url;
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
            console.log(`[EmoticonFixer] Fixed URL by exact filename stem and closest package. Original: "${originalSrc}", Match: "${bestPackageMatch.url}" (Package score: ${highestPackageScore.toFixed(2)})`);
            return bestPackageMatch.url;
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

        console.log(`[EmoticonFixer] Fixed ambiguous exact filename stem with package fallback. Original: "${originalSrc}", Match: "${bestExactMatch.item.url}"`);
        return bestExactMatch.item.url;
    }

    // 5. 主名没有命中，但分类精确命中时，先锁定该表情包，再在包内找最相似文件。
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
        const matchScope = samePackageCandidates.length > 0 ? 'same package' : 'library fallback';
        console.log(`[EmoticonFixer] Fixed URL by ${matchScope}. Original: "${originalSrc}", Best Match: "${bestMatch.url}" (Score: ${highestScore.toFixed(2)})`);
        return bestMatch.url;
    }

    // 理论上只有表情库条目全部无有效文件名时才会到这里。
    console.log(`[EmoticonFixer] Emoticon library has no usable candidates for "${originalSrc}". Passing through.`);
    return originalSrc;
}

    return Object.freeze({
        initialize,
        fixEmoticonUrl,
        snapshot: () => emoticonLibrary.map(({ url, filename }) => ({ url, filename })),
    });
}
