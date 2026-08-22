/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/after-show.ts
var WaAfterShowEvent = class extends Event {
  constructor() {
    super("wa-after-show", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaAfterShowEvent
};
