// 将 Excalidraw 打包到 vendor/excalidraw，供文坊的白板使用（ScriptoriumModules/scriptorium-board.js）。
// 项目本身不依赖 React：在临时目录安装官方包，用 esbuild 打成一份 IIFE，打开白板时才载入。
// 运行：node scripts/build-excalidraw.mjs <临时工作目录>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXCALIDRAW = '0.18.1';
const REACT = '19.1.1';
const ESBUILD = '0.25.10';
const KEEP_LOCALES = /\/(zh-CN|en)-[^/]*$/; // 只保留中文和英文，其余语言不打入（约 1.7 MB）
// Mermaid 转白板依赖完整的 mermaid，体积占一半以上：单独打成一份，使用时才载入。
const MERMAID = /^@excalidraw\/mermaid-to-excalidraw(\/|$)/;
const MERMAID_STUB = `let loading = null;
const load = () => loading ||= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = new URL('excalidraw-mermaid.js', window.EXCALIDRAW_ASSET_PATH).href;
    tag.onload = () => resolve(window.ScriptoriumExcalidrawMermaid);
    tag.onerror = () => { loading = null; reject(new Error('Mermaid 转换模块未能载入。')); };
    document.head.append(tag);
});
export const parseMermaidToExcalidraw = async (...args) => (await load()).parseMermaidToExcalidraw(...args);`;
// 官方中文语言包比英文包少约 95 条，界面上会出现英文。这里补上常用的条目（协作、用户列表等不涉及）。
const ZH_EXTRA = {
    labels: {
        changeStroke: '描边颜色', changeBackground: '背景颜色', more_options: '更多选项', arrowtypes: '箭头类型', arrowtype_sharp: '直线箭头', arrowtype_round: '曲线箭头',
        arrowtype_elbowed: '折线箭头', arrowhead_crowfoot_many: '鸦爪（多）', arrowhead_crowfoot_one: '鸦爪（一）', arrowhead_crowfoot_one_or_many: '鸦爪（一或多）',
        clearCanvas: '清空画布', toggleGrid: '网格', showFonts: '选择字体', theme: '主题', link: { hint: '输入或粘贴链接', goToElement: '跳转到目标元素' }, lineEditor: { editArrow: '编辑箭头' },
        zoomToFitViewport: '缩放到窗口', zoomToFitSelection: '缩放到选中内容', zoomToFit: '缩放到全部内容', autoResize: '文字自动调整大小', imageCropping: '裁剪图片',
        unCroppedDimension: '裁剪前尺寸', copyElementLink: '复制元素链接', linkToElement: '链接到元素', wrapSelectionInFrame: '用画框包围选中内容',
    },
    elementLink: { title: '链接到元素', desc: '在画布上点击一个形状，或粘贴链接。', notFound: '画布上找不到链接的元素。' },
    search: { title: '在画布上查找', noMatch: '未找到', singleResult: '条结果', multipleResults: '条结果', placeholder: '查找画布上的文字' },
    buttons: { copyLink: '复制链接', systemMode: '跟随系统' },
    element: { rectangle: '矩形', diamond: '菱形', ellipse: '椭圆', arrow: '箭头', line: '线条', freedraw: '手绘', text: '文字', image: '图片', group: '分组', frame: '画框', embeddable: '网页嵌入', selection: '选区', iframe: '内嵌框' },
    hints: {
        dismissSearch: '按 Esc 关闭查找', createFlowchart: '按住 Ctrl 和方向键创建流程图', arrowTool: '点击开始绘制多段线，拖动绘制单条线。再按 {{arrowShortcut}} 切换箭头类型。',
        leaveCropEditor: '点击图片外部，或按 Enter、Esc 结束裁剪',
    },
    helpDialog: { createFlowchart: '从一个元素创建流程图', navigateFlowchart: '在流程图中移动', cropStart: '裁剪图片', cropFinish: '结束裁剪' },
    stats: { shapes: '形状', fullTitle: '画布与形状属性', generalStats: '总体', elementProperties: '形状属性' },
    toast: { elementLinkCopied: '链接已复制' },
    fontList: { sceneFonts: '当前白板使用的字体', availableFonts: '可用字体', empty: '未找到字体', badge: { old: '旧' } },
    quickSearch: { placeholder: '快速查找' },
    commandPalette: { title: '命令面板', shortcuts: { select: '选择', confirm: '确认', close: '关闭' }, recents: '最近使用', search: { placeholder: '查找菜单与命令', noMatch: '没有匹配的命令' }, itemNotAvailable: '该命令当前不可用', shortcutHint: '命令面板：{{shortcut}}' },
};
const merged = (base, extra) => Object.fromEntries([...Object.keys(base), ...Object.keys(extra)].map((key) => [key,
    extra[key] && typeof extra[key] === 'object' ? merged(base[key] && typeof base[key] === 'object' ? base[key] : {}, extra[key]) : extra[key] ?? base[key]]));

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('用法：node scripts/build-excalidraw.mjs <临时工作目录>');
const out = path.join(repo, 'vendor', 'excalidraw');
fs.mkdirSync(work, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const wanted = [`@excalidraw/excalidraw@${EXCALIDRAW}`, `react@${REACT}`, `react-dom@${REACT}`, `esbuild@${ESBUILD}`];
if (!fs.existsSync(path.join(work, 'node_modules', '@excalidraw', 'excalidraw'))) {
    fs.writeFileSync(path.join(work, 'package.json'), '{"private":true}\n');
    execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...wanted], { cwd: work, stdio: 'inherit', shell: true });
}

