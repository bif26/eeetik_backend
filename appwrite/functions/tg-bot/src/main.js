/**
 * eeetik tg-bot – Appwrite Function (runtime: node-22)
 *
 * One function, two roles:
 *
 * 1. Telegram bot (every-minute schedule poll; webhook also supported when a
 *    function domain exists). Commands: /start /help /download /status
 *    /miniapp /id. Plain TikTok link -> DIRECT download: the media file is
 *    delivered straight into the chat (photo posts arrive as an image album),
 *    no external links, no quality-picker roundtrip.
 *
 * 2. Mini App / JSON action API (POST JSON {action, ...}):
 *    - auth      {initData}                 -> Appwrite user + session secret
 *    - metadata  {url}                      -> cached TikTok preview
 *    - prepare   {url, quality}             -> job row (requires Appwrite session)
 *    - jobs      {}                         -> my recent jobs (requires session)
 *    - download  {jobId}                    -> fresh file URL (session)
 *    - history   {}                         -> my download history (session)
 */
import crypto from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import TikTokApiDlModule from '@tobyg74/tiktok-api-dl';

const TikTokApiDl = TikTokApiDlModule?.Downloader
  ? TikTokApiDlModule
  : TikTokApiDlModule?.default ?? TikTokApiDlModule;

// ─── env ─────────────────────────────────────────────────────────────────────
const ENV = {
  endpoint: process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1',
  projectId: process.env.APPWRITE_FUNCTION_PROJECT_ID ?? process.env.APPWRITE_PROJECT_ID ?? '',
  apiKey: process.env.APPWRITE_API_KEY ?? '',
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  miniAppUrl: process.env.TELEGRAM_MINI_APP_URL ?? '',
  allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  bucketId: process.env.APPWRITE_BUCKET_ID ?? '',
  initdataMaxAge: Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS ?? 86400),
};
const DATABASE_ID = 'eeetik';
const QUALITIES = {
  hd: { label: 'HD 1080p', kind: 'video' },
  hd720: { label: 'HD 720p', kind: 'video' },
  sd: { label: 'SD 480p', kind: 'video' },
  sd360: { label: 'SD 360p', kind: 'video' },
  audio: { label: 'Audio MP3', kind: 'audio' },
  zip: { label: 'Images ZIP', kind: 'zip' },
  zipwebp: { label: 'Images WebP', kind: 'zip' },
  file: { label: 'Video File', kind: 'file' },
};

// ─── Appwrite REST helpers ───────────────────────────────────────────────────
async function aw(path, method = 'GET', body) {
  const response = await fetch(`${ENV.endpoint}${path}`, {
    method,
    headers: {
      'X-Appwrite-Project': ENV.projectId,
      'X-Appwrite-Key': ENV.apiKey,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.message ?? `Appwrite ${response.status}`);
    err.code = response.status;
    err.type = payload?.type;
    throw err;
  }
  return payload;
}

const createRow = (table, data) =>
  aw(`/tablesdb/${DATABASE_ID}/tables/${table}/rows`, 'POST', { rowId: 'unique()', data });
const getRow = (table, rowId) =>
  aw(`/tablesdb/${DATABASE_ID}/tables/${table}/rows/${rowId}`);
const updateRow = (table, rowId, data) =>
  aw(`/tablesdb/${DATABASE_ID}/tables/${table}/rows/${rowId}`, 'PATCH', { data });

/** List rows with queries[] array (builds query string safely). */
async function listTableRows(table, queries) {
  const params = new URLSearchParams();
  for (const query of queries) {
    params.append('queries[]', JSON.stringify(query));
  }
  const qs = params.toString();
  return aw(`/tablesdb/${DATABASE_ID}/tables/${table}/rows${qs ? `?${qs}` : ''}`);
}

// ─── Telegram initData validation (HMAC-SHA256) ──────────────────────────────
function validateInitData(rawInitData) {
  if (!ENV.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
  const params = new URLSearchParams(rawInitData);
  const hash = params.get('hash');
  if (!hash) {
    throw new Error('initData hash missing');
  }
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(ENV.botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('initData hash mismatch');
  }
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > ENV.initdataMaxAge) {
    throw new Error('initData expired');
  }
  const user = JSON.parse(params.get('user') ?? '{}');
  if (!user?.id) {
    throw new Error('initData user missing');
  }
  return user;
}

// ─── TikTok scrape + preview mapping (mirrors TikTokScraperService) ──────────
const asRecord = (value) => (value && typeof value === 'object' ? value : {});
const firstString = (candidates) =>
  candidates.find((c) => typeof c === 'string' && c.length > 0);
const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function extractUniqueId(url, content) {
  const author = asRecord(content?.author);
  const direct = typeof author?.unique_id === 'string' ? author.unique_id : undefined;
  if (direct) return direct;
  const match = String(url).match(/@([A-Za-z0-9_.]+)/);
  if (match) return match[1];
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12);
}

