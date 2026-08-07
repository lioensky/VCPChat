/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  select_styles_default
} from "./chunk.QVOJSZMB.js";
import {
  o as o2
} from "./chunk.2BXLTQVW.js";
import {
  scrollIntoView
} from "./chunk.VQZ46MYI.js";
import {
  WaShowEvent
} from "./chunk.4ZAKP7NY.js";
import {
  WaHideEvent
} from "./chunk.MQODJ75V.js";
import {
  WaAfterShowEvent
} from "./chunk.PX3HMKF7.js";
import {
  WaAfterHideEvent
} from "./chunk.3NKIHICW.js";
import {
  WaClearEvent
} from "./chunk.JTOY5KP3.js";
import {
  isTopDismissible,
  registerDismissible,
  unregisterDismissible
} from "./chunk.52WA2DJO.js";
import {
  RequiredValidator
} from "./chunk.GWSUX3V5.js";
import {
  form_control_styles_default
} from "./chunk.DLTFNMAZ.js";
import {
  WebAwesomeFormAssociatedElement
} from "./chunk.5VKLVAP2.js";
import {
  HasSlotController
} from "./chunk.RWNXKUCF.js";
import {
  warnDeprecatedSize
} from "./chunk.RPQJAXXR.js";
import {
  size_styles_default
} from "./chunk.JB5Y2AN3.js";
import {
  waitForEvent
} from "./chunk.F25QOBDY.js";
import {
  animateWithClass
} from "./chunk.L6CIKOFQ.js";
import {
  e as e2
} from "./chunk.KWDPKKFO.js";
import {
  watch
} from "./chunk.PZAN6FPN.js";
import {
  e,
  n,
  r,
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

// src/components/select/select.ts
var WaSelect = class extends WebAwesomeFormAssociatedElement {
  constructor() {
    super(...arguments);
    this.assumeInteractionOn = ["blur", "input"];
    this.cachedOptions = null;
    this.hasSlotController = new HasSlotController(this, "hint", "label");
    this.localize = new LocalizeController(this);
    this.selectionOrder = /* @__PURE__ */ new Map();
    this.typeToSelectString = "";
    this.slotChangePending = false;
    this.displayLabel = "";
    this.selectedOptions = [];
    this.name = "";
    this._defaultValue = null;
    this.size = "m";
    this.placeholder = "";
    this.multiple = false;
    this.maxOptionsVisible = 3;
    this.disabled = false;
    this.withClear = false;
    this.open = false;
    this.appearance = "outlined";
    this.pill = false;
    this.label = "";
    this.placement = "bottom";
    this.hint = "";
    this.withLabel = false;
    this.withHint = false;
    this.required = false;
    this.getTag = (option) => {
      return x`
        <wa-tag
          part="tag"
          exportparts="
            base:tag__base,
            content:tag__content,
            remove-button:tag__remove-button,
            remove-button__base:tag__remove-button__base
          "
          ?pill=${this.pill}
          size=${this.size}
          with-remove
          data-value=${option.value}
          @wa-remove=${(event) => this.handleTagRemove(event, option)}
        >
          ${option.label}
        </wa-tag>
      `;
    };
    this.handleDocumentFocusIn = (event) => {
      const path = event.composedPath();
      if (this && !path.includes(this)) {
        this.hide();
      }
    };
    this.handleDocumentKeyDown = (event) => {
      const target = event.target;
      const isClearButton = target.closest('[part~="clear-button"]') !== null;
      const isButton = target.closest("wa-button") !== null;
      if (isClearButton || isButton) {
        return;
      }
      if (event.key === "Escape" && this.open && isTopDismissible(this)) {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
        this.displayInput.focus({ preventScroll: true });
      }
      if (event.key === "Enter" || event.key === " " && this.typeToSelectString === "") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!this.open) {
          this.show();
          return;
        }
        if (this.currentOption && !this.currentOption.disabled) {
          this.valueHasChanged = true;
          this.hasInteracted = true;
          if (this.multiple) {
            this.toggleOptionSelection(this.currentOption);
          } else {
            this.setSelectedOptions(this.currentOption);
          }
          this.updateComplete.then(() => {
            this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
            this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          });
          if (!this.multiple) {
            this.hide();
            this.displayInput.focus({ preventScroll: true });
          }
        }
        return;
      }
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        const allOptions = this.getAllOptions();
        const currentIndex = allOptions.indexOf(this.currentOption);
        let newIndex = Math.max(0, currentIndex);
        event.preventDefault();
        if (!this.open) {
          this.show();
          if (this.currentOption) {
            return;
          }
        }
        if (event.key === "ArrowDown") {
          newIndex = currentIndex + 1;
          if (newIndex > allOptions.length - 1) newIndex = 0;
        } else if (event.key === "ArrowUp") {
          newIndex = currentIndex - 1;
          if (newIndex < 0) newIndex = allOptions.length - 1;
        } else if (event.key === "Home") {
          newIndex = 0;
        } else if (event.key === "End") {
          newIndex = allOptions.length - 1;
        }
        this.setCurrentOption(allOptions[newIndex]);
      }
      if (event.key?.length === 1 || event.key === "Backspace") {
        const allOptions = this.getAllOptions();
        if (event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }
        if (!this.open) {
          if (event.key === "Backspace") {
            return;
          }
          this.show();
        }
        event.stopPropagation();
        event.preventDefault();
        clearTimeout(this.typeToSelectTimeout);
        this.typeToSelectTimeout = window.setTimeout(() => this.typeToSelectString = "", 1e3);
        if (event.key === "Backspace") {
          this.typeToSelectString = this.typeToSelectString.slice(0, -1);
        } else {
          this.typeToSelectString += event.key.toLowerCase();
        }
        for (const option of allOptions) {
          const label = option.label.toLowerCase();
          if (label.startsWith(this.typeToSelectString)) {
            this.setCurrentOption(option);
            break;
          }
        }
      }
    };
    this.handleDocumentMouseDown = (event) => {
      const path = event.composedPath();
      if (this && !path.includes(this)) {
        this.hide();
      }
    };
  }
  static get validators() {
    const validators = o ? [] : [
      RequiredValidator({
        validationElement: Object.assign(document.createElement("select"), { required: true })
      })
    ];
    return [...super.validators, ...validators];
  }
  /** Where to anchor native constraint validation */
  get validationTarget() {
    return this.valueInput;
  }
  set defaultValue(val) {
    this._defaultValue = this.convertDefaultValue(val);
  }
  get defaultValue() {
    return this.convertDefaultValue(this._defaultValue);
  }
  rawValuesEqual(a, b) {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  /**
   * @private
   * A converter for defaultValue from array to string if its multiple. Also fixes some hydration issues.
   */
  convertDefaultValue(val) {
    const isMultiple = this.multiple || this.hasAttribute("multiple");
    if (!isMultiple && Array.isArray(val)) {
      val = val[0];
    }
    return val;
  }
  set value(val) {
    let oldValue = this.value;
    if (val instanceof FormData) {
      val = val.getAll(this.name);
    }
    if (val != null && !Array.isArray(val)) {
      val = [val];
    }
    const oldRawValue = this._value;
    this._value = val ?? null;
    if (!this.rawValuesEqual(oldRawValue, this._value)) {
      this.valueHasChanged = true;
      this.requestUpdate("value", oldValue);
    }
  }
  get value() {
    let value = this._value ?? this.defaultValue ?? null;
    if (value != null) {
      value = Array.isArray(value) ? value : [value];
    }
    this.optionValues = new Set(
      this.getAllOptions().filter((option) => !option.disabled).map((option) => option.value)
    );
    let ret = value;
    if (value != null) {
      ret = value.filter((v) => this.optionValues.has(v));
      ret = this.multiple ? ret : ret[0];
      ret = ret ?? null;
    }
    return ret;
  }
  handleSizeChange() {
    warnDeprecatedSize(this.localName, this.size);
  }
  connectedCallback() {
    super.connectedCallback();
    this.processSlotChange();
    this.open = false;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeOpenListeners();
    this.cachedOptions = null;
  }
  updateDefaultValue() {
    const allOptions = this.getAllOptions();
    const defaultSelectedOptions = allOptions.filter((el) => el.hasAttribute("selected") || el.defaultSelected);
    if (defaultSelectedOptions.length > 0) {
      const selectedValues = defaultSelectedOptions.map((el) => el.value);
      this._defaultValue = this.multiple ? selectedValues : selectedValues[0];
    }
    if (this.hasAttribute("value")) {
      this._defaultValue = this.getAttribute("value") || null;
    }
  }
  addOpenListeners() {
    document.addEventListener("focusin", this.handleDocumentFocusIn);
    document.addEventListener("keydown", this.handleDocumentKeyDown);
    document.addEventListener("mousedown", this.handleDocumentMouseDown);
    registerDismissible(this);
    if (this.getRootNode() !== document) {
      this.getRootNode().addEventListener("focusin", this.handleDocumentFocusIn);
    }
  }
  removeOpenListeners() {
    document.removeEventListener("focusin", this.handleDocumentFocusIn);
    document.removeEventListener("keydown", this.handleDocumentKeyDown);
    document.removeEventListener("mousedown", this.handleDocumentMouseDown);
    unregisterDismissible(this);
    if (this.getRootNode() !== document) {
      this.getRootNode().removeEventListener("focusin", this.handleDocumentFocusIn);
    }
  }
  handleFocus() {
    this.displayInput.setSelectionRange(0, 0);
  }
  handleLabelClick() {
    this.displayInput.focus();
  }
  handleComboboxClick(event) {
    event.preventDefault();
  }
  handleComboboxMouseDown(event) {
    const path = event.composedPath();
    const isButton = path.some((el) => el instanceof Element && el.tagName.toLowerCase() === "wa-button");
    if (this.disabled || isButton) {
      return;
    }
    event.preventDefault();
    this.displayInput.focus({ preventScroll: true });
    this.open = !this.open;
  }
  handleComboboxKeyDown(event) {
    event.stopPropagation();
    this.handleDocumentKeyDown(event);
  }
  handleClearClick(event) {
    event.stopPropagation();
    this.hasInteracted = true;
    this.valueHasChanged = true;
    if (this.value !== null) {
      this.displayLabel = "";
      this.selectionOrder.clear();
      this.setSelectedOptions([]);
      this.displayInput.focus({ preventScroll: true });
      this.updateComplete.then(() => {
        this.dispatchEvent(new WaClearEvent());
        this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      });
    }
  }
  handleClearMouseDown(event) {
    event.stopPropagation();
    event.preventDefault();
  }
  handleOptionClick(event) {
    const target = event.target;
    const option = target.closest("wa-option");
    if (option && !option.disabled) {
      this.hasInteracted = true;
      this.valueHasChanged = true;
      if (this.multiple) {
        this.toggleOptionSelection(option);
      } else {
        this.setSelectedOptions(option);
      }
      this.updateComplete.then(() => this.displayInput.focus({ preventScroll: true }));
      this.requestUpdate("value");
      this.updateComplete.then(() => {
        this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      });
      if (!this.multiple) {
        this.hide();
        this.displayInput.focus({ preventScroll: true });
      }
    }
  }
  /* @internal - used by options to update labels */
  handleDefaultSlotChange() {
    if (this.slotChangePending) return;
    this.slotChangePending = true;
    queueMicrotask(() => {
      this.slotChangePending = false;
      this.processSlotChange();
    });
  }
  processSlotChange() {
    if (!customElements.get("wa-option")) {
      customElements.whenDefined("wa-option").then(() => this.handleDefaultSlotChange());
    }
    if (this.didSSR && !this.hasUpdated) {
      this.updateComplete.then(() => {
        this.handleDefaultSlotChange();
      });
      return;
    }
    this.cachedOptions = null;
    const allOptions = this.getAllOptions();
    this.updateDefaultValue();
    let value = this.value;
    if (value == null || !this.valueHasChanged && !this.hasInteracted) {
      this.selectionChanged();
      return;
    }
    if (!Array.isArray(value)) {
      value = [value];
    }
    const selectedOptions = allOptions.filter((el) => value.includes(el.value));
    this.setSelectedOptions(selectedOptions);
  }
  handleTagRemove(event, directOption) {
    event.stopPropagation();
    if (this.disabled) return;
    this.hasInteracted = true;
    this.valueHasChanged = true;
    let option = directOption;
    if (!option) {
      const tagElement = event.target.closest("wa-tag[data-value]");
      if (tagElement) {
        const value = tagElement.dataset.value;
        option = this.selectedOptions.find((opt) => opt.value === value);
      }
    }
    if (option) {
      this.toggleOptionSelection(option, false);
      this.updateComplete.then(() => {
        this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      });
    }
  }
  // Gets an array of all `<wa-option>` elements
  getAllOptions() {
    if (this.cachedOptions) return this.cachedOptions;
    if (!this?.querySelectorAll) {
      return [];
    }
    this.cachedOptions = [...this.querySelectorAll("wa-option")];
    return this.cachedOptions;
  }
  // Gets the first `<wa-option>` element
  getFirstOption() {
    return this.querySelector("wa-option");
  }
  // Sets the current option, which is the option the user is currently interacting with (e.g. via keyboard). Only one
  // option may be "current" at a time.
  setCurrentOption(option) {
    const allOptions = this.getAllOptions();
    allOptions.forEach((el) => {
      el.current = false;
      el.tabIndex = -1;
    });
    if (option) {
      this.currentOption = option;
      option.current = true;
      option.tabIndex = 0;
      option.focus({ preventScroll: true });
      if (this.open && !this.listbox.hidden) {
        scrollIntoView(option, this.listbox, "vertical", "auto");
      }
    }
  }
  // Sets the selected option(s)
  setSelectedOptions(option) {
    const allOptions = this.getAllOptions();
    const newSelectedOptions = Array.isArray(option) ? option : [option];
    allOptions.forEach((el) => {
      if (newSelectedOptions.includes(el)) {
        return;
      }
      el.selected = false;
    });
    if (newSelectedOptions.length) {
      newSelectedOptions.forEach((el) => el.selected = true);
    }
    this.selectionChanged();
  }
  // Toggles an option's selected state
  toggleOptionSelection(option, force) {
    if (force === true || force === false) {
      option.selected = force;
    } else {
      option.selected = !option.selected;
    }
    this.selectionChanged();
  }
  // @internal This method must be called whenever the selection changes. It will update the selected options cache, the
  // current value, and the display value. The option component uses it internally to update labels as they change.
  selectionChanged() {
    const options = this.getAllOptions();
    const newSelectedOptions = options.filter((el) => {
      if (!this.hasInteracted && !this.valueHasChanged) {
        const defaultValue = this.defaultValue;
        const defaultValues = Array.isArray(defaultValue) ? defaultValue : [defaultValue];
        return el.hasAttribute("selected") || el.defaultSelected || el.selected || defaultValues?.includes(el.value);
      }
      return el.selected;
    });
    const newSelectedValues = new Set(newSelectedOptions.map((el) => el.value));
    for (const value of this.selectionOrder.keys()) {
      if (!newSelectedValues.has(value)) {
        this.selectionOrder.delete(value);
      }
    }
    const maxOrder = this.selectionOrder.size > 0 ? Math.max(...this.selectionOrder.values()) : -1;
    let nextOrder = maxOrder + 1;
    for (const option of newSelectedOptions) {
      if (!this.selectionOrder.has(option.value)) {
        this.selectionOrder.set(option.value, nextOrder++);
      }
    }
    this.selectedOptions = newSelectedOptions.sort((a, b) => {
      const orderA = this.selectionOrder.get(a.value) ?? 0;
      const orderB = this.selectionOrder.get(b.value) ?? 0;
      return orderA - orderB;
    });
    let selectedValues = new Set(this.selectedOptions.map((el) => el.value));
    if (selectedValues.size > 0 || this._value) {
      const oldValue = this._value;
      if (this._value == null) {
        let value = this.defaultValue ?? [];
        this._value = Array.isArray(value) ? value : [value];
      }
      this._value = this._value?.filter((value) => !this.optionValues?.has(value)) ?? null;
      this._value?.unshift(...selectedValues);
      this.requestUpdate("value", oldValue);
    }
    if (this.multiple) {
      if (this.placeholder && !this.value?.length) {
        this.displayLabel = "";
      } else {
        this.displayLabel = this.localize.term("numOptionsSelected", this.selectedOptions.length);
      }
    } else {
      const selectedOption = this.selectedOptions[0];
      this.displayLabel = selectedOption?.label ?? "";
    }
    this.updateComplete.then(() => {
      this.updateValidity();
    });
  }
  get tags() {
    return this.selectedOptions.map((option, index) => {
      if (index < this.maxOptionsVisible || this.maxOptionsVisible <= 0) {
        const tag = this.getTag(option, index);
        if (!tag) return null;
        return typeof tag === "string" ? o2(tag) : tag;
      } else if (index === this.maxOptionsVisible) {
        return x`
          <wa-tag
            part="tag"
            exportparts="
              base:tag__base,
              content:tag__content,
              remove-button:tag__remove-button,
              remove-button__base:tag__remove-button__base
            "
            >+${this.selectedOptions.length - index}</wa-tag
          >
        `;
      }
      return null;
    });
  }
  updated(changedProperties) {
    super.updated(changedProperties);
    if (changedProperties.has("value") || changedProperties.has("displayLabel")) {
      this.customStates.set("blank", !this.value && !this.displayLabel);
    }
  }
  handleDisabledChange() {
    if (this.disabled && this.open) {
      this.open = false;
    }
  }
  handleValueChange() {
    const allOptions = this.getAllOptions();
    const value = Array.isArray(this.value) ? this.value : [this.value];
    const selectedOptions = allOptions.filter((el) => value.includes(el.value));
    this.setSelectedOptions(selectedOptions);
    this.updateValidity();
  }
  async handleOpenChange() {
    if (this.open && !this.disabled) {
      this.setCurrentOption(this.selectedOptions[0] || this.getFirstOption());
      const waShowEvent = new WaShowEvent();
      this.dispatchEvent(waShowEvent);
      if (waShowEvent.defaultPrevented) {
        this.open = false;
        return;
      }
      this.addOpenListeners();
      this.listbox.hidden = false;
      this.popup.active = true;
      requestAnimationFrame(() => {
        this.setCurrentOption(this.currentOption);
      });
      await animateWithClass(this.popup.popup, "show");
      if (this.currentOption) {
        scrollIntoView(this.currentOption, this.listbox, "vertical", "auto");
      }
      this.dispatchEvent(new WaAfterShowEvent());
    } else {
      const waHideEvent = new WaHideEvent();
      this.dispatchEvent(waHideEvent);
      if (waHideEvent.defaultPrevented) {
        this.open = false;
        return;
      }
      this.removeOpenListeners();
      await animateWithClass(this.popup.popup, "hide");
      this.listbox.hidden = true;
      this.popup.active = false;
      this.dispatchEvent(new WaAfterHideEvent());
    }
  }
  /** Shows the listbox. */
  async show() {
    if (this.open || this.disabled) {
      this.open = false;
      return void 0;
    }
    this.open = true;
    return waitForEvent(this, "wa-after-show");
  }
  /** Hides the listbox. */
  async hide() {
    if (!this.open || this.disabled) {
      this.open = false;
      return void 0;
    }
    this.open = false;
    return waitForEvent(this, "wa-after-hide");
  }
  /** Sets focus on the control. */
  focus(options) {
    this.displayInput.focus(options);
  }
  /** Removes focus from the control. */
  blur() {
    this.displayInput.blur();
  }
  formResetCallback() {
    this.selectionOrder.clear();
    this.value = this.defaultValue;
    super.formResetCallback();
    this.handleValueChange();
    this.updateComplete.then(() => {
      this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    });
  }
  render() {
    const hasLabelSlot = this.hasSlotController.test("label", "withLabel");
    const hasHintSlot = this.hasSlotController.test("hint", "withHint");
    const hasLabel = this.label ? true : !!hasLabelSlot;
    const hasHint = this.hint ? true : !!hasHintSlot;
    const hasClearIcon = (this.hasUpdated || o) && this.withClear && !this.disabled && (this.displayLabel || this.value && this.value.length > 0);
    return x`
      <div
        part="form-control"
        class=${e2({
      "form-control": true,
      "form-control-has-label": hasLabel
    })}
      >
        <label
          id="label"
          part="form-control-label label"
          class=${e2({
      label: true,
      "has-label": hasLabel
    })}
          aria-hidden=${hasLabel ? "false" : "true"}
          @click=${this.handleLabelClick}
        >
          <slot name="label">${this.label}</slot>
        </label>

        <div part="form-control-input" class="form-control-input">
          <wa-popup
            class=${e2({
      select: true,
      open: this.open,
      disabled: this.disabled,
      enabled: !this.disabled,
      multiple: this.multiple
    })}
            placement=${this.placement}
            flip
            shift
            sync="width"
            auto-size="vertical"
            auto-size-padding="10"
          >
            <div
              part="combobox"
              class="combobox"
              slot="anchor"
              @keydown=${this.handleComboboxKeyDown}
              @mousedown=${this.handleComboboxMouseDown}
              @click=${this.handleComboboxClick}
            >
              <slot part="start" name="start" class="start"></slot>

              <input
                part="display-input"
                class="display-input"
                type="text"
                placeholder=${this.placeholder}
                .disabled=${this.disabled}
                .value=${this.displayLabel}
                ?required=${this.required}
                autocomplete="off"
                spellcheck="false"
                autocapitalize="off"
                readonly
                aria-invalid=${!this.validity.valid}
                aria-controls="listbox"
                aria-expanded=${this.open ? "true" : "false"}
                aria-haspopup="listbox"
                aria-labelledby="label"
                aria-disabled=${this.disabled ? "true" : "false"}
                aria-describedby="hint"
                role="combobox"
                tabindex="0"
                @focus=${this.handleFocus}
              />

              <!-- Tags need to wait for first hydration before populating otherwise it will create a hydration mismatch. -->
              ${this.multiple && this.hasUpdated ? x`<div part="tags" class="tags" @wa-remove=${this.handleTagRemove}>${this.tags}</div>` : ""}

              <input
                class="value-input"
                type="text"
                ?disabled=${this.disabled}
                ?required=${this.required}
                .value=${Array.isArray(this.value) ? this.value.join(", ") : this.value}
                tabindex="-1"
                aria-hidden="true"
                @focus=${() => this.focus()}
              />

              ${hasClearIcon ? x`
                    <button
                      part="clear-button"
                      type="button"
                      aria-label=${this.localize.term("clearEntry")}
                      @mousedown=${this.handleClearMouseDown}
                      @click=${this.handleClearClick}
                      tabindex="-1"
                    >
                      <slot name="clear-icon">
                        <wa-icon name="circle-xmark" library="system" variant="regular"></wa-icon>
                      </slot>
                    </button>
                  ` : ""}

              <slot name="end" part="end" class="end"></slot>

              <slot name="expand-icon" part="expand-icon" class="expand-icon">
                <wa-icon library="system" name="chevron-down" variant="solid"></wa-icon>
              </slot>
            </div>

            <div
              id="listbox"
              role="listbox"
              aria-expanded=${this.open ? "true" : "false"}
              aria-multiselectable=${this.multiple ? "true" : "false"}
              aria-labelledby="label"
              part="listbox"
              class="listbox"
              tabindex="-1"
              @mouseup=${this.handleOptionClick}
            >
              <slot @slotchange=${this.handleDefaultSlotChange}></slot>
            </div>
          </wa-popup>
        </div>

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
      </div>
    `;
  }
};
WaSelect.css = [select_styles_default, form_control_styles_default, size_styles_default];
__decorateClass([
  e(".select")
], WaSelect.prototype, "popup", 2);
__decorateClass([
  e(".combobox")
], WaSelect.prototype, "combobox", 2);
__decorateClass([
  e(".display-input")
], WaSelect.prototype, "displayInput", 2);
__decorateClass([
  e(".value-input")
], WaSelect.prototype, "valueInput", 2);
__decorateClass([
  e(".listbox")
], WaSelect.prototype, "listbox", 2);
__decorateClass([
  r()
], WaSelect.prototype, "displayLabel", 2);
__decorateClass([
  r()
], WaSelect.prototype, "currentOption", 2);
__decorateClass([
  r()
], WaSelect.prototype, "selectedOptions", 2);
__decorateClass([
  n({ reflect: true })
], WaSelect.prototype, "name", 2);
__decorateClass([
  n({
    attribute: false
  })
], WaSelect.prototype, "defaultValue", 1);
__decorateClass([
  n({ attribute: "value", reflect: false })
], WaSelect.prototype, "value", 1);
__decorateClass([
  n({ reflect: true })
], WaSelect.prototype, "size", 2);
__decorateClass([
  watch("size")
], WaSelect.prototype, "handleSizeChange", 1);
__decorateClass([
  n()
], WaSelect.prototype, "placeholder", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaSelect.prototype, "multiple", 2);
__decorateClass([
  n({ attribute: "max-options-visible", type: Number })
], WaSelect.prototype, "maxOptionsVisible", 2);
__decorateClass([
  n({ type: Boolean })
], WaSelect.prototype, "disabled", 2);
__decorateClass([
  n({ attribute: "with-clear", type: Boolean })
], WaSelect.prototype, "withClear", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaSelect.prototype, "open", 2);
__decorateClass([
  n({ reflect: true })
], WaSelect.prototype, "appearance", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaSelect.prototype, "pill", 2);
__decorateClass([
  n()
], WaSelect.prototype, "label", 2);
__decorateClass([
  n({ reflect: true })
], WaSelect.prototype, "placement", 2);
__decorateClass([
  n({ attribute: "hint" })
], WaSelect.prototype, "hint", 2);
__decorateClass([
  n({ attribute: "with-label", type: Boolean })
], WaSelect.prototype, "withLabel", 2);
__decorateClass([
  n({ attribute: "with-hint", type: Boolean })
], WaSelect.prototype, "withHint", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaSelect.prototype, "required", 2);
__decorateClass([
  n({ attribute: false })
], WaSelect.prototype, "getTag", 2);
__decorateClass([
  watch("disabled", { waitUntilFirstUpdate: true })
], WaSelect.prototype, "handleDisabledChange", 1);
__decorateClass([
  watch("value", { waitUntilFirstUpdate: true })
], WaSelect.prototype, "handleValueChange", 1);
__decorateClass([
  watch("open", { waitUntilFirstUpdate: true })
], WaSelect.prototype, "handleOpenChange", 1);
WaSelect = __decorateClass([
  t("wa-select")
], WaSelect);
WaSelect.disableWarning?.("change-in-update");

export {
  WaSelect
};
