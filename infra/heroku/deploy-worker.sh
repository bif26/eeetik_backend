#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <heroku-worker-app>"
  exit 1
fi

worker_app="$1"

deploy_with_container() {
  heroku container:login
  docker build -f Dockerfile.worker -t "registry.heroku.com/${worker_app}/worker" .
  docker push "registry.heroku.com/${worker_app}/worker"
  heroku container:release worker -a "${worker_app}"
  heroku ps:scale worker=1 web=0 -a "${worker_app}"
}

deploy_with_git_fallback() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Git fallback requires running inside a git repository."
    exit 1
  fi

  heroku stack:set heroku-22 -a "${worker_app}"
  heroku buildpacks:set heroku/nodejs -a "${worker_app}"
  heroku config:set NPM_CONFIG_PRODUCTION=false -a "${worker_app}"
  git push "https://git.heroku.com/${worker_app}.git" HEAD:main
  heroku ps:scale worker=1 web=0 -a "${worker_app}"
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  deploy_with_container
else
  echo "Docker is unavailable. Falling back to Heroku Git deployment for worker app."
  deploy_with_git_fallback
fi
