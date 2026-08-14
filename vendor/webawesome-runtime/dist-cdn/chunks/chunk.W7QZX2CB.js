/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */
import {
  library_default_default
} from "./chunk.KKI7M5DP.js";
import {
  library_system_default
} from "./chunk.LDM2MW63.js";

// src/components/icon/library.ts
var defaultIconFamily = "classic";
var registry = [library_default_default, library_system_default];
var watchedIcons = /* @__PURE__ */ new Set();
function watchIcon(icon) {
  watchedIcons.add(icon);
}
function unwatchIcon(icon) {
  watchedIcons.delete(icon);
}
function getIconLibrary(name) {
  return registry.find((lib) => lib.name === name);
}
function registerIconLibrary(name, options) {
  unregisterIconLibrary(name);
  registry.push({
    name,
    resolver: options.resolver,
    mutator: options.mutator,
    spriteSheet: options.spriteSheet
  });
  watchedIcons.forEach((icon) => {
    if (icon.library === name) {
      icon.setIcon();
    }
  });
}
function unregisterIconLibrary(name) {
  registry = registry.filter((lib) => lib.name !== name);
}
function setDefaultIconFamily(family) {
  defaultIconFamily = family;
  watchedIcons.forEach((icon) => icon.setIcon());
}
function getDefaultIconFamily() {
  return defaultIconFamily;
}

export {
  watchIcon,
  unwatchIcon,
  getIconLibrary,
  registerIconLibrary,
  unregisterIconLibrary,
  setDefaultIconFamily,
  getDefaultIconFamily
};
