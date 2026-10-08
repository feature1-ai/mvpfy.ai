import * as fs from 'node:fs';
import * as path from 'node:path';
import { IS_WIN, shellQuote, spawnShellSync } from './shell';

/**
 * The phones this machine can pretend to be.
 *
 * Running a phone app needs somewhere to run it, and there are three answers
 * of very different cost. A simulator that is already installed costs seconds
 * to boot. A real phone on the same network costs a QR code. An SDK that is
 * not here costs several gigabytes and a licence agreement, and is the
 * builder's decision rather than something to start on their behalf.
 *
 * Asked rather than assumed, because the difference decides what mvpfy should
 * offer: a button that boots a simulator the builder already has is worth far
 * more than instructions, and a button that cannot work is worth less than
 * nothing.
 */

export interface SimulatorTargets {
  /** iOS simulator device names, newest runtime first. macOS only. */
  ios: string[];
  /** Android virtual devices that exist on this machine. */
  android: string[];
  /**
   * Phones and running emulators adb can see right now, with the model name
   * where it can be read. A serial is not something anybody recognises as
   * their own phone; "Pixel 7" is.
   */
  devices: Array<{ serial: string; label: string }>;
}

/**
 * iPhone and iPad names out of `simctl list devices available -j`.
 *
 * Only the available ones: simctl lists devices whose runtime is missing too,
 * and booting one of those fails with a message about a runtime rather than
 * anything a product manager could act on.
 */
export function parseIosSimulators(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const byRuntime = (parsed as { devices?: Record<string, unknown> })?.devices;
  if (!byRuntime || typeof byRuntime !== 'object') return [];
  const out: string[] = [];
  // Newest runtime first: the key carries the version, so sorting them
  // backwards puts iOS-18 ahead of iOS-16 without parsing the version.
  for (const runtime of Object.keys(byRuntime).sort().reverse()) {
    const list = (byRuntime as Record<string, unknown>)[runtime];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const device = (entry ?? {}) as Record<string, unknown>;
      if (device.isAvailable === false) continue;
      const name = typeof device.name === 'string' ? device.name.trim() : '';
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** AVD names out of `emulator -list-avds`, which prints one per line. */
export function parseAvds(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(INFO|WARNING|ERROR)\b/i.test(line));
}

/**
 * Serials out of `adb devices`. Anything not in state `device` is skipped —
 * an unauthorised phone is one the builder has not tapped "trust" on yet, and
 * installing to it fails in a way that reads as mvpfy being broken.
 */
export function parseAdbDevices(text: string): string[] {
  return text
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
}

/** A device's own name for itself, when adb will say. */
export function deviceLabel(serial: string, model: string): string {
  const name = model.trim();
  return name && /^[\w .+-]{1,40}$/.test(name) ? `${name} (${serial})` : serial;
}

/**
 * Where to look for the Android tools, in order. What somebody set themselves
 * comes first, because they meant it; then where Android Studio puts the SDK
 * when nobody tells it otherwise.
 */
export function androidSdkRoots(env: NodeJS.ProcessEnv, platform: string): string[] {
  // The platform asked about, not the one this is running on: these take a
  // platform argument so they can be checked for every machine from any of
  // them, and joining with the host's separator makes that a lie.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const home = env.HOME || env.USERPROFILE || '';
  const fallback =
    platform === 'win32'
      ? join(env.LOCALAPPDATA || home, 'Android', 'Sdk')
      : platform === 'darwin'
        ? join(home, 'Library', 'Android', 'sdk')
        : join(home, 'Android', 'Sdk');
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, fallback].filter((root): root is string =>
    Boolean(root && root.trim())
  );
}

/**
 * The first of those roots that actually holds the tool.
 *
 * Resolved in Node rather than by chaining `||` in a shell, which was the
 * first attempt and was wrong twice over: the arguments attach only to the
 * last alternative in the chain, and `2>/dev/null` is not a thing on Windows.
 */
export function androidToolPath(
  tool: 'adb' | 'emulator',
  roots: string[],
  exists: (path: string) => boolean,
  platform: string = process.platform
): string | null {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const dir = tool === 'adb' ? 'platform-tools' : 'emulator';
  const file = platform === 'win32' ? `${tool}.exe` : tool;
  for (const root of roots) {
    const full = join(root, dir, file);
    if (exists(full)) return full;
  }
  return null;
}

const ask = (command: string): string => {
  const res = spawnShellSync(command, { encoding: 'utf8', timeout: 20_000 });
  return res.status === 0 ? res.stdout : '';
};

/**
 * `adb` and `emulator`, wherever they are.
 *
 * Neither is on PATH after a default Android Studio install — they live in the
 * SDK, and putting them on PATH is something a developer does to their shell
 * profile one day and forgets. Asking the shell for a bare `adb` therefore
 * finds nothing on a machine with a phone plugged into it, which is precisely
 * the machine that has one.
 */
function androidTool(tool: 'adb' | 'emulator'): string | null {
  const probe = IS_WIN ? `where ${tool}` : `command -v ${tool}`;
  if (spawnShellSync(probe, { encoding: 'utf8', timeout: 10_000 }).status === 0) return tool;
  const found = androidToolPath(tool, androidSdkRoots(process.env, process.platform), (p) =>
    fs.existsSync(p)
  );
  return found ? shellQuote(found) : null;
}

/** What this machine can run a phone app on, right now. */
export function simulatorTargets(): SimulatorTargets {
  const ios =
    process.platform === 'darwin'
      ? parseIosSimulators(ask('xcrun simctl list devices available -j'))
      : [];
  const emulator = androidTool('emulator');
  const adb = androidTool('adb');
  const android = emulator ? parseAvds(ask(`${emulator} -list-avds`)) : [];
  const devices = adb
    ? parseAdbDevices(ask(`${adb} devices`)).map((serial) => ({
        serial,
        label: deviceLabel(
          serial,
          ask(`${adb} -s ${shellQuote(serial)} shell getprop ro.product.model`)
        ),
      }))
    : [];
  return { ios, android, devices };
}
