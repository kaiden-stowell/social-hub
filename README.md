# Social Hub

Unified dashboard for every social media platform you care about, with a
built-in Claude Code assistant that has live context across all of them.
Powered by [Composio](https://composio.dev) — one key unlocks every platform.

**Built-in platforms:** Instagram, Facebook, TikTok
**Easy to extend:** drop a file into `platforms/` and it shows up everywhere

## Install (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/kaiden-stowell/social-hub/main/install.sh | bash
```

Installs to `~/social-hub`, runs as a launchd background service on macOS,
auto-starts on boot, and preserves `.env` + `data/` on reinstall.

Open <http://127.0.0.1:12791> once it finishes.

### Updating

Re-run the same curl command, or click the pulsing version chip / **Update**
button in the sidebar.

### Requirements

- Node.js 18+ and npm
- Claude Code CLI (`claude`) on your PATH — used for the Ask Claude view
- A Composio account with a client key (starts with `ck_`)
- Business/Creator accounts for any social platform you want to connect
  (personal IG/FB/TT accounts are not supported by the platforms' APIs)

## Setup

1. Go to <https://dashboard.composio.dev/developers> and copy your `ck_` key
2. Open the Social Hub dashboard → **Settings** tab → paste the key → Save
3. In the Composio dashboard, connect each platform you want
   (Instagram, Facebook, TikTok, ...)
4. Back in Settings, click **Refresh all** — data loads across every platform
   within a few seconds

## Views

- **Overview** — aggregate stats (followers, reach, impressions, unread DMs)
  across every platform, with a sidebar chip picker to scope to one
- **Direct Messages** — unified inbox across every platform
- **Posts** — grid of recent posts from every platform, tagged by color
- **Analytics** — per-platform charts and snapshot tables
- **Ask Claude** — chat that receives a live cross-platform brief on every
  question (“summarize my mentions this week”, “which post did best on TikTok?”,
  “reply politely to the Instagram DM from Maya”)
- **Settings** — manage the Composio key and see per-platform connection state

## Architecture

```
social-hub/
├── server.js              Express + WebSocket + REST
├── orchestrator.js        Poll every active platform, route DM sends
├── composio.js            Composio REST client
├── db.js                  JSON file store, every row tagged with .platform
├── runner.js              Claude Code subprocess runner with cross-platform context
├── platforms/
│   ├── index.js           Registry — auto-discovers built-in platforms
│   ├── instagram.js       IG fetchers + send
│   ├── facebook.js        FB fetchers + send
│   └── tiktok.js          TT fetchers (no send — TikTok API doesn't allow it)
└── public/                Vanilla-JS frontend with platform picker
```

Each platform module exports:

```js
{
  slug, name, color, composioToolkit,
  async fetchAll(ctx),
  async sendDirectMessage(ctx, thread, text),
}
```

`ctx = { composio, db, broadcast, userId }`. To add a new platform, create a
new file in `platforms/`, register it in `platforms/index.js`, and it picks
up every view, filter, and the Claude context block automatically.

## Talking to Social Hub from other agents

Exposes `GET /api/integration-manifest` describing its REST surface in the
shape that [agent-hub](https://github.com/kaiden-stowell/agent-hub) knows
how to inject into agent prompts. If both are running on the same machine,
agent-hub auto-discovers Social Hub and every agent instantly knows how to
query your social accounts — no extra wiring.

## Endpoints

Every data endpoint accepts `?platform=<slug>` to scope to a single platform,
or omits it for aggregate across all platforms.

```
GET  /api/status
GET  /api/platforms
GET  /api/platforms/active
GET  /api/stats?platform=instagram
GET  /api/accounts?platform=tiktok
GET  /api/posts?platform=facebook
GET  /api/threads
GET  /api/threads/:id
POST /api/threads/:id/read
POST /api/threads/:id/send       { text }
GET  /api/analytics?platform=instagram&limit=14
POST /api/refresh?platform=facebook

GET  /api/settings/composio
POST /api/settings/composio      { apiKey, userId }
DELETE /api/settings/composio
POST /api/settings/composio/connect

GET  /api/chat
POST /api/chat                   { text }
POST /api/chat/stop
DELETE /api/chat

GET  /api/integration-manifest
GET  /api/version
GET  /api/update/check
POST /api/update/apply
```
