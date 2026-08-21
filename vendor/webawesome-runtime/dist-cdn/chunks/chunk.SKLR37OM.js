/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/tab-show.ts
var WaTabShowEvent = class extends Event {
  constructor(detail) {
    super("wa-tab-show", { bubbles: true, cancelable: false, composed: true });
    this.detail = detail;
  }
};

export {
  WaTabShowEvent
};
