/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  WaErrorEvent
} from "./chunk.YDQCS2HK.js";
import {
  WaLoadEvent
} from "./chunk.WDIIGUNP.js";
import {
  icon_styles_default
} from "./chunk.WLKYECLX.js";
import {
  watch
} from "./chunk.PZAN6FPN.js";
import {
  WebAwesomeElement,
  n,
  r,
  t
} from "./chunk.LBLI4KS5.js";
import {
  e
} from "./chunk.EFUXUR2V.js";
import {
  getDefaultIconFamily,
  getIconLibrary,
  unwatchIcon,
  watchIcon
} from "./chunk.W7QZX2CB.js";
import {
  x
} from "./chunk.BKE5EYM3.js";
import {
  __decorateClass
} from "./chunk.JHZRD2LV.js";

// src/components/icon/icon.ts
var CACHEABLE_ERROR = Symbol();
var RETRYABLE_ERROR = Symbol();
var parser;
var iconCache = /* @__PURE__ */ new Map();
var WaIcon = class extends WebAwesomeElement {
  constructor() {
    super(...arguments);
    this.svg = null;
    this.autoWidth = false;
    this.swapOpacity = false;
    this.label = "";
    this.library = "default";
    this.rotate = 0;
    /** Given a URL, this function returns the resulting SVG element or an appropriate error symbol. */
    this.resolveIcon = async (url, library) => {
      let fileData;
      if (library?.spriteSheet) {
        if (!this.hasUpdated) {
          await this.updateComplete;
        }
        this.svg = x`<svg part="svg">
        <use part="use" href="${url}"></use>
      </svg>`;
        await this.updateComplete;
        const svg = this.shadowRoot.querySelector("[part='svg']");
        if (typeof library.mutator === "function") {
          library.mutator(svg, this);
        }
        return this.svg;
      }
      try {
        fileData = await fetch(url, { mode: "cors" });
        if (!fileData.ok) return fileData.status === 410 ? CACHEABLE_ERROR : RETRYABLE_ERROR;
      } catch {
        return RETRYABLE_ERROR;
      }
      try {
        const div = document.createElement("div");
        div.innerHTML = await fileData.text();
        const svg = div.firstElementChild;
        if (svg?.tagName?.toLowerCase() !== "svg") return CACHEABLE_ERROR;
        if (!parser) parser = new DOMParser();
        const doc = parser.parseFromString(svg.outerHTML, "text/html");
        const svgEl = doc.body.querySelector("svg");
        if (!svgEl) return CACHEABLE_ERROR;
        svgEl.part.add("svg");
        return document.adoptNode(svgEl);
      } catch {
        return CACHEABLE_ERROR;
      }
    };
  }
  connectedCallback() {
    super.connectedCallback();
    watchIcon(this);
  }
  firstUpdated(changedProperties) {
    super.firstUpdated(changedProperties);
    if (this.hasAttribute("rotate")) {
      this.style.setProperty("--rotate-angle", `${this.rotate}deg`);
    }
    this.setIcon();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    unwatchIcon(this);
  }
  async getIconSource() {
    const library = getIconLibrary(this.library);
    const family = this.family || getDefaultIconFamily();
    if (this.name && library) {
      const autoWidth = this.canvas === "auto" || this.autoWidth;
      let url;
      try {
        url = await library.resolver(this.name, family, this.variant, autoWidth);
      } catch {
        url = void 0;
      }
      return { url, fromLibrary: true };
    }
    return {
      url: this.src,
      fromLibrary: false
    };
  }
  handleLabelChange() {
    const hasLabel = typeof this.label === "string" && this.label.length > 0;
    if (hasLabel) {
      this.setAttribute("role", "img");
      this.setAttribute("aria-label", this.label);
      this.removeAttribute("aria-hidden");
    } else {
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
      this.setAttribute("aria-hidden", "true");
    }
  }
  async setIcon() {
    const { url, fromLibrary } = await this.getIconSource();
    const library = fromLibrary ? getIconLibrary(this.library) : void 0;
    if (!url) {
      this.svg = null;
      return;
    }
    let iconResolver = iconCache.get(url);
    if (!iconResolver) {
      iconResolver = this.resolveIcon(url, library);
      iconCache.set(url, iconResolver);
    }
    const svg = await iconResolver;
    if (svg === RETRYABLE_ERROR) {
      iconCache.delete(url);
    }
    const sourceAfterFetch = await this.getIconSource();
    if (url !== sourceAfterFetch.url) {
      return;
    }
    if (e(svg)) {
      this.svg = svg;
      return;
    }
    switch (svg) {
      case RETRYABLE_ERROR:
      case CACHEABLE_ERROR:
        this.svg = null;
        this.dispatchEvent(new WaErrorEvent());
        break;
      default:
        this.svg = svg.cloneNode(true);
        library?.mutator?.(this.svg, this);
        this.dispatchEvent(new WaLoadEvent());
    }
  }
  willUpdate(changedProperties) {
    if (!this.style) {
      this.setStyleProperty("--rotate-angle", `${this.rotate}deg`);
    }
    return super.willUpdate(changedProperties);
  }
  updated(changedProperties) {
    super.updated(changedProperties);
    const library = getIconLibrary(this.library);
    if (this.hasAttribute("rotate")) {
      this.style.setProperty("--rotate-angle", `${this.rotate}deg`);
    }
    const svg = this.shadowRoot?.querySelector("svg");
    if (svg) {
      library?.mutator?.(svg, this);
    }
  }
  render() {
    if (this.hasUpdated) {
      return this.svg;
    }
    return x`<svg part="svg" width="16" height="16" viewBox="0 0 16 16"></svg>`;
  }
};
WaIcon.css = icon_styles_default;
__decorateClass([
  r()
], WaIcon.prototype, "svg", 2);
__decorateClass([
  n({ reflect: true })
], WaIcon.prototype, "name", 2);
__decorateClass([
  n({ reflect: true })
], WaIcon.prototype, "family", 2);
__decorateClass([
  n({ reflect: true })
], WaIcon.prototype, "variant", 2);
__decorateClass([
  n({ reflect: true })
], WaIcon.prototype, "canvas", 2);
__decorateClass([
  n({ attribute: "auto-width", type: Boolean, reflect: true })
], WaIcon.prototype, "autoWidth", 2);
__decorateClass([
  n({ attribute: "swap-opacity", type: Boolean, reflect: true })
], WaIcon.prototype, "swapOpacity", 2);
__decorateClass([
  n()
], WaIcon.prototype, "src", 2);
__decorateClass([
  n()
], WaIcon.prototype, "label", 2);
__decorateClass([
  n({ reflect: true })
], WaIcon.prototype, "library", 2);
__decorateClass([
  n({ type: Number, reflect: true })
], WaIcon.prototype, "rotate", 2);
__decorateClass([
  n({ type: String, reflect: true })
], WaIcon.prototype, "flip", 2);
__decorateClass([
  n({ type: String, reflect: true })
], WaIcon.prototype, "animation", 2);
__decorateClass([
  watch("label")
], WaIcon.prototype, "handleLabelChange", 1);
__decorateClass([
  watch(["family", "name", "library", "variant", "src", "autoWidth", "canvas", "swapOpacity"], {
    waitUntilFirstUpdate: true
  })
], WaIcon.prototype, "setIcon", 1);
WaIcon = __decorateClass([
  t("wa-icon")
], WaIcon);

export {
  WaIcon
};
