import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeConfig } from "../src/config.js";

test("approval mode defaults to manual and trusted requires a pinned device", () => {
  const defaults = readRuntimeConfig({});
  assert.equal(defaults.approvalMode, "manual");
  assert.equal(defaults.serial, undefined);
  assert.equal(defaults.allowEmulator, false);
  assert.equal(readRuntimeConfig({ TAPPILOT_APPROVAL_MODE: "manual" }).approvalMode, "manual");

  const trusted = readRuntimeConfig({
    TAPPILOT_APPROVAL_MODE: "trusted", TAPPILOT_SERIAL: "  synthetic-test-phone  ",
    ADB_PATH: "/synthetic/adb", TAPPILOT_ALLOW_EMULATOR: "1",
  });
  assert.equal(trusted.approvalMode, "trusted");
  assert.equal(trusted.serial, "synthetic-test-phone");
  assert.equal(trusted.adbPath, "/synthetic/adb");
  assert.equal(trusted.allowEmulator, true);
});

test("unknown authorization modes and unpinned trusted startup fail closed", () => {
  for (const mode of ["", "auto", "TRUSTED", " trusted "]) {
    assert.throws(() => readRuntimeConfig({ TAPPILOT_APPROVAL_MODE: mode, TAPPILOT_SERIAL: "synthetic-test-phone" }), { code: "INVALID_CONFIGURATION" });
  }
  for (const serial of [undefined, "", " \t "]) {
    assert.throws(() => readRuntimeConfig({ TAPPILOT_APPROVAL_MODE: "trusted", TAPPILOT_SERIAL: serial }), { code: "INVALID_CONFIGURATION" });
  }
});
