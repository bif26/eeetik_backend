# Heroku process types.
# The web dyno runs the API + Telegram bot, plus the BullMQ worker by default
# (single-dyno mode – cheapest). Set ENABLE_COMBINED_WORKER=false and scale
# worker=1 to give the queue its own dyno instead.
web: node scripts/start-combined.js
worker: node dist/apps/worker/main
