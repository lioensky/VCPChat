/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/remove.ts
var WaRemoveEvent = class extends Event {
  constructor() {
    super("wa-remove", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaRemoveEvent
};
