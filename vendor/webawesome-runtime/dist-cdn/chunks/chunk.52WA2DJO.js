/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/internal/dismissible-stack.ts
var dismissibleStack = [];
function registerDismissible(key) {
  dismissibleStack.push(key);
}
function unregisterDismissible(key) {
  for (let i = dismissibleStack.length - 1; i >= 0; i--) {
    if (dismissibleStack[i] === key) {
      dismissibleStack.splice(i, 1);
      break;
    }
  }
}
function isTopDismissible(key) {
  return dismissibleStack.length > 0 && dismissibleStack[dismissibleStack.length - 1] === key;
}

export {
  registerDismissible,
  unregisterDismissible,
  isTopDismissible
};
