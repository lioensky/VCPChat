import { mountButton } from '../primitives/button.js';
import { mountField } from '../primitives/field.js';
import { mountInput } from '../primitives/input.js';
import { mountMenu } from '../primitives/menu.js';
import { mountAgentPresetSeat } from '../primitives/agent-preset-seat.js';
import { mountAgentPresetRow } from '../primitives/agent-preset-row.js';
import { mountLanguageRow } from '../primitives/language-row.js';
import { mountModal } from '../primitives/modal.js';
import { mountTooltip } from '../primitives/tooltip.js';
import { mountHoverCard } from '../primitives/hover-card.js';
import { mountDisclosureRow } from '../primitives/disclosure-row.js';
import { mountStateDot } from '../primitives/state-dot.js';
import { mountToast } from '../primitives/toast.js';
import { mountRiskConfirmation } from '../primitives/risk-confirmation.js';
import { mountSemanticIcon } from '../primitives/semantic-icon.js';
import { mountSelect } from '../primitives/select.js';
import { createPopupSelectController, mountPopupSelectView } from '../primitives/popup-select.js';
import { mountDirectoryBrowser } from '../primitives/directory-browser.js';
import { mountPill } from '../primitives/pill.js';
import { mountConnectionBanner } from '../primitives/connection-banner.js';
import { mountOnboardingSurface } from '../primitives/onboarding-surface.js';
import { mountAgentModelPicker } from '../primitives/agent-model-picker.js';
const STYLE_ID = 'vcp-harness-primitive-lab';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-primitive-lab{display:grid;gap:20px}.vcp-harness-lab-group{display:grid;gap:10px}.vcp-harness-lab-group>h4{margin:0;font-size:13px;line-height:20px;font-weight:600}.vcp-harness-lab-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.vcp-harness-lab-field{width:min(360px,100%)}.vcp-harness-lab-input-host{display:inline-flex}.vcp-harness-lab-provenance{margin:0;color:var(--dsw-alias-label-tertiary,var(--vcp-color-text-muted,#737780));font-size:12px;line-height:18px}`;
    (document.head || document.documentElement).append(style);
}
function group(root, title, provenance) {
    const host = document.createElement('section');
    host.className = 'vcp-harness-lab-group';
    const heading = document.createElement('h4');
    heading.textContent = title;
    const source = document.createElement('p');
    source.className = 'vcp-harness-lab-provenance';
    source.textContent = provenance;
    const row = document.createElement('div');
    row.className = 'vcp-harness-lab-row';
    host.append(heading, source, row);
    root.append(host);
    return row;
}
/** Candidate-only fixture host. It owns presentation state and no business state. */
export function mountPrimitiveLab(root, scope) {
    if (!root || !scope)
        throw new TypeError('Primitive lab requires root and scope.');
    ensureStyles();
    const labScope = scope.child('harness-primitive-lab');
    const originalNodes = Array.from(root.childNodes);
    const lab = document.createElement('div');
    lab.className = 'vcp-harness-primitive-lab vcp-ui-scope';
    lab.dataset.maturity = 'candidate';
    root.replaceChildren(lab);
    const buttonRow = group(lab, 'Button', 'deepseek-harness/packages/client/ui-primitives/src/Button.tsx');
    const variants = [
        ['Primary', { variant: 'primary' }],
        ['Ghost', { variant: 'ghost' }],
        ['Outline', { variant: 'outline' }],
        ['Toolbar', { variant: 'toolbar' }],
        ['Compact', { variant: 'ghost', size: 'sm' }],
        ['Disabled', { variant: 'primary', disabled: true }],
    ];
    variants.forEach(([label, props]) => {
        const button = document.createElement('button');
        button.textContent = label;
        buttonRow.append(button);
        mountButton(button, props, labScope);
    });
    const pillRow = group(lab, 'Pill', 'deepseek-harness/packages/client/ui-primitives/src/Pill.tsx');
    for (const [label, active] of [['Static', false], ['Interactive', false], ['Active', true]]) {
        const pill = document.createElement(label === 'Interactive' ? 'button' : 'span');
        pill.textContent = label;
        pillRow.append(pill);
        mountPill(pill, { active, interactive: label === 'Interactive', onClick: label === 'Interactive' ? () => { pill.dataset.clicked = 'true'; } : undefined }, labScope);
    }
    const connectionRow = group(lab, 'ConnectionBanner', 'deepseek-harness/packages/client/ui-primitives/src/ConnectionBanner.tsx');
    const connectionHost = document.createElement('div');
    connectionRow.append(connectionHost);
    mountConnectionBanner(connectionHost, { reconnecting: true }, labScope);
    const onboardingRow = group(lab, 'OnboardingSurface', 'deepseek-harness/packages/client/ui-primitives/src/OnboardingSurface.tsx');
    const onboardingContent = document.createElement('div');
    onboardingContent.textContent = 'Onboarding content';
    onboardingRow.append(onboardingContent);
    mountOnboardingSurface({ content: onboardingContent, appRoot: null, open: false }, labScope);
    const inputRow = group(lab, 'Input', 'deepseek-harness/packages/client/ui-primitives/src/Input.tsx');
    const inputHost = document.createElement('span');
    inputHost.className = 'vcp-harness-lab-input-host';
    const input = document.createElement('input');
    input.placeholder = 'Search';
    inputHost.append(input);
    inputRow.append(inputHost);
    const searchIcon = document.createElement('span');
    searchIcon.className = 'vcp-ui-icon';
    searchIcon.textContent = 'search';
    mountInput(input, { icon: searchIcon }, labScope);
    const fieldRow = group(lab, 'Field', 'deepseek-harness/packages/client/ui-settings-plugins ValueField production contract');
    const field = document.createElement('div');
    field.className = 'vcp-harness-lab-field';
    const fieldInput = document.createElement('input');
    field.append(fieldInput);
    fieldRow.append(field);
    mountField(field, { label: 'Workspace name', description: 'Shown in the workspace switcher.', control: fieldInput }, labScope);
    const selectRow = group(lab, 'Select / Menu', 'deepseek-harness AgentPresetSeat + ui-primitives/Menu production contracts');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Agent preset');
    ['Standard mode', 'Minimal mode', 'Planning mode'].forEach(label => {
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        select.append(option);
    });
    selectRow.append(select);
    mountSelect(select, { label: 'Agent preset', portal: true }, labScope);
    const menuRow = group(lab, 'Menu atom', 'deepseek-harness/packages/client/ui-primitives/src/Menu.tsx + WorkspaceBrowser production consumer');
    const menuTrigger = document.createElement('button');
    menuTrigger.type = 'button';
    menuTrigger.textContent = 'View options';
    menuRow.append(menuTrigger);
    const menu = mountMenu(menuTrigger, {
        portal: true,
        dense: true,
        selectedIds: ['workspace', 'updated'],
        items: [
            { type: 'label', id: 'group-label', text: 'Group by' },
            { id: 'workspace', label: 'Workspace' },
            { id: 'flat', label: 'Flat list' },
            { type: 'separator', id: 'order-separator' },
            { type: 'label', id: 'order-label', text: 'Order by' },
            { id: 'manual', label: 'Manual' },
            { id: 'updated', label: 'Recently updated' },
            { id: 'disabled', label: 'Unavailable', disabled: true },
            { id: 'danger', label: 'Remove view', danger: true },
            { id: 'layout', label: 'Layout', submenu: [{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }] },
        ],
        footer: [{ id: 'settings', label: 'View settings' }],
        onSelect: id => {
            menuTrigger.dataset.selected = id;
            menu.setOpen(false);
        },
    }, labScope);
    labScope.listen(menuTrigger, 'click', () => menu.setOpen(!menu.open));
    // Harness provenance: ui-agent-preset/src/client/AgentPresetSeat.tsx renders
    // the hero chip on the new-session screen (chat-side seat consumer). VCP has
    // no legal production consumer for it yet (assistantAgent is legacy-owned;
    // chat assistant switching is frozen), so this composite stays a Candidate
    // fixture, not a Stable or public business API. The disabled-seat color
    // token `--dsw-alias-label-quaternary` is undefined upstream in Harness
    // ui-theme; the primitive keeps that variable name so a future harness-side
    // definition applies verbatim.
    const seatRow = group(lab, 'Agent Preset seat', 'deepseek-harness/packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx + chat new-session hero consumer; Candidate only, no VCP production consumer');
    const seatTrigger = document.createElement('button');
    seatTrigger.type = 'button';
    seatRow.append(seatTrigger);
    let seat;
    const seatOptions = [
        { id: 'standard', name: 'Standard mode', description: 'Full coding agent with file editing, shell and search.' },
        { id: 'code', name: 'Code mode', description: 'Standard capabilities through the Code Mode SDK.' },
        { id: 'minimal', name: 'Minimal mode', description: 'Two-tool coding agent.' },
    ];
    seat = mountAgentPresetSeat(seatTrigger, {
        options: seatOptions,
        selectedId: 'standard',
        onSelect: id => {
            seat.setSelected(id);
            seat.setBusy(true);
            setTimeout(() => seat.setBusy(false), 600);
        },
        onClose: () => { seatTrigger.dataset.closed = 'true'; },
    }, labScope);
    // Harness chip owns its own click toggle (AgentPresetSeat.tsx); the lab
    // reproduces it through the controller because the Candidate does not bind
    // onClick by itself.
    labScope.listen(seatTrigger, 'click', () => seat.setOpen(!seat.open));
    const busyToggle = document.createElement('button');
    busyToggle.type = 'button';
    busyToggle.textContent = 'Toggle busy';
    seatRow.append(busyToggle);
    mountButton(busyToggle, { variant: 'ghost', size: 'sm' }, labScope);
    labScope.listen(busyToggle, 'click', () => seat.setBusy(!seat.button.disabled));
    const errorToggle = document.createElement('button');
    errorToggle.type = 'button';
    errorToggle.textContent = 'Set error';
    seatRow.append(errorToggle);
    mountButton(errorToggle, { variant: 'ghost', size: 'sm' }, labScope);
    let seatHasError = false;
    labScope.listen(errorToggle, 'click', () => {
        seatHasError = !seatHasError;
        seat.setError(seatHasError ? 'Could not stage the preset. Try again.' : null);
    });
    // Harness provenance: ui-agent-preset/src/client/AgentPresetRow.tsx +
    // PresetMenu.tsx render the settings preference row. VCP has no legal
    // production consumer yet (production Settings field adoption is thread B's
    // R2-02E ledger), so this composite stays a Candidate fixture. The picker
    // appends `· <userTrust>` to locally authored presets, matching
    // PresetMenu's trust==='user' label rule.
    const presetRowHost = document.createElement('div');
    const presetRowGroup = group(lab, 'Agent Preset row', 'deepseek-harness/packages/client/ui-agent-preset/src/client/AgentPresetRow.tsx; Candidate only, no VCP production consumer');
    presetRowGroup.append(presetRowHost);
    let presetRow;
    const presetRowOptions = [
        { id: 'standard', name: 'Standard mode', trust: 'system' },
        { id: 'custom-1', name: 'Research draft', description: 'Locally authored preset.', trust: 'user' },
        { id: 'minimal', name: 'Minimal mode', trust: 'system' },
    ];
    presetRow = mountAgentPresetRow(presetRowHost, {
        options: presetRowOptions,
        currentValue: 'standard',
        onSelect: id => {
            presetRow.setCurrent(id);
            presetRow.setBusy(true);
            setTimeout(() => presetRow.setBusy(false), 600);
        },
        onClose: () => { presetRow.trigger.dataset.closed = 'true'; },
    }, labScope);
    const rowErrorToggle = document.createElement('button');
    rowErrorToggle.type = 'button';
    rowErrorToggle.textContent = 'Set row error';
    presetRowGroup.append(rowErrorToggle);
    mountButton(rowErrorToggle, { variant: 'ghost', size: 'sm' }, labScope);
    let presetRowHasError = false;
    labScope.listen(rowErrorToggle, 'click', () => {
        presetRowHasError = !presetRowHasError;
        presetRow.setError(presetRowHasError ? 'Could not load presets. Try again.' : null);
    });
    // Harness locale/LanguageRow is a real General-settings composite. VCP
    // currently has no UI-locale capability or persisted setting, so the Lab
    // projection owns only its temporary selection and is never a consumer.
    const languageRowGroup = group(lab, 'Language row', 'deepseek-harness/packages/client/locale/src/client/LanguageRow.tsx; Candidate only, no VCP locale capability or production consumer');
    const languageRowHost = document.createElement('div');
    languageRowHost.className = 'vcp-harness-lab-field';
    languageRowGroup.append(languageRowHost);
    const languageRow = mountLanguageRow(languageRowHost, {
        activeId: 'en',
        options: [
            { id: 'en', label: 'English' },
            { id: 'zh-CN', label: 'Simplified Chinese' },
            { id: 'ja', label: 'Japanese' },
        ],
        onSelect: id => { languageRow.setActive(id); languageRowHost.dataset.selected = id; },
        onClose: () => { languageRowHost.dataset.menuClosed = 'true'; },
    }, labScope);
    // Harness provenance: ui-commands PopupSelectView is normally owned by the
    // conversation.input.overlay slot. That slot and the composer are frozen
    // in VCP, so this is a standalone Lab-only host: its deps are local DOM
    // callbacks, not an input-machine, IPC, command or token-consumption path.
    const popupRow = group(lab, 'Command PopupSelect', 'deepseek-harness/packages/client/ui-commands/src/client/PopupSelectView.tsx; Candidate Lab only, no VCP Composer or command wiring');
    const popupHost = document.createElement('div');
    popupHost.className = 'vcp-harness-lab-popup-host';
    const popupTrigger = document.createElement('button');
    popupTrigger.type = 'button';
    popupTrigger.textContent = 'Open model command';
    popupHost.append(popupTrigger);
    popupRow.append(popupHost);
    mountButton(popupTrigger, { variant: 'outline', size: 'sm' }, labScope);
    const popup = createPopupSelectController({
        options: async () => [
            { id: 'balanced', label: 'Balanced', detail: 'General-purpose model', active: true },
            { id: 'careful', label: 'Careful', detail: 'Requires acknowledgement', confirmation: { title: 'Switch model?', description: 'This Lab action has no product side effect.', acknowledgeLabel: 'I understand.', cancelLabel: 'Cancel', confirmLabel: 'Switch' } },
        ],
        onSelect: option => { popupTrigger.dataset.selected = option.id; },
    }, {
        consume: () => true,
        focusComposer: () => popupTrigger.focus(),
    });
    mountPopupSelectView(popupHost, { popup }, labScope);
    labScope.listen(popupTrigger, 'click', () => popup.open('model', {}, { via: 'enter', token: '/model' }));
    const modelPickerRow = group(lab, 'Agent Model Picker', 'deepseek-harness/packages/client/ui-model-selection/ModelSelect.tsx; Candidate Lab only, injected capability');
    const modelPickerHost = document.createElement('div');
    modelPickerHost.dataset.harnessCandidate = 'agent-model-picker';
    modelPickerRow.append(modelPickerHost);
    const modelPicker = mountAgentModelPicker(modelPickerHost, {
        label: 'Agent model',
        selectedId: 'gpt-4o',
        selectedEffort: 'balanced',
        efforts: [
            { id: 'balanced', label: 'Balanced', description: 'Provider default' },
            { id: 'deep', label: 'Deep reasoning', description: 'More reasoning effort' },
        ],
        options: async (signal) => {
            if (signal.aborted)
                return [];
            return [
                { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', favorite: true },
                { id: 'claude-3-7', label: 'Claude 3.7 Sonnet', provider: 'Anthropic' },
                { id: 'local-llama', label: 'Llama 3.3', provider: 'Local', disabled: true },
            ];
        },
        onSelect: option => { modelPicker.trigger.dataset.selected = option.id; },
    }, labScope);
    mountButton(modelPicker.trigger, { variant: 'outline', size: 'sm' }, labScope);
    // Harness provenance: ui-directory-picker-browse DirectoryBrowser. The
    // Candidate owns only presentation state; this Lab supplies an in-memory
    // fixture tree, never VCP filesystem IPC, persisted Workspace paths or
    // workspace adoption.
    const directoryRow = group(lab, 'Directory Browser', 'deepseek-harness/packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx; Candidate Lab only, injected in-memory tree');
    const directoryTrigger = document.createElement('button');
    directoryTrigger.type = 'button';
    directoryTrigger.textContent = 'Browse fixture folder';
    directoryRow.append(directoryTrigger);
    mountButton(directoryTrigger, { variant: 'outline', size: 'sm' }, labScope);
    const listing = new Map([
        ['/home', { path: '/home', crumbs: [{ name: 'Home', path: '/home' }], entries: [{ name: 'projects', path: '/home/projects' }, { name: 'archive', path: '/home/archive' }, { name: '.secrets', path: '/home/.secrets', hidden: true }] }],
        ['/home/projects', { path: '/home/projects', crumbs: [{ name: 'Home', path: '/home' }, { name: 'projects', path: '/home/projects' }], entries: [{ name: 'vcpchat', path: '/home/projects/vcpchat' }, { name: 'harness', path: '/home/projects/harness' }] }],
        ['/home/archive', { path: '/home/archive', crumbs: [{ name: 'Home', path: '/home' }, { name: 'archive', path: '/home/archive' }], entries: [] }],
    ]);
    let directory;
    directory = mountDirectoryBrowser({
        listDirectory: async (path) => listing.get(path ?? '/home') ?? { path: path ?? '/home', entries: [] },
        createDirectory: async (parent, name) => `${parent}/${name}`,
        onOpen: path => { directoryTrigger.dataset.path = path; directory.setOpen(false); },
        onClose: () => directory.setOpen(false),
    }, labScope);
    labScope.listen(directoryTrigger, 'click', () => directory.setOpen(true));
    const modalRow = group(lab, 'Modal', 'deepseek-harness/packages/client/ui-primitives/src/Modal.tsx + Workspace/Settings production consumers');
    const modalTrigger = document.createElement('button');
    modalTrigger.type = 'button';
    modalTrigger.textContent = 'Open modal';
    modalRow.append(modalTrigger);
    mountButton(modalTrigger, { variant: 'outline', size: 'sm' }, labScope);
    const modalBody = document.createElement('div');
    modalBody.textContent = 'Create a workspace without leaving the current page.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = 'Create';
    mountButton(cancel, { variant: 'outline', size: 'sm' }, labScope);
    mountButton(create, { variant: 'primary', size: 'sm' }, labScope);
    const modal = mountModal({
        title: 'Create workspace',
        closeLabel: 'Close dialog',
        description: 'Choose a name and location for the workspace.',
        body: modalBody,
        footer: [cancel, create],
        onClose: () => modal.setOpen(false),
    }, labScope);
    labScope.listen(modalTrigger, 'click', () => modal.setOpen(true));
    labScope.listen(cancel, 'click', () => modal.setOpen(false));
    labScope.listen(create, 'click', () => { modalTrigger.dataset.result = 'create'; modal.setOpen(false); });
    const headlessTrigger = document.createElement('button');
    headlessTrigger.type = 'button';
    headlessTrigger.textContent = 'Open headless';
    modalRow.append(headlessTrigger);
    mountButton(headlessTrigger, { variant: 'ghost', size: 'sm' }, labScope);
    const headlessBody = document.createElement('div');
    headlessBody.className = 'vcp-harness-lab-headless-modal';
    const headlessTitle = document.createElement('h2');
    headlessTitle.textContent = 'Custom modal frame';
    const headlessClose = document.createElement('button');
    headlessClose.type = 'button';
    headlessClose.textContent = 'Close';
    mountButton(headlessClose, { variant: 'outline', size: 'sm' }, labScope);
    headlessBody.append(headlessTitle, headlessClose);
    const headless = mountModal({ title: 'Custom modal frame', body: headlessBody, headless: true, onClose: () => headless.setOpen(false) }, labScope);
    labScope.listen(headlessTrigger, 'click', () => headless.setOpen(true));
    labScope.listen(headlessClose, 'click', () => headless.setOpen(false));
    const tooltipRow = group(lab, 'Tooltip / HoverCard', 'deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx + HoverCard.tsx; Goal/Sidebar/Workspace consumers');
    const tooltipButton = document.createElement('button');
    tooltipButton.type = 'button';
    tooltipButton.textContent = 'Hover for details';
    tooltipRow.append(tooltipButton);
    mountButton(tooltipButton, { variant: 'toolbar', size: 'sm' }, labScope);
    mountTooltip(tooltipButton, { label: 'Open workspace details', side: 'bottom', delayMs: 120 }, labScope);
    const hoverAnchor = document.createElement('div');
    hoverAnchor.className = 'vcp-harness-lab-hover-anchor';
    hoverAnchor.textContent = 'Workspace path';
    tooltipRow.append(hoverAnchor);
    const hoverContent = document.createElement('div');
    hoverContent.className = 'vcp-harness-lab-hover-content';
    hoverContent.textContent = '/Users/asahi/Documents/Codex/VCPChat-newarchitecture';
    mountHoverCard(hoverAnchor, {
        content: hoverContent,
        openDelayMs: 120,
        copyText: '/Users/asahi/Documents/Codex/VCPChat-newarchitecture',
        copyLabel: 'Copy path',
        copiedLabel: 'Copied',
    }, labScope);
    const disclosureRow = group(lab, 'DisclosureRow', 'deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.tsx + ToolRow/WorkflowRun production consumers');
    const disclosureHost = document.createElement('div');
    disclosureHost.className = 'vcp-harness-lab-disclosure-host';
    disclosureRow.append(disclosureHost);
    const disclosureIcon = document.createElement('span');
    disclosureIcon.className = 'vcp-ui-icon';
    disclosureIcon.textContent = 'terminal';
    const disclosureSummary = document.createElement('span');
    disclosureSummary.className = 'vcp-harness-lab-disclosure-summary';
    disclosureSummary.textContent = ' · npm run check:uiux';
    const disclosureBody = document.createElement('div');
    disclosureBody.className = 'vcp-harness-lab-disclosure-body';
    disclosureBody.textContent = 'UIUX contract verification completed successfully.';
    let disclosure;
    disclosure = mountDisclosureRow(disclosureHost, {
        icon: disclosureIcon,
        title: 'Terminal',
        open: false,
        expandable: true,
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        collapsedContent: disclosureSummary,
        children: disclosureBody,
        onToggle: () => disclosure.setOpen(!disclosure.open),
    }, labScope);
    const stateDotRow = group(lab, 'StateDot', 'deepseek-harness/packages/client/ui-primitives/src/StateDot.tsx + Jobs/Workflow/Workspace production consumers');
    ['done', 'warning', 'ongoing', 'error'].forEach(state => {
        const fixture = document.createElement('span');
        fixture.className = 'vcp-harness-lab-state-dot-fixture';
        fixture.dataset.state = state;
        const dotHost = document.createElement('span');
        const label = document.createElement('span');
        label.textContent = state;
        fixture.append(dotHost, label);
        stateDotRow.append(fixture);
        mountStateDot(dotHost, { state }, labScope);
    });
    const toastRow = group(lab, 'Toast', 'deepseek-harness/packages/client/ui-primitives/src/Toast.tsx + InputBar/ModelSelect production consumers');
    const toastAnchor = document.createElement('div');
    toastAnchor.className = 'vcp-harness-lab-toast-anchor';
    const toastTrigger = document.createElement('button');
    toastTrigger.type = 'button';
    toastTrigger.textContent = 'Show toast';
    toastAnchor.append(toastTrigger);
    toastRow.append(toastAnchor);
    mountButton(toastTrigger, { variant: 'outline', size: 'sm' }, labScope);
    let activeToast = null;
    labScope.listen(toastTrigger, 'click', () => {
        void activeToast?.dispose();
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.textContent = 'warning';
        let toast;
        toast = mountToast({
            text: 'The selected model is temporarily unavailable.',
            icon,
            anchor: toastAnchor,
            onDone: () => {
                if (activeToast !== toast)
                    return;
                void toast.dispose();
                activeToast = null;
            },
        }, labScope);
        activeToast = toast;
    });
    const riskRow = group(lab, 'RiskConfirmation', 'deepseek-harness/packages/client/ui-primitives/src/RiskConfirmation.tsx + Permission/Command production consumers; Candidate only, no VCP business command');
    const riskTrigger = document.createElement('button');
    riskTrigger.type = 'button';
    riskTrigger.textContent = 'Open risk confirmation';
    riskRow.append(riskTrigger);
    mountButton(riskTrigger, { variant: 'outline', size: 'sm' }, labScope);
    let risk;
    risk = mountRiskConfirmation({
        title: 'Allow external command?',
        description: 'This action may access files outside the current workspace.',
        acknowledgeLabel: 'I understand the risk.',
        cancelLabel: 'Cancel',
        confirmLabel: 'Allow command',
        acknowledged: false,
        onAcknowledgedChange: value => risk.setAcknowledged(value),
        onCancel: () => risk.setOpen(false),
        onConfirm: () => risk.setOpen(false),
    }, labScope);
    labScope.listen(riskTrigger, 'click', () => { risk.setAcknowledged(false); risk.setDisabled(false); risk.setOpen(true); });
    const iconRow = group(lab, 'Semantic icon slots', 'deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx; delegates to existing VCP Lucide adapter, private Candidate contract');
    ['warning', 'close', 'check', 'chevron-down'].forEach(name => {
        const fixture = document.createElement('span');
        fixture.className = 'vcp-harness-lab-icon-fixture';
        fixture.dataset.icon = name;
        const iconHost = document.createElement('span');
        const label = document.createElement('span');
        label.textContent = name;
        fixture.append(iconHost, label);
        iconRow.append(fixture);
        mountSemanticIcon(iconHost, { name, size: name === 'warning' ? 18 : 16 }, labScope);
    });
    return scope.own(async () => {
        await labScope.dispose('primitive-lab-unmounted');
        root.replaceChildren(...originalNodes);
    }, 'harness-primitive-lab', 'ui-surface');
}
