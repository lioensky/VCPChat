/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  B,
  T
} from "./chunk.BKE5EYM3.js";

// ../../node_modules/@lit/reactive-element/css-tag.js
var t = globalThis;
var e = t.ShadowRoot && (void 0 === t.ShadyCSS || t.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype;
var s = Symbol();
var o = /* @__PURE__ */ new WeakMap();
var n = class {
  constructor(t2, e3, o5) {
    if (this._$cssResult$ = true, o5 !== s) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    this.cssText = t2, this.t = e3;
  }
  get styleSheet() {
    let t2 = this.o;
    const s3 = this.t;
    if (e && void 0 === t2) {
      const e3 = void 0 !== s3 && 1 === s3.length;
      e3 && (t2 = o.get(s3)), void 0 === t2 && ((this.o = t2 = new CSSStyleSheet()).replaceSync(this.cssText), e3 && o.set(s3, t2));
    }
    return t2;
  }
  toString() {
    return this.cssText;
  }
};
var r = (t2) => new n("string" == typeof t2 ? t2 : t2 + "", void 0, s);
var i = (t2, ...e3) => {
  const o5 = 1 === t2.length ? t2[0] : e3.reduce(((e4, s3, o6) => e4 + ((t3) => {
    if (true === t3._$cssResult$) return t3.cssText;
    if ("number" == typeof t3) return t3;
    throw Error("Value passed to 'css' function must be a 'css' function result: " + t3 + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
  })(s3) + t2[o6 + 1]), t2[0]);
  return new n(o5, t2, s);
};
var S = (s3, o5) => {
  if (e) s3.adoptedStyleSheets = o5.map(((t2) => t2 instanceof CSSStyleSheet ? t2 : t2.styleSheet));
  else for (const e3 of o5) {
    const o6 = document.createElement("style"), n4 = t.litNonce;
    void 0 !== n4 && o6.setAttribute("nonce", n4), o6.textContent = e3.cssText, s3.appendChild(o6);
  }
};
var c = e ? (t2) => t2 : (t2) => t2 instanceof CSSStyleSheet ? ((t3) => {
  let e3 = "";
  for (const s3 of t3.cssRules) e3 += s3.cssText;
  return r(e3);
})(t2) : t2;

// ../../node_modules/@lit/reactive-element/reactive-element.js
var { is: i2, defineProperty: e2, getOwnPropertyDescriptor: h, getOwnPropertyNames: r2, getOwnPropertySymbols: o2, getPrototypeOf: n2 } = Object;
var a = globalThis;
var c2 = a.trustedTypes;
var l = c2 ? c2.emptyScript : "";
var p = a.reactiveElementPolyfillSupport;
var d = (t2, s3) => t2;
var u = { toAttribute(t2, s3) {
  switch (s3) {
    case Boolean:
      t2 = t2 ? l : null;
      break;
    case Object:
    case Array:
      t2 = null == t2 ? t2 : JSON.stringify(t2);
  }
  return t2;
}, fromAttribute(t2, s3) {
  let i4 = t2;
  switch (s3) {
    case Boolean:
      i4 = null !== t2;
      break;
    case Number:
      i4 = null === t2 ? null : Number(t2);
      break;
    case Object:
    case Array:
      try {
        i4 = JSON.parse(t2);
      } catch (t3) {
        i4 = null;
      }
  }
  return i4;
} };
var f = (t2, s3) => !i2(t2, s3);
var b = { attribute: true, type: String, converter: u, reflect: false, useDefault: false, hasChanged: f };
Symbol.metadata ?? (Symbol.metadata = Symbol("metadata")), a.litPropertyMetadata ?? (a.litPropertyMetadata = /* @__PURE__ */ new WeakMap());
var y = class extends HTMLElement {
  static addInitializer(t2) {
    this._$Ei(), (this.l ?? (this.l = [])).push(t2);
  }
  static get observedAttributes() {
    return this.finalize(), this._$Eh && [...this._$Eh.keys()];
  }
  static createProperty(t2, s3 = b) {
    if (s3.state && (s3.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t2) && ((s3 = Object.create(s3)).wrapped = true), this.elementProperties.set(t2, s3), !s3.noAccessor) {
      const i4 = Symbol(), h2 = this.getPropertyDescriptor(t2, i4, s3);
      void 0 !== h2 && e2(this.prototype, t2, h2);
    }
  }
  static getPropertyDescriptor(t2, s3, i4) {
    const { get: e3, set: r3 } = h(this.prototype, t2) ?? { get() {
      return this[s3];
    }, set(t3) {
      this[s3] = t3;
    } };
    return { get: e3, set(s4) {
      const h2 = e3?.call(this);
      r3?.call(this, s4), this.requestUpdate(t2, h2, i4);
    }, configurable: true, enumerable: true };
  }
  static getPropertyOptions(t2) {
    return this.elementProperties.get(t2) ?? b;
  }
  static _$Ei() {
    if (this.hasOwnProperty(d("elementProperties"))) return;
    const t2 = n2(this);
    t2.finalize(), void 0 !== t2.l && (this.l = [...t2.l]), this.elementProperties = new Map(t2.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(d("finalized"))) return;
    if (this.finalized = true, this._$Ei(), this.hasOwnProperty(d("properties"))) {
      const t3 = this.properties, s3 = [...r2(t3), ...o2(t3)];
      for (const i4 of s3) this.createProperty(i4, t3[i4]);
    }
    const t2 = this[Symbol.metadata];
    if (null !== t2) {
      const s3 = litPropertyMetadata.get(t2);
      if (void 0 !== s3) for (const [t3, i4] of s3) this.elementProperties.set(t3, i4);
    }
    this._$Eh = /* @__PURE__ */ new Map();
    for (const [t3, s3] of this.elementProperties) {
      const i4 = this._$Eu(t3, s3);
      void 0 !== i4 && this._$Eh.set(i4, t3);
    }
    this.elementStyles = this.finalizeStyles(this.styles);
  }
  static finalizeStyles(s3) {
    const i4 = [];
    if (Array.isArray(s3)) {
      const e3 = new Set(s3.flat(1 / 0).reverse());
      for (const s4 of e3) i4.unshift(c(s4));
    } else void 0 !== s3 && i4.push(c(s3));
    return i4;
  }
  static _$Eu(t2, s3) {
    const i4 = s3.attribute;
    return false === i4 ? void 0 : "string" == typeof i4 ? i4 : "string" == typeof t2 ? t2.toLowerCase() : void 0;
  }
  constructor() {
    super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
  }
  _$Ev() {
    this._$ES = new Promise(((t2) => this.enableUpdating = t2)), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach(((t2) => t2(this)));
  }
  addController(t2) {
    (this._$EO ?? (this._$EO = /* @__PURE__ */ new Set())).add(t2), void 0 !== this.renderRoot && this.isConnected && t2.hostConnected?.();
  }
  removeController(t2) {
    this._$EO?.delete(t2);
  }
  _$E_() {
    const t2 = /* @__PURE__ */ new Map(), s3 = this.constructor.elementProperties;
    for (const i4 of s3.keys()) this.hasOwnProperty(i4) && (t2.set(i4, this[i4]), delete this[i4]);
    t2.size > 0 && (this._$Ep = t2);
  }
  createRenderRoot() {
    const t2 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    return S(t2, this.constructor.elementStyles), t2;
  }
  connectedCallback() {
    this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this.enableUpdating(true), this._$EO?.forEach(((t2) => t2.hostConnected?.()));
  }
  enableUpdating(t2) {
  }
  disconnectedCallback() {
    this._$EO?.forEach(((t2) => t2.hostDisconnected?.()));
  }
  attributeChangedCallback(t2, s3, i4) {
    this._$AK(t2, i4);
  }
  _$ET(t2, s3) {
    const i4 = this.constructor.elementProperties.get(t2), e3 = this.constructor._$Eu(t2, i4);
    if (void 0 !== e3 && true === i4.reflect) {
      const h2 = (void 0 !== i4.converter?.toAttribute ? i4.converter : u).toAttribute(s3, i4.type);
      this._$Em = t2, null == h2 ? this.removeAttribute(e3) : this.setAttribute(e3, h2), this._$Em = null;
    }
  }
  _$AK(t2, s3) {
    const i4 = this.constructor, e3 = i4._$Eh.get(t2);
    if (void 0 !== e3 && this._$Em !== e3) {
      const t3 = i4.getPropertyOptions(e3), h2 = "function" == typeof t3.converter ? { fromAttribute: t3.converter } : void 0 !== t3.converter?.fromAttribute ? t3.converter : u;
      this._$Em = e3, this[e3] = h2.fromAttribute(s3, t3.type) ?? this._$Ej?.get(e3) ?? null, this._$Em = null;
    }
  }
  requestUpdate(t2, s3, i4) {
    if (void 0 !== t2) {
      const e3 = this.constructor, h2 = this[t2];
      if (i4 ?? (i4 = e3.getPropertyOptions(t2)), !((i4.hasChanged ?? f)(h2, s3) || i4.useDefault && i4.reflect && h2 === this._$Ej?.get(t2) && !this.hasAttribute(e3._$Eu(t2, i4)))) return;
      this.C(t2, s3, i4);
    }
    false === this.isUpdatePending && (this._$ES = this._$EP());
  }
  C(t2, s3, { useDefault: i4, reflect: e3, wrapped: h2 }, r3) {
    i4 && !(this._$Ej ?? (this._$Ej = /* @__PURE__ */ new Map())).has(t2) && (this._$Ej.set(t2, r3 ?? s3 ?? this[t2]), true !== h2 || void 0 !== r3) || (this._$AL.has(t2) || (this.hasUpdated || i4 || (s3 = void 0), this._$AL.set(t2, s3)), true === e3 && this._$Em !== t2 && (this._$Eq ?? (this._$Eq = /* @__PURE__ */ new Set())).add(t2));
  }
  async _$EP() {
    this.isUpdatePending = true;
    try {
      await this._$ES;
    } catch (t3) {
      Promise.reject(t3);
    }
    const t2 = this.scheduleUpdate();
    return null != t2 && await t2, !this.isUpdatePending;
  }
  scheduleUpdate() {
    return this.performUpdate();
  }
  performUpdate() {
    if (!this.isUpdatePending) return;
    if (!this.hasUpdated) {
      if (this.renderRoot ?? (this.renderRoot = this.createRenderRoot()), this._$Ep) {
        for (const [t4, s4] of this._$Ep) this[t4] = s4;
        this._$Ep = void 0;
      }
      const t3 = this.constructor.elementProperties;
      if (t3.size > 0) for (const [s4, i4] of t3) {
        const { wrapped: t4 } = i4, e3 = this[s4];
        true !== t4 || this._$AL.has(s4) || void 0 === e3 || this.C(s4, void 0, i4, e3);
      }
    }
    let t2 = false;
    const s3 = this._$AL;
    try {
      t2 = this.shouldUpdate(s3), t2 ? (this.willUpdate(s3), this._$EO?.forEach(((t3) => t3.hostUpdate?.())), this.update(s3)) : this._$EM();
    } catch (s4) {
      throw t2 = false, this._$EM(), s4;
    }
    t2 && this._$AE(s3);
  }
  willUpdate(t2) {
  }
  _$AE(t2) {
    this._$EO?.forEach(((t3) => t3.hostUpdated?.())), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t2)), this.updated(t2);
  }
  _$EM() {
    this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this._$ES;
  }
  shouldUpdate(t2) {
    return true;
  }
  update(t2) {
    this._$Eq && (this._$Eq = this._$Eq.forEach(((t3) => this._$ET(t3, this[t3])))), this._$EM();
  }
  updated(t2) {
  }
  firstUpdated(t2) {
  }
};
y.elementStyles = [], y.shadowRootOptions = { mode: "open" }, y[d("elementProperties")] = /* @__PURE__ */ new Map(), y[d("finalized")] = /* @__PURE__ */ new Map(), p?.({ ReactiveElement: y }), (a.reactiveElementVersions ?? (a.reactiveElementVersions = [])).push("2.1.0");

