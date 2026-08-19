/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/reposition.ts
var WaRepositionEvent = class extends Event {
  constructor() {
    super("wa-reposition", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaRepositionEvent
};
