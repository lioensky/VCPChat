// 把 Excalidraw 打包进 vendor/excalidraw。
// 这个仓库没有 React，也不加这个依赖：在临时目录装官方包，esbuild 打成一份，文坊打开白板时才载入，和 pdf.js 一样。
// 运行：node scripts/build-excalidraw.mjs <临时工作目录>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXCALIDRAW = '0.18.1';
const REACT = '19.1.1';
const ESBUILD = '0.25.10';
const KEEP_LOCALES = /\/(zh-CN|en)-[^/]*$/; // 其余语言不进包，省约 1.7 MB
// Mermaid 转白板带着整个 mermaid，占了包的一大半。单独打一份，用到时才载入，打开白板不多等。
const MERMAID = /^@excalidraw\/mermaid-to-excalidraw(\/|$)/;
const MERMAID_STUB = `let loading = null;
const load = () => loading ||= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = new URL('excalidraw-mermaid.js', window.EXCALIDRAW_ASSET_PATH).href;
    tag.onload = () => resolve(window.UTTUExcalidrawMermaid);
    tag.onerror = () => { loading = null; reject(new Error('Mermaid 转换没有载入。')); };
    document.head.append(tag);
});
export const parseMermaidToExcalidraw = async (...args) => (await load()).parseMermaidToExcalidraw(...args);`;
// 官方中文包比英文包少 95 条，界面上会冒英文。常用的这里补上，用不到的（协作、用户列表）不管。
const ZH_EXTRA = {
    labels: {
        changeStroke: '改描边色', changeBackground: '改背景色', more_options: '更多选项', arrowtypes: '箭头类型', arrowtype_sharp: '直线箭头', arrowtype_round: '曲线箭头',
        arrowtype_elbowed: '折线箭头', arrowhead_crowfoot_many: '鸦爪（多）', arrowhead_crowfoot_one: '鸦爪（一）', arrowhead_crowfoot_one_or_many: '鸦爪（一或多）',
        clearCanvas: '清空画布', toggleGrid: '网格', showFonts: '选择字体', theme: '主题', link: { hint: '输入或粘贴链接', goToElement: '跳到目标元素' }, lineEditor: { editArrow: '编辑箭头' },
        zoomToFitViewport: '缩放到窗口', zoomToFitSelection: '缩放到选中内容', zoomToFit: '缩放到全部内容', autoResize: '文字自动调整大小', imageCropping: '裁剪图片',
        unCroppedDimension: '裁剪前尺寸', copyElementLink: '复制对象链接', linkToElement: '链接到对象', wrapSelectionInFrame: '用画框包住选中内容',
    },
    elementLink: { title: '链接到对象', desc: '在画布上点一个形状，或者粘贴链接。', notFound: '画布上找不到链接的对象。' },
    search: { title: '在画布上查找', noMatch: '没有找到', singleResult: '条结果', multipleResults: '条结果', placeholder: '查找画布上的文字' },
    buttons: { copyLink: '复制链接', systemMode: '跟随系统' },
    element: { rectangle: '矩形', diamond: '菱形', ellipse: '椭圆', arrow: '箭头', line: '线条', freedraw: '手绘', text: '文字', image: '图片', group: '分组', frame: '画框', embeddable: '网页嵌入', selection: '选区', iframe: '内嵌框' },
    hints: {
        dismissSearch: '按 Esc 关闭查找', createFlowchart: '按住 Ctrl 和方向键建流程图', arrowTool: '点击开始画多段线，拖动画单条线。再按 {{arrowShortcut}} 换箭头类型。',
        leaveCropEditor: '点图片外面，或按 Enter、Esc 结束裁剪',
    },
    helpDialog: { createFlowchart: '从一个元素建流程图', navigateFlowchart: '在流程图里移动', cropStart: '裁剪图片', cropFinish: '结束裁剪' },
    stats: { shapes: '形状', fullTitle: '画布和形状属性', generalStats: '总体', elementProperties: '形状属性' },
    toast: { elementLinkCopied: '链接已复制' },
    fontList: { sceneFonts: '这块白板用到的', availableFonts: '可用字体', empty: '没有找到字体', badge: { old: '旧' } },
    quickSearch: { placeholder: '快速查找' },
    commandPalette: { title: '命令面板', shortcuts: { select: '选择', confirm: '确认', close: '关闭' }, recents: '最近用过', search: { placeholder: '查找菜单和命令', noMatch: '没有匹配的命令' }, itemNotAvailable: '这条命令现在不能用', shortcutHint: '命令面板：{{shortcut}}' },
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

// 主菜单留官方的查找、帮助、清空、明暗、画布背景。打开和保存在文坊的文件菜单里，登录、协作和外部链接不要。
export function mount(container, props) {
    const root = createRoot(container);
    const items = MainMenu.DefaultItems;
    root.render(createElement(Excalidraw, props, createElement(MainMenu, null,
        createElement(items.SearchMenu), createElement(items.Help), createElement(items.ClearCanvas),
        createElement(MainMenu.Separator), createElement(items.ToggleTheme), createElement(items.ChangeCanvasBackground))));
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
    entryPoints: { excalidraw: entry }, absWorkingDir: work, bundle: true, minify: true, format: 'iife', globalName: 'UTTUExcalidraw',
    target: 'chrome130', conditions: ['production'], outdir: out, legalComments: 'none', logLevel: 'info', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"', 'import.meta.env': '{}' },
    loader: { '.woff2': 'empty', '.ttf': 'empty', '.png': 'empty', '.svg': 'empty' },
    plugins: [{
        name: 'drop-locales',
        setup(build) {
            build.onResolve({ filter: MERMAID }, (args) => ({ path: args.path, namespace: 'uttu-mermaid' }));
            build.onLoad({ filter: /.*/, namespace: 'uttu-mermaid' }, () => ({ contents: MERMAID_STUB, loader: 'js' }));
            build.onLoad({ filter: /locales[\\/][^\\/]+\.js$/ }, async (args) => {
                const file = args.path.replace(/\\/g, '/');
                if (!KEEP_LOCALES.test(file)) return { contents: 'export default {};', loader: 'js' };
                if (!/\/zh-CN-/.test(file)) return null;
                const pack = (await import(pathToFileURL(args.path).href)).default;
                // 官方按具名导出读语言包，默认导出也留着。
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
    entryPoints: { 'excalidraw-mermaid': mermaidEntry }, absWorkingDir: work, bundle: true, minify: true, format: 'iife', globalName: 'UTTUExcalidrawMermaid',
    target: 'chrome130', conditions: ['production'], outdir: out, legalComments: 'none', logLevel: 'info', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"', 'import.meta.env': '{}' },
});
fs.cpSync(path.join(source, 'dist', 'prod', 'fonts'), path.join(out, 'fonts'), { recursive: true });

// 打包时去掉了代码里的版权注释，MIT 这类许可要求随附原文：从 metafile 找出打进去的每个包，许可证文件汇成一份。
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
// 包里没带许可证文件的（Radix 各组件、Excalidraw 自己等），到包的 GitHub 仓库取 LICENSE；同一个仓库只取一次。
const fromRepo = new Map();
function repoLicense(pkg) {
    const url = String(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '');
    const match = /github\.com[/:]([^/]+)\/([^/#.]+)/.exec(url);
    if (!match) return Promise.resolve(null);
    const repo = `${match[1]}/${match[2]}`;
    if (!fromRepo.has(repo)) fromRepo.set(repo, (async () => {
        for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
            const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`).catch(() => null);
            if (response?.ok) return { text: (await response.text()).trim(), from: `github.com/${repo} 的 ${name}` };
        }
        return null;
    })());
    return fromRepo.get(repo);
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
        text = found ? `包里没有许可证文件，下面取自 ${found.from}。\n\n${found.text}` : `包里没有许可证文件，package.json 写的是 ${declared}，仓库：${pkg.repository?.url || pkg.repository || pkg.homepage || '未写明'}。`;
        if (!found) unlicensed.push(`${pkg.name}@${pkg.version}（${declared}）`);
    }
    notices.push(`${pkg.name}@${pkg.version}（${declared}）\n\n${text}`);
}
fs.writeFileSync(path.join(out, 'THIRD-PARTY-LICENSES.txt'),
    `excalidraw.js、excalidraw-mermaid.js、excalidraw.css 里打进了下面 ${notices.length} 个包，这里是各自的许可证原文。\n\n`
    + notices.join(`\n\n${'-'.repeat(72)}\n\n`).replace(/\r\n/g, '\n') + '\n');
fs.writeFileSync(path.join(out, 'README.md'), `# Excalidraw

官方包 @excalidraw/excalidraw ${EXCALIDRAW}，React ${REACT}，由 \`scripts/build-excalidraw.mjs\` 打成一份。只留中文和英文；
Mermaid 转白板单独打成 \`excalidraw-mermaid.js\`，用到时才载入。
字体在 \`fonts/\`，页面设 \`EXCALIDRAW_ASSET_PATH\` 指到这里，不走网络。不要手改这里的文件，要升级改脚本里的版本号重新打包。

打进去的各个包的许可证原文在 \`THIRD-PARTY-LICENSES.txt\`。字体的许可在各自字体文件的元数据里，都是开源字体（SIL OFL 或 MIT）。
`);
if (unlicensed.length) console.log(`没有许可证文件的包：${unlicensed.join('、')}`);
const size = (file) => fs.statSync(path.join(out, file)).size;
console.log(`excalidraw.js ${(size('excalidraw.js') / 1048576).toFixed(2)} MB, excalidraw.css ${(size('excalidraw.css') / 1024).toFixed(0)} KB`);