function mapScrapeToPreview(url, content) {
  const author = asRecord(content?.author);
  const video = asRecord(content?.video);
  const music = asRecord(content?.music);
  const stats = asRecord(content?.statistics);
  const imageUrls = Array.isArray(content?.images)
    ? content.images.filter((i) => typeof i === 'string')
    : [];
  const uniqueId = extractUniqueId(url, content);
  return {
    uniqueId,
    url: String(url),
    title: typeof content?.desc === 'string' ? content.desc.slice(0, 512) : '',
    authorName: firstString([author?.nickname]) ?? '',
    authorAvatarUrl: firstString([author?.avatar, author?.avatarThumb, author?.avatarMedium]) ?? '',
    thumbnailUrl: firstString([video?.originCover?.[0], video?.cover?.[0]]) ?? '',
    videoUrl: firstString([video?.playAddr?.[0], content?.direct]) ?? '',
    videoHdUrl: firstString([content?.videoHD, video?.playAddr?.[0]]) ?? '',
    videoSdUrl: firstString([content?.videoSD, video?.downloadAddr?.[0]]) ?? '',
    videoWatermarkUrl: firstString([content?.videoWatermark]) ?? '',
    audioUrl: firstString([music?.playUrl?.[0]]) ?? '',
    musicTitle: firstString([music?.title, music?.name, typeof music?.title === 'string' ? music.title : '']) ?? '',
    imageUrls,
    stats: {
      views: toNumber(stats?.playCount),
      likes: toNumber(stats?.likeCount),
      comments: toNumber(stats?.commentCount),
      shares: toNumber(stats?.shareCount),
    },
    hashtags: Array.isArray(content?.hashtag)
      ? content.hashtag.filter((h) => typeof h === 'string').slice(0, 8)
      : [],
    duration: toNumber(video?.duration ?? music?.duration),
  };
}

async function scrapePreview(url) {
  const response = await TikTokApiDl.Downloader(url, { version: 'v1' });
  if (response?.status !== 'success' || !response.result) {
    throw new Error(response?.message || 'Unable to fetch TikTok metadata');
  }
  return mapScrapeToPreview(url, response.result);
}

async function getCachedPreview(url, uniqueId) {
  try {
    const row = await getRow('meta', uniqueId);
    const fresh = Date.now() - Date.parse(row.$createdAt) < 24 * 3600 * 1000;
    if (fresh && row.url === url) {
      return JSON.parse(row.payload);
    }
  } catch {
    /* cache miss */
  }
  const preview = await scrapePreview(url);
  try {
    await createRow('meta', { uniqueId: preview.uniqueId, url, payload: JSON.stringify(preview) });
  } catch (err) {
    if (err.code !== 409) logSafe(err);
    try {
      await updateRow('meta', preview.uniqueId, { url, payload: JSON.stringify(preview) });
    } catch {
      /* best effort */
    }
  }
  return preview;
}

function logSafe(err) {
  console.error('[tg-bot]', err?.message ?? err);
}

// ─── Bot UX ─────────────────────────────────────────────────────────────
const URL_REGEX = /https?:\/\/\S+/i;
const BOT_COMMANDS_VERSION = '2026-10-16.1';

function mainKeyboard() {
  const keyboard = new InlineKeyboard();
  if (ENV.miniAppUrl) {
    keyboard.webApp('📱 Open Mini App', ENV.miniAppUrl);
  }
  keyboard.text('ℹ️ Help', 'help');
  return keyboard;
}

