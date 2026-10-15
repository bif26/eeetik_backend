const SIGNED_URL_MODE_CDN = 'cdn';

interface AssertSignedUrlRuntimeConfigInput {
  serviceName: 'api' | 'worker';
  env?: NodeJS.ProcessEnv;
}

export function assertSignedUrlRuntimeConfig({
  serviceName,
  env = process.env,
}: AssertSignedUrlRuntimeConfigInput): void {
  const signedUrlMode = (env.SIGNED_URL_MODE ?? SIGNED_URL_MODE_CDN)
    .toLowerCase()
    .trim();
  if (signedUrlMode !== SIGNED_URL_MODE_CDN) {
    throw new Error(
      `[${serviceName}] SIGNED_URL_MODE must be "${SIGNED_URL_MODE_CDN}". Direct R2 signed URLs are disabled.`,
    );
  }

  const cdnBaseUrl = readRequiredValue(
    env.CDN_SIGNED_BASE_URL,
    `[${serviceName}] CDN_SIGNED_BASE_URL is required when SIGNED_URL_MODE=cdn`,
  );
  const parsedCdnUrl = parseAbsoluteHttpUrl(
    cdnBaseUrl,
    `[${serviceName}] CDN_SIGNED_BASE_URL must be an absolute http/https URL`,
  );

  const requiredCdnHost = env.CDN_PUBLIC_HOST?.trim().toLowerCase();
  if (
    requiredCdnHost &&
    parsedCdnUrl.hostname.toLowerCase() !== requiredCdnHost
  ) {
    throw new Error(
      `[${serviceName}] CDN_SIGNED_BASE_URL host must match CDN_PUBLIC_HOST (${requiredCdnHost})`,
    );
  }

  readRequiredValue(
    env.CDN_SIGNING_SECRET,
    `[${serviceName}] CDN_SIGNING_SECRET is required when SIGNED_URL_MODE=cdn`,
  );

  const signedPathPrefix = env.CDN_SIGNED_PATH_PREFIX?.trim();
  if (signedPathPrefix && !signedPathPrefix.startsWith('/')) {
    throw new Error(
      `[${serviceName}] CDN_SIGNED_PATH_PREFIX must start with "/"`,
    );
  }
}

function readRequiredValue(
  value: string | undefined,
  errorMessage: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }

  return normalized;
}

function parseAbsoluteHttpUrl(value: string, errorMessage: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(errorMessage);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(errorMessage);
  }

  return parsed;
}
