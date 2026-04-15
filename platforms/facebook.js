'use strict';
const { v4: uuidv4 } = require('uuid');

const slug = 'facebook';
const name = 'Facebook';
const color = '#1877f2';
const composioToolkit = 'facebook';

async function fetchAll(ctx) {
  const profile = await _fetchProfile(ctx);
  if (!profile) return;
  await _fetchPosts(ctx, profile);
}

async function _fetchProfile(ctx) {
  // Facebook's tool surface on Composio typically exposes FACEBOOK_GET_* tools
  // that mirror the Graph API. Actual slugs may vary between Composio releases;
  // we try a couple of reasonable candidates and fall back gracefully.
  const candidates = [
    { slug: 'FACEBOOK_GET_ME', args: {} },
    { slug: 'FACEBOOK_GET_USER', args: { user_id: 'me' } },
  ];
  for (const c of candidates) {
    try {
      const r = await ctx.composio.execute(c.slug, c.args);
      const p = r?.data || r || {};
      if (!p.id && !p.name && !p.username) continue;
      const acct = {
        id: `facebook:${p.id || 'me'}`,
        platform: slug,
        username: p.username || p.name || 'me',
        name: p.name || '',
        followers: p.friends?.summary?.total_count || p.followers_count || 0,
        following: 0,
        media_count: 0,
        remote_id: p.id || 'me',
        connected_at: new Date().toISOString(),
      };
      ctx.db.upsertAccount(acct);
      ctx.broadcast('account:updated', acct);
      return { id: p.id || 'me', accountId: acct.id };
    } catch (e) {
      // try next candidate
    }
  }
  console.error('[facebook] profile fetch failed — no candidate slug returned data');
  return null;
}

async function _fetchPosts(ctx, profile) {
  const candidates = [
    { slug: 'FACEBOOK_GET_USER_POSTS',   args: { user_id: profile.id, limit: 25 } },
    { slug: 'FACEBOOK_LIST_POSTS',       args: { limit: 25 } },
    { slug: 'FACEBOOK_GET_PAGE_POSTS',   args: { page_id: profile.id, limit: 25 } },
  ];
  for (const c of candidates) {
    try {
      const r = await ctx.composio.execute(c.slug, c.args);
      const items = r?.data?.data || r?.data || [];
      if (!Array.isArray(items) || !items.length) continue;
      for (const p of items) {
        ctx.db.upsertPost({
          id: `facebook:${p.id}`,
          platform: slug,
          account_id: profile.accountId,
          caption: p.message || p.story || '',
          media_url: p.full_picture || p.picture || '',
          permalink: p.permalink_url || '',
          like_count: p.likes?.summary?.total_count || p.reactions?.summary?.total_count || 0,
          comments_count: p.comments?.summary?.total_count || 0,
          ts: p.created_time || new Date().toISOString(),
        });
      }
      ctx.broadcast('post:updated', { platform: slug, count: items.length });
      return;
    } catch {}
  }
}

async function sendDirectMessage(ctx, thread, text) {
  // Facebook Messenger send is currently out of scope; drop a local record
  // so the UI still reflects the attempt until we wire up the right slug.
  return {
    id: `facebook:${uuidv4()}`,
    platform: slug,
    thread_id: thread.id,
    from: 'me',
    text,
    ts: new Date().toISOString(),
    outbound: true,
    note: 'facebook send not yet wired to Composio tool',
  };
}

module.exports = { slug, name, color, composioToolkit, fetchAll, sendDirectMessage };
