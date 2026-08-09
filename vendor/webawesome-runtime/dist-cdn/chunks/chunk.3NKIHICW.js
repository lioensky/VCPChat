/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/after-hide.ts
var WaAfterHideEvent = class extends Event {
  constructor() {
    super("wa-after-hide", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaAfterHideEvent
};
