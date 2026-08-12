'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function escapeInlineScriptSource(source) {
    return String(source || '').replace(/<\/script/gi, '<\\/script');
}

function libraryForExternalScriptUrl(value) {
    const url = String(value || '').trim();
    if (/cdn\.jsdelivr\.net\/npm\/three/i.test(url)
        || /unpkg\.com\/three/i.test(url)
        || /cdnjs\.cloudflare\.com.*three/i.test(url)) return 'three';
    if (/cdn\.jsdelivr\.net\/npm\/animejs/i.test(url)
        || /unpkg\.com\/animejs/i.test(url)) return 'anime';
    return null;
}

function collectMarkedDependencies(html) {
    const dependencies = new Set();
    const scriptPattern = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;
    let match;
    while ((match = scriptPattern.exec(String(html || '')))) {
        const attributes = match[1] || '';
        const libraryMatch = attributes.match(
            /data-vdoc-library\s*=\s*(?:"([^"]+)"|'([^']+)')/i
        );
        const library = String(
            libraryMatch?.[1] || libraryMatch?.[2] || ''
        ).toLowerCase();
        if (['anime', 'three'].includes(library)) dependencies.add(library);

        const sourceMatch = attributes.match(
            /src\s*=\s*(?:"([^"]+)"|'([^']+)')/i
        );
        const source = sourceMatch?.[1] || sourceMatch?.[2] || '';
        const externalLibrary = libraryForExternalScriptUrl(source);
        if (externalLibrary) dependencies.add(externalLibrary);
    }
    return dependencies;
}

async function inlineProgrammableDependencies(html) {
    const dependencies = collectMarkedDependencies(html);
    let output = String(html || '')
        .replace(
            /<script\b(?=[^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi,
            ''
        )
        .replace(
            /<script\b(?=[^>]*\bdata-vdoc-library\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi,
            ''
        );

    const sources = [];
    for (const library of ['anime', 'three']) {
        if (!dependencies.has(library)) continue;
        const fileName = library === 'anime' ? 'anime.min.js' : 'three.min.js';
        const sourcePath = path.join(projectRoot, 'vendor', fileName);
        const source = await fs.promises.readFile(sourcePath, 'utf8');
        const escapedSource = escapeInlineScriptSource(source);
        inlineProgrammableDependencies.expectedSources ||= [];
        inlineProgrammableDependencies.expectedSources.push({
            library,
            source: escapedSource,
        });
        try {
            new vm.Script(source, { filename: `${library}-original.js` });
            console.log(`${library} 原始库语法合法 ✓`);
        } catch (error) {
            console.error(`${library} 原始库语法错误 ✗:`, error.message);
        }
        try {
            new vm.Script(escapedSource, { filename: `${library}-escaped.js` });
            console.log(`${library} HTML 转义后语法合法 ✓`);
        } catch (error) {
            const difference = [...source].findIndex(
                (character, index) => character !== escapedSource[index]
            );
            console.error(`${library} HTML 转义后语法错误 ✗:`, error.message);
            console.error('  首个改写位置:', difference);
            console.error(
                '  原始片段:',
                JSON.stringify(source.slice(Math.max(0, difference - 80), difference + 80))
            );
            console.error(
                '  转义片段:',
                JSON.stringify(escapedSource.slice(Math.max(0, difference - 80), difference + 80))
            );
        }
        sources.push(
            `<script data-vdoc-embedded-library="${library}">\n${
                escapedSource
            }\n</script>`
        );
    }

    if (!sources.length) return output;
    const embedded = sources.join('\n');
    if (/<\/head\s*>/i.test(output)) {
        return output.replace(/<\/head\s*>/i, `${embedded}\n</head>`);
    }
    return `${embedded}\n${output}`;
}

async function main() {
    const inputHtml = [
        '<!doctype html><html><head>',
        '<style>body { margin: 0; }</style>',
        '</head><body>',
        '<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>',
        '<script>const scene = new THREE.Scene(); console.log(scene);</script>',
        '</body></html>',
    ].join('');

    console.log('=== 导出内联依赖测试 ===');
    console.log('输入 HTML 字节:', Buffer.byteLength(inputHtml, 'utf8'));

    const deps = collectMarkedDependencies(inputHtml);
    console.log('识别依赖:', [...deps]);

    const output = await inlineProgrammableDependencies(inputHtml);
    console.log('输出 HTML 字节:', Buffer.byteLength(output, 'utf8'));

    const scripts = [...output.matchAll(
        /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
    )].map((m) => m[1]);

    console.log('脚本数量:', scripts.length);

    const expectedLibrary = inlineProgrammableDependencies.expectedSources?.[0]?.source || '';
    const extractedLibrary = scripts[0]?.replace(/^\n/, '').replace(/\n$/, '') || '';
    let firstDifference = -1;
    const comparisonLength = Math.max(expectedLibrary.length, extractedLibrary.length);
    for (let index = 0; index < comparisonLength; index += 1) {
        if (expectedLibrary[index] !== extractedLibrary[index]) {
            firstDifference = index;
            break;
        }
    }
    console.log('库写入前字符数:', expectedLibrary.length);
    console.log('库提取后字符数:', extractedLibrary.length);
    console.log('库源码逐字一致:', firstDifference < 0 ? '是 ✓' : '否 ✗');
    if (firstDifference >= 0) {
        console.log('首个差异位置:', firstDifference);
        console.log(
            '写入前片段:',
            JSON.stringify(expectedLibrary.slice(
                Math.max(0, firstDifference - 100),
                firstDifference + 100
            ))
        );
        console.log(
            '提取后片段:',
            JSON.stringify(extractedLibrary.slice(
                Math.max(0, firstDifference - 100),
                firstDifference + 100
            ))
        );
    }

    let allValid = true;
    scripts.forEach((scriptSource, index) => {
        try {
            new vm.Script(scriptSource, {
                filename: `export-script-${index + 1}.js`,
            });
            console.log(
                `脚本 ${index + 1} · ${Buffer.byteLength(scriptSource)} 字节 · 语法合法 ✓`
            );
        } catch (error) {
            allValid = false;
            const firstHtmlBoundary = scriptSource.search(/<\/?(?:html|head|body|script)\b/i);
            console.error(
                `脚本 ${index + 1} · 语法错误 ✗:`,
                error.message
            );
            console.error('  HTML 边界位置:', firstHtmlBoundary);
            console.error(
                '  脚本末尾 240 字符:',
                JSON.stringify(scriptSource.slice(-240))
            );
            console.error(
                '  错误栈首行:',
                String(error.stack || '').split('\n').slice(0, 2).join(' | ')
            );
        }
    });

    const hasCdn = /<script[^>]*src="https?:\/\/cdn/i.test(output);
    console.log('仍含 CDN 外链:', hasCdn ? '是 ✗' : '否 ✓');

    console.log(
        '导出包装闭合标签数:',
        (output.match(/<\/script\s*>/gi) || []).length
    );
    const passed = !hasCdn && allValid && scripts.length === 2;
    console.log(passed ? '测试结果: 通过 ✓' : '测试结果: 失败 ✗');

    if (!passed) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});