/**
 * The public address of a share, read out of the tunnel's own output.
 *
 * cloudflared prints it once, in a box, among fifty lines about connector ids
 * and protocols. Nothing else reports it — there is no file and no API — so
 * the log is the only place it exists.
 */
const QUICK_TUNNEL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

export function parseTunnelUrl(log: string | null | undefined): string | null {
  const m = (log ?? '').match(QUICK_TUNNEL);
  return m ? m[0] : null;
}

/**
 * A tunnel that has stopped being usable, in its own words.
 *
 * A quick tunnel is a favour Cloudflare does for free and can withdraw: they
 * are rate limited, and one can be refused or torn down mid-share. Said
 * plainly, that is somebody's link going dead while they are looking at it.
 */
export function tunnelRefused(log: string | null | undefined): boolean {
  const text = log ?? '';
  return /failed to request quick tunnel|429 Too Many Requests|error="context deadline exceeded"/i.test(
    text
  );
}