/** Extras offered alongside a direct delivery (no external links). */
function postExtrasKeyboard(hash, hasImages) {
  const keyboard = new InlineKeyboard();
  keyboard.text('🎵 Get MP3', `music:${hash}`);
  if (hasImages) {
    keyboard.text('📦 Images ZIP', `quality:${hash}:zip`).text('🌐 WebP ZIP', `quality:${hash}:zipwebp`);
  } else {
    keyboard.text('🎬 More sizes', `more:${hash}`);
  }
  return keyboard;
}

function qualityKeyboard(hash) {
  const keyboard = new InlineKeyboard();
  keyboard.text('🎬 HD 1080p', `quality:${hash}:hd`).text('🎥 HD 720p', `quality:${hash}:hd720`).text('📱 SD 480p', `quality:${hash}:sd`).row();
  keyboard.text('📉 SD 360p', `quality:${hash}:sd360`).text('🎧 Audio MP3', `quality:${hash}:audio`).text('🖼️ Images ZIP', `quality:${hash}:zip`).row();
  keyboard.text('🌐 Images WebP', `quality:${hash}:zipwebp`).text('📄 Video File', `quality:${hash}:file`).text('🎵 Song MP3', `quality:${hash}:audio2`).row();
  keyboard.text('🔙 Back', `quality:${hash}:back`);
  return keyboard;
}

function formatCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function registerBot(bot) {
  // Private-bot allowlist (TELEGRAM_ALLOWED_USER_IDS, comma separated).
  // Delete the variable to make the bot public.
  bot.use(async (ctx, next) => {
    if (!ENV.allowedUserIds.length) return next();
    const fromId = String(ctx.from?.id ?? '');
    if (fromId && ENV.allowedUserIds.includes(fromId)) return next();
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCallbackQuery({ text: '🔒 This bot is private.', show_alert: true });
      } catch {
        /* already answered */
      }
      return;
    }
    await ctx.reply('🔒 This is a private bot. Ask the owner for access.').catch(() => {});
  });

  bot.command('id', (ctx) =>
    ctx.reply(
      [
        '🪪 <b>Your IDs</b>',
        `User: <code>${ctx.from?.id ?? '?'}</code>`,
        `Chat: <code>${ctx.chat?.id ?? '?'}</code>`,
        '',
        'Send the User ID to the bot owner to get access.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    ));

  bot.command('start', (ctx) =>
    ctx.reply(
      [
        `👋 Welcome, <b>${escapeHtml(ctx.from?.first_name ?? 'friend')}</b>!`,
        '',
        'Send me any TikTok link and I download it <b>directly into this chat</b> —',
        'HD video, photo albums and the song as MP3. No watermark, no extra links.',
        '',
        '<b>Commands</b>',
        '/download &lt;link&gt; – download a TikTok post',
        '/status – your recent downloads',
        '/miniapp – open the Mini App',
        '/help – full guide',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: mainKeyboard() },
    ),
  );

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        '<b>How eeetik works</b>',
        '',
        '• Send a TikTok link (vm./vt. short links work too) — no buttons needed:',
        '   🎬 videos arrive as HD video, 🖼️ photo posts as an image album,',
        '   🎵 and every delivery offers the song as MP3 with its real title.',
        '• Each delivery also shows the post description, author, stats',
        '   (views / likes / comments / shares) and the music name.',
        '• Files up to 49 MB are delivered straight into this chat.',
        '• Want a different size (720p / 480p / 360p) or a WebP image pack?',
        '   Tap “🎬 More sizes” under the video — or use the Mini App.',
        '',
        '<b>Commands</b>',
        '/download &lt;link&gt; · /status · /miniapp · /help · /id',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: mainKeyboard() },
    ),
  );

  bot.command('miniapp', (ctx) => {
    if (!ENV.miniAppUrl) {
      return ctx.reply('📱 The Mini App is being set up — check back soon.');
    }
    return ctx.reply('Tap below to open the eeetik Mini App 👇', {
      reply_markup: new InlineKeyboard().webApp('📱 Open Mini App', ENV.miniAppUrl),
    });
  });

  bot.command('status', async (ctx) => {
    try {
      const result = await listTableRows('jobs', [
        { method: 'equal', attribute: 'telegramUserId', values: [String(ctx.from?.id ?? '')] },
        { method: 'orderDesc', attribute: '$createdAt' },
        { method: 'limit', values: [6] },
      ]);
      const rows = result.rows ?? [];
      if (!rows.length) {
        await ctx.reply('📊 No downloads yet — send me a TikTok link to try!');
        return;
      }
      const icon = { queued: '⏳', processing: '🔄', completed: '✅', failed: '❌' };
      const lines = ['📊 <b>Your recent downloads</b>', ''];
      for (const row of rows) {
        const kindIcon = row.kind === 'audio' ? '🎵' : row.kind === 'zip' || row.kind === 'images' ? '🖼️' : '🎬';
        lines.push(
          `${icon[row.status] ?? '•'} ${kindIcon} ${escapeHtml((row.title || row.url).slice(0, 60))}\n` +
          `      ${(row.quality ?? '').toUpperCase()} · ${row.status}`,
        );
      }
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      logSafe(err);
      await ctx.reply('✅ Bot is up and running. (Could not load your download list right now.)');
    }
  });

  bot.command('download', async (ctx) => {
    const text = ctx.message?.text ?? '';
    const match = text.match(URL_REGEX);
    if (!match) {
      await ctx.reply('Send me a link like:\n/download https://www.tiktok.com/@user/video/123');
      return;
    }
    await handleLink(ctx, match[0]);
  });

  bot.on('message:text', async (ctx) => {
    const match = (ctx.message.text ?? '').match(URL_REGEX);
    if (match) {
      await handleLink(ctx, match[0]);
      return;
    }
    await ctx.reply('🤔 That does not look like a TikTok link. Send me something like https://vm.tiktok.com/…', {
      reply_markup: mainKeyboard(),
    });
  });

  bot.on('message:web_app_data', async (ctx) => {
    const raw = ctx.message.web_app_data?.data ?? '';
    let url = raw;
    try {
      const parsed = JSON.parse(raw);
      url = parsed?.url ?? parsed?.link ?? raw;
    } catch {
      /* plain text payload */
    }
    const match = String(url).match(URL_REGEX);
    if (match) {
      await handleLink(ctx, match[0]);
    }
  });

  bot.callbackQuery(/^quality:(\w+):(back)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('👇 Send me a TikTok link or open the Mini App.', {
      reply_markup: mainKeyboard(),
    });
  });

  // "🎬 More sizes" under a delivered video: show the full quality keyboard.
  bot.callbackQuery(/^more:(\w+)$/, async (ctx) => {
    const [, hash] = ctx.match;
    try {
      await ctx.answerCallbackQuery();
      await ctx.reply('Pick a size — it will be delivered right here:', {
        reply_markup: qualityKeyboard(hash),
      });
    } catch (err) {
      logSafe(err);
    }
  });

  bot.callbackQuery(/^quality:(\w+):(hd|hd720|sd|sd360|audio|audio2|zip|zipwebp|file)$/, async (ctx) => {
    const [, hash, quality] = ctx.match;
    const spec = QUALITIES[quality === 'audio2' ? 'audio' : quality];
    try {
      await ctx.answerCallbackQuery();
      // Resolve the ORIGINAL video URL from the metadata cache (the callback
      // payload only carries the 12-char cache key).
      let jobUrl = '';
      let uniqueId = hash;
      try {
        const metaRow = await getRow('meta', hash);
        const cached = JSON.parse(metaRow.payload);
        jobUrl = cached.url ?? '';
        uniqueId = cached.uniqueId ?? uniqueId;
      } catch {
        /* expired / missing */
      }
      if (!jobUrl) {
        await ctx
          .editMessageText('⌛ This preview expired — send me the TikTok link again.')
          .catch(() => {});
        return;
      }
      await ctx.editMessageText(`⏳ Preparing <b>${spec.label}</b>…`, { parse_mode: 'HTML' });
      // Normalise the job quality (audio2 is just the keyboard duplicate of audio).
      await createRow('jobs', {
        url: jobUrl,
        uniqueId,
        quality: quality === 'audio2' ? 'audio' : quality,
        kind: spec.kind,
        status: 'queued',
        chatId: String(ctx.chat?.id ?? ''),
        telegramUserId: String(ctx.from?.id ?? ''),
        title: '',
      });
      await ctx.editMessageText(
        `✅ <b>${spec.label}</b> added to the queue.\nYou will receive the file right here in a moment. 🚀`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      logSafe(err);
      try {
        await ctx.answerCallbackQuery({ text: 'Something went wrong, try again', show_alert: true });
      } catch {
        /* callback already answered */
      }
    }
  });

  // "🎵 Get MP3" button under a delivered video: queue the song for this post.
  bot.callbackQuery(/^music:(\w+)$/, async (ctx) => {
    const [, hash] = ctx.match;
    try {
      let jobUrl = '';
      let uniqueId = hash;
      let musicTitle = '';
      try {
        const metaRow = await getRow('meta', hash);
        const cached = JSON.parse(metaRow.payload);
        jobUrl = cached.url ?? '';
        uniqueId = cached.uniqueId ?? uniqueId;
        musicTitle = cached.musicTitle ?? '';
      } catch {
        /* expired / missing */
      }
      if (!jobUrl) {
        await ctx.answerCallbackQuery({ text: '⌛ Preview expired — send the link again', show_alert: true });
        return;
      }
      await createRow('jobs', {
        url: jobUrl,
        uniqueId,
        quality: 'audio',
        kind: 'audio',
        status: 'queued',
        chatId: String(ctx.chat?.id ?? ''),
        telegramUserId: String(ctx.from?.id ?? ''),
        title: '',
      });
      await ctx.answerCallbackQuery({
        text: musicTitle ? `🎵 ${musicTitle.slice(0, 55)}` : '🎵 Song queued as MP3',
      });
    } catch (err) {
      logSafe(err);
      await ctx.answerCallbackQuery({ text: 'Something went wrong, try again', show_alert: true }).catch(() => {});
    }
  });

  bot.catch((botError) => {
    logSafe(botError?.error);
  });
}

