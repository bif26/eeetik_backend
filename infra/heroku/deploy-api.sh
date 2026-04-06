#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <heroku-api-app>"
  exit 1
fi

api_app="$1"

deploy_with_container() {
  heroku container:login
  docker build -f Dockerfile.api -t "registry.heroku.com/${api_app}/web" .
  docker push "registry.heroku.com/${api_app}/web"
  heroku container:release web -a "${api_app}"
  heroku ps:scale web=1 worker=0 -a "${api_app}"
}

deploy_with_git_fallback() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Git fallback requires running inside a git repository."
    exit 1
  fi

  heroku stack:set heroku-22 -a "${api_app}"
  heroku buildpacks:set heroku/nodejs -a "${api_app}"
  heroku config:set NPM_CONFIG_PRODUCTION=false -a "${api_app}"
  git push "https://git.heroku.com/${api_app}.git" HEAD:main
  heroku ps:scale web=1 worker=0 -a "${api_app}"
}

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  deploy_with_container
else
  echo "Docker is unavailable. Falling back to Heroku Git deployment for API app."
  deploy_with_git_fallback
fi