// ../../node_modules/lit-html/is-server.js
var o3 = false;

// ../../node_modules/lit-element/lit-element.js
var s2 = globalThis;
var i3 = class extends y {
  constructor() {
    super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
  }
  createRenderRoot() {
    var _a;
    const t2 = super.createRenderRoot();
    return (_a = this.renderOptions).renderBefore ?? (_a.renderBefore = t2.firstChild), t2;
  }
  update(t2) {
    const r3 = this.render();
    this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t2), this._$Do = B(r3, this.renderRoot, this.renderOptions);
  }
  connectedCallback() {
    super.connectedCallback(), this._$Do?.setConnected(true);
  }
  disconnectedCallback() {
    super.disconnectedCallback(), this._$Do?.setConnected(false);
  }
  render() {
    return T;
  }
};
i3._$litElement$ = true, i3["finalized"] = true, s2.litElementHydrateSupport?.({ LitElement: i3 });
var o4 = s2.litElementPolyfillSupport;
o4?.({ LitElement: i3 });
var n3 = { _$AK: (t2, e3, r3) => {
  t2._$AK(e3, r3);
}, _$AL: (t2) => t2._$AL };
(s2.litElementVersions ?? (s2.litElementVersions = [])).push("4.2.0");

export {
  i,
  u,
  f,
  y,
  i3 as i2,
  n3 as n,
  o3 as o
};
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-element/lit-element.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
