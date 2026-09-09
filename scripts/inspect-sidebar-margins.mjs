// scripts/inspect-sidebar-margins.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('..', import.meta.url));
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = url => new Promise((resolve, reject) => {
    http.get(url, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
});

const freePort = async () => {
    const s = net.createServer();
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise(r => s.close(r));
    return p;
};

async function main() {
    const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-margin-probe-'));
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
        uiMode: 'classic',
        enableDistributedServer: false,
        vcpServerUrl: 'http://127.0.0.1:1',
        vcpApiKey: 'margin-key',
    }), 'utf8');

    const port = await freePort();
    const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
        cwd: root,
        env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    try {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            try { await json(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); }
        }
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
        let page;
        while (Date.now() < deadline) {
            page = (await browser.pages()).find(p => {
                try { return p.url().includes('main.html'); } catch { return false; }
            });
            if (page) break;
            await sleep(100);
        }
        await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: 45000 });

        // Create temporary agent & select it
        const agent = await page.evaluate(async () => {
            return await window.chatAPI.createAgent('MarginAgent', { model: 'test' });
        });
        const agentId = agent.agentId;

        await page.evaluate(async ({ agentId }) => {
            const config = await window.chatAPI.getAgentConfig(agentId);
            const { chatManager } = await import('./modules/chatManager.js');
            await chatManager.selectItem(agentId, 'agent', config?.name || agentId, null, config);
        }, { agentId });

        const metrics = await page.evaluate(async () => {
            const sidebar = document.querySelector('aside.sidebar');
            const sidebarRect = sidebar.getBoundingClientRect();
            const sidebarStyle = getComputedStyle(sidebar);

            // 1. Switch to Topics tab
            window.uiManager?.switchToTab?.('topics');
            await new Promise(r => setTimeout(r, 200));

            const topicTools = document.querySelector('.next-ui-topic-tools');
            const createTopicBtn = document.getElementById('nextUiCreateTopicBtn');
            const topicToolsRect = topicTools?.getBoundingClientRect();
            const createTopicBtnRect = createTopicBtn?.getBoundingClientRect();
            const topicToolsStyle = topicTools ? getComputedStyle(topicTools) : null;
            const createTopicBtnStyle = createTopicBtn ? getComputedStyle(createTopicBtn) : null;

            // 2. Switch to Settings tab
            window.uiManager?.switchToTab?.('settings');
            await new Promise(r => setTimeout(r, 200));

            const settingsTab = document.getElementById('tabContentSettings');
            const settingsTabRect = settingsTab?.getBoundingClientRect();
            const settingsTabStyle = getComputedStyle(settingsTab);

            const identitySection = document.querySelector('#agentSettingsForm .agent-settings-section[data-section-key="identity"]');
            const identityHeader = identitySection?.querySelector('.agent-settings-section-header');
            const identityHeaderRect = identityHeader?.getBoundingClientRect();

            // Expand identity section
            if (identitySection?.classList.contains('collapsed')) {
                identitySection.classList.remove('collapsed');
                await new Promise(r => setTimeout(r, 200));
            }

            const identityCard = document.querySelector('#agentSettingsForm .agent-identity-container');
            const identityCardRect = identityCard?.getBoundingClientRect();
            const identityCardStyle = identityCard ? getComputedStyle(identityCard) : null;

            const nameInput = document.getElementById('agentNameInput');
            const nameInputRect = nameInput?.getBoundingClientRect();

            return {
                sidebar: {
                    left: sidebarRect.left,
                    right: sidebarRect.right,
                    width: sidebarRect.width,
                    paddingLeft: sidebarStyle.paddingLeft,
                    paddingRight: sidebarStyle.paddingRight,
                },
                topics: {
                    tools: topicToolsRect ? {
                        left: topicToolsRect.left,
                        right: topicToolsRect.right,
                        width: topicToolsRect.width,
                        offsetFromSidebarLeft: topicToolsRect.left - sidebarRect.left,
                        offsetFromSidebarRight: sidebarRect.right - topicToolsRect.right,
                        marginLeft: topicToolsStyle?.marginLeft,
                        marginRight: topicToolsStyle?.marginRight,
                    } : null,
                    createTopicBtn: createTopicBtnRect ? {
                        left: createTopicBtnRect.left,
                        right: createTopicBtnRect.right,
                        width: createTopicBtnRect.width,
                        offsetFromSidebarLeft: createTopicBtnRect.left - sidebarRect.left,
                        offsetFromSidebarRight: sidebarRect.right - createTopicBtnRect.right,
                        paddingLeft: createTopicBtnStyle?.paddingLeft,
                        paddingRight: createTopicBtnStyle?.paddingRight,
                    } : null,
                },
                settings: {
                    tab: {
                        left: settingsTabRect.left,
                        right: settingsTabRect.right,
                        width: settingsTabRect.width,
                        offsetFromSidebarLeft: settingsTabRect.left - sidebarRect.left,
                        offsetFromSidebarRight: sidebarRect.right - settingsTabRect.right,
                        paddingLeft: settingsTabStyle.paddingLeft,
                        paddingRight: settingsTabStyle.paddingRight,
                        marginLeft: settingsTabStyle.marginLeft,
                        marginRight: settingsTabStyle.marginRight,
                    },
                    header: identityHeaderRect ? {
                        left: identityHeaderRect.left,
                        right: identityHeaderRect.right,
                        width: identityHeaderRect.width,
                        offsetFromSidebarLeft: identityHeaderRect.left - sidebarRect.left,
                        offsetFromSidebarRight: sidebarRect.right - identityHeaderRect.right,
                    } : null,
                    identityCard: identityCardRect ? {
                        left: identityCardRect.left,
                        right: identityCardRect.right,
                        width: identityCardRect.width,
                        offsetFromSidebarLeft: identityCardRect.left - sidebarRect.left,
                        offsetFromSidebarRight: sidebarRect.right - identityCardRect.right,
                        marginLeft: identityCardStyle?.marginLeft,
                        marginRight: identityCardStyle?.marginRight,
                        paddingLeft: identityCardStyle?.paddingLeft,
                        paddingRight: identityCardStyle?.paddingRight,
                    } : null,
                    nameInput: nameInputRect ? {
                        left: nameInputRect.left,
                        right: nameInputRect.right,
                        width: nameInputRect.width,
                        offsetFromSidebarLeft: nameInputRect.left - sidebarRect.left,
                        offsetFromSidebarRight: sidebarRect.right - nameInputRect.right,
                    } : null,
                },
            };
        });

        console.log('--- SIDEBAR MARGIN METRICS ---');
        console.log(JSON.stringify(metrics, null, 2));

        await browser.disconnect();
    } finally {
        child.kill('SIGTERM');
    }
}

main().catch(console.error);
