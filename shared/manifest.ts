/**
 * The two places mvpfy.yml says which port the product is on.
 *
 * `host_port` is what the compose file publishes; the port inside `url` is
 * what mvpfy opens. They are written by an agent, separately, and when they
 * disagree the product manager's app points at nothing — which looks exactly
 * like a product that never started. Read in one place so the code that
 * opens the app and the code that checks the file cannot disagree about what
 * the file says.
 */
export interface ManifestPorts {
  hostPort: number | null;
  urlPort: number | null;
}

export function manifestPorts(mvpfyYml: string | null | undefined): ManifestPorts {
  if (!mvpfyYml) return { hostPort: null, urlPort: null };
  const hostPort = mvpfyYml.match(/^\s*host_port:\s*["']?(\d{2,5})["']?\s*$/m);
  const url = mvpfyYml.match(/^\s*url:\s*["']?https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/m);
  return {
    hostPort: hostPort ? Number(hostPort[1]) : null,
    urlPort: url ? Number(url[1]) : null,
  };
}
