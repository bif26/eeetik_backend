#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [api-base-url]"
  echo "Environment overrides:"
  echo "  API_BASE_URL (default: https://api.eeetik.app)"
  echo "  ORIGIN_HEADER (default: https://eeetik.app)"
  echo "  SAMPLE_TIKTOK_URL (default: https://www.tiktok.com/@scout2015/video/6718335390845095173)"
  echo "  PREPARE_REQUEST_TYPE (default: audio)"
  echo "  AD_TOKEN (default: production-smoke-check)"
  echo "  AD_DURATION_SECONDS (default: 30)"
  echo "  STATUS_POLL_INTERVAL_SECONDS (default: 3)"
  echo "  MAX_STATUS_POLLS (default: 40)"
  echo "  EXPECTED_DOWNLOAD_HOST (default: cdn.eeetik.app)"
  exit 1
fi

api_base_url="${1:-${API_BASE_URL:-https://api.eeetik.app}}"
origin_header="${ORIGIN_HEADER:-https://eeetik.app}"
sample_tiktok_url="${SAMPLE_TIKTOK_URL:-https://www.tiktok.com/@scout2015/video/6718335390845095173}"
prepare_request_type="${PREPARE_REQUEST_TYPE:-audio}"
ad_token="${AD_TOKEN:-production-smoke-check}"
ad_duration_seconds="${AD_DURATION_SECONDS:-30}"
status_poll_interval_seconds="${STATUS_POLL_INTERVAL_SECONDS:-3}"
max_status_polls="${MAX_STATUS_POLLS:-40}"
expected_download_host="${EXPECTED_DOWNLOAD_HOST:-cdn.eeetik.app}"

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}"
    exit 1
  fi
}

assert_positive_int() {
  local label="$1"
  local raw_value="$2"
  if ! [[ "${raw_value}" =~ ^[0-9]+$ ]] || [ "${raw_value}" -le 0 ]; then
    echo "${label} must be a positive integer. Got: ${raw_value}"
    exit 1
  fi
}

request_json() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local response

  if [ -n "${payload}" ]; then
    response="$(
      curl --silent --show-error --location \
        --request "${method}" \
        --header 'Accept: application/json' \
        --header 'Content-Type: application/json' \
        --header "Origin: ${origin_header}" \
        --data "${payload}" \
        "${url}" \
        --write-out $'\n%{http_code}'
    )"
  else
    response="$(
      curl --silent --show-error --location \
        --request "${method}" \
        --header 'Accept: application/json' \
        --header "Origin: ${origin_header}" \
        "${url}" \
        --write-out $'\n%{http_code}'
    )"
  fi

  HTTP_BODY="${response%$'\n'*}"
  HTTP_STATUS="${response##*$'\n'}"
}

fail_with_response() {
  local label="$1"
  echo "${label} failed with status ${HTTP_STATUS}"
  echo "Response body: ${HTTP_BODY}"
  exit 1
}

require_command curl
require_command node
assert_positive_int "AD_DURATION_SECONDS" "${ad_duration_seconds}"
assert_positive_int "STATUS_POLL_INTERVAL_SECONDS" "${status_poll_interval_seconds}"
assert_positive_int "MAX_STATUS_POLLS" "${max_status_polls}"

echo "Running production smoke flow against ${api_base_url}"
echo "Using Origin header: ${origin_header}"

echo "1/5 Checking API health endpoints..."
request_json GET "${api_base_url}/api/v2/health/live"
if [ "${HTTP_STATUS}" != "200" ]; then
  fail_with_response "Liveness endpoint"
fi
printf '%s' "${HTTP_BODY}" | node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (body?.status !== "ok") {
  console.error(`Unexpected /health/live payload: ${JSON.stringify(body)}`);
  process.exit(1);
}
'

request_json GET "${api_base_url}/api/v2/health/ready"
if [ "${HTTP_STATUS}" != "200" ]; then
  fail_with_response "Readiness endpoint"
fi
printf '%s' "${HTTP_BODY}" | node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (body?.status !== "ready") {
  console.error(`Unexpected /health/ready payload: ${JSON.stringify(body)}`);
  process.exit(1);
}
'

echo "2/5 Requesting metadata..."
metadata_payload="$(
  node -e '
const url = process.argv[1];
process.stdout.write(JSON.stringify({ url }));
' "${sample_tiktok_url}"
)"
request_json POST "${api_base_url}/api/v2/model/download/tiktok" "${metadata_payload}"
if [ "${HTTP_STATUS}" != "200" ] && [ "${HTTP_STATUS}" != "201" ]; then
  fail_with_response "Metadata request"
fi

