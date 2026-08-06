/** Derive a filesystem-safe slug from a repo URL or local path. */
export function slugFromRepoUrl(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).filter(Boolean).pop() || 'project';
  return (
    last
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}
