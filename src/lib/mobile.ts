import { load } from 'js-yaml';

export interface MobilePreview {
  /** exp:// URL for Expo Go, if the project runs an Expo dev server. */
  expoUrl: string | null;
  /** Free-form hint for the PM (e.g. "install Expo Go, scan the QR"). */
  note: string | null;
  /** e.g. "flutter-web", "expo", "react-native" — informational only. */
  kind: string | null;
}

/** Extract the `mobile:` block from a project's mvpfy.yml, if present. */
export function parseMobilePreview(mvpfyYml: string | null | undefined): MobilePreview | null {
  if (!mvpfyYml) return null;
  let doc: unknown;
  try {
    doc = load(mvpfyYml);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const mobile = (doc as Record<string, unknown>).mobile;
  if (!mobile || typeof mobile !== 'object') return null;
  const rec = mobile as Record<string, unknown>;
  const expoUrl =
    typeof rec.expo_url === 'string'
      ? rec.expo_url
      : typeof rec.expoUrl === 'string'
        ? rec.expoUrl
        : null;
  const note = typeof rec.note === 'string' ? rec.note : null;
  const kind = typeof rec.kind === 'string' ? rec.kind : null;
  if (!expoUrl && !note) return null;
  return { expoUrl, note, kind };
}
