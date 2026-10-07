import { IS_WIN, spawnShellSync } from './shell';

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

const ask = (command: string): string => {
  const res = spawnShellSync(command, { encoding: 'utf8', timeout: 20_000 });
  return res.status === 0 ? res.stdout : '';
};

/** What this machine can run a phone app on, right now. */
export function simulatorTargets(): SimulatorTargets {
  const ios =
    process.platform === 'darwin'
      ? parseIosSimulators(ask('xcrun simctl list devices available -j'))
      : [];
  // The emulator binary is not on PATH in a default Android Studio install, so
  // the usual home is tried as well before concluding there is nothing here.
  const home = IS_WIN
    ? '%LOCALAPPDATA%\\Android\\Sdk'
    : process.platform === 'darwin'
      ? '$HOME/Library/Android/sdk'
      : '$HOME/Android/Sdk';
  const android = parseAvds(
    ask('emulator -list-avds') || ask(`"${home}/emulator/emulator" -list-avds`)
  );
  const devices = parseAdbDevices(ask('adb devices')).map((serial) => ({
    serial,
    // Quoted because a serial comes from outside and reaches a command line.
    label: deviceLabel(
      serial,
      ask(`adb -s '${serial.replace(/'/g, '')}' shell getprop ro.product.model`)
    ),
  }));
  return { ios, android, devices };
}
