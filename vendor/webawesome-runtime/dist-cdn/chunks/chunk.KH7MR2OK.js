/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  tab_styles_default
} from "./chunk.5ZSSLK3M.js";
import {
  e as e2
} from "./chunk.KWDPKKFO.js";
import {
  watch
} from "./chunk.PZAN6FPN.js";
import {
  WebAwesomeElement,
  e,
  n,
  t
} from "./chunk.LBLI4KS5.js";
import {
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// src/components/tab/tab.ts
var id = 0;
var WaTab = class extends WebAwesomeElement {
  constructor() {
    super(...arguments);
    this.attrId = ++id;
    this.componentId = `wa-tab-${this.attrId}`;
    this.panel = "";
    this.active = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.slot = "nav";
    this.role = "tab";
  }
  handleActiveChange() {
    this.setAttribute("aria-selected", this.active ? "true" : "false");
  }
  handleDisabledChange() {
    this.setAttribute("aria-disabled", this.disabled ? "true" : "false");
    if (this.disabled && !this.active) {
      this.tabIndex = -1;
    } else {
      this.tabIndex = 0;
    }
  }
  render() {
    this.id = this.id?.length > 0 ? this.id : this.componentId;
    return x`
      <div
        part="base tab"
        class=${e2({
      tab: true,
      "tab-active": this.active
    })}
      >
        <slot></slot>
      </div>
    `;
  }
};
WaTab.css = tab_styles_default;
__decorateClass([
  e(".tab")
], WaTab.prototype, "tab", 2);
__decorateClass([
  n({ reflect: true })
], WaTab.prototype, "panel", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaTab.prototype, "active", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaTab.prototype, "disabled", 2);
__decorateClass([
  n({ type: Number, reflect: true })
], WaTab.prototype, "tabIndex", 2);
__decorateClass([
  n({ reflect: true })
], WaTab.prototype, "slot", 2);
__decorateClass([
  n({ reflect: true })
], WaTab.prototype, "role", 2);
__decorateClass([
  watch("active")
], WaTab.prototype, "handleActiveChange", 1);
__decorateClass([
  watch("disabled")
], WaTab.prototype, "handleDisabledChange", 1);
WaTab = __decorateClass([
  t("wa-tab")
], WaTab);

export {
  WaTab
};
