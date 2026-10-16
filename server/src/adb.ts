import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface Device {
  serial: string;
  state: string;
  usb: boolean;
  emulator: boolean;
  model?: string;
}

export interface AdbOptions {
  executable?: string;
  serial?: string;
  allowEmulator?: boolean;
}

export function parseDevices(output: string): Device[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+(device|offline|unauthorized|no permissions)(?:\s+(.*))?$/.exec(line.trim());
    if (!match) return [];
    const [, serial, state, properties = ""] = match;
    if (!serial || !state) return [];
    return [{ serial, state, usb: /(?:^|\s)usb:\S+/.test(properties),
      emulator: /^emulator-\d+$/.test(serial),
      model: /(?:^|\s)model:(\S+)/.exec(properties)?.[1] }];
  });
}

export class Adb {
  private pinnedSerial?: string;
  private port?: number;
  private connecting?: Promise<number>;
  private closing = false;

  constructor(private readonly options: AdbOptions = {}) {}

  get selectedSerial(): string | undefined { return this.pinnedSerial; }

  private async run(args: string[]): Promise<string> {
    try {
      const env = { ...process.env };
      delete env.ADB_SERVER_SOCKET;
      delete env.ANDROID_ADB_SERVER_ADDRESS;
      delete env.ANDROID_ADB_SERVER_PORT;
      const { stdout } = await execFileAsync(this.options.executable ?? "adb", ["-H", "127.0.0.1", "-P", "5037", ...args], {
        timeout: 8_000, maxBuffer: 128 * 1024, encoding: "utf8", windowsHide: true,
        env,
      });
      return stdout.trim();
    } catch {
      // Do not propagate adb's raw stdout/stderr (which can contain device data).
      throw new AgentError("ADB_FAILED", "ADB failed or timed out. Check ADB_PATH, USB authorization and adb devices -l.", true);
    }
  }

  async devices(): Promise<Device[]> { return parseDevices(await this.run(["devices", "-l"])); }

  async select(): Promise<Device> {
    const devices = await this.devices();
    const wanted = this.pinnedSerial ?? this.options.serial;
    const allowed = (d: Device) => d.usb || (this.options.allowEmulator === true && d.emulator);
    let device: Device | undefined;
    if (wanted) {
      device = devices.find((d) => d.serial === wanted);
      if (!device) throw new AgentError("DEVICE_DISCONNECTED", "The configured or pinned device is disconnected. No fallback device will be selected.", true);
      if (device.state !== "device") throw new AgentError("DEVICE_UNAVAILABLE", "The selected device is offline or not USB-authorized.", true);
      if (!allowed(device)) throw new AgentError("DEVICE_TRANSPORT_DENIED", "Only USB devices are allowed. Emulators require TAPPILOT_ALLOW_EMULATOR=1; network ADB is unsupported.");
    } else {
      const candidates = devices.filter((d) => d.state === "device" && allowed(d));
      if (candidates.length !== 1) throw new AgentError("DEVICE_SELECTION_REQUIRED", "Connect exactly one authorized USB device or set TAPPILOT_SERIAL. Network ADB is unsupported.", true);
      device = candidates[0]!;
    }
    this.pinnedSerial = device.serial;
    return device;
  }

  async ensureForward(): Promise<number> {
    if (this.closing) throw new AgentError("SHUTTING_DOWN", "MCP server is shutting down.");
    if (this.connecting) return this.connecting;
    this.connecting = this.connectForward();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }

  private async verifyLoopback(port: number): Promise<void> {
    try {
      const { stdout } = await execFileAsync("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], {
        timeout: 3_000, maxBuffer: 32 * 1024, encoding: "utf8",
      });
      const addresses = stdout.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
      if (addresses.length && addresses.every((address) => address === `127.0.0.1:${port}` || address === `[::1]:${port}`)) return;
    } catch { /* Missing lsof and invisible/wildcard listeners both fail closed. */ }
    throw new AgentError("UNSAFE_ADB_LISTENER", "Cannot verify a loopback-only ADB forward. Ensure lsof is installed and restart ADB without -a.");
  }

  private async connectForward(): Promise<number> {
    const device = await this.select();
    if (this.port !== undefined) {
      // ADB can lose forwards across disconnects. Check ownership before using or recreating one.
      const forwards = await this.run(["forward", "--list"]);
      if (forwards.split(/\r?\n/).some((line) => line.trim() === `${device.serial} tcp:${this.port} localabstract:tappilot`)) {
        await this.verifyLoopback(this.port);
        return this.port;
      }
      this.port = undefined;
    }
    const value = await this.run(["-s", device.serial, "forward", "tcp:0", "localabstract:tappilot"]);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      throw new AgentError("ADB_PROTOCOL_ERROR", "ADB did not return a valid dynamically allocated local port.");
    }
    this.port = Number(value);
    try { await this.verifyLoopback(this.port); } catch (error) {
      await this.run(["-s", device.serial, "forward", "--remove", `tcp:${this.port}`]).catch(() => undefined);
      this.port = undefined;
      throw error;
    }
    return this.port;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.connecting?.catch(() => undefined);
    if (this.port === undefined || !this.pinnedSerial) return;
    const port = this.port;
    this.port = undefined;
    try {
      const forwards = await this.run(["forward", "--list"]);
      const owned = `${this.pinnedSerial} tcp:${port} localabstract:tappilot`;
      if (forwards.split(/\r?\n/).some((line) => line.trim() === owned)) {
        await this.run(["-s", this.pinnedSerial, "forward", "--remove", `tcp:${port}`]);
      }
    } catch { /* Never remove another process's forward to recover from an ADB error. */ }
  }
}
