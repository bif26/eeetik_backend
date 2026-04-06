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

load_env_file() {
  local env_file_path="$1"
  local line_number=0
  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    line_number=$((line_number + 1))
    local line="${raw_line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    if [ -z "$line" ] || [[ "$line" == \#* ]]; then
      continue
    fi

    if [[ "$line" != *=* ]]; then
      echo "Invalid env line ${line_number} in ${env_file_path}: ${raw_line}"
      echo "Expected KEY=value format."
      exit 1
    fi

    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"

    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "Invalid env key '${key}' on line ${line_number} in ${env_file_path}"
      exit 1
    fi

    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "${key}=${value}"
  done < "$env_file_path"
}

load_env_file "$shared_env_file"

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
  if [[ "$env_value" == *"<"* || "$env_value" == *">"* || "$env_value" == "replace-me" ]]; then
    echo "Invalid placeholder value for ${env_key} in ${shared_env_file}: ${env_value}"
    echo "Set a real value before running provisioning."
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
