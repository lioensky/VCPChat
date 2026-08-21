/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  tab_panel_styles_default
} from "./chunk.IOZQCLLD.js";
import {
  e
} from "./chunk.KWDPKKFO.js";
import {
  watch
} from "./chunk.PZAN6FPN.js";
import {
  WebAwesomeElement,
  n,
  t
} from "./chunk.LBLI4KS5.js";
import {
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// src/components/tab-panel/tab-panel.ts
var id = 0;
var WaTabPanel = class extends WebAwesomeElement {
  constructor() {
    super(...arguments);
    this.attrId = ++id;
    this.componentId = `wa-tab-panel-${this.attrId}`;
    this.name = "";
    this.active = false;
    this.role = "tabpanel";
  }
  connectedCallback() {
    super.connectedCallback();
    this.id = (this.id || "").length > 0 ? this.id : this.componentId;
  }
  handleActiveChange() {
    this.setAttribute("aria-hidden", this.active ? "false" : "true");
  }
  render() {
    return x`
      <slot
        part="base"
        class=${e({
      "tab-panel": true,
      "tab-panel-active": this.active
    })}
      ></slot>
    `;
  }
};
WaTabPanel.css = tab_panel_styles_default;
__decorateClass([
  n({ reflect: true })
], WaTabPanel.prototype, "name", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaTabPanel.prototype, "active", 2);
__decorateClass([
  n({ reflect: true })
], WaTabPanel.prototype, "role", 2);
__decorateClass([
  watch("active")
], WaTabPanel.prototype, "handleActiveChange", 1);
WaTabPanel = __decorateClass([
  t("wa-tab-panel")
], WaTabPanel);

export {
  WaTabPanel
};
