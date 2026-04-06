#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <heroku-api-app>"
  exit 1
fi

api_app="$1"

heroku container:login
docker build -f Dockerfile.api -t "registry.heroku.com/${api_app}/web" .
docker push "registry.heroku.com/${api_app}/web"
heroku container:release web -a "${api_app}"
