'use strict';
const { v4: uuidv4 } = require('uuid');

const slug = 'tiktok';
const name = 'TikTok';
const color = '#00f2ea';
const composioToolkit = 'tiktok';

async function fetchAll(ctx) {
  const profile = await _fetchProfile(ctx);
  if (!profile) return;
  await _fetchVideos(ctx, profile);
}

async function _fetchProfile(ctx) {
  const candidates = [
    { slug: 'TIKTOK_GET_USER_INFO', args: {} },
    { slug: 'TIKTOK_GET_ME',         args: {} },
  ];
  for (const c of candidates) {
    try {
      const r = await ctx.composio.execute(c.slug, c.args);
      const p = r?.data?.user || r?.data || r || {};
      if (!p.open_id && !p.display_name && !p.username) continue;
      const acct = {
        id: `tiktok:${p.open_id || 'me'}`,
        platform: slug,
        username: p.display_name || p.username || 'me',
        name: p.display_name || '',
        followers: p.follower_count || 0,
        following: p.following_count || 0,
        media_count: p.video_count || 0,
        profile_picture_url: p.avatar_url || '',
        remote_id: p.open_id || 'me',
        connected_at: new Date().toISOString(),
      };
      ctx.db.upsertAccount(acct);
      ctx.broadcast('account:updated', acct);
      return { id: p.open_id || 'me', accountId: acct.id };
    } catch {}
  }
  console.error('[tiktok] profile fetch failed');
  return null;
}

async function _fetchVideos(ctx, profile) {
  const candidates = [
    { slug: 'TIKTOK_GET_USER_VIDEOS', args: { max_count: 25 } },
    { slug: 'TIKTOK_LIST_VIDEOS',     args: { limit: 25 } },
  ];
  for (const c of candidates) {
    try {
      const r = await ctx.composio.execute(c.slug, c.args);
      const items = r?.data?.videos || r?.data?.data || r?.data || [];
      if (!Array.isArray(items) || !items.length) continue;
      for (const v of items) {
        ctx.db.upsertPost({
          id: `tiktok:${v.id}`,
          platform: slug,
          account_id: profile.accountId,
          caption: v.title || v.video_description || '',
          media_url: v.cover_image_url || v.embed_link || '',
          permalink: v.share_url || '',
          like_count: v.like_count || 0,
          comments_count: v.comment_count || 0,
          media_type: 'VIDEO',
          ts: v.create_time
            ? new Date(v.create_time * 1000).toISOString()
            : new Date().toISOString(),
        });
      }
      ctx.broadcast('post:updated', { platform: slug, count: items.length });
      return;
    } catch {}
  }
}

async function sendDirectMessage() {
  throw new Error('TikTok does not support sending DMs via the public API.');
}

module.exports = { slug, name, color, composioToolkit, fetchAll, sendDirectMessage };
