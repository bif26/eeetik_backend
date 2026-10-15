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
import { Bot, InputFile } from 'grammy';
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
    imageUrls,
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
  return preview.videoHdUrl || preview.videoUrl;
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
  try {
    const row = await getRow('files', cacheKey.replace(/[^\w.-]/g, '_'));
    cachedFileId = row.fileId ?? '';
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

  const caption = [
    `🎵 <b>${escapeHtml(preview.title || 'TikTok')}</b>`,
    `👤 @${preview.uniqueId} · ${quality.toUpperCase()}`,
  ].join('\n');

  // 2a. Cached file_id -> send instantly (no re-upload).
  if (cachedFileId) {
    await sendByKind(bot, chatId, cachedFileId, kind, caption, preview, undefined, log);
    await updateRow('jobs', jobId, { status: 'completed', fileId: cachedFileId });
    await addHistory(job, preview, quality, kind, cachedFileId, 'completed');
    log(`job ${jobId}: delivered cached file_id (${cacheKey})`);
    return;
  }

  // 2b. Fresh download -> upload -> cache file_id.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eeetik-'));
  try {
    let filePath;
    let thumbnail;
    if (kind === 'zip') {
      if (!preview.imageUrls?.length) {
        throw new Error('This post has no images to zip');
      }
      const maxImages = Math.min(preview.imageUrls.length, 30);
      const entries = [];
      for (let i = 0; i < maxImages; i += 1) {
        const buffer = await downloadToBuffer(preview.imageUrls[i], MAX_BYTES);
        entries.push({ buffer, name: `${preview.uniqueId}-${i + 1}.jpg` });
      }
      filePath = await zipFiles(entries);
    } else {
      const sourceUrl = kind === 'audio' ? preview.audioUrl : pickVideoUrl(preview, quality);
      if (!sourceUrl) {
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

    const message = await uploadByKind(bot, chatId, filePath, kind, caption, preview, thumbnail);
    const fileId = extractFileId(message, kind);
    if (!fileId) {
      throw new Error('Telegram did not return a file_id');
    }
    await upsertFileCache(cacheKey.replace(/[^\w.-]/g, '_'), {
      key: cacheKey,
      fileId,
      uniqueId: preview.uniqueId,
      kind,
      quality,
    });
    await updateRow('jobs', jobId, { status: 'completed', fileId });
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

async function uploadByKind(bot, chatId, filePath, kind, caption, preview, thumbnail) {
  const options = { caption, parse_mode: 'HTML' };
  if (preview.duration) {
    options.duration = Math.round(preview.duration);
  }
  if (thumbnail) {
    options.thumbnail = new InputFile(thumbnail, 'thumb.jpg');
  }
  if (kind === 'audio') {
    return bot.api.sendAudio(chatId, new InputFile(filePath), {
      ...options,
      title: (preview.title || 'TikTok audio').slice(0, 60),
      performer: preview.authorName || preview.uniqueId,
    });
  }
  if (kind === 'zip') {
    return bot.api.sendDocument(chatId, new InputFile(filePath), options);
  }
  return bot.api.sendVideo(chatId, new InputFile(filePath), { ...options, supports_streaming: true });
}

async function sendByKind(bot, chatId, fileId, kind, caption, preview, _extra, log) {
  const options = { caption, parse_mode: 'HTML' };
  try {
    if (kind === 'audio') {
      await bot.api.sendAudio(chatId, fileId, {
        ...options,
        title: (preview.title || 'TikTok audio').slice(0, 60),
      });
    } else if (kind === 'zip') {
      await bot.api.sendDocument(chatId, fileId, options);
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
  return message.video?.file_id ?? '';
}

async function notifyChat(bot, chatId, text) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch {
    /* best effort */
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
  const body = req.bodyJson ?? {};
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
