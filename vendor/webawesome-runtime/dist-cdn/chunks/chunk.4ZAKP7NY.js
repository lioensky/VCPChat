/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/show.ts
var WaShowEvent = class extends Event {
  constructor() {
    super("wa-show", { bubbles: true, cancelable: true, composed: true });
  }
};

export {
  WaShowEvent
};
