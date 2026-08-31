import { createDomRenderer } from '../runtime/dom-renderer.js';
const STYLE_ID = 'vcp-harness-uiux-field';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Matches the captured Harness ValueField output, including its current
    // invalid-control browser-default anomaly rather than normalizing it away.
    style.textContent = `.vcp-harness-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;font-size:14px;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-field-head{display:flex;align-items:center;gap:8px}.vcp-harness-field-label{display:block;flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-field-input{box-sizing:content-box;width:calc(100% - 26px);height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-field-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#1677ff)}.vcp-harness-field-description,.vcp-harness-field-error{margin:0;font-size:12px;line-height:1.5}.vcp-harness-field-description{color:var(--dsw-alias-label-tertiary,#81858c)}.vcp-harness-field-error{color:var(--dsw-alias-label-error,#0f1115)}.vcp-harness-field-input-invalid{box-sizing:content-box;width:calc(100% - 8px);height:16px;padding:1px 2px;border:2px solid #000;border-radius:0;background:#fff;font-size:13.3333px;font-weight:400;line-height:normal;color:#000}`;
    (document.head || document.documentElement).append(style);
}
/** Harness Field contract rendered in Light DOM; no business state or IPC. */
export function mountField(root, props, scope) {
    if (!root || !props?.control || !scope)
        throw new TypeError('Field requires root, control and scope.');
    ensureStyles();
    const fieldId = props.control.id || `vcp-field-${Math.random().toString(36).slice(2)}`;
    const originalId = props.control.getAttribute('id');
    const originalDescribedBy = props.control.getAttribute('aria-describedby');
    const originalInvalid = props.control.getAttribute('aria-invalid');
    const originalControlClass = props.control.getAttribute('class');
    props.control.id = fieldId;
    const existingLabel = root.tagName === 'LABEL' ? root : null;
    const label = existingLabel || document.createElement('label');
    if (!existingLabel) {
        label.className = 'vcp-harness-field-label';
        label.id = `${fieldId}-label`;
        label.textContent = props.label;
        label.htmlFor = fieldId;
        root.prepend(label);
    }
    else {
        existingLabel.dataset.vcpFieldLabel = props.label;
        existingLabel.classList.add('vcp-harness-field-label');
        existingLabel.htmlFor = fieldId;
    }
    const head = document.createElement('div');
    head.className = 'vcp-harness-field-head';
    if (!existingLabel) {
        root.insertBefore(head, label);
        head.append(label);
    }
    else
        head.remove();
    props.control.classList.add('vcp-harness-field-input');
    const description = props.description ? document.createElement('p') : null;
    if (description) {
        description.className = 'vcp-harness-field-description';
        description.textContent = props.description ?? '';
    }
    const error = props.error ? document.createElement('p') : null;
    if (error) {
        error.className = 'vcp-harness-field-error';
        error.textContent = props.error ?? '';
        props.control.classList.replace('vcp-harness-field-input', 'vcp-harness-field-input-invalid');
        props.control.setAttribute('aria-invalid', 'true');
    }
    root.classList.add('vcp-harness-field');
    const renderer = createDomRenderer(scope);
    if (description)
        renderer.mount(root, description);
    if (error)
        renderer.mount(root, error);
    return scope.own(() => {
        head.remove();
        if (!existingLabel)
            label.remove();
        else {
            delete existingLabel.dataset.vcpFieldLabel;
            existingLabel.classList.remove('vcp-harness-field-label');
        }
        description?.remove();
        error?.remove();
        root.classList.remove('vcp-harness-field');
        if (originalId === null)
            props.control.removeAttribute('id');
        else
            props.control.setAttribute('id', originalId);
        if (originalInvalid === null)
            props.control.removeAttribute('aria-invalid');
        else
            props.control.setAttribute('aria-invalid', originalInvalid);
        if (originalDescribedBy === null)
            props.control.removeAttribute('aria-describedby');
        else
            props.control.setAttribute('aria-describedby', originalDescribedBy);
        if (originalControlClass === null)
            props.control.removeAttribute('class');
        else
            props.control.setAttribute('class', originalControlClass);
    }, 'harness-field', 'ui-primitive');
}
