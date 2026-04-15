'use strict';
// Owns platform polling. For every enabled platform that has a matching
// Composio connection, periodically runs platform.fetchAll() to keep the db
// in sync. Swap-in or swap-out platforms happens by editing platforms/index.js.

const composio = require('./composio');
const db       = require('./db');
const platforms = require('./platforms');

let _broadcast = () => {};
let _pollTimer = null;
const POLL_MS = 60_000;

function setBroadcast(fn) { _broadcast = fn || (() => {}); }

function _ctx() {
  return {
    composio,
    db,
    broadcast: _broadcast,
    userId: process.env.COMPOSIO_USER_ID?.trim() || 'default',
  };
}

function mode() {
  return composio.isEnabled() ? 'composio' : 'unconfigured';
}

// Which platforms the user currently has hooked up through Composio.
// A platform is "active" when it's in the registry AND has at least one
// active connection in Composio for that toolkit slug.
async function getActivePlatforms() {
  if (!composio.isEnabled()) return [];
  const active = [];
  for (const p of platforms.list()) {
    try {
      const conns = await composio.listConnections(p.composioToolkit);
      const isActive = conns.some(c => (c.status || '').toLowerCase() === 'active');
      if (isActive) active.push(p);
    } catch {}
  }
  return active;
}

async function fetchAll() {
  if (!composio.isEnabled()) return;
  const active = await getActivePlatforms();
  for (const p of active) {
    try { await p.fetchAll(_ctx()); }
    catch (e) { console.error(`[orchestrator] ${p.slug} fetchAll failed:`, e.message); }
  }
}

async function fetchPlatform(slug) {
  const p = platforms.get(slug);
  if (!p) throw new Error(`unknown platform ${slug}`);
  await p.fetchAll(_ctx());
}

async function sendDirectMessage(threadId, text) {
  const thread = db.getThread(threadId);
  if (!thread) throw new Error(`thread ${threadId} not found`);
  const p = platforms.get(thread.platform);
  if (!p) throw new Error(`no platform module for ${thread.platform}`);
  const msg = await p.sendDirectMessage(_ctx(), thread, text);
  db.appendMessage(msg);
  _broadcast('dm:message', msg);
  return msg;
}

function start() {
  fetchAll().catch(e => console.error('[orchestrator] initial fetch failed:', e.message));
  _pollTimer = setInterval(() => {
    fetchAll().catch(e => console.error('[orchestrator] poll failed:', e.message));
  }, POLL_MS);
}

function stop() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

module.exports = {
  setBroadcast, start, stop, fetchAll, fetchPlatform, sendDirectMessage,
  getActivePlatforms, mode,
};
