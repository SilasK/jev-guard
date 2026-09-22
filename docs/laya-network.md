# Running Laya across machines (LAN and Cloudflare)

The plugin only needs HTTP reach to a Laya server. One server can serve many OpenCode installs; the
only per-machine things are the plugin shim, the config file (endpoint + token), and OpenCode itself.

## Option A — one server on the LAN

On the machine that hosts the model, bind to the LAN and set a token:

```sh
# ~/.config/systemd/user/laya-guard-server.service.d/override.conf
[Service]
Environment=LAYAPORT=8790
Environment=LAYA_HOST=0.0.0.0
EnvironmentFile=/home/silask/GitHub/jev-guard/laya-server/laya-guard.env   # LAYAGUARD_TOKEN=…
```

```sh
systemctl --user daemon-reload && systemctl --user restart laya-guard-server
```

- **Always set `LAYAGUARD_TOKEN`** when binding beyond loopback; without it the server answers anyone.
- Firewall the port to your subnet (`ufw allow from 192.168.0.0/16 to any port 8790 proto tcp`),
  or keep `LAYA_HOST=127.0.0.1` and use the tunnel below.
- On each other machine, point the plugin at the host:

```json
{ "endpoint": "http://192.168.1.50:8790/decide", "token": "…same token…" }
```

## Option B — Cloudflare Tunnel (no open ports)

You already run `cloudflared` here. Keep the server on loopback and expose it through a tunnel, so
nothing is reachable except through Cloudflare (TLS + optional Access).

1. Add an ingress rule to a tunnel, or a dedicated tunnel:

   ```yaml
   # tunnel config
   ingress:
     - hostname: laya.silask.ch
       service: http://127.0.0.1:8790
     - service: http_status:404
   ```

   ```sh
   cloudflared tunnel route dns <tunnel> laya.silask.ch
   ```

2. **Protect it.** A tunnel URL is public. Either keep `LAYAGUARD_TOKEN` (required — the plugin sends
   `Authorization: Bearer`), or put the hostname behind **Cloudflare Access** with a service token and
   add the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. For a personal setup, the bearer
   token over Cloudflare TLS is adequate; on a team, use Access.

3. On each machine:

   ```json
   { "endpoint": "https://laya.silask.ch/decide", "token": "…" }
   ```

Latency: local CPU inference is ~140–160 ms per call; a WAN round trip adds ~20–100 ms. That is still
well inside the 2.5 s timeout, and the guard is fail-safe (`onError: ask`) if the tunnel is down.

## Distributing the plugin itself

OpenCode loads either a package or a local file. Two patterns:

**Local shim (current setup, any number of machines):**

```js
// ~/.config/opencode/plugins/laya-guard.js
export { JevGuardFallback } from "/absolute/path/to/jev-guard/src/opencode-fallback.js";
```

Clone the fork on each machine (`git clone https://github.com/SilasK/jev-guard`) and fix the path.

**Package (cleaner for many machines):** publish the fork under a scoped name and reference it in
`opencode.json`, passing options as a tuple (no shim, no absolute paths):

```json
{
  "plugin": [
    ["@silask/laya-guard-opencode", {
      "endpoint": "https://laya.silask.ch/decide",
      "token": "…"
    }]
  ]
}
```

To publish, add a tiny entry that re-exports the fallback and set it as `main`:

```js
// index.js
export { JevGuardFallback } from "./src/opencode-fallback.js";
```

`npm publish --access public` under the scope of your choice. Plugin-tuple options are merged over
`~/.config/opencode/laya-guard.json`, so you can keep the token in the config file instead of
`opencode.json`.

## Security checklist

- `LAYAGUARD_TOKEN` set on the server and present in every client; env file or config `chmod 600`.
- Never expose `/decide` without either the token or Cloudflare Access.
- `/health` is intentionally unauthenticated but reveals only the model path and config; if that is
  too much, put the whole hostname behind Access.
- The server has no filesystem access to tool arguments beyond what the plugin sends; it only echoes
  state through the model. It never executes anything.