// ─── scheduled polling mode (no webhook domain needed) ──────────────────
const OFFSET_ROW_ID = 'tg_update_offset';

async function readOffset() {
  try {
    const row = await getRow('meta', OFFSET_ROW_ID);
    return Number(row.payload) || 0;
  } catch {
    return 0;
  }
}

async function writeOffset(offset) {
  try {
    await getRow('meta', OFFSET_ROW_ID);
    await updateRow('meta', OFFSET_ROW_ID, { payload: String(offset) });
  } catch {
    await createRow('meta', { uniqueId: OFFSET_ROW_ID, url: 'internal://offset', payload: String(offset) });
  }
}

/**
 * Poll Telegram getUpdates once (non-blocking) and handle every update.
 * Called on the every-minute schedule; webhook mode stays available when a
 * domain exists. Latency is <= ~60s worst case.
 */
async function pollOnce(log) {
  const bot = makeBot();
  if (!bot) {
    log('poll skipped: TELEGRAM_BOT_TOKEN is not configured');
    return { ok: false, handled: 0, reason: 'no-token' };
  }
  await syncBotMeta(bot, log);
  const offset = await readOffset();
  let updates = [];
  try {
    updates = await bot.api.getUpdates({ offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  } catch (err) {
    // 409 = another poller still running – harmless on overlapping schedules
    return { ok: false, handled: 0, reason: String(err?.message ?? err).slice(0, 200) };
  }
  let lastOffset = offset;
  for (const update of updates) {
    try {
      await bot.handleUpdate(update);
    } catch (err) {
      logSafe(err);
    }
    lastOffset = update.update_id + 1;
  }
  if (lastOffset !== offset) {
    await writeOffset(lastOffset);
  }
  return { ok: true, handled: updates.length };
}

/**
 * Direct-download flow: no quality-picker roundtrip. A link immediately
 * queues the best variant and the media is delivered straight into the chat:
 *   - photo posts -> image album (+ MP3 / ZIP extras keyboard)
 *   - videos      -> HD video (+ MP3 / more sizes extras keyboard)
 */
async function handleLink(ctx, url) {
  const waitMsg = await ctx.reply('🔎 Fetching post info…');
  try {
    const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
    const preview = await getCachedPreview(url, hash);
    await ctx.deleteMessage(waitMsg.message_id).catch(() => {});

    const queueJob = async (quality, kind) =>
      createRow('jobs', {
        url,
        uniqueId: preview.uniqueId,
        quality,
        kind,
        status: 'queued',
        chatId: String(ctx.chat?.id ?? ''),
        telegramUserId: String(ctx.from?.id ?? ''),
        title: preview.title ?? '',
      });

    if (preview.imageUrls?.length) {
      await queueJob('auto', 'images');
      await ctx.reply(
        `🖼️ <b>Photo post</b> — sending ${preview.imageUrls.length} image(s) here…\n` +
        `👤 @${escapeHtml(preview.uniqueId)}${preview.musicTitle ? ` · 🎵 ${escapeHtml(preview.musicTitle)}` : ''}`,
        { parse_mode: 'HTML', reply_markup: postExtrasKeyboard(hash, true) },
      );
      return;
    }

    if (preview.videoUrl || preview.videoHdUrl || preview.videoSdUrl) {
      await queueJob('hd', 'video');
      await ctx.reply(
        `⏳ Downloading <b>HD video</b> — it will arrive right here 🚀\n` +
        `🎵 ${escapeHtml(preview.title || preview.musicTitle || 'TikTok video')}`,
        { parse_mode: 'HTML', reply_markup: postExtrasKeyboard(hash, false) },
      );
      return;
    }

    await ctx.reply(
      '⚠️ This post has no downloadable media — it may be private, removed or unsupported.',
    );
  } catch (err) {
    logSafe(err);
    await ctx
      .reply('⚠️ Could not fetch this link. It may be private, removed or unsupported.')
      .catch(() => {});
  }
}

function makeBot() {
  if (!ENV.botToken) {
    return null;
  }
  const bot = new Bot(ENV.botToken);
  registerBot(bot);
  return bot;
}

/**
 * Registers the command list + Mini App menu button on Telegram (once per
 * version, tracked in the meta table so scheduled runs stay cheap).
 */
async function syncBotMeta(bot, log) {
  try {
    let current = '';
    try {
      current = String((await getRow('meta', 'tg_commands_version')).payload ?? '');
    } catch {
      /* first run */
    }
    if (current === BOT_COMMANDS_VERSION) return;
    await bot.api.setMyCommands([
      { command: 'start', description: '👋 Start the bot' },
      { command: 'download', description: '📥 Download a TikTok link' },
      { command: 'status', description: '📊 Your recent downloads' },
      { command: 'miniapp', description: '📱 Open the Mini App' },
      { command: 'help', description: 'ℹ️ How to use' },
      { command: 'id', description: '🪪 Show your IDs' },
    ]);
    if (ENV.miniAppUrl) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: 'Open eeetik', web_app: { url: ENV.miniAppUrl } },
      });
    }
    try {
      await getRow('meta', 'tg_commands_version');
      await updateRow('meta', 'tg_commands_version', { payload: BOT_COMMANDS_VERSION });
    } catch {
      await createRow('meta', {
        uniqueId: 'tg_commands_version',
        url: 'internal://commands',
        payload: BOT_COMMANDS_VERSION,
      });
    }
    log('bot commands + menu button synced');
  } catch (err) {
    logSafe(err);
  }
}

