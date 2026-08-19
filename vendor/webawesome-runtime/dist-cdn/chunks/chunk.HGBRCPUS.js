/*! Copyright 2026 Fonticons, Inc. - https://webawesome.com/license */

// src/utilities/base-path.ts
var basePath = "";
var iconPath = "";
var kitCode = "";
function setBasePath(path) {
  basePath = path;
}
function getBasePath(subpath = "") {
  if (!basePath) {
    const el = document.querySelector("[data-webawesome]");
    if (el?.hasAttribute("data-webawesome")) {
      const rootRelativeUrl = new URL(el.getAttribute("data-webawesome") ?? "", window.location.href).pathname;
      setBasePath(rootRelativeUrl);
    } else {
      const scripts = [...document.getElementsByTagName("script")];
      const waScript = scripts.find(
        (script) => script.src.endsWith("webawesome.js") || script.src.endsWith("webawesome.loader.js") || script.src.endsWith("webawesome.ssr-loader.js")
      );
      if (waScript) {
        const path = String(waScript.getAttribute("src"));
        setBasePath(path.split("/").slice(0, -1).join("/"));
      }
    }
  }
  return basePath.replace(/\/$/, "") + (subpath ? `/${subpath.replace(/^\//, "")}` : ``);
}
function setIconPath(path) {
  iconPath = path;
}
function getIconPath() {
  return iconPath.replace(/\/$/, "");
}
function setKitCode(code) {
  kitCode = code;
}
function getKitCode() {
  if (!kitCode) {
    const el = document.querySelector("[data-fa-kit-code]");
    if (el) {
      setKitCode(el.getAttribute("data-fa-kit-code") || "");
    }
  }
  return kitCode;
}

export {
  setBasePath,
  getBasePath,
  setIconPath,
  getIconPath,
  setKitCode,
  getKitCode
};
