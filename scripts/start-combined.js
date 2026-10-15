#!/usr/bin/env node
/*
 * Single-dyno launcher (Heroku): runs the NestJS API and the BullMQ worker
 * side by side inside ONE dyno to save credits.
 *
 * - API:    node dist/apps/eeetik_backend/main.js
 * - Worker: node dist/apps/worker/main.js
 *
 * Behaviour:
 * - Crashed children are restarted after a short backoff (max 10 restarts
 *   per hour per app to avoid hot restart loops).
 * - SIGTERM / SIGINT are forwarded so `heroku ps:stop` and deploys shut both
 *   processes down cleanly.
 * - Set ENABLE_COMBINED_WORKER=false to run the API only (pair it with
 *   `heroku ps:scale worker=1` for a dedicated queue dyno).
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS_PER_HOUR = 10;

const children = new Map();
const restarts = [];
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[combined] ${new Date().toISOString()} ${message}\n`);
}

function restartBudgetExhausted() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (restarts.length > 0 && restarts[0] < oneHourAgo) {
    restarts.shift();
  }
  return restarts.length >= MAX_RESTARTS_PER_HOUR;
}

function maybeExit() {
  if (children.size === 0) {
    process.exit(0);
  }
}

function startChild(name, scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  children.set(name, child);
  log(`started ${name} (pid ${child.pid})`);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) {
      log(`${name} exited (code=${code} signal=${signal})`);
      maybeExit();
      return;
    }
    if (restartBudgetExhausted()) {
      log(`${name} crashed too often – giving up. code=${code} signal=${signal}`);
      maybeExit();
      return;
    }
    restarts.push(Date.now());
    log(
      `${name} exited unexpectedly (code=${code} signal=${signal}) – restarting in ${RESTART_DELAY_MS}ms`,
    );
    setTimeout(() => {
      if (!shuttingDown) {
        startChild(name, scriptPath);
      }
    }, RESTART_DELAY_MS);
  });
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`received ${signal} – stopping children`);
  for (const child of children.values()) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  // Hard exit if a child ignores SIGTERM.
  setTimeout(() => process.exit(0), 8000).unref();
}

function main() {
  const combineWorker = !['false', '0', 'off', 'no'].includes(
    String(process.env.ENABLE_COMBINED_WORKER ?? '')
      .trim()
      .toLowerCase(),
  );

  startChild(
    'api',
    path.join(__dirname, '..', 'dist', 'apps', 'eeetik_backend', 'main.js'),
  );
  if (combineWorker) {
    startChild(
      'worker',
      path.join(__dirname, '..', 'dist', 'apps', 'worker', 'main.js'),
    );
  } else {
    log(
      'ENABLE_COMBINED_WORKER=false – run the worker on its own dyno (heroku ps:scale worker=1)',
    );
  }

  ['SIGTERM', 'SIGINT'].forEach((signal) =>
    process.on(signal, () => shutdown(signal)),
  );
  process.on('exit', () => {
    for (const child of children.values()) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  });
}

main();
