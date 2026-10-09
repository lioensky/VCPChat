import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const css = fs.readFileSync(new URL('../Promptmodules/prompt-modules.css', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../Promptmodules/modular-prompt-module.js', import.meta.url), 'utf8');

test('prompt blocks contain multiline content in narrow/wide layouts and inline editing', { timeout: 45000 }, async t => {
    const browser = await puppeteer.launch({ headless: true, timeout: 15000, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setContent('<style>body { margin: 0; font-family: sans-serif; } .fixture { margin: 20px; }</style><div class="fixture modular-prompt-container"><div class="blocks-container"></div></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
        const module = new window.ModularPromptModule({});
        module.save = () => {};
        const blocks = [
            { id: 'short', type: 'text', content: '{{AgentVictionque}}' },
            { id: 'newline', type: 'newline' },
            { id: 'long', type: 'text', content: '[[ContextFoldingV2.0]]\n打开Vchat浏览器 (LoomApp)，打开后你会自动获得浏览器控制权限。请在必要的时候使用工具。\ntool_name: LoomController\nurl: https://www.bing.com/search?q=' + 'long_query_'.repeat(35) },
            { id: 'next', type: 'text', content: '{{VCPTavern::dailychat}}' },
            { id: 'named', type: 'text', name: '命名积木', content: '编辑正文\n'.repeat(15), variants: ['编辑正文\n'.repeat(15), '另一条正文'] },
        ];
        module.blocks = blocks;
        module.blocksContainer = document.querySelector('.blocks-container');
        module.renderBlocks();
        window.layoutModule = module;
    });
    async function check(width, column, editing) {
        await page.evaluate(({ width, column }) => {
            document.querySelector('.fixture').style.width = `${width}px`;
            document.querySelector('.blocks-container').classList.toggle('no-tile-mode', column);
        }, { width, column });
        const violations = await page.evaluate(() => {
            const container = document.querySelector('.blocks-container');
            const outer = container.getBoundingClientRect();
            return [...container.querySelectorAll('.prompt-block')].flatMap(block => {
                const box = block.getBoundingClientRect();
                const content = block.querySelector('.block-content');
                const errors = [];
                if (box.left < outer.left - 1 || box.right > outer.right + 1) errors.push(`${block.dataset.id}: block outside container`);
                if (content) {
                    const rect = content.getBoundingClientRect();
                    if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1) errors.push(`${block.dataset.id}: text outside block vertically`);
                    if (rect.left < box.left - 1 || rect.right > box.right + 1 || content.scrollWidth > content.clientWidth + 1) errors.push(`${block.dataset.id}: text outside block horizontally`);
                }
                return errors;
            });
        });
        assert.deepEqual(violations, [], `width=${width}, column=${column}, editing=${editing}`);
    }
    for (const width of [220, 260, 420, 720]) {
        for (const column of [false, true]) await check(width, column, false);
    }
    await page.setViewport({ width: 480, height: 900 });
    await check(260, false, false);
    await page.setViewport({ width: 1280, height: 900 });
    await page.$eval('[data-id="named"] .block-content', el => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    assert.equal(await page.$eval('[data-id="named"] .block-content', el => el.contentEditable), 'true');
    for (const width of [220, 260, 720]) await check(width, false, true);
    await page.$eval('[data-id="named"] .block-content', el => el.blur());
    assert.equal(await page.$eval('[data-id="named"] .block-content', el => el.textContent), '命名积木');
    assert.equal(await page.evaluate(() => window.layoutModule.blocks[4].variants[0]), '编辑正文\n'.repeat(15));
});