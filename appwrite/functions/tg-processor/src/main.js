/**
 * eeetik tg-processor – Appwrite Function (runtime: node-22, max 900s)
 *
 * Triggered by:
 *  - table event: databases.eeetik.tables.jobs.rows.*.create  (per job)
 *  - schedule (every 5 min): sweeps stuck `queued` jobs as a safety net
 *
 * Flow per job:
 *   scrape (cached) -> check Telegram file_id cache -> download to /tmp ->
 *   upload to Telegram (delivers to chat when chatId known) -> cache file_id
 *   -> job completed (+ history row for Mini App users) -> cleanup /tmp
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bot, InputFile, InlineKeyboard } from 'grammy';
import archiver from 'archiver';
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
  storageChatId: process.env.TELEGRAM_STORAGE_CHAT_ID ?? '',
  bucketId: process.env.APPWRITE_BUCKET_ID ?? '',
  bucketMaxTotalMb: Number(process.env.BUCKET_MAX_TOTAL_MB ?? 1800),
  maxUploadMb: Number(process.env.TELEGRAM_MAX_UPLOAD_MB ?? 49),
};
const DATABASE_ID = 'eeetik';
const MAX_BYTES = ENV.maxUploadMb * 1024 * 1024;

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

async function listTableRows(table, queries) {
  const params = new URLSearchParams();
  for (const query of queries) {
    params.append('queries[]', JSON.stringify(query));
  }
  const qs = params.toString();
  return aw(`/tablesdb/${DATABASE_ID}/tables/${table}/rows${qs ? `?${qs}` : ''}`);
}

async function upsertFileCache(key, data) {
  try {
    await getRow('files', key.replace(/[^\w.-]/g, '_'));
    await updateRow('files', key.replace(/[^\w.-]/g, '_'), data);
  } catch {
    await createRow('files', { key, ...data });
  }
}

// ─── Appwrite Storage bucket (permanent download links) ─────────────────
const bucketViewUrl = (fileId) =>
  `${ENV.endpoint}/storage/buckets/${ENV.bucketId}/files/${fileId}/view?project=${ENV.projectId}`;

/** Best-effort upload; returns the Appwrite file id or '' when disabled/failed. */
async function uploadToBucket(filePath, fileName, log) {
  if (!ENV.bucketId || !ENV.apiKey) {
    return '';
  }
  try {
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('fileId', 'unique()');
    form.append('file', new Blob([buffer]), fileName);
    const response = await fetch(`${ENV.endpoint}/storage/buckets/${ENV.bucketId}/files`, {
      method: 'POST',
      headers: {
        'X-Appwrite-Project': ENV.projectId,
        'X-Appwrite-Key': ENV.apiKey,
      },
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message ?? `HTTP ${response.status}`);
    }
    return payload.$id ?? '';
  } catch (err) {
    log(`bucket upload skipped: ${String(err?.message ?? err).slice(0, 200)}`);
    return '';
  }
}

// ─── scrape + preview (mirrors tg-bot mapping) ───────────────────────────────
const asRecord = (value) => (value && typeof value === 'object' ? value : {});
const firstString = (candidates) =>
  candidates.find((c) => typeof c === 'string' && c.length > 0);
