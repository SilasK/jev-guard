# Running Laya locally on macOS

Run the model on the Mac and let the guard decide locally, while still sending training data to the
central sink on the gamer. No GPU needed — CPU inference is ~80–250 ms.

## 1. Prerequisites

```sh
brew install node        # Node 20+ (Apple Silicon: /opt/homebrew/bin/node, Intel: /usr/local/bin/node)
node --version
```

## 2. Get the plugin + server

```sh
git clone https://github.com/SilasK/jev-guard.git ~/GitHub/jev-guard
cd ~/GitHub/jev-guard/laya-server
npm install
```

First start downloads the ~1.7 GB ONNX weights to `~/.cache/receptron-laya` and loads in a few seconds:

```sh
node server.mjs          # foreground; Ctrl-C to stop
curl -s localhost:8790/health
```

## 3. Keep it running (launchd)

macOS uses launchd, not systemd. A template ships in the repo:

```sh
NODE="$(which node)"
sed "s#/usr/local/bin/node#${NODE}#; s#/Users/silas#${HOME}#g" \
  ~/GitHub/jev-guard/laya-server/com.silask.laya-guard.plist \
  > ~/Library/LaunchAgents/com.silask.laya-guard.plist
launchctl load -w ~/Library/LaunchAgents/com.silask.laya-guard.plist
launchctl list | grep laya-guard
```

It binds `127.0.0.1:8790` only, so no auth is needed on loopback. Logs: `~/Library/Logs/laya-guard.log`.

## 4. Point the guard at the local server, keep data central

The shared config (from `agent-settings`) points at the Cloudflare endpoint. Override it per machine
with a **local, non-git** file:

```jsonc
// ~/.config/opencode/laya-guard.local.json   (chmod 600)
{
  "endpoint": "http://127.0.0.1:8790/decide",
  "feedbackEndpoint": "https://laya.silask.ch/feedback",
  "feedbackToken": "<central Laya token>"
}
```

- `endpoint` — decide with the local model (fast, private).
- `feedbackEndpoint` + `feedbackToken` — training data still lands in the central sink, so all machines
  contribute to one dataset. Get the token from the gamer:

  ```sh
  ssh gamer 'grep LAYAGUARD_TOKEN ~/GitHub/jev-guard/laya-server/laya-guard.env'
  ```

  If you would rather not put the central token on the Mac, drop those two keys and the plugin writes a
  local fallback; fold it in later with `node laya-server/push-feedback.mjs` on the gamer.

## 5. Install the plugin on the Mac

```sh
git clone https://github.com/SilasK/agent-settings.git ~/agent-settings
cd ~/agent-settings
./bin/install-opencode.sh --force
./bin/sync-config.sh --machine mac
# restart opencode
```

`config/machines/mac.json` already references `file:///Users/silas/GitHub/jev-guard/src/opencode-fallback.js`,
so the fork must be cloned at that path (step 2).

Verify:

```sh
opencode debug config | jq -c '.permission.bash, (.plugin[] | select(test("jev-guard")))'
```

## 6. Sanity check

```sh
# local server answers
curl -s localhost:8790/health

# the guard uses it: an explicit, task-relevant read is allowed; a destructive one is not
# (run inside a project) opencode, ask it to "check the config in ../" — no prompt should appear
```

## Notes

- **No GPU needed.** The GPU on the gamer is for *training* later, not serving.
- **Model updates:** re-run `npm start` after replacing the bundle, or point `LAYAGUARD_MODEL_DIR` at a
  retrained ONNX bundle to pick it up.
- **Memory:** ~1.5 GB RSS for the loaded model; the machine needs Node 20+.
