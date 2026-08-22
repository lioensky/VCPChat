/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  MirrorValidator
} from "./chunk.R7QX4M6R.js";
import {
  WebAwesomeFormAssociatedElement
} from "./chunk.5VKLVAP2.js";
import {
  WaInvalidEvent
} from "./chunk.VC3BPUZJ.js";
import {
  HasSlotController
} from "./chunk.RWNXKUCF.js";
import {
  o
} from "./chunk.3MSWQ3RG.js";
import {
  button_styles_default
} from "./chunk.ZZSRBQZ6.js";
import {
  warnDeprecatedSize
} from "./chunk.RPQJAXXR.js";
import {
  size_styles_default
} from "./chunk.JB5Y2AN3.js";
import {
  variants_styles_default
} from "./chunk.K5Q2EBKV.js";
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
  b,
  w,
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// ../../node_modules/lit-html/static.js
var a = Symbol.for("");
var o2 = (t2) => {
  if (t2?.r === a) return t2?._$litStatic$;
};
var i = (t2, ...r2) => ({ _$litStatic$: r2.reduce(((r3, e3, a2) => r3 + ((t3) => {
  if (void 0 !== t3._$litStatic$) return t3._$litStatic$;
  throw Error(`Value passed to 'literal' function must be a 'literal' result: ${t3}. Use 'unsafeStatic' to pass non-literal values, but
            take care to ensure page security.`);
})(e3) + t2[a2 + 1]), t2[0]), r: a });
var l = /* @__PURE__ */ new Map();
var n2 = (t2) => (r2, ...e3) => {
  const a2 = e3.length;
  let s, i2;
  const n3 = [], u2 = [];
  let c2, $2 = 0, f = false;
  for (; $2 < a2; ) {
    for (c2 = r2[$2]; $2 < a2 && void 0 !== (i2 = e3[$2], s = o2(i2)); ) c2 += s + r2[++$2], f = true;
    $2 !== a2 && u2.push(i2), n3.push(c2), $2++;
  }
  if ($2 === a2 && n3.push(r2[a2]), f) {
    const t3 = n3.join("$$lit$$");
    void 0 === (r2 = l.get(t3)) && (n3.raw = n3, l.set(t3, r2 = n3)), e3 = u2;
  }
  return t2(r2, ...e3);
};
var u = n2(x);
var c = n2(b);
var $ = n2(w);

