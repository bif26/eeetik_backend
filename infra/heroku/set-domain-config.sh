#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <heroku-api-app> <heroku-worker-app>"
  exit 1
fi

api_app="$1"
worker_app="$2"

heroku config:set \
  SIGNED_URL_MODE=cdn \
  CDN_SIGNED_BASE_URL=https://cdn.eeetik.app \
  CDN_PUBLIC_HOST=cdn.eeetik.app \
  CDN_SIGNED_PATH_PREFIX=/media \
  API_PUBLIC_BASE_URL=https://api.eeetik.app \
  WORKER_PUBLIC_BASE_URL=https://api1.eeetik.app \
  -a "${api_app}"

heroku config:set \
  SIGNED_URL_MODE=cdn \
  CDN_SIGNED_BASE_URL=https://cdn.eeetik.app \
  CDN_PUBLIC_HOST=cdn.eeetik.app \
  CDN_SIGNED_PATH_PREFIX=/media \
  API_PUBLIC_BASE_URL=https://api.eeetik.app \
  WORKER_PUBLIC_BASE_URL=https://api1.eeetik.app \
  -a "${worker_app}"

echo "Set CDN/domain config vars. Set CDN_SIGNING_SECRET separately on both apps."
