import { createHmac } from 'node:crypto';

const DEFAULT_SIGNED_CDN_PATH_PREFIX = '/media';

export interface BuildSignedCdnUrlInput {
  baseUrl: string;
  signingSecret: string;
  objectKey: string;
  expiresInSeconds: number;
  pathPrefix?: string;
  now?: Date;
}

export function buildSignedCdnUrl({
  baseUrl,
  signingSecret,
  objectKey,
  expiresInSeconds,
  pathPrefix,
  now,
}: BuildSignedCdnUrlInput): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedSecret = signingSecret.trim();
  if (!normalizedSecret) {
    throw new Error('CDN signing secret is required');
  }

  const normalizedObjectKey = normalizeObjectKey(objectKey);
  const normalizedPrefix = normalizePathPrefix(pathPrefix);
  const expiresAtSeconds =
    Math.floor((now?.getTime() ?? Date.now()) / 1000) +
    normalizeExpiresInSeconds(expiresInSeconds);

  const encodedObjectKey = encodeObjectKey(normalizedObjectKey);
  const signedPath = `${normalizedPrefix}/${encodedObjectKey}`;
  const signature = createHmac('sha256', normalizedSecret)
    .update(`${signedPath}:${expiresAtSeconds}`)
    .digest('hex');

  const url = new URL(normalizedBaseUrl);
  url.pathname = joinUrlPath(url.pathname, signedPath);
  url.searchParams.set('exp', String(expiresAtSeconds));
  url.searchParams.set('sig', signature);
  return url.toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error('CDN base URL is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error('CDN base URL must be a valid absolute URL');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('CDN base URL must use http or https');
  }

  return parsedUrl.toString();
}

function normalizeObjectKey(objectKey: string): string {
  const trimmed = objectKey.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Object key is required');
  }

  return trimmed;
}

function normalizePathPrefix(pathPrefix?: string): string {
  const trimmed = pathPrefix?.trim();
  if (!trimmed) {
    return DEFAULT_SIGNED_CDN_PATH_PREFIX;
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');

  return withoutTrailingSlash || DEFAULT_SIGNED_CDN_PATH_PREFIX;
}

function normalizeExpiresInSeconds(expiresInSeconds: number): number {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error('CDN signed URL TTL must be a positive number');
  }

  return Math.floor(expiresInSeconds);
}

function encodeObjectKey(objectKey: string): string {
  return objectKey
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function joinUrlPath(basePath: string, appendPath: string): string {
  const segments = [
    ...basePath.split('/').filter((segment) => segment.length > 0),
    ...appendPath.split('/').filter((segment) => segment.length > 0),
  ];

  return `/${segments.join('/')}`;
}