const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function extractUniqueId(url, content) {
  const author = asRecord(content?.author);
  if (typeof author?.unique_id === 'string') return author.unique_id;
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
  return {
    uniqueId: extractUniqueId(url, content),
    title: typeof content?.desc === 'string' ? content.desc.slice(0, 300) : '',
    authorName: firstString([author?.nickname]) ?? '',
    thumbnailUrl: firstString([video?.originCover?.[0], video?.cover?.[0]]) ?? '',
    videoUrl: firstString([video?.playAddr?.[0], content?.direct]) ?? '',
    videoHdUrl: firstString([content?.videoHD, video?.playAddr?.[0]]) ?? '',
    videoSdUrl: firstString([content?.videoSD, video?.downloadAddr?.[0]]) ?? '',
    audioUrl: firstString([music?.playUrl?.[0]]) ?? '',
    musicTitle: firstString([music?.title, music?.name]) ?? '',
    imageUrls,
    stats: {
      views: toNumber(stats?.playCount),
      likes: toNumber(stats?.likeCount),
      comments: toNumber(stats?.commentCount),
      shares: toNumber(stats?.shareCount),
    },
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

async function resolvePreview(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  try {
    const row = await getRow('meta', hash);
    if (Date.now() - Date.parse(row.$createdAt) < 24 * 3600 * 1000) {
      return JSON.parse(row.payload);
    }
  } catch {
    /* cache miss */
  }
  const preview = await scrapePreview(url);
  try {
    await createRow('meta', { uniqueId: preview.uniqueId, url, payload: JSON.stringify(preview) });
  } catch {
    await updateRow('meta', hash, { url, payload: JSON.stringify(preview) }).catch(() => {});
  }
  return preview;
}

// ─── delivery helpers ────────────────────────────────────────────────────────
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pickVideoUrl(preview, quality) {
  if (quality === 'sd' || quality === 'sd360') {
    return preview.videoSdUrl || preview.videoUrl;
  }
  // hd / hd720 / file (original, uncompressed) all prefer the HD source.
  return preview.videoHdUrl || preview.videoUrl;
}

const QUALITY_LABELS = {
  hd: 'HD 1080p',
  hd720: 'HD 720p',
  sd: 'SD 480p',
  sd360: 'SD 360p',
  audio: 'Audio MP3',
  zip: 'Images ZIP',
  zipwebp: 'Images WebP',
  file: 'Video File',
  auto: 'Photos',
};

function formatCompact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Rich delivery caption: description, author, quality, stats and song name. */
function formatDeliveryCaption(preview, quality, extraNote) {
  const stats = preview.stats ?? {};
  const lines = [
    `🎵 <b>${escapeHtml(preview.title || 'TikTok')}</b>`,
    `👤 @${preview.uniqueId}${preview.authorName ? ` · ${escapeHtml(preview.authorName)}` : ''} · ${QUALITY_LABELS[quality] ?? String(quality).toUpperCase()}`,
  ];
  const statParts = [
    stats.views ? `👁 ${formatCompact(stats.views)}` : '',
    stats.likes ? `❤️ ${formatCompact(stats.likes)}` : '',
    stats.comments ? `💬 ${formatCompact(stats.comments)}` : '',
    stats.shares ? `🔁 ${formatCompact(stats.shares)}` : '',
  ].filter(Boolean);
  if (statParts.length) lines.push(statParts.join(' · '));
  if (preview.musicTitle) lines.push(`🎵 ${escapeHtml(preview.musicTitle)}`);
  if (preview.duration) lines.push(`⏱ ${Math.round(preview.duration)}s`);
  if (extraNote) lines.push(escapeHtml(extraNote));
  return lines.join('\n');
}

/**
 * Inline keyboard under the delivered media. Direct-to-chat only: no external
 * links – just callback buttons for the song / other sizes.
 */
function buildDeliveryMarkup(urlHash, kind) {
  const keyboard = new InlineKeyboard();
  if (kind === 'video' || kind === 'file') {
    keyboard.text('🎵 Get MP3', `music:${urlHash}`).text('🎬 More sizes', `more:${urlHash}`);
    return keyboard;
  }
  if (kind === 'zip') {
    keyboard.text('🎵 Get MP3', `music:${urlHash}`);
    return keyboard;
  }
  return undefined;
}

// ─── bucket capacity guard (stay on the free plan) ──────────────────────
async function ensureBucketCapacity(incomingBytes, log) {
  if (!ENV.bucketId || !ENV.apiKey || !ENV.bucketMaxTotalMb) return;
  const maxBytes = ENV.bucketMaxTotalMb * 1024 * 1024;
  try {
    const bucket = await aw(`/storage/buckets/${ENV.bucketId}`);
    let total = bucket.totalSize ?? 0;
    if (total + incomingBytes <= maxBytes) return;
    log(
      `bucket at ${(total / 1048576).toFixed(0)} MB — pruning oldest files to stay under ${ENV.bucketMaxTotalMb} MB`,
    );
    const all = [];
    for (let offset = 0; offset < 4000; offset += 100) {
      const qs = `queries[]=${encodeURIComponent(JSON.stringify({ method: 'limit', values: [100] }))}`
        + `&queries[]=${encodeURIComponent(JSON.stringify({ method: 'offset', values: [offset] }))}`;
      const res = await aw(`/storage/buckets/${ENV.bucketId}/files?${qs}`);
      const batch = res.files ?? [];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    all.sort((a, b) => Date.parse(a.$createdAt) - Date.parse(b.$createdAt));
    for (const file of all) {
      if (total + incomingBytes <= maxBytes) return;
      try {
        await aw(`/storage/buckets/${ENV.bucketId}/files/${file.$id}`, 'DELETE');
        total -= file.sizeOriginal ?? 0;
      } catch {
        /* already gone */
      }
    }
    log(`bucket pruned to ${(total / 1048576).toFixed(0)} MB`);
  } catch (err) {
    log(`capacity check skipped: ${String(err?.message ?? err).slice(0, 120)}`);
  }
}

// ─── WebP conversion (optional native dep, graceful fallback) ───────────
let sharpState = undefined; // undefined = not loaded, false = unavailable
async function getSharp() {
  if (sharpState !== undefined) return sharpState || null;
  try {
    sharpState = (await import('sharp')).default ?? null;
  } catch {
    sharpState = false;
  }
  return sharpState || null;
}

async function toWebpBuffer(buffer, log) {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    return await sharp(buffer).webp({ quality: 100, effort: 4 }).toBuffer();
  } catch (err) {
    log(`webp conversion failed: ${String(err?.message ?? err).slice(0, 120)}`);
    return null;
  }
}

async function downloadToBuffer(url, maxBytes) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; eeetik-bot)' },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    throw new Error(`too-large:${declared}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`too-large:${buffer.byteLength}`);
  }
  return buffer;
}

