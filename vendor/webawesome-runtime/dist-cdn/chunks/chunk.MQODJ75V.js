/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/hide.ts
var WaHideEvent = class extends Event {
  constructor(detail) {
    super("wa-hide", { bubbles: true, cancelable: true, composed: true });
    this.detail = detail;
  }
};

export {
  WaHideEvent
};
