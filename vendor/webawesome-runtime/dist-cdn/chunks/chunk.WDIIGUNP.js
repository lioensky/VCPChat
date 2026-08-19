/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/load.ts
var WaLoadEvent = class extends Event {
  constructor() {
    super("wa-load", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaLoadEvent
};
