/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  card_styles_default
} from "./chunk.FG2PKHMT.js";
import {
  HasSlotController
} from "./chunk.RWNXKUCF.js";
import {
  size_styles_default
} from "./chunk.JB5Y2AN3.js";
import {
  e
} from "./chunk.KWDPKKFO.js";
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

// src/components/card/card.ts
var WaCard = class extends WebAwesomeElement {
  constructor() {
    super(...arguments);
    this.hasSlotController = new HasSlotController(
      this,
      "footer",
      "header",
      "media",
      "header-actions",
      "footer-actions",
      "actions"
    );
    this.appearance = "outlined";
    this.withHeader = false;
    this.withMedia = false;
    this.withFooter = false;
    this.withHeaderActions = false;
    this.withFooterActions = false;
    this.orientation = "vertical";
  }
  willUpdate(changedProperties) {
    this.withHeader = this.hasSlotController.test("header", "withHeader");
    this.withMedia = this.hasSlotController.test("media", "withMedia");
    this.withFooter = this.hasSlotController.test("footer", "withFooter");
    super.willUpdate(changedProperties);
  }
  render() {
    if (this.orientation === "horizontal") {
      return x`
        <slot name="media" part="media" class="media"></slot>
        <div part="body" class="body"><slot></slot></div>
        <slot name="actions" part="actions" class="actions"></slot>
      `;
    }
    const hasHeaderActions = this.hasSlotController.test("header-actions", "withHeaderActions");
    const hasFooterActions = this.hasSlotController.test("footer-actions", "withFooterActions");
    return x`
      <slot name="media" part="media" class="media"></slot>

      <header
        part="header"
        class=${e({
      header: true,
      "has-actions": hasHeaderActions
    })}
      >
        <slot name="header"></slot>
        <slot name="header-actions"></slot>
      </header>

      <div part="body" class="body"><slot></slot></div>

      <footer
        part="footer"
        class=${e({
      footer: true,
      "has-actions": hasFooterActions
    })}
      >
        <slot name="footer"></slot>
        <slot name="footer-actions"></slot>
      </footer>
    `;
  }
};
WaCard.css = [size_styles_default, card_styles_default];
__decorateClass([
  n({ reflect: true })
], WaCard.prototype, "appearance", 2);
__decorateClass([
  n({ attribute: "with-header", type: Boolean, reflect: true })
], WaCard.prototype, "withHeader", 2);
__decorateClass([
  n({ attribute: "with-media", type: Boolean, reflect: true })
], WaCard.prototype, "withMedia", 2);
__decorateClass([
  n({ attribute: "with-footer", type: Boolean, reflect: true })
], WaCard.prototype, "withFooter", 2);
__decorateClass([
  n({ attribute: "with-header-actions", type: Boolean, reflect: true })
], WaCard.prototype, "withHeaderActions", 2);
__decorateClass([
  n({ attribute: "with-footer-actions", type: Boolean, reflect: true })
], WaCard.prototype, "withFooterActions", 2);
__decorateClass([
  n({ reflect: true })
], WaCard.prototype, "orientation", 2);
WaCard = __decorateClass([
  t("wa-card")
], WaCard);
WaCard.disableWarning?.("change-in-update");

export {
  WaCard
};
