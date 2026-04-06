#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <heroku-api-app> <heroku-worker-app> <shared-env-file> [redis-plan]"
  exit 1
fi

api_app="$1"
worker_app="$2"
shared_env_file="$3"
redis_plan="${4:-heroku-redis:mini}"

if [ ! -f "$shared_env_file" ]; then
  echo "Shared env file not found: $shared_env_file"
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set -a
# shellcheck disable=SC1090
source "$shared_env_file"
set +a

required_vars=(
  MONGO_URI
  R2_ENDPOINT
  R2_REGION
  R2_BUCKET
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  STORAGE_MAX_MONTHLY_BYTES
  CDN_SIGNING_SECRET
)

for env_key in "${required_vars[@]}"; do
  env_value="${!env_key:-}"
  if [ -z "$env_value" ]; then
    echo "Missing required ${env_key} in ${shared_env_file}"
    exit 1
  fi
done

"${script_dir}/set-domain-config.sh" "${api_app}" "${worker_app}"

redis_url="$(heroku config:get REDIS_URL -a "${api_app}" | tr -d '\r')"
if [ -z "$redis_url" ]; then
  echo "Provisioning ${redis_plan} on ${api_app}..."
  heroku addons:create "${redis_plan}" -a "${api_app}"
fi

redis_url=""
for attempt in $(seq 1 24); do
  redis_url="$(heroku config:get REDIS_URL -a "${api_app}" | tr -d '\r')"
  if [ -n "$redis_url" ]; then
    break
  fi

  echo "Waiting for REDIS_URL on ${api_app} (attempt ${attempt}/24)..."
  sleep 5
done

if [ -z "$redis_url" ]; then
  echo "REDIS_URL is still empty on ${api_app}. Check addon provisioning status."
  exit 1
fi

mapfile -t redis_parts < <(
  node -e '
const rawUrl = process.argv[1];
let parsed;
try {
  parsed = new URL(rawUrl);
} catch (error) {
  console.error(`Invalid REDIS_URL: ${String(error)}`);
  process.exit(1);
}
const host = parsed.hostname?.trim();
const port = (parsed.port || "6379").trim();
const password = decodeURIComponent(parsed.password || "");
if (!host) {
  console.error("REDIS_URL host is missing");
  process.exit(1);
}
process.stdout.write(`${host}\n${port}\n${password}`);
' "$redis_url"
)

if [ "${#redis_parts[@]}" -lt 2 ]; then
  echo "Failed to parse REDIS_URL from ${api_app}"
  exit 1
fi

redis_host="${redis_parts[0]}"
redis_port="${redis_parts[1]}"
redis_password="${redis_parts[2]:-}"

shared_config_args=(
  "MONGO_URI=${MONGO_URI}"
  "REDIS_HOST=${redis_host}"
  "REDIS_PORT=${redis_port}"
  "REDIS_PASSWORD=${redis_password}"
  "THROTTLE_REDIS_HOST=${redis_host}"
  "THROTTLE_REDIS_PORT=${redis_port}"
  "THROTTLE_REDIS_PASSWORD=${redis_password}"
  "R2_ENDPOINT=${R2_ENDPOINT}"
  "R2_REGION=${R2_REGION}"
  "R2_BUCKET=${R2_BUCKET}"
  "R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}"
  "R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}"
  "STORAGE_MAX_MONTHLY_BYTES=${STORAGE_MAX_MONTHLY_BYTES}"
  "CDN_SIGNING_SECRET=${CDN_SIGNING_SECRET}"
)

for app in "${api_app}" "${worker_app}"; do
  heroku config:set "${shared_config_args[@]}" -a "${app}"
done

echo "Provisioned shared Redis + applied shared service secrets for ${api_app} and ${worker_app}."
echo "Run ${script_dir}/check-shared-config.sh ${api_app} ${worker_app} to verify parity."
