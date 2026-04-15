'use strict';
const { v4: uuidv4 } = require('uuid');

const slug = 'instagram';
const name = 'Instagram';
const color = '#e1306c';
const composioToolkit = 'instagram';

async function fetchAll(ctx) {
  const profile = await _fetchProfile(ctx);
  if (!profile) return;
  await _fetchMedia(ctx, profile.id);
  await _fetchInsights(ctx, profile.id);
  await _fetchThreads(ctx, profile.id);
}

async function _fetchProfile(ctx) {
  const r = await ctx.composio.execute('INSTAGRAM_GET_USER_INFO', { ig_user_id: 'me' });
  const profile = r?.data || r || {};
  const id = profile.id || 'instagram-me';
  const acct = {
    id: `instagram:${id}`,
    platform: slug,
    username: profile.username || 'me',
    name: profile.name || profile.username || '',
    followers: profile.followers_count ?? 0,
    following: profile.follows_count ?? 0,
    media_count: profile.media_count ?? 0,
    biography: profile.biography || '',
    profile_picture_url: profile.profile_picture_url || '',
    remote_id: id,
    connected_at: new Date().toISOString(),
  };
  ctx.db.upsertAccount(acct);
  ctx.broadcast('account:updated', acct);
  return { id, accountId: acct.id };
}

async function _fetchMedia(ctx, remoteId) {
  const r = await ctx.composio.execute('INSTAGRAM_GET_IG_USER_MEDIA', {
    ig_user_id: remoteId,
    limit: 30,
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
  });
  const items = r?.data?.data || r?.data || [];
  for (const m of items) {
    ctx.db.upsertPost({
      id: `instagram:${m.id}`,
      platform: slug,
      account_id: `instagram:${remoteId}`,
      caption: m.caption || '',
      media_url: m.media_url || m.thumbnail_url || '',
      permalink: m.permalink || '',
      like_count: m.like_count || 0,
      comments_count: m.comments_count || 0,
      media_type: m.media_type || '',
      ts: m.timestamp || new Date().toISOString(),
    });
  }
  ctx.broadcast('post:updated', { platform: slug, count: items.length });
}

async function _fetchInsights(ctx, remoteId) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - 30 * 86400;
  try {
    const r = await ctx.composio.execute('INSTAGRAM_GET_USER_INSIGHTS', {
      ig_user_id: remoteId,
      metric: ['reach', 'follower_count', 'accounts_engaged', 'total_interactions', 'views'],
      period: 'day',
      since,
      until: now,
    });
    const series = r?.data?.data || r?.data || [];
    const byDate = new Map();
    for (const metric of series) {
      for (const pt of (metric.values || [])) {
        const date = (pt.end_time || '').slice(0, 10);
        if (!date) continue;
        if (!byDate.has(date)) byDate.set(date, { date, ts: pt.end_time });
        byDate.get(date)[metric.name] = pt.value;
      }
    }
    for (const row of byDate.values()) {
      ctx.db.insertAnalytics({
        id: uuidv4(),
        platform: slug,
        account_id: `instagram:${remoteId}`,
        ts: row.ts || row.date,
        followers: row.follower_count ?? 0,
        reach: row.reach ?? 0,
        impressions: row.views ?? 0,
        profile_views: 0,
        engagement_rate: row.accounts_engaged && row.reach
          ? +((row.accounts_engaged / row.reach) * 100).toFixed(2) : 0,
      });
    }
    ctx.broadcast('analytics:updated', { platform: slug, snapshots: byDate.size });
  } catch (e) {
    console.error('[instagram] insights failed:', e.message);
  }
}

async function _fetchThreads(ctx, remoteId) {
  try {
    const r = await ctx.composio.execute('INSTAGRAM_LIST_ALL_CONVERSATIONS', { limit: 25 });
    const threads = r?.data?.data || r?.data || [];
    for (const t of threads) {
      const threadId = `instagram:${t.id}`;
      try {
        const mr = await ctx.composio.execute('INSTAGRAM_LIST_ALL_MESSAGES', {
          conversation_id: t.id,
          limit: 20,
        });
        const msgs = mr?.data?.data || mr?.data || [];
        const ordered = msgs.slice().reverse();
        const other = ordered.find(m => m.from?.username && m.from.username !== 'me');
        ctx.db.upsertThread({
          id: threadId,
          platform: slug,
          account_id: `instagram:${remoteId}`,
          remote_id: t.id,
          participant: other?.from?.id || 'unknown',
          participant_name: other?.from?.username || 'Instagram user',
          unread: 0,
          last_message_at: ordered[ordered.length - 1]?.created_time || t.updated_time || new Date().toISOString(),
        });
        const existing = new Set(ctx.db.getMessages(threadId).map(m => m.id));
        for (const m of ordered) {
          const mid = `instagram:${m.id}`;
          if (existing.has(mid)) continue;
          ctx.db.appendMessage({
            id: mid,
            platform: slug,
            thread_id: threadId,
            from: m.from?.username || 'unknown',
            text: m.message || '',
            ts: m.created_time || new Date().toISOString(),
            outbound: false,
          });
        }
      } catch {
        // individual thread failures are non-fatal
      }
    }
    ctx.broadcast('threads:updated', { platform: slug, count: threads.length });
  } catch (e) {
    console.error('[instagram] threads failed:', e.message);
  }
}

async function sendDirectMessage(ctx, thread, text) {
  const msg = {
    id: `instagram:${uuidv4()}`,
    platform: slug,
    thread_id: thread.id,
    from: 'me',
    text,
    ts: new Date().toISOString(),
    outbound: true,
  };
  await ctx.composio.execute('INSTAGRAM_SEND_TEXT_MESSAGE', {
    recipient_id: thread.participant,
    text,
  });
  return msg;
}

module.exports = { slug, name, color, composioToolkit, fetchAll, sendDirectMessage };
