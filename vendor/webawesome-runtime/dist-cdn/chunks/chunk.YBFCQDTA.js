/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/tab-hide.ts
var WaTabHideEvent = class extends Event {
  constructor(detail) {
    super("wa-tab-hide", { bubbles: true, cancelable: false, composed: true });
    this.detail = detail;
  }
};

export {
  WaTabHideEvent
};
