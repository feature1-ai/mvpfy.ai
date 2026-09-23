# Reconnecting Feature1 after the tenant-isolation fix

Older mvpfy versions could mark Feature1 connected without receiving a personal
credential. They trusted a shared MCP server login, which could belong to someone
else. The fixed client never imports or launches a Feature1 agent run without a
personal token verified against the selected workspace's `/api/auth/me` endpoint.

1. Update mvpfy and deploy the companion HTTP MCP server isolation fix.
2. In Settings, enter the intended workspace address and open browser sign-in.
3. Copy the personal token shown by the updated sign-in page into mvpfy's token
   field, then choose **Verify and connect**. A personal integration token from
   Feature1 Settings can also be used. Do not use another person's token.
4. Sync features. A rejected token disconnects the client and clears the list.

Tokens are kept using mvpfy's existing credential store and passed only to that
workspace's API/MCP and the specific coding-agent run. Browser login alone does
not mark mvpfy connected. Legacy connections without a credential are disconnected
on startup. Workspace switches clear lists and discard late replies from the
previous connection.

Existing local plans and downloaded files are preserved. Review any material
imported under the old shared login separately; reconnecting does not erase it.

## Validation

Run `npm test` and `npm run build`. The browser regression additionally checks
wrong-tenant login, delayed sync across workspace switches, and clearing cached
features on authentication failure. Start Vite on port 5198 and run:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/feature1-isolation.browser.cjs
```

The harness uses synthetic credentials and responses. No real account or tenant
is contacted by the browser regression.