// ─── JSON action handlers ────────────────────────────────────────────────────
async function handleAuth(body) {
  const tgUser = validateInitData(body.initData);
  const tgId = String(tgUser.id);
  const awUserId = `tg_${tgId}`;
  const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');

  try {
    await aw(`/users/${awUserId}`);
  } catch {
    await aw('/users', 'POST', { userId: awUserId, name: fullName || `tg_${tgId}` });
  }

  // Upsert app-level profile row (deterministic row id).
  const profile = {
    telegramId: tgId,
    appwriteUserId: awUserId,
    username: tgUser.username ?? '',
    firstName: tgUser.first_name ?? '',
    lastName: tgUser.last_name ?? '',
    photoUrl: tgUser.photo_url ?? '',
    languageCode: tgUser.language_code ?? '',
    isPremium: Boolean(tgUser.is_premium),
  };
  try {
    await getRow('users', awUserId);
    await updateRow('users', awUserId, profile);
  } catch {
    await createRow('users', profile);
  }

  const session = await aw(`/users/${awUserId}/sessions`, 'POST', {});
  return {
    ok: true,
    userId: awUserId,
    secret: session.secret,
    user: { id: tgId, username: tgUser.username ?? '', name: fullName },
  };
}

async function handlePrepare(body, awUserId) {
  if (!awUserId) {
    return { status: 401, payload: { ok: false, error: 'Sign in with Telegram first' } };
  }
  const url = String(body?.url ?? '').trim();
  const quality = String(body?.quality ?? '').trim();
  const spec = QUALITIES[quality];
  if (!URL_REGEX.test(url) || !spec) {
    return { status: 400, payload: { ok: false, error: 'url and quality are required' } };
  }
  const preview = await getCachedPreview(url, crypto.createHash('sha1').update(url).digest('hex').slice(0, 12));
  let telegramUserId = '';
  try {
    const profile = await getRow('users', awUserId);
    telegramUserId = profile.telegramUserId ?? '';
  } catch {
    /* profile missing */
  }
  const job = await createRow('jobs', {
    url,
    uniqueId: preview.uniqueId,
    quality,
    kind: spec.kind,
    status: 'queued',
    appwriteUserId: awUserId,
    telegramUserId,
    title: preview.title ?? '',
  });
  return { status: 200, payload: { ok: true, jobId: job.$id, uniqueId: preview.uniqueId } };
}

