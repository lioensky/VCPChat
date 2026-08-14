/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/invalid.ts
var WaInvalidEvent = class extends Event {
  constructor() {
    super("wa-invalid", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaInvalidEvent
};
