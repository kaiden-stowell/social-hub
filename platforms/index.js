'use strict';
// Platform registry.
//
// Each platform module exports an object implementing the Platform interface:
//
//   {
//     slug: 'instagram',                    // stable identifier used in db + URLs
//     name: 'Instagram',                    // human display name
//     color: '#e1306c',                     // brand color (used in UI)
//     composioToolkit: 'instagram',         // slug used by Composio's toolkit API
//     async fetchAll(ctx),                  // pull everything, write to db, broadcast
//     async sendDirectMessage(ctx, thread, text),  // return the new message row
//   }
//
// `ctx` is injected by the runtime and contains { composio, db, broadcast, userId }.
//
// To add a new platform: drop a file into platforms/, add its slug to the
// array below, and it automatically appears in Settings, Overview, etc.

const registry = new Map();

function register(mod) {
  if (!mod || !mod.slug) throw new Error('platform missing slug');
  registry.set(mod.slug, mod);
}

// Built-ins
register(require('./instagram'));
register(require('./facebook'));
register(require('./tiktok'));

function list() {
  const enabled = (process.env.PLATFORMS || '').trim();
  const enabledSet = enabled
    ? new Set(enabled.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
    : null;
  const out = [];
  for (const mod of registry.values()) {
    if (enabledSet && !enabledSet.has(mod.slug)) continue;
    out.push(mod);
  }
  return out;
}

function get(slug) { return registry.get(slug) || null; }

module.exports = { list, get, register };