// src/components/button/button.ts
var WaButton = class extends WebAwesomeFormAssociatedElement {
  constructor() {
    super(...arguments);
    this.assumeInteractionOn = ["click"];
    this.hasSlotController = new HasSlotController(this, "[default]", "start", "end");
    this.localize = new LocalizeController(this);
    this.invalid = false;
    this.isIconButton = false;
    this.title = "";
    this.variant = "neutral";
    this.appearance = "accent";
    this.size = "m";
    this.withCaret = false;
    this.withStart = false;
    this.withEnd = false;
    this.disabled = false;
    this.loading = false;
    this.pill = false;
    this.type = "button";
  }
  static get validators() {
    return [...super.validators, MirrorValidator()];
  }
  handleSizeChange() {
    warnDeprecatedSize(this.localName, this.size);
  }
  constructLightDOMButton() {
    const button = document.createElement("button");
    for (const attribute of this.attributes) {
      if (attribute.name === "style") {
        continue;
      }
      button.setAttribute(attribute.name, attribute.value);
    }
    button.type = this.type;
    button.style.position = "absolute !important";
    button.style.width = "0 !important";
    button.style.height = "0 !important";
    button.style.clipPath = "inset(50%) !important";
    button.style.overflow = "hidden !important";
    button.style.whiteSpace = "nowrap !important";
    if (this.name) {
      button.name = this.name;
    }
    button.value = this.value || "";
    return button;
  }
  handleClick(event) {
    if (this.disabled || this.loading) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this.type !== "submit" && this.type !== "reset") {
      return;
    }
    const form = this.getForm();
    if (!form) return;
    const lightDOMButton = this.constructLightDOMButton();
    this.parentElement?.append(lightDOMButton);
    lightDOMButton.click();
    lightDOMButton.remove();
  }
  handleInvalid() {
    this.dispatchEvent(new WaInvalidEvent());
  }
  handleLabelSlotChange() {
    const nodes = this.labelSlot.assignedNodes({ flatten: true });
    let hasIconLabel = false;
    let hasIcon = false;
    let hasText = false;
    let hasOtherElements = false;
    [...nodes].forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (element.localName === "wa-icon") {
          hasIcon = true;
          if (!hasIconLabel) hasIconLabel = element.label !== void 0;
        } else {
          hasOtherElements = true;
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim() || "";
        if (text.length > 0) {
          hasText = true;
        }
      }
    });
    this.isIconButton = hasIcon && !hasText && !hasOtherElements;
    this.customStates.set("icon-button", this.isIconButton);
    if (this.isIconButton && !hasIconLabel) {
      console.warn(
        'Icon buttons must have a label for screen readers. Add <wa-icon label="..."> to remove this warning.',
        this
      );
    }
  }
  isButton() {
    return this.href ? false : true;
  }
  isLink() {
    return this.href ? true : false;
  }
  handleDisabledChange() {
    this.customStates.set("disabled", this.disabled);
    this.updateValidity();
  }
  handleHrefChange() {
    this.customStates.set("link", this.isLink());
  }
  handleLoadingChange() {
    this.customStates.set("loading", this.loading);
  }
  // eslint-disable-next-line
  setValue(..._args) {
  }
  /** Simulates a click on the button. */
  click() {
    this.button.click();
  }
  /** Sets focus on the button. */
  focus(options) {
    this.button.focus(options);
  }
  /** Removes focus from the button. */
  blur() {
    this.button.blur();
  }
  render() {
    const isLink = this.isLink();
    const tag = isLink ? i`a` : i`button`;
    return u`
      <${tag}
        part="base button"
        class=${e2({
      button: true,
      caret: this.withCaret,
      disabled: this.disabled,
      loading: this.loading,
      rtl: this.localize.dir() === "rtl",
      "has-label": this.hasSlotController.test("[default]"),
      "has-start": this.hasSlotController.test("start", "withStart"),
      "has-end": this.hasSlotController.test("end", "withEnd"),
      "is-icon-button": this.isIconButton
    })}
        ?disabled=${o(isLink ? void 0 : this.disabled)}
        type=${o(isLink ? void 0 : this.type)}
        title=${this.title}
        name=${o(isLink ? void 0 : this.name)}
        value=${o(isLink ? void 0 : this.value)}
        href=${o(isLink ? this.href : void 0)}
        target=${o(isLink ? this.target : void 0)}
        download=${o(isLink ? this.download : void 0)}
        rel=${o(isLink && this.rel ? this.rel : void 0)}
        role=${o(isLink ? void 0 : "button")}
        aria-disabled=${o(isLink && this.disabled ? "true" : void 0)}
        tabindex=${this.disabled ? "-1" : "0"}
        @invalid=${this.isButton() ? this.handleInvalid : null}
        @click=${this.handleClick}
      >
        <slot name="start" part="start" class="start"></slot>
        <slot part="label" class="label" @slotchange=${this.handleLabelSlotChange}></slot>
        <slot name="end" part="end" class="end"></slot>
        ${this.withCaret ? u`
                <wa-icon part="caret" class="caret" library="system" name="chevron-down" variant="solid"></wa-icon>
              ` : ""}
        ${this.loading ? u`<wa-spinner part="spinner"></wa-spinner>` : ""}
      </${tag}>
    `;
  }
};
WaButton.shadowRootOptions = { ...WebAwesomeFormAssociatedElement.shadowRootOptions, delegatesFocus: true };
WaButton.css = [button_styles_default, variants_styles_default, size_styles_default];
__decorateClass([
  e(".button")
], WaButton.prototype, "button", 2);
__decorateClass([
  e("slot:not([name])")
], WaButton.prototype, "labelSlot", 2);
__decorateClass([
  r()
], WaButton.prototype, "invalid", 2);
__decorateClass([
  r()
], WaButton.prototype, "isIconButton", 2);
__decorateClass([
  n()
], WaButton.prototype, "title", 2);
__decorateClass([
  n({ reflect: true })
], WaButton.prototype, "variant", 2);
__decorateClass([
  n({ reflect: true })
], WaButton.prototype, "appearance", 2);
__decorateClass([
  n({ reflect: true })
], WaButton.prototype, "size", 2);
__decorateClass([
  watch("size")
], WaButton.prototype, "handleSizeChange", 1);
__decorateClass([
  n({ attribute: "with-caret", type: Boolean, reflect: true })
], WaButton.prototype, "withCaret", 2);
__decorateClass([
  n({ attribute: "with-start", type: Boolean })
], WaButton.prototype, "withStart", 2);
__decorateClass([
  n({ attribute: "with-end", type: Boolean })
], WaButton.prototype, "withEnd", 2);
__decorateClass([
  n({ type: Boolean })
], WaButton.prototype, "disabled", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaButton.prototype, "loading", 2);
__decorateClass([
  n({ type: Boolean, reflect: true })
], WaButton.prototype, "pill", 2);
__decorateClass([
  n()
], WaButton.prototype, "type", 2);
__decorateClass([
  n({ reflect: true })
], WaButton.prototype, "name", 2);
__decorateClass([
  n({ reflect: true })
], WaButton.prototype, "value", 2);
__decorateClass([
  n({ reflect: true })
], WaButton.prototype, "href", 2);
__decorateClass([
  n()
], WaButton.prototype, "target", 2);
__decorateClass([
  n()
], WaButton.prototype, "rel", 2);
__decorateClass([
  n()
], WaButton.prototype, "download", 2);
__decorateClass([
  n({ attribute: "formaction" })
], WaButton.prototype, "formAction", 2);
__decorateClass([
  n({ attribute: "formenctype" })
], WaButton.prototype, "formEnctype", 2);
__decorateClass([
  n({ attribute: "formmethod" })
], WaButton.prototype, "formMethod", 2);
__decorateClass([
  n({ attribute: "formnovalidate", type: Boolean })
], WaButton.prototype, "formNoValidate", 2);
__decorateClass([
  n({ attribute: "formtarget" })
], WaButton.prototype, "formTarget", 2);
__decorateClass([
  watch("disabled", { waitUntilFirstUpdate: true })
], WaButton.prototype, "handleDisabledChange", 1);
__decorateClass([
  watch("href")
], WaButton.prototype, "handleHrefChange", 1);
__decorateClass([
  watch("loading", { waitUntilFirstUpdate: true })
], WaButton.prototype, "handleLoadingChange", 1);
WaButton = __decorateClass([
  t("wa-button")
], WaButton);
WaButton.disableWarning?.("change-in-update");

export {
  WaButton
};
/*! Bundled license information:

lit-html/static.js:
  (**
   * @license
   * Copyright 2020 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
