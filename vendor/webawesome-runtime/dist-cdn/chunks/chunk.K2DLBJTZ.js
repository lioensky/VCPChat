/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  checkbox_styles_default
} from "./chunk.YNIJJMXK.js";
import {
  RequiredValidator
} from "./chunk.GWSUX3V5.js";
import {
  form_control_styles_default
} from "./chunk.DLTFNMAZ.js";
import {
  l
} from "./chunk.K5EDTD7G.js";
import {
  WebAwesomeFormAssociatedElement
} from "./chunk.5VKLVAP2.js";
import {
  HasSlotController
} from "./chunk.RWNXKUCF.js";
import {
  o as o2
} from "./chunk.3MSWQ3RG.js";
import {
  warnDeprecatedSize
} from "./chunk.RPQJAXXR.js";
import {
  size_styles_default
} from "./chunk.JB5Y2AN3.js";
import {
  e as e2
} from "./chunk.KWDPKKFO.js";
import {
  watch
} from "./chunk.PZAN6FPN.js";
import {
  e,
  n,
  t
} from "./chunk.LBLI4KS5.js";
import {
  o
} from "./chunk.TLFIX76K.js";
import {
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// src/components/checkbox/checkbox.ts
var WaCheckbox = class extends WebAwesomeFormAssociatedElement {
  constructor() {
    super(...arguments);
    this.hasSlotController = new HasSlotController(this, "hint");
    this.title = "";
    // make reactive to pass through
    this._value = this.getAttribute("value") ?? null;
    this.size = "m";
    this.disabled = false;
    this.indeterminate = false;
    this._checked = null;
    this.defaultChecked = this.hasAttribute("checked");
    this.required = false;
    this.hint = "";
  }
  static get validators() {
    const validators = o ? [] : [
      RequiredValidator({
        validationProperty: "checked",
        // Use a checkbox so we get "free" translation strings.
        validationElement: Object.assign(document.createElement("input"), {
          type: "checkbox",
          required: true
        })
      })
    ];
    return [...super.validators, ...validators];
  }
  /** The value of the checkbox, submitted as a name/value pair with form data. */
  get value() {
    return this._value ?? "on";
  }
  set value(val) {
    this._value = val;
  }
  handleSizeChange() {
    warnDeprecatedSize(this.localName, this.size);
  }
  get checked() {
    if (this.valueHasChanged) {
      return Boolean(this._checked);
    }
    return this._checked ?? this.defaultChecked;
  }
  set checked(val) {
    this._checked = Boolean(val);
    this.valueHasChanged = true;
  }
  handleClick() {
    this.hasInteracted = true;
    this.checked = !this.checked;
    this.indeterminate = false;
    this.updateComplete.then(() => {
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.didSSR && !this.hasUpdated) {
      this.updateComplete.then(() => {
        this.handleDefaultCheckedChange();
      });
      return;
    }
    this.handleDefaultCheckedChange();
  }
  handleDefaultCheckedChange() {
    this.handleValueOrCheckedChange();
  }
  handleValueOrCheckedChange() {
    if (this.didSSR && !this.hasUpdated) {
      this.updateComplete.then(() => {
        this.handleValueOrCheckedChange();
      });
      return;
    }
    this.setValue(this.checked ? this.value : null, this._value);
    this.updateValidity();
  }
  handleStateChange() {
    if (this.hasUpdated) {
      this.input.checked = this.checked;
      this.input.indeterminate = this.indeterminate;
    }
    this.customStates.set("checked", this.checked);
    this.customStates.set("indeterminate", this.indeterminate);
    this.updateValidity();
  }
  handleDisabledChange() {
    this.customStates.set("disabled", this.disabled);
  }
  willUpdate(changedProperties) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("value") || changedProperties.has("checked") || changedProperties.has("defaultChecked") || changedProperties.has("disabled")) {
      this.handleValueOrCheckedChange();
    }
  }
  formResetCallback() {
    this._checked = null;
    super.formResetCallback();
    this.handleValueOrCheckedChange();
  }
  /** Simulates a click on the checkbox. */
  click() {
    this.input.click();
  }
  /** Sets focus on the checkbox. */
  focus(options) {
    this.input.focus(options);
  }
  /** Removes focus from the checkbox. */
  blur() {
    this.input.blur();
  }
  render() {
    const hasHintSlot = o ? true : this.hasSlotController.test("hint");
    const hasHint = this.hint ? true : !!hasHintSlot;
    const isIndeterminate = !this.checked && this.indeterminate;
    const iconName = isIndeterminate ? "indeterminate" : "check";
    const iconState = isIndeterminate ? "indeterminate" : "checked";
    const checkedAttribute = this.didSSR && !this.hasUpdated ? this.checked : this.defaultChecked;
    const checkedProperty = this.didSSR && !this.hasUpdated ? null : l(this.checked);
    return x`
      <label part="base checkbox">
        <span part="control">
          <input
            class="input"
            type="checkbox"
            title=${this.title}
            name=${o2(this.name)}
            value=${o2(this.value)}
            .indeterminate=${l(this.indeterminate)}
            .checked=${o2(checkedProperty)}
            ?checked=${checkedAttribute}
            ?disabled=${this.disabled}
            ?required=${this.required}
            aria-checked=${this.indeterminate ? "mixed" : this.checked ? "true" : "false"}
            aria-describedby="hint"
            @click=${this.handleClick}
          />

          <wa-icon part="${iconState}-icon icon" library="system" name=${iconName}></wa-icon>
        </span>

        <slot part="label"></slot>
      </label>

      <slot
        id="hint"
        part="hint"
        name="hint"
        aria-hidden=${hasHint ? "false" : "true"}
        class="${e2({ "has-slotted": hasHint })}"
      >
        ${this.hint}
      </slot>
    `;
  }
};
WaCheckbox.css = [form_control_styles_default, size_styles_default, checkbox_styles_default];
WaCheckbox.shadowRootOptions = { ...WebAwesomeFormAssociatedElement.shadowRootOptions, delegatesFocus: true };
__decorateClass([
  e('input[type="checkbox"]')
], WaCheckbox.prototype, "input", 2);
__decorateClass([
  n()
], WaCheckbox.prototype, "title", 2);
__decorateClass([
  n({ reflect: true })
], WaCheckbox.prototype, "value", 1);
__decorateClass([
  n({ reflect: true })
], WaCheckbox.prototype, "size", 2);
__decorateClass([
  watch("size")
], WaCheckbox.prototype, "handleSizeChange", 1);
__decorateClass([
  n({ type: Boolean })
], WaCheckbox.prototype, "disabled", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaCheckbox.prototype, "indeterminate", 2);
__decorateClass([
  n({ type: Boolean, attribute: false })
], WaCheckbox.prototype, "checked", 1);
__decorateClass([
  n({ type: Boolean, reflect: true, attribute: "checked" })
], WaCheckbox.prototype, "defaultChecked", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaCheckbox.prototype, "required", 2);
__decorateClass([
  n()
], WaCheckbox.prototype, "hint", 2);
__decorateClass([
  watch(["checked", "defaultChecked"])
], WaCheckbox.prototype, "handleDefaultCheckedChange", 1);
__decorateClass([
  watch(["checked", "indeterminate"])
], WaCheckbox.prototype, "handleStateChange", 1);
__decorateClass([
  watch("disabled")
], WaCheckbox.prototype, "handleDisabledChange", 1);
WaCheckbox = __decorateClass([
  t("wa-checkbox")
], WaCheckbox);
WaCheckbox.disableWarning?.("change-in-update");

export {
  WaCheckbox
};
