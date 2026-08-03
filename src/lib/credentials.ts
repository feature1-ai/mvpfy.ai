import { load } from 'js-yaml';

export interface DemoCredential {
  label: string;
  fields: Array<{ key: string; value: string }>;
}

function toCredential(label: string, rec: Record<string, unknown>): DemoCredential {
  const fields: DemoCredential['fields'] = [];
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'label' || key === 'name') continue;
    if (typeof value === 'string' || typeof value === 'number') {
      fields.push({ key, value: String(value) });
    }
  }
  return { label, fields };
}

/**
 * Extract demo login credentials from a project's mvpfy.yml. Accepts either a
 * single `demo_login:`/`demo_account:` mapping or a `demo_credentials:` list.
 */
export function parseDemoCredentials(mvpfyYml: string | null | undefined): DemoCredential[] {
  if (!mvpfyYml) return [];
  let doc: unknown;
  try {
    doc = load(mvpfyYml);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const root = doc as Record<string, unknown>;
  const out: DemoCredential[] = [];

  const single = root.demo_login ?? root.demo_account ?? root.demo_user;
  if (single && typeof single === 'object') {
    out.push(toCredential('App login', single as Record<string, unknown>));
  }
  if (Array.isArray(root.demo_credentials)) {
    for (const item of root.demo_credentials) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        out.push(toCredential(String(rec.label ?? rec.name ?? 'Login'), rec));
      }
    }
  }
  return out.filter((c) => c.fields.length > 0);
}
