#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <heroku-worker-app>"
  exit 1
fi

worker_app="$1"

heroku container:login
docker build -f Dockerfile.worker -t "registry.heroku.com/${worker_app}/worker" .
docker push "registry.heroku.com/${worker_app}/worker"
heroku container:release worker -a "${worker_app}"
