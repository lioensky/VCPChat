/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/events/clear.ts
var WaClearEvent = class extends Event {
  constructor() {
    super("wa-clear", { bubbles: true, cancelable: false, composed: true });
  }
};

export {
  WaClearEvent
};