function zipFiles(entries) {
  return new Promise((resolve, reject) => {
    const dest = path.join(os.tmpdir(), `eeetik-${crypto.randomUUID()}.zip`);
    const output = fs.createWriteStream(dest);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(dest));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) {
      archive.append(entry.buffer, { name: entry.name });
    }
    archive.finalize();
  });
}

async function tryFetchThumbnail(url) {
  try {
    if (!url) return undefined;
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength < 200 * 1024 ? buffer : undefined;
  } catch {
    return undefined;
  }
}

function makeBot() {
  if (!ENV.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }
  return new Bot(ENV.botToken);
}

// ─── core job processing ─────────────────────────────────────────────────────
async function processJob(job, log) {
  const jobId = job.$id;
  const quality = job.quality;
  const kind = job.kind;

  await updateRow('jobs', jobId, { status: 'processing' });

  const preview = await resolvePreview(job.url);
  await updateRow('jobs', jobId, { title: preview.title ?? '' });

  // 1. file_id cache check (Telegram CDN reuse).
  const cacheKey = `${preview.uniqueId}:${kind}:${quality}`;
  let cachedFileId = '';
  let cachedBucketFileId = '';
  try {
    const row = await getRow('files', cacheKey.replace(/[^\w.-]/g, '_'));
    cachedFileId = row.fileId ?? '';
    cachedBucketFileId = row.appwriteFileId ?? '';
  } catch {
    /* miss */
  }

  const bot = makeBot();
  const chatId = job.chatId || ENV.storageChatId;
  if (!chatId) {
    throw new Error(
      'No delivery target: job has no chatId and TELEGRAM_STORAGE_CHAT_ID is not configured',
    );
  }

  const urlHash = crypto.createHash('sha1').update(job.url).digest('hex').slice(0, 12);
  const caption = formatDeliveryCaption(preview, quality);

  // 1b. Photo posts -> deliver ALL post images as an album, straight into the
  //     chat (explicit user request: automatic media images for photo posts).
  //     Albums are not file_id-cached; re-downloading images is fast.
  if (kind === 'images') {
    if (!preview.imageUrls?.length) {
      throw new Error('This post has no images to send');
    }
    const maxImages = Math.min(preview.imageUrls.length, 30);
    let delivered = 0;
    for (let offset = 0; offset < maxImages; offset += 10) {
      const batch = [];
      for (let i = offset; i < Math.min(offset + 10, maxImages); i += 1) {
        const buffer = await downloadToBuffer(preview.imageUrls[i], MAX_BYTES);
        batch.push({
          type: 'photo',
          media: new InputFile(buffer, `${preview.uniqueId}-${i + 1}.jpg`),
          // Rich caption (desc / author / stats / music) on the first photo.
          ...(delivered === 0 ? { caption, parse_mode: 'HTML' } : {}),
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await bot.api.sendMediaGroup(chatId, batch);
      delivered += batch.length;
    }
    // Follow-up extras: the song + zip packs of the same post (callbacks only).
    const extras = new InlineKeyboard()
      .text('🎵 Get MP3', `music:${urlHash}`)
      .text('📦 Images ZIP', `quality:${urlHash}:zip`)
      .text('🌐 WebP ZIP', `quality:${urlHash}:zipwebp`);
    await bot.api
      .sendMessage(chatId, `🖼️ ${delivered} image(s) delivered${preview.musicTitle ? ` — song: ${escapeHtml(preview.musicTitle)}` : ''}`, {
        reply_markup: extras,
      })
      .catch(() => {});
    await updateRow('jobs', jobId, { status: 'completed' });
    await addHistory(job, preview, quality, kind, '', 'completed');
    log(`job ${jobId}: delivered ${delivered} image(s) as album`);
    return;
  }

  // 2a. Cached file_id -> send instantly (no re-upload).
  if (cachedFileId) {
    const markup = buildDeliveryMarkup(urlHash, kind);
    await sendByKind(bot, chatId, cachedFileId, kind, caption, preview, markup, log);
    await updateRow('jobs', jobId, { status: 'completed', fileId: cachedFileId, appwriteFileId: cachedBucketFileId });
    await addHistory(job, preview, quality, kind, cachedFileId, 'completed');
    log(`job ${jobId}: delivered cached file_id (${cacheKey})`);
    return;
  }

  // 2b. Fresh download -> upload -> cache file_id.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eeetik-'));
  let captionNote = '';
  try {
    let filePath;
    let thumbnail;
    if (kind === 'zip') {
      if (!preview.imageUrls?.length) {
        throw new Error('This post has no images to zip');
      }
      const asWebp = quality === 'zipwebp';
      const maxImages = Math.min(preview.imageUrls.length, 30);
      const entries = [];
      let converted = 0;
      for (let i = 0; i < maxImages; i += 1) {
        const buffer = await downloadToBuffer(preview.imageUrls[i], MAX_BYTES);
        let payload = buffer;
        let ext = 'jpg';
        if (asWebp) {
          const webp = await toWebpBuffer(buffer, log);
          if (webp) {
            payload = webp;
            ext = 'webp';
            converted += 1;
          }
        }
        entries.push({ buffer: payload, name: `${preview.uniqueId}-${i + 1}.${ext}` });
      }
      filePath = await zipFiles(entries);
      if (asWebp && converted < maxImages) {
        log(`job ${jobId}: webp fallback for ${maxImages - converted} image(s)`);
      }
      captionNote = asWebp && converted === 0
        ? 'webp converter unavailable — original quality kept'
        : '';
    } else {
      const sourceUrl = kind === 'audio' ? preview.audioUrl : pickVideoUrl(preview, quality);
      if (!sourceUrl) {
        if (preview.imageUrls?.length) {
          throw new Error('This is a photo post — tap 📦 Images ZIP on the preview to get the pictures');
        }
        throw new Error(`No ${kind} source available for this post`);
      }
      let buffer;
      try {
        buffer = await downloadToBuffer(sourceUrl, MAX_BYTES);
      } catch (err) {
        if (String(err.message).startsWith('too-large') && kind === 'video' && quality !== 'sd' && preview.videoSdUrl) {
          log(`job ${jobId}: too large for ${quality}, falling back to SD`);
          buffer = await downloadToBuffer(preview.videoSdUrl, MAX_BYTES);
        } else if (String(err.message).startsWith('too-large')) {
          const sizeMb = Math.round(Number(String(err.message).split(':')[1]) / (1024 * 1024));
          throw new Error(`File is ~${sizeMb} MB, larger than the ${ENV.maxUploadMb} MB Telegram bot limit. Open the Mini App for direct playback instead.`);
        } else {
          throw err;
        }
      }
      const ext = kind === 'audio' ? 'm4a' : 'mp4';
      filePath = path.join(tmpDir, `${preview.uniqueId}-${quality}.${ext}`);
      fs.writeFileSync(filePath, buffer);
      thumbnail = kind === 'video' ? await tryFetchThumbnail(preview.thumbnailUrl) : undefined;
    }

    // Permanent copy in the Appwrite Storage bucket (best effort) – the Mini
    // App serves these via authenticated downloads.
    let bucketFileId = '';
    try {
      await ensureBucketCapacity(fs.statSync(filePath).size, log);
      bucketFileId = await uploadToBucket(filePath, path.basename(filePath), log);
    } catch (bucketErr) {
      log(`bucket upload skipped: ${bucketErr?.message ?? bucketErr}`);
    }
    const markup = buildDeliveryMarkup(urlHash, kind);

    const message = await uploadByKind(
      bot, chatId, filePath, kind,
      captionNote ? formatDeliveryCaption(preview, quality, captionNote) : caption,
      preview, thumbnail, markup,
    );
    const fileId = extractFileId(message, kind);
    if (!fileId) {
      throw new Error('Telegram did not return a file_id');
    }
    await upsertFileCache(cacheKey.replace(/[^\w.-]/g, '_'), {
      key: cacheKey,
      fileId,
      appwriteFileId: bucketFileId,
      uniqueId: preview.uniqueId,
      kind,
      quality,
    });
    await updateRow('jobs', jobId, {
      status: 'completed',
      fileId,
      appwriteFileId: bucketFileId,
    });
    await addHistory(job, preview, quality, kind, fileId, 'completed');
    log(`job ${jobId}: uploaded + cached (${cacheKey})`);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

async function addHistory(job, preview, quality, kind, fileId, status) {
  if (!job.appwriteUserId) {
    return;
  }
  try {
    await createRow('history', {
      appwriteUserId: job.appwriteUserId,
      telegramUserId: job.telegramUserId ?? '',
      uniqueId: preview.uniqueId,
      title: preview.title ?? '',
      quality,
      kind,
      fileId: fileId ?? '',
      thumbnailUrl: preview.thumbnailUrl ?? '',
      status,
    });
  } catch (err) {
    console.error('[tg-processor] history insert failed:', err?.message ?? err);
  }
}

async function uploadByKind(bot, chatId, filePath, kind, caption, preview, thumbnail, replyMarkup) {
  const options = { caption, parse_mode: 'HTML' };
  if (replyMarkup) {
    options.reply_markup = replyMarkup;
  }
  if (preview.duration) {
    options.duration = Math.round(preview.duration);
  }
  if (thumbnail) {
    options.thumbnail = new InputFile(thumbnail, 'thumb.jpg');
  }
  if (kind === 'audio') {
    return bot.api.sendAudio(chatId, new InputFile(filePath), {
      ...options,
      title: (preview.musicTitle || preview.title || 'TikTok audio').slice(0, 60),
      performer: preview.authorName || preview.uniqueId,
    });
  }
  if (kind === 'zip' || kind === 'file') {
    // Documents are sent as-is: no Telegram video compression, original bytes.
    const prettyName = kind === 'file'
      ? `${String(preview.title || preview.uniqueId).replace(/[^\w\- ]+/g, '').trim().slice(0, 48) || preview.uniqueId}.mp4`
      : path.basename(filePath);
    const documentOptions = { ...options };
    if (kind === 'file') {
      // Without this flag Telegram sniffs the mp4 and re-registers the upload
      // as a streamable `video` message instead of returning a document.
      documentOptions.disable_content_type_detection = true;
    }
    return bot.api.sendDocument(chatId, new InputFile(filePath, prettyName), documentOptions);
  }
  return bot.api.sendVideo(chatId, new InputFile(filePath), { ...options, supports_streaming: true });
}

async function sendByKind(bot, chatId, fileId, kind, caption, preview, replyMarkup, log) {
  const options = { caption, parse_mode: 'HTML' };
  if (replyMarkup) {
    options.reply_markup = replyMarkup;
  }
  try {
    if (kind === 'audio') {
      await bot.api.sendAudio(chatId, fileId, {
        ...options,
        title: (preview.musicTitle || preview.title || 'TikTok audio').slice(0, 60),
      });
    } else if (kind === 'zip') {
      await bot.api.sendDocument(chatId, fileId, options);
    } else if (kind === 'file') {
      await bot.api.sendDocument(chatId, fileId, { ...options, disable_content_type_detection: true });
    } else {
      await bot.api.sendVideo(chatId, fileId, { ...options, supports_streaming: true });
    }
  } catch (err) {
    // file_id may be invalid (media deleted) – caller treats as cache miss
    log(`cached send failed: ${err?.message ?? err}`);
    throw err;
  }
}

function extractFileId(message, kind) {
  if (!message) return '';
  if (kind === 'audio') return message.audio?.file_id ?? '';
  if (kind === 'zip') return message.document?.file_id ?? '';
  if (kind === 'file') {
    // Telegram may still present the upload as a streamable video; bytes are
    // identical either way – accept both so the cache never misses.
    return message.document?.file_id ?? message.video?.file_id ?? '';
  }
  return message.video?.file_id ?? '';
}

async function notifyChat(bot, chatId, text) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch {
    /* best effort */
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function processJobSafe(job, log, error) {
  try {
    await processJob(job, log);
  } catch (err) {
    const message = String(err?.message ?? err);
    error(`job ${job.$id} failed: ${message}`);
    await updateRow('jobs', job.$id, { status: 'failed', error: message.slice(0, 1000) }).catch(() => {});
    await addHistory(job, { uniqueId: job.uniqueId ?? '', title: job.title ?? '', thumbnailUrl: '' }, job.quality, job.kind, '', 'failed');
    if (job.chatId) {
      try {
        const bot = makeBot();
        await notifyChat(bot, job.chatId, `⚠️ <b>Download failed</b>\n${escapeHtml(message.slice(0, 300))}`);
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── entrypoint ──────────────────────────────────────────────────────────────
export default async ({ req, res, log, error }) => {
  // NOTE: the runtime's req.bodyJson getter THROWS on empty bodies (scheduled
  // executions arrive with no body) – never access it unguarded.
  let body = {};
  try {
    body = req.bodyJson ?? safeParse(req.bodyRaw) ?? {};
  } catch {
    body = safeParse(req.bodyRaw) ?? {};
  }
  try {
    const candidate =
      body?.data?.$id ?? body?.row?.$id ?? body?.$id ?? body?.document?.$id ?? '';

    if (candidate) {
      const job = await getRow('jobs', candidate);
      log(`event-triggered job ${candidate}`);
      await processJobSafe(job, log, error);
    } else {
      // Sweep mode (schedule safety net): oldest queued jobs first.
      const result = await listTableRows('jobs', [
        { method: 'equal', attribute: 'status', values: ['queued'] },
        { method: 'orderAsc', attribute: '$createdAt' },
        { method: 'limit', values: [5] },
      ]);
      const queued = result.rows ?? [];
      log(`sweep: ${queued.length} queued job(s)`);
      for (const job of queued) {
        await processJobSafe(job, log, error);
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    error(`tg-processor failure: ${err?.message ?? err}`);
    return res.json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
};
