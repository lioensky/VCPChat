/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  switch_styles_default
} from "./chunk.EEC2F5YM.js";
import {
  form_control_styles_default
} from "./chunk.DLTFNMAZ.js";
import {
  l
} from "./chunk.K5EDTD7G.js";
import {
  MirrorValidator
} from "./chunk.R7QX4M6R.js";
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
  LocalizeController
} from "./chunk.4QWUDRS5.js";
import {
  o
} from "./chunk.TLFIX76K.js";
import {
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// src/components/switch/switch.ts
var WaSwitch = class extends WebAwesomeFormAssociatedElement {
  constructor() {
    super(...arguments);
    this.hasSlotController = new HasSlotController(this, "hint");
    this.localize = new LocalizeController(this);
    this.title = "";
    this.name = null;
    this._value = this.getAttribute("value") ?? null;
    this.size = "m";
    this.disabled = false;
    this._checked = null;
    this.defaultChecked = this.hasAttribute("checked");
    this.required = false;
    this.hint = "";
    this.withHint = false;
  }
  static get validators() {
    return o ? [] : [...super.validators, MirrorValidator()];
  }
  /** The value of the switch, submitted as a name/value pair with form data. */
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
    this.updateComplete.then(() => {
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
  }
  handleKeyDown(event) {
    const isRtl = this.localize.dir() === "rtl";
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.checked = isRtl;
      this.updateComplete.then(() => {
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      });
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.checked = !isRtl;
      this.updateComplete.then(() => {
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      });
    }
  }
  willUpdate(changedProperties) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("value") || changedProperties.has("checked") || changedProperties.has("defaultChecked") || changedProperties.has("disabled")) {
      this.handleValueOrCheckedChange();
    }
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
    }
    this.customStates.set("checked", this.checked);
    this.updateValidity();
  }
  handleDisabledChange() {
    this.updateValidity();
  }
  /** Simulates a click on the switch. */
  click() {
    this.input.click();
  }
  /** Sets focus on the switch. */
  focus(options) {
    this.input.focus(options);
  }
  /** Removes focus from the switch. */
  blur() {
    this.input.blur();
  }
  setValue(value, stateValue) {
    if (!this.checked) {
      this.internals.setFormValue(null, null);
      return;
    }
    this.internals.setFormValue(value ?? "on", stateValue);
  }
  formResetCallback() {
    this._checked = null;
    super.formResetCallback();
    this.handleValueOrCheckedChange();
  }
  render() {
    const hasHintSlot = this.hasSlotController.test("hint", "withHint");
    const hasHint = this.hint ? true : !!hasHintSlot;
    const checkedAttribute = this.didSSR && !this.hasUpdated ? this.checked : this.defaultChecked;
    const checkedProperty = this.didSSR && !this.hasUpdated ? null : l(this.checked);
    return x`
      <label
        part="base switch"
        class=${e2({
      checked: this.checked,
      disabled: this.disabled
    })}
      >
        <input
          class="input"
          type="checkbox"
          title=${this.title}
          name=${o2(this.name)}
          value=${o2(this.value)}
          .checked=${o2(checkedProperty)}
          ?checked=${checkedAttribute}
          ?disabled=${this.disabled}
          ?required=${this.required}
          role="switch"
          aria-checked=${this.checked ? "true" : "false"}
          aria-describedby="hint"
          @click=${this.handleClick}
          @keydown=${this.handleKeyDown}
        />

        <span part="control" class="switch">
          <span part="thumb" class="thumb"></span>
        </span>

        <slot part="label" class="label"></slot>
      </label>

      <slot
        id="hint"
        name="hint"
        part="hint"
        class=${e2({
      "has-slotted": hasHint
    })}
        aria-hidden=${hasHint ? "false" : "true"}
        >${this.hint}</slot
      >
    `;
  }
};
WaSwitch.shadowRootOptions = { ...WebAwesomeFormAssociatedElement.shadowRootOptions, delegatesFocus: true };
WaSwitch.css = [form_control_styles_default, size_styles_default, switch_styles_default];
__decorateClass([
  e('input[type="checkbox"]')
], WaSwitch.prototype, "input", 2);
__decorateClass([
  n()
], WaSwitch.prototype, "title", 2);
__decorateClass([
  n({ reflect: true })
], WaSwitch.prototype, "name", 2);
__decorateClass([
  n({ reflect: true })
], WaSwitch.prototype, "value", 1);
__decorateClass([
  n({ reflect: true })
], WaSwitch.prototype, "size", 2);
__decorateClass([
  watch("size")
], WaSwitch.prototype, "handleSizeChange", 1);
__decorateClass([
  n({ type: Boolean })
], WaSwitch.prototype, "disabled", 2);
__decorateClass([
  n({ type: Boolean, attribute: false })
], WaSwitch.prototype, "checked", 1);
__decorateClass([
  n({ type: Boolean, attribute: "checked", reflect: true })
], WaSwitch.prototype, "defaultChecked", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaSwitch.prototype, "required", 2);
__decorateClass([
  n({ attribute: "hint" })
], WaSwitch.prototype, "hint", 2);
__decorateClass([
  n({ attribute: "with-hint", type: Boolean })
], WaSwitch.prototype, "withHint", 2);
__decorateClass([
  watch(["checked", "defaultChecked"])
], WaSwitch.prototype, "handleStateChange", 1);
__decorateClass([
  watch("disabled", { waitUntilFirstUpdate: true })
], WaSwitch.prototype, "handleDisabledChange", 1);
WaSwitch = __decorateClass([
  t("wa-switch")
], WaSwitch);
WaSwitch.disableWarning?.("change-in-update");

export {
  WaSwitch
};
