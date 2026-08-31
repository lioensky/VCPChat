import { mountButton } from './button.js';
import { mountModal } from './modal.js';
const STYLE_ID = 'vcp-harness-uiux-risk-confirmation';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-risk-confirmation{width:min(440px,100%);max-height:calc(100vh - 48px);overflow:hidden}.vcp-harness-risk-confirmation-content{min-height:0;overflow-y:auto;overscroll-behavior:contain}.vcp-harness-risk-warning{display:flex;align-items:flex-start;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}.vcp-harness-risk-warning>p{margin:0}.vcp-harness-risk-warning-icon{display:grid;place-items:center;flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary)}.vcp-harness-risk-acknowledgement{display:flex;align-items:flex-start;gap:10px;margin-top:20px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer}.vcp-harness-risk-acknowledgement>input{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-button-primary-fill);cursor:pointer}.vcp-harness-risk-acknowledgement>input:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:2px}.vcp-harness-risk-acknowledgement>input:disabled{cursor:default}.vcp-harness-risk-modal-action{min-width:72px}.vcp-harness-risk-confirm-action{min-width:136px}@supports(height:100dvh){.vcp-harness-risk-confirmation{max-height:calc(100dvh - 48px)}}`;
    (document.head || document.documentElement).append(style);
}
/** Candidate-only controlled acknowledgement gate; it owns no VCP business command or durable state. */
export function mountRiskConfirmation(props, scope) {
    if (!props?.title || !props.description || !props.acknowledgeLabel || !props.cancelLabel || !props.confirmLabel || !scope) {
        throw new TypeError('RiskConfirmation requires labels, description, callbacks and scope.');
    }
    ensureStyles();
    const riskScope = scope.child('harness-risk-confirmation');
    const body = document.createElement('div');
    const warning = document.createElement('div');
    warning.className = 'vcp-harness-risk-warning';
    const icon = document.createElement('span');
    icon.className = 'vcp-harness-risk-warning-icon vcp-ui-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'warning';
    const description = document.createElement('p');
    description.textContent = props.description;
    warning.append(icon, description);
    const acknowledgement = document.createElement('label');
    acknowledgement.className = 'vcp-harness-risk-acknowledgement';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const label = document.createElement('span');
    label.textContent = props.acknowledgeLabel;
    acknowledgement.append(checkbox, label);
    body.append(warning, acknowledgement);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'vcp-harness-risk-modal-action';
    cancel.textContent = props.cancelLabel;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'vcp-harness-risk-confirm-action';
    confirm.textContent = props.confirmLabel;
    mountButton(cancel, { variant: 'outline' }, riskScope);
    mountButton(confirm, { variant: 'primary' }, riskScope);
    let acknowledged = props.acknowledged;
    let disabled = props.disabled ?? false;
    const sync = () => { checkbox.checked = acknowledged; checkbox.disabled = disabled; confirm.disabled = disabled || !acknowledged; };
    let controller;
    const modal = mountModal({
        title: props.title,
        className: 'vcp-harness-risk-confirmation',
        contentClassName: 'vcp-harness-risk-confirmation-content',
        body,
        footer: [cancel, confirm],
        open: props.open,
        onClose: () => props.onCancel(),
    }, riskScope);
    const setOpen = (open) => {
        modal.setOpen(open);
        if (open && !disabled)
            checkbox.focus();
    };
    const setAcknowledged = (value) => { acknowledged = value; sync(); };
    const setDisabled = (value) => { disabled = value; sync(); };
    riskScope.listen(checkbox, 'change', () => props.onAcknowledgedChange(checkbox.checked));
    riskScope.listen(cancel, 'click', () => props.onCancel());
    riskScope.listen(confirm, 'click', () => { if (!confirm.disabled)
        props.onConfirm(); });
    sync();
    controller = { modal, acknowledgement: checkbox, confirmButton: confirm, get open() { return modal.open; }, setOpen, setAcknowledged, setDisabled, dispose: async () => { await riskScope.dispose('harness-risk-confirmation-unmounted'); } };
    if (props.open && !disabled)
        checkbox.focus();
    return controller;
}
