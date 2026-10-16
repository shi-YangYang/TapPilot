import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Adb, parseDevices } from "../src/adb.js";

test("device parsing distinguishes USB, network, emulator and unauthorized", () => {
  const devices = parseDevices("List of devices attached\nusb1 device usb:336592896X product:pixel model:Pixel_8 transport_id:1\n192.168.1.4:5555 device model:Pixel\nemulator-5554 device product:sdk\nusb2 unauthorized usb:123\n");
  assert.equal(devices.length, 4);
  assert.equal(devices[0]?.usb, true);
  assert.equal(devices[1]?.usb, false);
  assert.equal(devices[2]?.emulator, true);
  assert.equal(devices[3]?.state, "unauthorized");
});

test("ADB pins one device, rejects network and emulator by default, and forces local daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tappilot-adb-test-"));
  const state = join(directory, "devices.txt");
  const executable = join(directory, "adb-fixture");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv.slice(2,6).join(' ') !== '-H 127.0.0.1 -P 5037' || process.env.ADB_SERVER_SOCKET || process.env.ANDROID_ADB_SERVER_ADDRESS) process.exit(2);\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(state)},'utf8'));\n`, { mode: 0o700 });
  try {
    await writeFile(state, "usbA device usb:1\n");
    const adb = new Adb({ executable });
    assert.equal((await adb.select()).serial, "usbA");
    await writeFile(state, "usbB device usb:2\n");
    await assert.rejects(adb.select(), { code: "DEVICE_DISCONNECTED" });
    await writeFile(state, "1.2.3.4:5555 device\n");
    await assert.rejects(new Adb({ executable, serial: "1.2.3.4:5555" }).select(), { code: "DEVICE_TRANSPORT_DENIED" });
    await writeFile(state, "emulator-5554 device\n");
    await assert.rejects(new Adb({ executable }).select(), { code: "DEVICE_SELECTION_REQUIRED" });
    assert.equal((await new Adb({ executable, allowEmulator: true }).select()).serial, "emulator-5554");
    await writeFile(state, "usbA device usb:1\nusbB device usb:2\n");
    await assert.rejects(new Adb({ executable }).select(), { code: "DEVICE_SELECTION_REQUIRED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
