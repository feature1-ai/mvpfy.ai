import { shellQuote, spawnShellSync } from './shell';
import { IS_WIN } from './shell';

/**
 * Putting a locally-running app on the internet for a few minutes.
 *
 * A quick tunnel, which needs no Cloudflare account and no configuration —
 * that is the whole reason it is the one mvpfy uses. The address it hands back
 * is random and lasts as long as the process does.
 *
 * Nothing here is persisted and nothing starts by itself. A share is somebody
 * deciding to put their half-built product, with its demo login printed on the
 * screen beside it, somewhere anybody holding the link can reach — which is a
 * decision, made each time, that ends when they close it.
 */
export function tunnelCommand(port: number, hostHeader = ''): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${port} is not a port`);
  }
  // A product that works out which tenant it is serving from the hostname sees
  // the tunnel's random name instead — four words that match no tenant — and
  // shows the visitor nothing. This tells the local app which host it is being
  // asked for, while the world still uses the tunnel's address.
  const host = hostHeader.trim();
  if (host && !/^[\w.-]+(:\d{1,5})?$/.test(host)) {
    throw new Error(`"${host}" is not a hostname`);
  }
  const hostFlag = host ? `--http-host-header ${shellQuote(host)} ` : '';
  // --no-autoupdate: an update mid-share restarts the process and changes the
  // address, which is a link going dead in somebody else's browser.
  return `cloudflared tunnel --no-autoupdate ${hostFlag}--url ${shellQuote(`http://localhost:${port}`)}`;
}

/** Whether the tunnel client is on this machine at all. */
export function hasCloudflared(): boolean {
  const locator = IS_WIN ? 'where cloudflared' : 'command -v cloudflared';
  const res = spawnShellSync(locator, { encoding: 'utf8', timeout: 10_000 });
  return res.status === 0 && res.stdout.trim().length > 0;
}
