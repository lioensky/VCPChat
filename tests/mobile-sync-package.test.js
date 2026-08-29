"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("Electron Builder allowlist includes the complete MobileSync/CDS runtime chain", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const files = new Set(packageJson.build?.files || []);
  for (const required of [
    "VCPDistributedServer/VCPDistributedServer.js",
    "VCPDistributedServer/Plugin.js",
    "VCPDistributedServer/Plugin/VCPMobileSync/**/*",
    "modules/**/*",
  ]) {
    assert.equal(files.has(required), true, `missing build.files entry ${required}`);
  }
  assert.equal(
    (packageJson.build?.asarUnpack || []).includes(
      "modules/services/chatDataService/bin/**/*",
    ),
    true,
  );
  const buildRuntime = fs.readFileSync(
    path.join(ROOT, "rust_chat_data_service", "build-runtime.js"),
    "utf8",
  );
  assert.match(buildRuntime, /'build', '--release', '--locked'/);
  for (const relativePath of [
    "VCPDistributedServer/VCPDistributedServer.js",
    "VCPDistributedServer/Plugin.js",
    "VCPDistributedServer/Plugin/VCPMobileSync/index.js",
    "VCPDistributedServer/Plugin/VCPMobileSync/sync/canonical.js",
    "rust_chat_data_service/Cargo.lock",
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, relativePath)),
      true,
      `source package file is missing: ${relativePath}`,
    );
  }
});
