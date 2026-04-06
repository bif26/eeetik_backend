#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <heroku-api-app> <heroku-worker-app>"
  exit 1
fi

api_app="$1"
worker_app="$2"

heroku domains:add api.eeetik.app -a "${api_app}"
heroku domains:add api1.eeetik.app -a "${worker_app}"

echo "Add a DNS record for each value shown by Heroku."
echo "Configure cdn.eeetik.app at Cloudflare for signed media delivery."
