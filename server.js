'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');

const db           = require('./db');
const platforms    = require('./platforms');
const orchestrator = require('./orchestrator');
const runner       = require('./runner');
const composio     = require('./composio');
const settings     = require('./settings');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '12791', 10);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const server  = http.createServer(app);
const wss     = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ event: 'hello', data: { mode: orchestrator.mode() } }));
});

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

orchestrator.setBroadcast(broadcast);
runner.setBroadcast(broadcast);

// ── Version + update ───────────────────────────────────────────────────
const REPO_API_URL = 'https://api.github.com/repos/kaiden-stowell/social-hub/contents/version.json?ref=main';
let cachedRemoteVersion = null;
let lastVersionCheck = 0;

function getLocalVersion() {
  try {
    return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version;
  } catch { return 'unknown'; }
}

app.get('/api/version', (req, res) => res.json({ version: getLocalVersion() }));

app.get('/api/update/check', async (req, res) => {
  try {
    const localVersion = getLocalVersion();
    const forceCheck = req.query.force === '1';
    if (!forceCheck && Date.now() - lastVersionCheck < 120000 && cachedRemoteVersion) {
      return res.json({ local: localVersion, remote: cachedRemoteVersion, updateAvailable: cachedRemoteVersion !== localVersion });
    }
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const r = https.get(REPO_API_URL, {
        headers: { 'User-Agent': 'social-hub', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, resp => {
        if (resp.statusCode !== 200) { reject(new Error(`GitHub API returned ${resp.statusCode}`)); resp.resume(); return; }
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Request timed out')); });
    });
    const json = JSON.parse(data);
    if (!json.content) throw new Error('No content in GitHub response');
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    const remote = JSON.parse(content).version;
    cachedRemoteVersion = remote;
    lastVersionCheck = Date.now();
    res.json({ local: localVersion, remote, updateAvailable: remote !== localVersion });
  } catch (e) {
    console.error('[update] check failed:', e.message);
    res.json({ local: getLocalVersion(), remote: null, updateAvailable: false, error: e.message });
  }
});

app.post('/api/update/apply', (req, res) => {
  const fs = require('fs');
  const { execSync } = require('child_process');
  const gitDir = path.join(__dirname, '.git');
  if (!fs.existsSync(gitDir)) {
    return res.status(400).json({ error: 'Not a git repo. Run the install script first.' });
  }
  try {
    const dataDir = path.join(__dirname, 'data');
    const backupDir = path.join(__dirname, 'backups', 'pre-update_' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(dataDir)) {
      const dataBackup = path.join(backupDir, 'data');
      fs.mkdirSync(dataBackup, { recursive: true });
      for (const f of fs.readdirSync(dataDir)) {
        try { fs.copyFileSync(path.join(dataDir, f), path.join(dataBackup, f)); } catch {}
      }
    }
    const envFile = path.join(__dirname, '.env');
    if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(backupDir, '.env'));
    try {
      const currentRemote = execSync('git remote get-url origin', { cwd: __dirname, stdio: 'pipe', timeout: 5000 }).toString().trim();
      if (!currentRemote.includes('social-hub')) {
        execSync('git remote set-url origin https://github.com/kaiden-stowell/social-hub.git', { cwd: __dirname, stdio: 'pipe', timeout: 5000 });
      }
    } catch {
      try { execSync('git remote add origin https://github.com/kaiden-stowell/social-hub.git', { cwd: __dirname, stdio: 'pipe', timeout: 5000 }); } catch {}
    }
    try { execSync('git stash', { cwd: __dirname, stdio: 'pipe', timeout: 10000 }); } catch {}
    try {
      execSync('git pull --ff-only origin main', { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
    } catch {
      execSync('git fetch origin main', { cwd: __dirname, stdio: 'pipe', timeout: 30000 });
      execSync('git reset --hard origin/main', { cwd: __dirname, stdio: 'pipe', timeout: 10000 });
    }
    try {
      execSync('npm install --production --silent', { cwd: __dirname, stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      console.error('[update] npm install failed:', e.message);
    }
    const newVersion = getLocalVersion();
    cachedRemoteVersion = null;
    lastVersionCheck = 0;
    broadcast('update:applied', { version: newVersion });
    res.json({ ok: true, version: newVersion, restarting: true });
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    console.error('[update] apply failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Status / platforms ─────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    mode: orchestrator.mode(),
    version: getLocalVersion(),
    claudeBin: runner.CLAUDE_BIN,
    claudeExists: require('fs').existsSync(runner.CLAUDE_BIN),
    node: process.version,
    platforms: platforms.list().map(p => ({ slug: p.slug, name: p.name, color: p.color })),
  });
});

app.get('/api/platforms', (req, res) => {
  res.json(platforms.list().map(p => ({
    slug: p.slug, name: p.name, color: p.color, composioToolkit: p.composioToolkit,
  })));
});

app.get('/api/platforms/active', async (req, res) => {
  try {
    const active = await orchestrator.getActivePlatforms();
    res.json(active.map(p => ({ slug: p.slug, name: p.name, color: p.color })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Data endpoints (accept ?platform= filter) ──────────────────────────
app.get('/api/accounts',  (req, res) => res.json(db.getAccounts({ platform: req.query.platform || null })));
app.get('/api/stats',     (req, res) => res.json(db.getStats({ platform: req.query.platform || null })));
app.get('/api/posts',     (req, res) => res.json(db.getPosts({ platform: req.query.platform || null, account_id: req.query.account_id || null })));
app.get('/api/threads',   (req, res) => res.json(db.getThreads({ platform: req.query.platform || null, account_id: req.query.account_id || null })));

app.get('/api/threads/:id', (req, res) => {
  const thread = db.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'not found' });
  res.json({ thread, messages: db.getMessages(req.params.id) });
});

app.post('/api/threads/:id/read', (req, res) => {
  db.markThreadRead(req.params.id);
  broadcast('thread:read', { id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/threads/:id/send', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const msg = await orchestrator.sendDirectMessage(req.params.id, text);
    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics', (req, res) => {
  const limit = parseInt(req.query.limit || '30', 10);
  res.json(db.getAnalytics({ platform: req.query.platform || null, account_id: req.query.account_id || null }, limit));
});

app.post('/api/refresh', async (req, res) => {
  try {
    if (req.query.platform) await orchestrator.fetchPlatform(req.query.platform);
    else await orchestrator.fetchAll();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings / Composio ────────────────────────────────────────────────
app.get('/api/settings/composio', async (req, res) => {
  const env = settings.readEnv();
  const hasKey = Boolean(env.COMPOSIO_API_KEY);
  let perPlatform = [];
  let error = null;
  if (hasKey) {
    for (const p of platforms.list()) {
      try {
        const conns = await composio.listConnections(p.composioToolkit);
        const active = conns.find(c => (c.status || '').toLowerCase() === 'active');
        perPlatform.push({
          slug: p.slug, name: p.name, color: p.color,
          connected: Boolean(active),
          connection_id: active?.id || null,
        });
      } catch (e) {
        perPlatform.push({ slug: p.slug, name: p.name, color: p.color, connected: false, error: e.message });
      }
    }
  } else {
    perPlatform = platforms.list().map(p => ({ slug: p.slug, name: p.name, color: p.color, connected: false }));
  }
  res.json({
    configured: hasKey,
    keyMasked: settings.maskKey(env.COMPOSIO_API_KEY || ''),
    userId: env.COMPOSIO_USER_ID || 'default',
    mode: orchestrator.mode(),
    platforms: perPlatform,
    error,
  });
});

app.post('/api/settings/composio', async (req, res) => {
  try {
    const { apiKey, userId } = req.body || {};
    if (!apiKey?.trim()) return res.status(400).json({ error: 'apiKey required' });
    settings.writeEnv({
      COMPOSIO_API_KEY: apiKey.trim(),
      COMPOSIO_USER_ID: (userId || 'default').trim(),
    });
    orchestrator.stop();
    orchestrator.start();
    broadcast('settings:updated', { mode: orchestrator.mode() });
    res.json({ ok: true, mode: orchestrator.mode() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/settings/composio', (req, res) => {
  settings.writeEnv({ COMPOSIO_API_KEY: '' });
  orchestrator.stop();
  broadcast('settings:updated', { mode: orchestrator.mode() });
  res.json({ ok: true, mode: orchestrator.mode() });
});

// Open the Composio dashboard — user picks the platform to connect there.
app.post('/api/settings/composio/connect', (req, res) => {
  res.json({ redirect_url: 'https://dashboard.composio.dev/' });
});

// ── Claude chat ────────────────────────────────────────────────────────
app.get('/api/chat', (req, res) => res.json(db.getChats()));
app.post('/api/chat', (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const id = runner.sendChat(text);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/chat/stop', (req, res) => res.json({ stopped: runner.stopChat() }));
app.delete('/api/chat', (req, res) => {
  db.clearChats();
  broadcast('chat:cleared', {});
  res.json({ ok: true });
});

// ── Integration manifest (for agent-hub discovery) ─────────────────────
app.get('/api/integration-manifest', (req, res) => {
  const baseUrl = `http://${HOST}:${PORT}`;
  const mode = orchestrator.mode();
  const plats = platforms.list().map(p => p.slug).join(', ');
  res.json({
    kind: 'local-hub',
    slug: 'social-hub',
    name: 'Social Hub',
    version: getLocalVersion(),
    base_url: baseUrl,
    mode,
    platforms: platforms.list().map(p => ({ slug: p.slug, name: p.name })),
    desc: `Local multi-platform social media control plane. Built-in platforms: ${plats}. Mode: ${mode.toUpperCase()}.`,
    usage: [
      `Social Hub is running locally at ${baseUrl}. It unifies multiple social platforms (currently: ${plats}) behind one REST API. All endpoints return JSON and accept an optional ?platform=<slug> query to filter to one platform; omit it to get everything.`,
      ``,
      `READ:`,
      `  curl -s ${baseUrl}/api/stats                            # aggregate stats across platforms`,
      `  curl -s "${baseUrl}/api/stats?platform=instagram"       # stats for a single platform`,
      `  curl -s ${baseUrl}/api/accounts                         # connected accounts`,
      `  curl -s "${baseUrl}/api/posts?platform=facebook"        # recent posts`,
      `  curl -s ${baseUrl}/api/threads                          # DM threads across platforms`,
      `  curl -s ${baseUrl}/api/threads/<id>                     # a specific thread + messages`,
      `  curl -s "${baseUrl}/api/analytics?platform=tiktok&limit=14"`,
      ``,
      `WRITE:`,
      `  curl -s -X POST ${baseUrl}/api/threads/<id>/send \\`,
      `    -H 'Content-Type: application/json' -d '{"text":"hi"}'     # reply in a DM`,
      `  curl -s -X POST ${baseUrl}/api/threads/<id>/read              # mark read`,
      `  curl -s -X POST "${baseUrl}/api/refresh?platform=instagram"   # force a pull`,
      ``,
      `When a user asks about their social media ("did anyone DM me?", "how did my last post do?",`,
      `"summarize my mentions"), start with /api/stats and /api/posts (add /api/threads for DM questions)`,
      `via curl, then answer from the JSON.`,
    ].join('\n'),
  });
});

// ── Boot ───────────────────────────────────────────────────────────────
orchestrator.start();

server.listen(PORT, HOST, () => {
  console.log(`\n  Social Hub running at http://${HOST}:${PORT}`);
  console.log(`  Mode: ${orchestrator.mode().toUpperCase()}`);
  console.log(`  Platforms: ${platforms.list().map(p => p.name).join(', ')}`);
  console.log(`  Claude binary: ${runner.CLAUDE_BIN}\n`);
});

process.on('SIGINT',  () => { orchestrator.stop(); process.exit(0); });
process.on('SIGTERM', () => { orchestrator.stop(); process.exit(0); });