async function handleJobs(awUserId) {
  if (!awUserId) {
    return { status: 401, payload: { ok: false, error: 'Sign in with Telegram first' } };
  }
  const result = await listTableRows('jobs', [
    { method: 'equal', attribute: 'appwriteUserId', values: [awUserId] },
    { method: 'orderAsc', attribute: '$createdAt' },
    { method: 'limit', values: [25] },
  ]);
  const jobs = (result.rows ?? []).map((row) => ({
    id: row.$id,
    uniqueId: row.uniqueId,
    title: row.title,
    quality: row.quality,
    kind: row.kind,
    status: row.status,
    error: row.error,
    note: row.note,
    createdAt: row.$createdAt,
  }));
  return { status: 200, payload: { ok: true, jobs } };
}

async function handleDownload(body, awUserId) {
  if (!awUserId) {
    return { status: 401, payload: { ok: false, error: 'Sign in with Telegram first' } };
  }
  if (!ENV.botToken) {
    return { status: 500, payload: { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' } };
  }
  const job = await getRow('jobs', String(body?.jobId ?? ''));
  if ((job.appwriteUserId ?? '') !== awUserId) {
    return { status: 403, payload: { ok: false, error: 'Not your job' } };
  }
  if (job.status !== 'completed' || (!job.fileId && !job.appwriteFileId)) {
    return { status: 409, payload: { ok: false, error: `Job is ${job.status}` } };
  }
  // Prefer the permanent Appwrite Storage copy (never expires) over the
  // 1-hour Telegram file URL.
  if (job.appwriteFileId && ENV.bucketId) {
    return {
      status: 200,
      payload: {
        ok: true,
        kind: job.kind,
        source: 'bucket',
        url: `${ENV.endpoint}/storage/buckets/${ENV.bucketId}/files/${job.appwriteFileId}/view?project=${ENV.projectId}`,
      },
    };
  }
  const bot = makeBot();
  const file = await bot.api.getFile(job.fileId);
  return {
    status: 200,
    payload: {
      ok: true,
      kind: job.kind,
      source: 'telegram',
      url: `https://api.telegram.org/file/bot${ENV.botToken}/${file.file_path}`,
    },
  };
}

async function handleHistory(awUserId) {
  if (!awUserId) {
    return { status: 401, payload: { ok: false, error: 'Sign in with Telegram first' } };
  }
  const result = await listTableRows('history', [
    { method: 'equal', attribute: 'appwriteUserId', values: [awUserId] },
    { method: 'orderAsc', attribute: '$createdAt' },
    { method: 'limit', values: [30] },
  ]);
  const history = (result.rows ?? []).map((row) => ({
    id: row.$id,
    uniqueId: row.uniqueId,
    title: row.title,
    quality: row.quality,
    kind: row.kind,
    status: row.status,
    thumbnailUrl: row.thumbnailUrl,
    createdAt: row.$createdAt,
  }));
  return { status: 200, payload: { ok: true, history } };
}

/** Reads (and optionally updates) the Mini App settings for the session user. */
async function handleSettings(body, awUserId) {
  if (!awUserId) {
    return { status: 401, payload: { ok: false, error: 'Sign in with Telegram first' } };
  }
  let row;
  try {
    row = await getRow('users', awUserId);
  } catch {
    return { status: 404, payload: { ok: false, error: 'Profile not found – authenticate first' } };
  }
  if (body?.settings !== undefined) {
    const serialized = JSON.stringify(body.settings).slice(0, 4000);
    await updateRow('users', awUserId, { settings: serialized });
    row = { ...row, settings: serialized };
  }
  let settings = {};
  try {
    settings = JSON.parse(row.settings ?? '{}');
  } catch {
    settings = {};
  }
  return {
    status: 200,
    payload: {
      ok: true,
      settings: JSON.stringify(settings),
      user: {
        telegramId: row.telegramId,
        username: row.username,
        firstName: row.firstName,
      },
    },
  };
}

// ─── entrypoint ──────────────────────────────────────────────────────────────
export default async ({ req, res, log, error }) => {
  // NOTE: the runtime's req.bodyJson getter THROWS on empty bodies (scheduled
  // executions arrive with no body) – never access it unguarded. Without this
  // guard every scheduled poll crashes and the bot goes deaf.
  let body = {};
  try {
    body = req.bodyJson ?? safeParse(req.bodyRaw) ?? {};
  } catch {
    body = safeParse(req.bodyRaw) ?? {};
  }
  const headers = req.headers ?? {};

  try {
    // Role 1: Telegram webhook (via function domain).
    const telegramSecret = headers['x-telegram-bot-api-secret-token'];
    if (telegramSecret !== undefined) {
      if (ENV.webhookSecret && telegramSecret !== ENV.webhookSecret) {
        error('webhook secret mismatch');
        return res.json({ ok: false }, 403);
      }
      const bot = makeBot();
      if (!bot) {
        error('TELEGRAM_BOT_TOKEN is not configured');
        return res.json({ ok: false }, 500);
      }
      await bot.handleUpdate(body);
      return res.json({ ok: true });
      // (syncBotMeta runs on the polling path; webhook mode stays lean)
    }

    // Role 1b: scheduled polling mode (every-minute schedule, no domain needed).
    const isScheduleTrigger = Array.isArray(body?.events)
      && body.events.some((e) => String(e).includes('schedules'));
    if (isScheduleTrigger || (body?.action === 'poll')) {
      const result = await pollOnce(log);
      return res.json({ ok: true, poll: result });
    }

    // Role 2: JSON action API.
    const action = body?.action;
    const awUserId = headers['x-appwrite-user-id'] ?? '';
    let result;
    switch (action) {
      case 'auth':
        result = { status: 200, payload: await handleAuth(body) };
        break;
      case 'metadata':
        result = {
          status: 200,
          payload: {
            ok: true,
            preview: await getCachedPreview(
              String(body?.url ?? req.query?.url ?? ''),
              crypto.createHash('sha1').update(String(body?.url ?? req.query?.url ?? '')).digest('hex').slice(0, 12),
            ),
          },
        };
        break;
      case 'prepare':
        result = await handlePrepare(body, awUserId);
        break;
      case 'jobs':
        result = await handleJobs(awUserId);
        break;
      case 'download':
        result = await handleDownload(body, awUserId);
        break;
      case 'history':
        result = await handleHistory(awUserId);
        break;
      case 'settings':
        result = await handleSettings(body, awUserId);
        break;
      case 'ping':
        result = { status: 200, payload: { ok: true, pong: true, miniAppUrl: ENV.miniAppUrl } };
        break;
      default:
        result = { status: 400, payload: { ok: false, error: 'Unknown action' } };
    }
    return res.json(result.payload, result.status);
  } catch (err) {
    error(`tg-bot failure: ${err?.message ?? err}`);
    return res.json({ ok: false, error: err?.message ?? 'internal error' }, 500);
  }
};

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