mapfile -t metadata_parts < <(
  printf '%s' "${HTTP_BODY}" | node -e '
const fs = require("fs");
const expectedHost = process.argv[1];
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (body?.success !== true || typeof body?.data !== "object" || body.data === null) {
  console.error(`Unexpected metadata payload: ${JSON.stringify(body)}`);
  process.exit(1);
}
const uniqueId = body.data.uniqueId;
if (typeof uniqueId !== "string" || uniqueId.trim().length === 0) {
  console.error(`Metadata uniqueId is missing: ${JSON.stringify(body)}`);
  process.exit(1);
}
const urls = [];
if (typeof body.data.thumbnail === "string") {
  urls.push(body.data.thumbnail);
}
if (typeof body.data.author?.avatar === "string") {
  urls.push(body.data.author.avatar);
}
if (Array.isArray(body.data.images)) {
  for (const value of body.data.images) {
    if (typeof value === "string") {
      urls.push(value);
    }
  }
}
for (const value of urls) {
  let host;
  try {
    host = new URL(value).host.toLowerCase();
  } catch (error) {
    console.error(`Invalid metadata URL: ${value}`);
    process.exit(1);
  }
  if (host !== expectedHost) {
    console.error(`Metadata URL host mismatch: expected ${expectedHost}, got ${host}`);
    process.exit(1);
  }
}
console.log(uniqueId.trim());
console.log(urls.length.toString());
' "${expected_download_host}"
)
unique_id="${metadata_parts[0]}"
metadata_url_count="${metadata_parts[1]:-0}"

echo "3/5 Submitting prepare request..."
prepare_payload="$(
  node -e '
const [uniqueId, requestType, adToken, adDuration] = process.argv.slice(1);
process.stdout.write(
  JSON.stringify({
    uniqueId,
    requestType,
    adToken,
    adDurationSeconds: Number(adDuration),
  }),
);
' "${unique_id}" "${prepare_request_type}" "${ad_token}" "${ad_duration_seconds}"
)"
request_json POST "${api_base_url}/api/v2/model/download/tiktok/prepare" "${prepare_payload}"
if [ "${HTTP_STATUS}" != "200" ] && [ "${HTTP_STATUS}" != "201" ]; then
  fail_with_response "Prepare request"
fi

mapfile -t prepare_parts < <(
  printf '%s' "${HTTP_BODY}" | node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (typeof body?.jobId !== "string" || body.jobId.trim().length === 0) {
  console.error(`Prepare jobId is missing: ${JSON.stringify(body)}`);
  process.exit(1);
}
if (body?.status !== "processing") {
  console.error(`Prepare status must be processing: ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log(body.jobId.trim());
'
)
job_id="${prepare_parts[0]}"

echo "4/5 Polling status for job ${job_id}..."
final_status=""
download_url=""
for attempt in $(seq 1 "${max_status_polls}"); do
  request_json GET "${api_base_url}/api/v2/model/download/tiktok/status/${job_id}"
  if [ "${HTTP_STATUS}" != "200" ]; then
    fail_with_response "Status poll"
  fi

  mapfile -t status_parts < <(
    printf '%s' "${HTTP_BODY}" | node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (typeof body?.status !== "string") {
  console.error(`Status payload is missing status: ${JSON.stringify(body)}`);
  process.exit(1);
}
const downloadUrl =
  typeof body.downloadUrl === "string" ? body.downloadUrl.trim() : "";
const errorMessage =
  typeof body.errorMessage === "string" ? body.errorMessage.trim() : "";
console.log(body.status.trim());
console.log(downloadUrl);
console.log(errorMessage);
'
  )

  final_status="${status_parts[0]}"
  download_url="${status_parts[1]:-}"
  error_message="${status_parts[2]:-}"

  echo "   poll ${attempt}/${max_status_polls}: ${final_status}"

  if [ "${final_status}" = "completed" ]; then
    break
  fi

  if [ "${final_status}" = "failed" ] || [ "${final_status}" = "expired" ]; then
    echo "Download job did not complete successfully (${final_status})."
    if [ -n "${error_message}" ]; then
      echo "Error message: ${error_message}"
    fi
    exit 1
  fi

  sleep "${status_poll_interval_seconds}"
done

if [ "${final_status}" != "completed" ]; then
  echo "Download job did not complete within ${max_status_polls} polls."
  exit 1
fi

if [ -z "${download_url}" ]; then
  echo "Completed status did not include downloadUrl."
  exit 1
fi

echo "5/5 Verifying returned download URL..."
node -e '
const [downloadUrl, expectedHost] = process.argv.slice(1);
let parsed;
try {
  parsed = new URL(downloadUrl);
} catch (error) {
  console.error(`Invalid downloadUrl: ${downloadUrl}`);
  process.exit(1);
}
const host = parsed.host.toLowerCase();
if (host !== expectedHost) {
  console.error(`downloadUrl host mismatch: expected ${expectedHost}, got ${host}`);
  process.exit(1);
}
const lower = downloadUrl.toLowerCase();
const disallowedTokens = [
  "cloudflarestorage.com",
  "r2.dev",
  "amazonaws.com",
  "storage.googleapis.com",
  "x-amz-algorithm=",
];
for (const token of disallowedTokens) {
  if (lower.includes(token)) {
    console.error(`downloadUrl appears to use direct object storage (${token}).`);
    process.exit(1);
  }
}
' "${download_url}" "${expected_download_host}"

echo "Smoke check passed."
echo "uniqueId=${unique_id}"
echo "jobId=${job_id}"
echo "metadataSignedUrlCount=${metadata_url_count}"
echo "downloadUrl=${download_url}"