const entry = path.join(work, 'entry.js');
fs.writeFileSync(entry, `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu, CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, getNonDeletedElements, hashElementsVersion,
    restore, restoreElements, sceneCoordsToViewportCoords, serializeAsJSON, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// 主菜单保留官方的查找、帮助、清空画布与画布背景。明暗跟随文坊的主题；打开和保存使用文坊原有的按钮；登录、协作与外部链接不保留。
export function mount(container, props) {
    const root = createRoot(container);
    const items = MainMenu.DefaultItems;
    root.render(createElement(Excalidraw, props, createElement(MainMenu, null,
        createElement(items.SearchMenu), createElement(items.Help), createElement(items.ClearCanvas),
        createElement(MainMenu.Separator), createElement(items.ChangeCanvasBackground))));
    return () => root.unmount();
}
export { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, getNonDeletedElements, hashElementsVersion,
    restore, restoreElements, sceneCoordsToViewportCoords, serializeAsJSON, viewportCoordsToSceneCoords };
`);

const require = createRequire(path.join(work, 'package.json'));
const esbuild = require('esbuild');
const source = path.join(work, 'node_modules', '@excalidraw', 'excalidraw');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const main = await esbuild.build({
    entryPoints: { excalidraw: entry }, absWorkingDir: work, bundle: true, minify: true, format: 'iife', globalName: 'ScriptoriumExcalidraw',
    target: 'chrome130', conditions: ['production'], outdir: out, legalComments: 'none', logLevel: 'info', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"', 'import.meta.env': '{}' },
    loader: { '.woff2': 'empty', '.ttf': 'empty', '.png': 'empty', '.svg': 'empty' },
    plugins: [{
        name: 'drop-locales',
        setup(build) {
            build.onResolve({ filter: MERMAID }, (args) => ({ path: args.path, namespace: 'scriptorium-mermaid' }));
            build.onLoad({ filter: /.*/, namespace: 'scriptorium-mermaid' }, () => ({ contents: MERMAID_STUB, loader: 'js' }));
            build.onLoad({ filter: /locales[\\/][^\\/]+\.js$/ }, async (args) => {
                const file = args.path.replace(/\\/g, '/');
                if (!KEEP_LOCALES.test(file)) return { contents: 'export default {};', loader: 'js' };
                if (!/\/zh-CN-/.test(file)) return null;
                const pack = (await import(pathToFileURL(args.path).href)).default;
                // 官方按具名导出读取语言包，默认导出一并保留。
                const full = merged(pack, ZH_EXTRA);
                const named = Object.entries(full).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`).join('\n');
                return { contents: `${named}\nexport default ${JSON.stringify(full)};`, loader: 'js' };
            });
        },
    }],
});
const mermaidEntry = path.join(work, 'entry-mermaid.js');
fs.writeFileSync(mermaidEntry, `export { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';\n`);
const mermaid = await esbuild.build({
    entryPoints: { 'excalidraw-mermaid': mermaidEntry }, absWorkingDir: work, bundle: true, minify: true, format: 'iife', globalName: 'ScriptoriumExcalidrawMermaid',
    target: 'chrome130', conditions: ['production'], outdir: out, legalComments: 'none', logLevel: 'info', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"', 'import.meta.env': '{}' },
});
fs.cpSync(path.join(source, 'dist', 'prod', 'fonts'), path.join(out, 'fonts'), { recursive: true });

// 字体：只随附许可明确为 SIL OFL 1.1 或 MIT 的字体。Liberation Sans 1.05（GPLv2 附字体例外）与 Cascadia Code
// （文件内的许可说明与所附 OFL 网址不一致）不随附；二者只用于旧版白板的“Helvetica”“代码”字体，用到时由 Excalidraw 从其 CDN 载入或使用系统字体。
// 官方包中的字体切片未保留许可证元数据，各字体的版权声明与许可证原文写入 fonts/LICENSES.txt。升级时如出现新的字体目录，须先核实许可再登记。
const DROPPED_FONTS = ['Liberation', 'Cascadia'];
const FONTS = [
    ['Excalifont', 'Copyright (c) 2024 Excalidraw', 'SIL OFL 1.1', 'https://plus.excalidraw.com/excalifont'],
    ['Virgil', 'Copyright (c) 2011 Your Own Font Foundry', 'SIL OFL 1.1', 'https://github.com/excalidraw/virgil'],
    ['Xiaolai', 'Copyright 2020-2024 LXGW; Copyright 2014 Nozomi Seto', 'SIL OFL 1.1（原文见下文）', 'https://github.com/lxgw/kose-font'],
    ['Nunito', 'Copyright 2014 The Nunito Project Authors', 'SIL OFL 1.1', 'https://github.com/googlefonts/nunito'],
    ['Lilita', 'Copyright (c) 2011 Juan Montoreano, with Reserved Font Names "Lilita One"', 'SIL OFL 1.1', 'https://fonts.google.com/specimen/Lilita+One'],
    ['Assistant', 'Copyright 2020 The Assistant Project Authors; Copyright 2010 The Source Sans Pro Authors', 'SIL OFL 1.1', 'https://github.com/hafontia/Assistant'],
    ['ComicShanns', 'Copyright (c) 2018 Shannon Miwa 等（见下文）', 'MIT（原文见下文）', '字体文件内的许可声明'],
];
const COMIC_SHANNS_MIT = `MIT License

Copyright (c) 2018 Shannon Miwa
Copyright (c) 2023 Jesus Gonzalez
Copyright (c) 2023 Rodrigo Batista de Moraes
Copyright (c) 2024 Fini Jastrow
Copyright (c) 2024 Kyle Beechly

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
for (const family of DROPPED_FONTS) fs.rmSync(path.join(out, 'fonts', family), { recursive: true, force: true });
const unknownFonts = fs.readdirSync(path.join(out, 'fonts')).filter((name) => !FONTS.some(([family]) => family === name));
if (unknownFonts.length) throw new Error(`未登记许可的字体目录：${unknownFonts.join('、')}。请核实许可后加入 FONTS 或 DROPPED_FONTS。`);
async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`未能获取 ${url}（${response.status}）`);
    return (await response.text()).replace(/\r\n/g, '\n').trim();
}
const oflTemplate = await fetchText('https://openfontlicense.org/documents/OFL.txt');
const ofl = oflTemplate.slice(oflTemplate.indexOf('This Font Software is licensed'));
const xiaolaiOfl = await fetchText('https://raw.githubusercontent.com/lxgw/kose-font/HEAD/OFL.txt');
const line = '-'.repeat(72);
fs.writeFileSync(path.join(out, 'fonts', 'LICENSES.txt'), [
    '文坊白板随附的字体（vendor/excalidraw/fonts）及其许可证。官方包中的字体切片未保留许可证元数据，此处列出各字体的版权声明与许可证原文。',
    '',
    ...FONTS.map(([family, copyright, license, from]) => `${family}\n  版权：${copyright}\n  许可证：${license}\n  来源：${from}`),
    '',
    line,
    'SIL Open Font License 1.1 原文（适用于上表中标为 SIL OFL 1.1 的字体，各字体的版权声明见上表）',
    line,
    ofl,
    '',
    line,
    'Xiaolai：取自 github.com/lxgw/kose-font 的 OFL.txt',
    line,
    xiaolaiOfl,
    '',
    line,
    'Comic Shanns：字体文件内的许可声明',
    line,
    COMIC_SHANNS_MIT,
    '',
].join('\n'));

// 打包时去掉了代码中的版权注释，而 MIT 等许可要求随附原文：从 metafile 找出打入的每个包，将许可证文件汇总为一份。
function packagesIn(...metafiles) {
    const dirs = new Set();
    for (const meta of metafiles) {
        for (const input of Object.keys(meta.inputs)) {
            const parts = input.replace(/\\/g, '/').split('/');
            const at = parts.lastIndexOf('node_modules');
            if (at < 0) continue;
            const name = parts.slice(at + 1, parts[at + 1]?.startsWith('@') ? at + 3 : at + 2);
            dirs.add(path.join(work, ...parts.slice(0, at + 1), ...name));
        }
    }
    return [...dirs].sort();
}
// 包中没有许可证文件的（Radix 各组件、Excalidraw 本身等），从包的 GitHub 仓库获取 LICENSE；同一仓库只获取一次。
const fromRepo = new Map();
function repoLicense(pkg) {
    const url = String(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '');
    const match = /github\.com[/:]([^/]+)\/([^/#.]+)/.exec(url);
    if (!match) return Promise.resolve(null);
    const repoName = `${match[1]}/${match[2]}`;
    if (!fromRepo.has(repoName)) fromRepo.set(repoName, (async () => {
        for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
            const response = await fetch(`https://raw.githubusercontent.com/${repoName}/HEAD/${name}`).catch(() => null);
            if (response?.ok) return { text: (await response.text()).trim(), from: `github.com/${repoName} 的 ${name}` };
        }
        return null;
    })());
    return fromRepo.get(repoName);
}
const unlicensed = [];
const seen = new Set();
const notices = [];
for (const dir of packagesIn(main.metafile, mermaid.metafile)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (seen.has(`${pkg.name}@${pkg.version}`)) continue;
    seen.add(`${pkg.name}@${pkg.version}`);
    const declared = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || '未写明';
    const file = fs.readdirSync(dir).find((name) => /^licen[cs]e([.-][\w.-]*)?$/i.test(name));
    let text = file && fs.readFileSync(path.join(dir, file), 'utf8').trim();
    if (!text) {
        const found = await repoLicense(pkg);
        text = found ? `包中没有许可证文件，以下取自 ${found.from}。\n\n${found.text}` : `包中没有许可证文件，package.json 声明为 ${declared}，仓库：${pkg.repository?.url || pkg.repository || pkg.homepage || '未写明'}。`;
        if (!found) unlicensed.push(`${pkg.name}@${pkg.version}（${declared}）`);
    }
    notices.push(`${pkg.name}@${pkg.version}（${declared}）\n\n${text}`);
}
fs.writeFileSync(path.join(out, 'THIRD-PARTY-LICENSES.txt'),
    `excalidraw.js、excalidraw-mermaid.js、excalidraw.css 中打入了以下 ${notices.length} 个包，此处为各自的许可证原文。\n\n`
    + notices.join(`\n\n${'-'.repeat(72)}\n\n`).replace(/\r\n/g, '\n') + '\n');
fs.writeFileSync(path.join(out, 'README.md'), `# Excalidraw

官方包 @excalidraw/excalidraw ${EXCALIDRAW}、React ${REACT}，由 \`scripts/build-excalidraw.mjs\` 打包为一份，供文坊的白板使用。
只保留中文和英文；Mermaid 转白板单独打包为 \`excalidraw-mermaid.js\`，使用时才载入。
字体位于 \`fonts/\`，页面将 \`EXCALIDRAW_ASSET_PATH\` 指向此处，不从网络加载。请勿手动修改本目录的文件；升级时修改脚本中的版本号并重新打包。

打入的各个包的许可证原文见 \`THIRD-PARTY-LICENSES.txt\`。字体的版权声明与许可证原文见 \`fonts/LICENSES.txt\`（SIL OFL 1.1 或 MIT）；
官方包中的 Liberation Sans 与 Cascadia Code 不随附，用到时由 Excalidraw 从其 CDN 载入或使用系统字体。
`);
if (unlicensed.length) console.log(`没有许可证文件的包：${unlicensed.join('、')}`);
const size = (file) => fs.statSync(path.join(out, file)).size;
console.log(`excalidraw.js ${(size('excalidraw.js') / 1048576).toFixed(2)} MB, excalidraw.css ${(size('excalidraw.css') / 1024).toFixed(0)} KB`);
