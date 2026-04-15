'use strict';
// Thin Claude Code runner — same shape as agent-hub/runner.js but keyed to
// the social-hub db so every question gets cross-platform context.

const { spawn }   = require('child_process');
const fs          = require('fs');
const path        = require('path');
const { v4: uuidv4 } = require('uuid');
const db          = require('./db');
const platforms   = require('./platforms');

let _broadcast = () => {};
function setBroadcast(fn) { _broadcast = fn || (() => {}); }

function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(process.env.HOME || '', '.npm', 'bin', 'claude'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return require('child_process').execSync('which claude', { stdio: 'pipe' }).toString().trim(); } catch {}
  return 'claude';
}
const CLAUDE_BIN = findClaude();
console.log(`[runner] claude binary: ${CLAUDE_BIN}`);

function claudeArgs(prompt) {
  return [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-sonnet-4-6',
    '--dangerously-skip-permissions',
    prompt,
  ];
}

function parseStreamLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) out.push(block.text);
          else if (block.type === 'tool_use')       out.push(`\`[tool: ${block.name}]\``);
        }
      }
    } catch {}
  }
  return out.join('');
}

function buildContext() {
  const lines = ['# Social Hub — live context', ''];
  for (const p of platforms.list()) {
    const stats = db.getStats({ platform: p.slug });
    if (!stats.accounts) continue;
    const posts = db.getPosts({ platform: p.slug }).slice(0, 5);
    const threads = db.getThreads({ platform: p.slug }).slice(0, 5);
    const analytics = db.getAnalytics({ platform: p.slug }, 5);
    lines.push(`## ${p.name}`);
    lines.push(`- Accounts: ${stats.accounts}`);
    lines.push(`- Followers: ${stats.followers}`);
    lines.push(`- Reach (latest): ${stats.reach}`);
    lines.push(`- Unread DMs: ${stats.unread}`);
    lines.push(`- Posts: ${stats.posts}`);
    if (posts.length) {
      lines.push('- Recent posts:');
      for (const x of posts) {
        lines.push(`  - [${(x.ts || '').slice(0,10)}] ${x.like_count || 0} likes, ${x.comments_count || 0} comments — "${(x.caption || '').slice(0, 80)}"`);
      }
    }
    if (threads.length) {
      lines.push('- Recent DMs:');
      for (const t of threads) {
        lines.push(`  - ${t.participant_name} (${t.unread || 0} unread)`);
      }
    }
    if (analytics.length) {
      lines.push('- Analytics (latest 5 snapshots):');
      for (const a of analytics) {
        lines.push(`  - ${(a.ts || '').slice(0,10)}: followers=${a.followers} reach=${a.reach} imp=${a.impressions} er=${a.engagement_rate}%`);
      }
    }
    lines.push('');
  }
  if (lines.length === 2) {
    lines.push('No connected platforms yet. The user needs to connect Composio and link accounts in Settings.');
  }
  lines.push('---');
  lines.push('You are a social media assistant. Answer using the context above. Be concise.');
  return lines.join('\n');
}

let activeChat = null;

function sendChat(userText) {
  if (activeChat) { try { activeChat.kill('SIGTERM'); } catch {} activeChat = null; }

  const userMsg = { id: uuidv4(), role: 'user', content: userText, ts: new Date().toISOString() };
  db.appendChat(userMsg);
  _broadcast('chat:message', userMsg);

  const assistantId = uuidv4();
  const asstMsg = { id: assistantId, role: 'assistant', content: '', ts: new Date().toISOString(), streaming: true };
  db.appendChat(asstMsg);
  _broadcast('chat:message', asstMsg);

  const prompt = buildContext() + '\n\nUser: ' + userText;
  const proc = spawn(CLAUDE_BIN, claudeArgs(prompt), {
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChat = proc;

  let buf = '';
  proc.stdout.on('data', d => {
    const text = parseStreamLines(d.toString());
    if (text) {
      buf += text;
      db.updateLastChat({ content: buf });
      _broadcast('chat:chunk', { id: assistantId, chunk: text, content: buf });
    }
  });
  proc.stderr.on('data', d => {
    const m = d.toString().trim();
    if (m) console.error('[runner] stderr:', m);
  });
  proc.on('close', code => {
    activeChat = null;
    db.updateLastChat({ content: buf || `[no output — exit ${code}]`, streaming: false });
    _broadcast('chat:done', { id: assistantId, content: buf, exit_code: code });
  });
  proc.on('error', err => {
    activeChat = null;
    const msg = `failed to start claude: ${err.message} (binary: ${CLAUDE_BIN})`;
    db.updateLastChat({ content: msg, streaming: false, error: true });
    _broadcast('chat:done', { id: assistantId, content: msg, exit_code: -1 });
  });

  return assistantId;
}

function stopChat() {
  if (activeChat) { try { activeChat.kill('SIGTERM'); } catch {} activeChat = null; return true; }
  return false;
}

module.exports = { setBroadcast, sendChat, stopChat, CLAUDE_BIN };
