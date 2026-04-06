#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <heroku-api-app> <heroku-worker-app>"
  exit 1
fi

api_app="$1"
worker_app="$2"
has_errors=0

check_expected_value() {
  local env_key="$1"
  local expected_value="$2"
  local app_name
  local actual_value

  for app_name in "${api_app}" "${worker_app}"; do
    actual_value="$(heroku config:get "${env_key}" -a "${app_name}" | tr -d '\r')"
    if [ "${actual_value}" != "${expected_value}" ]; then
      echo "Unexpected ${env_key} on ${app_name}. Expected '${expected_value}'."
      has_errors=1
    fi
  done
}

check_shared_value() {
  local env_key="$1"
  local required="$2"
  local api_value
  local worker_value

  api_value="$(heroku config:get "${env_key}" -a "${api_app}" | tr -d '\r')"
  worker_value="$(heroku config:get "${env_key}" -a "${worker_app}" | tr -d '\r')"

  if [ "${required}" = "required" ]; then
    if [ -z "${api_value}" ] || [ -z "${worker_value}" ]; then
      echo "Missing required ${env_key} on one or both apps."
      has_errors=1
      return
    fi
  else
    if [ -z "${api_value}" ] && [ -z "${worker_value}" ]; then
      return
    fi
  fi

  if [ "${api_value}" != "${worker_value}" ]; then
    echo "Mismatched ${env_key} between ${api_app} and ${worker_app}."
    has_errors=1
  fi
}

check_expected_value "SIGNED_URL_MODE" "cdn"
check_expected_value "CDN_SIGNED_BASE_URL" "https://cdn.eeetik.app"
check_expected_value "CDN_PUBLIC_HOST" "cdn.eeetik.app"
check_expected_value "CDN_SIGNED_PATH_PREFIX" "/media"
check_expected_value "API_PUBLIC_BASE_URL" "https://api.eeetik.app"
check_expected_value "WORKER_PUBLIC_BASE_URL" "https://api1.eeetik.app"

required_shared_keys=(
  MONGO_URI
  REDIS_HOST
  REDIS_PORT
  THROTTLE_REDIS_HOST
  THROTTLE_REDIS_PORT
  R2_ENDPOINT
  R2_REGION
  R2_BUCKET
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  STORAGE_MAX_MONTHLY_BYTES
  CDN_SIGNING_SECRET
)

optional_shared_keys=(
  REDIS_PASSWORD
  THROTTLE_REDIS_PASSWORD
)

for env_key in "${required_shared_keys[@]}"; do
  check_shared_value "${env_key}" "required"
done

for env_key in "${optional_shared_keys[@]}"; do
  check_shared_value "${env_key}" "optional"
done

if [ "${has_errors}" -ne 0 ]; then
  exit 1
fi

echo "Shared Heroku config is consistent for ${api_app} and ${worker_app}."
