"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("Electron Builder packages the MobileSync/CDS runtime chain", () => {
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
});
