import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const json = url => new Promise((resolve, reject) => {
    http.get(url, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
});
const freePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
};

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-sidebar-parity-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'classic',
    enableDistributedServer: false,
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'sidebar-parity-key',
}), 'utf8');
const port = await freePort();
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
let browser;
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12000); });

try {
    console.log('[INFO] Starting Electron sidebar parity probe');
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        try { await json(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => {
            try { return candidate.url().includes('main.html'); } catch { return false; }
        });
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `main renderer did not appear: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: 90000 });
    console.log('[INFO] Renderer ready');

    const agent = await page.evaluate(async () => {
        const result = await window.chatAPI.createAgent(`SidebarParityAgent_${Date.now()}`, { model: 'parity-model' });
        return result;
    });
    assert.equal(agent.success, true, `temporary agent creation failed: ${JSON.stringify(agent)}`);
    console.log('[INFO] Temporary Agent created');
    const agentId = agent.agentId;
    const group = await page.evaluate(async ({ agentId }) => {
        const created = await window.chatAPI.createAgentGroup(`SidebarParityGroup_${Date.now()}`);
        if (!created?.success) return created;
        const config = await window.chatAPI.getAgentGroupConfig(created.agentGroup.id);
        const saved = await window.chatAPI.saveAgentGroupConfig(created.agentGroup.id, {
            ...config,
            members: [agentId],
            mode: 'sequential',
            modeSettings: { ...(config.modeSettings || {}), sequential: { speakerOrder: [agentId] } },
            sequentialSpeakerOrder: [agentId],
        });
        return { ...created, saved };
    }, { agentId });
    assert.equal(group.success, true, `temporary group creation failed: ${JSON.stringify(group)}`);
    console.log('[INFO] Temporary Group created');
    const groupId = group.agentGroup.id;

    await withTimeout(page.evaluate(async ({ agentId }) => {
        const config = await window.chatAPI.getAgentConfig(agentId);
        const { chatManager } = await import('./modules/chatManager.js');
        await chatManager.selectItem(agentId, 'agent', config?.name || agentId, config?.avatarUrl || null, config);
        window.uiManager?.switchToTab?.('settings');
    }, { agentId }), 30000, 'Agent settings selection');
    const collapsedSummary = await page.evaluate(() => {
        const summary = document.querySelector('#identitySummary');
        const avatar = summary?.querySelector('.agent-settings-summary-avatar');
        const label = summary?.querySelector('.agent-settings-summary-label');
        const identity = document.querySelector('#agentSettingsForm .agent-settings-section[data-section-key="identity"]');
        return {
            isCollapsed: identity?.classList.contains('collapsed'),
            hasSummaryClass: summary?.classList.contains('summary-with-avatar'),
            summaryVisible: summary ? summary.offsetWidth > 0 && summary.offsetHeight > 0 : false,
            summaryAvatarWidth: avatar ? avatar.offsetWidth : 0,
            summaryLabel: label ? label.textContent.trim() : '',
        };
    });
    console.log('[INFO] Agent collapsed identity summary:', collapsedSummary);
    assert.equal(collapsedSummary.isCollapsed, true, 'Agent identity section must be collapsed on first open in 3ca4f032');
    assert.equal(collapsedSummary.hasSummaryClass, true, 'Collapsed identity summary must have summary-with-avatar class');
    assert.equal(collapsedSummary.summaryVisible, true, 'Collapsed identity summary box must be visible');
    assert.equal(collapsedSummary.summaryAvatarWidth, 30, 'Collapsed identity summary avatar must be 30px');
    assert.ok(collapsedSummary.summaryLabel.length > 0, 'Collapsed identity summary label must be populated');
    console.log('[PASS] Agent collapsed identity box verified');

    console.log('[INFO] Expanding Agent identity section by clicking toggle');
    await page.click(':is(#identityToggleBtn, #agentSettingsForm [data-section-key="identity"] .agent-settings-toggle-btn, #identityToggleHeader)');
    await sleep(350);

    const agentGeometry = await page.evaluate(() => {
        const get = selector => document.querySelector(selector);
        const style = selector => {
            const node = get(selector);
            if (!node) return null;
            const computed = getComputedStyle(node);
            return {
                width: computed.width,
                height: computed.height,
                borderRadius: computed.borderRadius,
                fontSize: computed.fontSize,
                fontWeight: computed.fontWeight,
                paddingRight: computed.paddingRight,
                opacity: computed.opacity,
                transition: computed.transition,
            };
        };
        const identity = get('#agentSettingsForm .agent-settings-section[data-section-key="identity"]');
        const avatar = get('#agentAvatarPreview');
        const wrapper = get('#agentAvatarPreview')?.closest('.agent-avatar-wrapper');
        const overlay = get('#agentAvatarPreview')?.closest('.agent-avatar-wrapper')?.querySelector('.avatar-upload-overlay');
        const identityCard = get('#agentSettingsForm .agent-identity-container');
        const nameNode = get('#agentNameInput');
        const nameControl = nameNode?.closest('.vcp-uiux-input-wrap') || nameNode;
        const nameCtrlStyle = nameControl ? getComputedStyle(nameControl) : null;
        const nameInputStyle = nameNode ? getComputedStyle(nameNode) : null;
        const modelNode = get('#agentModel');
        const modelControl = modelNode?.closest('.vcp-uiux-input-wrap') || modelNode;
        return {
            identityOpen: !identity?.classList.contains('collapsed'),
            identityCard: identityCard ? {
                borderRadius: getComputedStyle(identityCard).borderRadius,
            } : null,
            avatar: style('#agentAvatarPreview'),
            wrapper: style('#agentAvatarPreview')?.width ? style('#agentAvatarPreview') : null,
            wrapperComputed: wrapper ? { width: getComputedStyle(wrapper).width, height: getComputedStyle(wrapper).height } : null,
            name: {
                height: nameCtrlStyle?.height,
                borderRadius: nameCtrlStyle?.borderRadius,
                fontSize: nameInputStyle?.fontSize,
                fontWeight: nameInputStyle?.fontWeight,
            },
            nameHasInlineImportant: nameNode?.style.getPropertyValue('height') === '36px' || nameControl?.style.getPropertyPriority('height') === 'important',
            collapseIconText: document.querySelector('.style-collapse-icon')?.textContent.trim() || '',
            model: {
                paddingRight: modelNode ? getComputedStyle(modelNode).paddingRight : null,
            },
            overlay: overlay ? { opacity: getComputedStyle(overlay).opacity, transition: getComputedStyle(overlay).transition } : null,
            mimoDirector: Boolean(document.querySelector('.tts-director-settings')),
            streamSelector: Boolean(document.querySelector('.agent-stream-mode-selector, .agent-stream-mode-group, #agentStreamOutputTrue')),
            tooltipBadgeCount: document.querySelectorAll('.vcp-settings-info-badge').length,
        };
    });
    console.log('[INFO] Agent expanded geometry sampled');
    assert.equal(agentGeometry.identityOpen, true, 'Agent identity section expands after click');
    assert.ok(['0px', '12px', '14px'].includes(agentGeometry.identityCard?.borderRadius), `Identity container border radius was ${agentGeometry.identityCard?.borderRadius}`);
    assert.equal(agentGeometry.avatar.width, '30px');
    assert.equal(agentGeometry.avatar.height, '30px');
    assert.ok(['15px', '50%'].includes(agentGeometry.avatar.borderRadius), `Avatar borderRadius was ${agentGeometry.avatar.borderRadius}`);
    assert.equal(agentGeometry.wrapperComputed.width, '30px');
    assert.equal(agentGeometry.wrapperComputed.height, '30px');
    assert.equal(agentGeometry.name.height, '30px');
    assert.equal(agentGeometry.name.borderRadius, '8px');
    assert.equal(agentGeometry.name.fontSize, '13.5px');
    assert.equal(agentGeometry.name.fontWeight, '600');
    assert.equal(agentGeometry.nameHasInlineImportant, false, 'agentNameInput height must NOT be forced via inline !important');
    assert.equal(agentGeometry.collapseIconText, '', 'Accordion icon must be pure CSS pseudo-element without text');
    assert.ok(['32px', '36px'].includes(agentGeometry.model.paddingRight), `agentModel paddingRight was ${agentGeometry.model.paddingRight}`);
    assert.equal(agentGeometry.mimoDirector, true, 'MiMo director settings must be present');
    assert.equal(agentGeometry.streamSelector, true, 'Stream mode selector must be present');
    assert.ok(agentGeometry.tooltipBadgeCount >= 3, `Expected at least 3 tooltip badges, found ${agentGeometry.tooltipBadgeCount}`);
    assert.equal(agentGeometry.overlay.opacity, '0');
    assert.match(agentGeometry.overlay.transition, /opacity/);
    console.log('[INFO] Hovering Agent avatar wrapper');
    await page.hover('#agentSettingsForm .agent-avatar-wrapper');
    await sleep(350);
    await withTimeout(page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#agentAvatarPreview')?.closest('.agent-avatar-wrapper')?.querySelector('.avatar-upload-overlay')).opacity) >= 0.99), 5000, 'Agent avatar hover overlay');
    console.log('[PASS] Agent identity geometry, components, and avatar hover overlay');

    console.log('[INFO] Testing focus state on Agent name input');
    await page.focus('#agentNameInput');
    const nameFocusBorder = await page.evaluate(() => {
        const input = document.querySelector('#agentNameInput');
        return input ? getComputedStyle(input).borderColor : null;
    });
    assert.ok(nameFocusBorder && nameFocusBorder !== 'rgba(0, 0, 0, 0)', 'Focus border must appear on agentNameInput focus');
    console.log('[PASS] Agent name input focus state active');

    console.log('[INFO] Testing style collapse accordion interaction and DisclosureRow geometry');
    const collapseContainer = '#agentSettingsForm .agent-style-collapsible-container';
    const isInitiallyCollapsed = await page.evaluate(sel => document.querySelector(sel)?.classList.contains('collapsed'), collapseContainer);
    assert.equal(isInitiallyCollapsed, true, 'Style collapse container is initially collapsed');

    const headerMetrics = await page.evaluate(() => {
        const header = document.querySelector('#agentSettingsForm #styleCollapseHeader');
        const icon = header?.querySelector('.style-collapse-icon');
        const title = header?.querySelector('.style-collapse-title');
        const hRect = header?.getBoundingClientRect();
        const iRect = icon?.getBoundingClientRect();
        const tRect = title?.getBoundingClientRect();
        const bg = header ? getComputedStyle(header).backgroundColor : null;
        return {
            height: hRect ? Math.round(hRect.height) : 0,
            iconLeft: iRect ? Math.round(iRect.left) : 0,
            titleLeft: tRect ? Math.round(tRect.left) : 0,
            bg,
            isDisclosurePrimitive: header?.classList.contains('vcp-uiux-disclosure-row'),
            ariaExpanded: header?.getAttribute('aria-expanded'),
        };
    });
    assert.equal(headerMetrics.height, 24, 'Style collapse header height must be strictly 24px');
    assert.ok(headerMetrics.iconLeft < headerMetrics.titleLeft, 'Leading chevron must be positioned to the left of the title');
    assert.equal(headerMetrics.isDisclosurePrimitive, true, 'Style collapse header must carry vcp-uiux-disclosure-row primitive class');
    assert.equal(headerMetrics.ariaExpanded, 'false', 'Style collapse header must have aria-expanded="false" when collapsed');

    const cardHandle = await page.$('#agentSettingsForm .agent-identity-container');
    if (cardHandle) {
        await cardHandle.screenshot({ path: '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828/scratch/style_disclosure_collapsed.png' });
    }

    await page.click('#agentSettingsForm #styleCollapseHeader');
    await page.waitForFunction(sel => !document.querySelector(sel)?.classList.contains('collapsed'), { timeout: 5000 }, collapseContainer);
    console.log('[PASS] Accordion successfully expanded upon user click');

    const expandedAria = await page.evaluate(() => document.querySelector('#agentSettingsForm #styleCollapseHeader')?.getAttribute('aria-expanded'));
    assert.equal(expandedAria, 'true', 'Style collapse header must have aria-expanded="true" when expanded');

    await sleep(300);
    if (cardHandle) {
        await cardHandle.screenshot({ path: '/Users/asahi/.gemini/antigravity/brain/007afa13-0e99-4fcb-aab1-e20c01db4828/scratch/style_disclosure_expanded.png' });
    }

    await page.click('#agentSettingsForm #styleCollapseHeader');
    await page.waitForFunction(sel => document.querySelector(sel)?.classList.contains('collapsed'), { timeout: 5000 }, collapseContainer);
    console.log('[PASS] Accordion successfully re-collapsed upon second user click');

    console.log('[INFO] Checking form action buttons visibility');
    const formActionsState = await page.evaluate(() => {
        const submit = document.querySelector('#agentSettingsForm .form-actions button[type="submit"]');
        const del = document.querySelector('#deleteAgentBtn');
        return {
            submitVisible: submit && !submit.hidden && getComputedStyle(submit).display !== 'none',
            deleteVisible: del && !del.hidden && getComputedStyle(del).display !== 'none',
        };
    });
    assert.equal(formActionsState.submitVisible, true, 'Save agent button must be visible in form-actions');
    assert.equal(formActionsState.deleteVisible, true, 'Delete agent button must be visible in form-actions');
    console.log('[PASS] Form action buttons are visible and not hidden');

    console.log('[INFO] Testing Regex Section accordion, rule rendering and action buttons');
    const regexCollapsedInitial = await page.evaluate(() => {
        const section = document.querySelector('#agentSettingsForm .agent-settings-section[data-section-key="regex"]');
        const summary = document.getElementById('regexSummary');
        return {
            isCollapsed: section?.classList.contains('collapsed'),
            summaryVisible: summary ? getComputedStyle(summary).display !== 'none' : false,
        };
    });
    assert.equal(regexCollapsedInitial.isCollapsed, true, 'Regex section must be initially collapsed');
    assert.equal(regexCollapsedInitial.summaryVisible, true, 'Regex summary must be visible when collapsed');

    console.log('[INFO] Expanding Regex section');
    await page.click(':is(#regexToggleBtn, #agentSettingsForm [data-section-key="regex"] .agent-settings-toggle-btn, #regexToggleHeader)');
    await sleep(350);

    const regexExpandedMetrics = await page.evaluate(() => {
        const section = document.querySelector('#agentSettingsForm .agent-settings-section[data-section-key="regex"]');
        const summary = document.getElementById('regexSummary');
        const actions = section?.querySelector('.strip-regex-actions');
        const addBtn = actions?.querySelector('.btn-add-regex:not(.btn-add-regex-secondary)');
        const importBtn = actions?.querySelector('.btn-add-regex-secondary');
        const aRect = addBtn?.getBoundingClientRect();
        const iRect = importBtn?.getBoundingClientRect();
        return {
            isOpen: !section?.classList.contains('collapsed'),
            summaryHidden: summary ? getComputedStyle(summary).display === 'none' : true,
            hasActions: !!actions,
            addHeight: aRect ? Math.round(aRect.height) : 0,
            importHeight: iRect ? Math.round(iRect.height) : 0,
            sameRow: aRect && iRect ? Math.abs(aRect.top - iRect.top) <= 2 : false,
            equalWidth: aRect && iRect ? Math.abs(aRect.width - iRect.width) <= 2 : false,
        };
    });
    assert.equal(regexExpandedMetrics.isOpen, true, 'Regex section must be expanded');
    assert.equal(regexExpandedMetrics.summaryHidden, true, 'Regex summary must be hidden when expanded');
    assert.equal(regexExpandedMetrics.hasActions, true, 'Actions container must exist');
    assert.equal(regexExpandedMetrics.addHeight, 32, 'Add button height must be 32px');
    assert.equal(regexExpandedMetrics.sameRow, true, 'Add and import buttons must sit side by side in the same row');
    assert.equal(regexExpandedMetrics.equalWidth, true, 'Add and import buttons must have equal widths');
    console.log('[PASS] Regex section expanded state, hidden summary, and twin button layout verified');

    console.log('[INFO] Testing rule insertion and ghost button dimensions');
    const ruleMetrics = await page.evaluate(() => {
        const list = document.getElementById('stripRegexListContainer');
        if (!list) return null;
        const row = document.createElement('div');
        row.className = 'strip-regex-row';
        const title = document.createElement('span');
        title.className = 'strip-regex-title';
        title.textContent = '测试正则规则';
        const btns = document.createElement('div');
        btns.className = 'strip-regex-row-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-edit-regex';
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-delete-regex';
        btns.append(editBtn, delBtn);
        row.append(title, btns);
        list.appendChild(row);

        const rRect = row.getBoundingClientRect();
        const eRect = editBtn.getBoundingClientRect();
        const dRect = delBtn.getBoundingClientRect();
        const eBg = getComputedStyle(editBtn).backgroundColor;
        const dBg = getComputedStyle(delBtn).backgroundColor;
        return {
            rowHeight: Math.round(rRect.height),
            editSize: { width: Math.round(eRect.width), height: Math.round(eRect.height) },
            delSize: { width: Math.round(dRect.width), height: Math.round(dRect.height) },
            editBg: eBg,
            delBg: dBg,
        };
    });
    assert.ok(ruleMetrics.rowHeight <= 38, `Rule row height must be compact (<=38px), got ${ruleMetrics.rowHeight}px`);
    assert.deepEqual(ruleMetrics.editSize, { width: 28, height: 28 }, 'Edit button must be 28x28px');
    assert.deepEqual(ruleMetrics.delSize, { width: 28, height: 28 }, 'Delete button must be 28x28px');
    assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(ruleMetrics.editBg), 'Edit button default background must be transparent');
    assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(ruleMetrics.delBg), 'Delete button default background must be transparent');
    console.log('[PASS] Rule item compact card and 28x28 ghost buttons verified');

    console.log('[INFO] Testing Dark Theme agent styling');
    await page.evaluate(() => document.body.setAttribute('data-vcp-theme', 'dark'));
    const darkGeometry = await page.evaluate(() => {
        const input = document.querySelector('#agentNameInput');
        const target = input?.closest('.vcp-uiux-input-wrap') || input;
        const style = target ? getComputedStyle(target) : null;
        return {
            height: style?.height,
            borderRadius: style?.borderRadius,
        };
    });
    assert.equal(darkGeometry.height, '30px');
    assert.equal(darkGeometry.borderRadius, '8px');
    await page.evaluate(() => document.body.setAttribute('data-vcp-theme', 'light'));
    console.log('[PASS] Dark theme styling preserves 30px/8px geometry');

    await withTimeout(page.evaluate(async groupId => {
        const config = await window.chatAPI.getAgentGroupConfig(groupId);
        const { chatManager } = await import('./modules/chatManager.js');
        await chatManager.selectItem(groupId, 'group', config?.name || groupId, null, config);
        window.uiManager?.switchToTab?.('settings');
        await window.GroupRenderer.displayGroupSettingsPage(groupId);
    }, groupId), 30000, 'Group settings display');
    const groupSummary = await page.evaluate(() => {
        const summary = document.getElementById('groupIdentitySummary');
        const avatar = summary?.querySelector('.group-settings-summary-avatar');
        const label = summary?.querySelector('.group-settings-summary-label');
        const identity = document.querySelector('#groupSettingsForm .group-settings-section[data-section-key="identity"]');
        return {
            isCollapsed: identity?.classList.contains('collapsed'),
            hasSummaryClass: summary?.classList.contains('summary-with-avatar'),
            summaryVisible: summary ? summary.offsetWidth > 0 && summary.offsetHeight > 0 : false,
            summaryAvatarWidth: avatar ? avatar.offsetWidth : 0,
            summaryLabel: label ? label.textContent.trim() : '',
        };
    });
    console.log('[INFO] Group collapsed identity summary:', groupSummary);
    assert.equal(groupSummary.isCollapsed, true, 'Group identity section must be collapsed on first open');
    assert.equal(groupSummary.hasSummaryClass, true, 'Collapsed group identity summary must have summary-with-avatar class');
    assert.equal(groupSummary.summaryVisible, true, 'Collapsed group identity summary box must be visible');
    assert.equal(groupSummary.summaryAvatarWidth, 30, 'Collapsed group identity summary avatar must be 30px');
    console.log('[PASS] Group collapsed identity box verified');

    console.log('[INFO] Expanding Group identity section by clicking toggle');
    await page.click(':is(#groupIdentityToggleBtn, #groupSettingsForm [data-section-key="identity"] .group-settings-toggle-btn, #groupIdentityToggleHeader)');
    await sleep(350);

    const groupGeometry = await page.evaluate(() => {
        const identity = document.querySelector('#groupSettingsForm .group-settings-section[data-section-key="identity"]');
        const avatar = document.getElementById('groupAvatarPreview');
        const name = document.getElementById('groupNameInput');
        const item = document.querySelector('#sequentialSpeakerOrderList .sequential-speaker-order-item');
        const handle = item?.querySelector('.sequential-speaker-drag-handle');
        const css = node => node ? getComputedStyle(node) : null;
        return {
            identityOpen: !identity?.classList.contains('collapsed'),
            avatar: css(avatar) && { width: css(avatar).width, height: css(avatar).height, borderRadius: css(avatar).borderRadius },
            name: css(name) && { height: css(name).height, borderRadius: css(name).borderRadius, fontSize: css(name).fontSize, fontWeight: css(name).fontWeight },
            item: css(item)?.cursor || '',
            handle: css(handle)?.cursor || '',
            draggable: item?.draggable === true,
        };
    });
    console.log('[INFO] Group expanded geometry sampled');
    assert.equal(groupGeometry.identityOpen, true, 'Group identity section expands after click');
    assert.equal(groupGeometry.avatar.width, '30px');
    assert.equal(groupGeometry.avatar.height, '30px');
    assert.ok(['15px', '50%'].includes(groupGeometry.avatar.borderRadius), `Group avatar borderRadius was ${groupGeometry.avatar.borderRadius}`);
    assert.deepEqual(groupGeometry.name, { height: '30px', borderRadius: '8px', fontSize: '13.5px', fontWeight: '600' });
    assert.equal(groupGeometry.item, 'grab');
    assert.equal(groupGeometry.handle, 'grab');
    assert.equal(groupGeometry.draggable, true);
    console.log('[PASS] Group identity geometry and sequential drag affordance');

    console.log('[INFO] Re-collapsing Group identity section by clicking toggle');
    await page.click(':is(#groupIdentityToggleBtn, #groupSettingsForm [data-section-key="identity"] .group-settings-toggle-btn, #groupIdentityToggleHeader)');
    await sleep(350);
    const groupReCollapsed = await page.evaluate(() => {
        const summary = document.getElementById('groupIdentitySummary');
        const identity = document.querySelector('#groupSettingsForm .group-settings-section[data-section-key="identity"]');
        return {
            isCollapsed: identity?.classList.contains('collapsed'),
            summaryVisible: summary ? summary.offsetWidth > 0 && summary.offsetHeight > 0 : false,
        };
    });
    assert.equal(groupReCollapsed.isCollapsed, true, 'Group identity section re-collapses cleanly');
    assert.equal(groupReCollapsed.summaryVisible, true, 'Group identity summary box re-appears cleanly upon re-collapse');
    console.log('[PASS] Group identity toggle expand and re-collapse verified');
} finally {
    if (browser) browser.disconnect();
    child.kill('SIGTERM');
}

console.log('Settings sidebar parity Electron gate passed.');
process.exit(0);
