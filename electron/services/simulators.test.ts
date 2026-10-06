import { describe, expect, it } from 'vitest';
import { parseAdbDevices, parseAvds, parseIosSimulators } from './simulators';

describe('parseIosSimulators', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [
        { name: 'iPhone 14', isAvailable: true },
        { name: 'Old iPhone', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
        { name: 'iPhone 16 Pro', isAvailable: true },
        { name: 'iPad Pro', isAvailable: true },
      ],
    },
  });

  it('puts the newest runtime first, because that is the one to boot', () => {
    expect(parseIosSimulators(json)).toEqual(['iPhone 16 Pro', 'iPad Pro', 'iPhone 14']);
  });

  it('leaves out a device whose runtime is not installed', () => {
    // Booting one fails with a message about a runtime, which reads as mvpfy
    // being broken rather than as something anybody can act on.
    expect(parseIosSimulators(json)).not.toContain('Old iPhone');
  });

  it('is empty rather than throwing when there is no Xcode to ask', () => {
    expect(parseIosSimulators('')).toEqual([]);
    expect(parseIosSimulators('xcrun: error: unable to find utility')).toEqual([]);
    expect(parseIosSimulators('{}')).toEqual([]);
  });
});

describe('parseAvds', () => {
  it('reads the virtual devices that exist', () => {
    expect(parseAvds('Pixel_7_API_34\nTablet_API_33\n')).toEqual([
      'Pixel_7_API_34',
      'Tablet_API_33',
    ]);
  });

  it('ignores the noise the tool prints around them', () => {
    expect(parseAvds('INFO | Storing crashdata\nPixel_7_API_34\n')).toEqual(['Pixel_7_API_34']);
    expect(parseAvds('')).toEqual([]);
  });
});

describe('parseAdbDevices', () => {
  it('lists what is actually connected and trusted', () => {
    const out = 'List of devices attached\nemulator-5554\tdevice\n39081FDJG\tdevice\n';
    expect(parseAdbDevices(out)).toEqual(['emulator-5554', '39081FDJG']);
  });

  it('skips a phone the builder has not trusted yet', () => {
    // Installing to it fails in a way that reads as mvpfy being broken.
    const out = 'List of devices attached\n39081FDJG\tunauthorized\nZY22\toffline\n';
    expect(parseAdbDevices(out)).toEqual([]);
  });

  it('is empty when adb is not here at all', () => {
    expect(parseAdbDevices('')).toEqual([]);
  });
});
