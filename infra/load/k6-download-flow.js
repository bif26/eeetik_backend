import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const loadMode = (__ENV.LOADTEST_MODE || 'local').toLowerCase();
const originHeader = __ENV.ORIGIN_HEADER || 'http://localhost';

const sampleTikTokUrl =
  __ENV.SAMPLE_TIKTOK_URL || 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
const localSampleTikTokUrl =
  __ENV.LOCAL_SAMPLE_TIKTOK_URL ||
  'https://www.tiktok.com/@loadtest/video/7350000000000000000';

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const localTargetRate = toPositiveInt(__ENV.LOCAL_TARGET_RATE, 8);
const localRampSeconds = toPositiveInt(__ENV.LOCAL_RAMP_SECONDS, 15);
const localSteadySeconds = toPositiveInt(__ENV.LOCAL_STEADY_SECONDS, 45);
const localHealthRate = toPositiveInt(__ENV.LOCAL_HEALTH_RATE, 8);
const localPreAllocatedVUs = toPositiveInt(__ENV.LOCAL_PRE_ALLOCATED_VUS, 20);
const localMaxVUs = toPositiveInt(__ENV.LOCAL_MAX_VUS, 100);
const localHealthDurationSeconds = toPositiveInt(
  __ENV.LOCAL_HEALTH_DURATION_SECONDS,
  localRampSeconds + localSteadySeconds + localRampSeconds,
);

const e2ePreAllocatedVUs = toPositiveInt(__ENV.E2E_PRE_ALLOCATED_VUS, 30);
const e2eMaxVUs = toPositiveInt(__ENV.E2E_MAX_VUS, 200);
const e2eWarmupRate = toPositiveInt(__ENV.E2E_WARMUP_RATE, 20);
const e2ePeakRate = toPositiveInt(__ENV.E2E_PEAK_RATE, 80);
const e2eRampDownRate = toPositiveInt(__ENV.E2E_RAMP_DOWN_RATE, 20);
const e2eWarmupDuration = toPositiveInt(__ENV.E2E_WARMUP_DURATION_SECONDS, 60);
const e2ePeakDuration = toPositiveInt(__ENV.E2E_PEAK_DURATION_SECONDS, 180);
const e2eRampDownDuration = toPositiveInt(__ENV.E2E_RAMP_DOWN_DURATION_SECONDS, 60);

const adDurationSeconds = toPositiveInt(__ENV.AD_DURATION_SECONDS, 10);
const metadataSleepSeconds = Number(__ENV.METADATA_SLEEP_SECONDS || '0.2');
const prepareRequestType = __ENV.PREPARE_REQUEST_TYPE || 'audio';

const localOptions = {
  scenarios: {
    health_checks: {
      executor: 'constant-arrival-rate',
      exec: 'healthChecks',
      rate: localHealthRate,
      timeUnit: '1s',
      duration: `${localHealthDurationSeconds}s`,
      preAllocatedVUs: localPreAllocatedVUs,
      maxVUs: localMaxVUs,
    },
    cached_metadata_prepare_flow: {
      executor: 'ramping-arrival-rate',
      exec: 'cachedMetadataPrepareFlow',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: localPreAllocatedVUs,
      maxVUs: localMaxVUs,
      stages: [
        { duration: `${localRampSeconds}s`, target: localTargetRate },
        { duration: `${localSteadySeconds}s`, target: localTargetRate },
        { duration: `${localRampSeconds}s`, target: 1 },
      ],
    },
  },
  thresholds: {
    'http_req_failed{scenario:health_checks}': ['rate<0.01'],
    'http_req_duration{scenario:health_checks}': ['p(95)<200'],
    'http_req_failed{scenario:cached_metadata_prepare_flow}': ['rate<0.02'],
    'http_req_duration{scenario:cached_metadata_prepare_flow}': ['p(95)<750'],
  },
};

const e2eOptions = {
  scenarios: {
    metadata_flow: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: e2ePreAllocatedVUs,
      maxVUs: e2eMaxVUs,
      stages: [
        { duration: `${e2eWarmupDuration}s`, target: e2eWarmupRate },
        { duration: `${e2ePeakDuration}s`, target: e2ePeakRate },
        { duration: `${e2eRampDownDuration}s`, target: e2eRampDownRate },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1000'],
  },
};

export const options = loadMode === 'e2e' ? e2eOptions : localOptions;

const jsonHeaders = {
  'Content-Type': 'application/json',
  Origin: originHeader,
};

const requestMetadata = (url) =>
  http.post(
    `${baseUrl}/api/v2/model/download/tiktok`,
    JSON.stringify({ url }),
    {
      headers: jsonHeaders,
    },
  );

const toJson = (response) => {
  if (!response.body) {
    return null;
  }

  try {
    return response.json();
  } catch {
    return null;
  }
};

export function setup() {
  if (loadMode === 'e2e') {
    return {};
  }

  const metadataResponse = requestMetadata(localSampleTikTokUrl);
  check(metadataResponse, {
    'setup metadata status is 201 or 200': (response) =>
      response.status === 201 || response.status === 200,
  });

  const metadata = toJson(metadataResponse);
  return {
    seededUniqueId: metadata?.uniqueId,
  };
}

export function healthChecks() {
  const liveResponse = http.get(`${baseUrl}/api/v2/health/live`);
  check(liveResponse, {
    'health live status is 200': (response) => response.status === 200,
  });

  const readyResponse = http.get(`${baseUrl}/api/v2/health/ready`);
  check(readyResponse, {
    'health ready status is 200': (response) => response.status === 200,
  });

  sleep(0.1);
}

export function cachedMetadataPrepareFlow(setupData) {
  const metadataResponse = requestMetadata(localSampleTikTokUrl);
  check(metadataResponse, {
    'metadata status is 201 or 200': (response) =>
      response.status === 201 || response.status === 200,
  });

  const metadata = toJson(metadataResponse);
  const uniqueId = metadata?.uniqueId ?? setupData?.seededUniqueId;

  check({ uniqueId }, {
    'metadata uniqueId exists': ({ uniqueId: value }) => Boolean(value),
  });

  if (uniqueId) {
    const prepareResponse = http.post(
      `${baseUrl}/api/v2/model/download/tiktok/prepare`,
      JSON.stringify({
        uniqueId,
        requestType: prepareRequestType,
        adToken: 'k6-test-token',
        adDurationSeconds,
      }),
      {
        headers: jsonHeaders,
      },
    );

    check(prepareResponse, {
      'prepare status is 201 or 200': (response) =>
        response.status === 201 || response.status === 200,
    });
  }

  sleep(metadataSleepSeconds);
}

export default function () {
  const metadataResponse = requestMetadata(sampleTikTokUrl);
  check(metadataResponse, {
    'metadata status is 201 or 200': (response) =>
      response.status === 201 || response.status === 200,
  });

  const metadata = toJson(metadataResponse);
  if (!metadata?.uniqueId) {
    sleep(1);
    return;
  }

  const prepareResponse = http.post(
    `${baseUrl}/api/v2/model/download/tiktok/prepare`,
    JSON.stringify({
      uniqueId: metadata.uniqueId,
      requestType: prepareRequestType,
      adToken: 'k6-test-token',
      adDurationSeconds,
    }),
    {
      headers: jsonHeaders,
    },
  );

  check(prepareResponse, {
    'prepare status is 201 or 200': (response) =>
      response.status === 201 || response.status === 200,
  });

  sleep(1);
}
