import { safeStorage } from 'electron';
import * as fs from 'node:fs';
import { ensureDirs, SECRETS_FILE } from '../paths';

/** OS-keychain-encrypted secret storage (~/.mvpfy/secrets.json). */

type SecretsMap = Record<string, string>;

function readSecrets(): SecretsMap {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as SecretsMap;
  } catch {
    return {};
  }
}

export function keychainSet(entry: string, value: string): void {
  ensureDirs();
  const secrets = readSecrets();
  if (safeStorage.isEncryptionAvailable()) {
    secrets[entry] = safeStorage.encryptString(value).toString('base64');
  } else {
    // Fallback for environments without keychain access (e.g. some CI).
    secrets[entry] = Buffer.from(value, 'utf8').toString('base64');
  }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

export function keychainGet(entry: string): string | null {
  const stored = readSecrets()[entry];
  if (!stored) return null;
  const buf = Buffer.from(stored, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
