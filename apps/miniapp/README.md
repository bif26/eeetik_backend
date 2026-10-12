# eeetik Mini App

SvelteKit 2 + Svelte 5 + Tailwind CSS 4 + daisyUI 5 Telegram Mini App for
eeetik.

## Develop

```bash
npm install
npm run dev
```

Point it at a local API by creating `.env`:

```
PUBLIC_API_BASE_URL=http://localhost:3000
```

## Pages

| Route | Purpose | daisyUI components |
|---|---|---|
| `/` | Paste TikTok URL | `card`, `input`, `btn btn-primary`, `badge`, `alert` |
| `/preview` | Metadata + quality selector | `card`, `stats`, `btn-group` (join), `radio`, `progress`, `badge` |
| `/queue` | Job status polling | `radial-progress`, `alert`, `skeleton` |
| `/library` | Past downloads | `table`, `badge`, pagination (`join`), `alert` |
| `/settings` | Preferences | `toggle`, `select`, `fieldset` |

## Telegram integration

- `@telegram-apps/sdk` (`init`, `backButton`) + official `telegram-web-app.js`
  fallback for `initData`
- Theme: `data-theme` follows `window.Telegram.WebApp.colorScheme` (light /
  dark), custom `telegram` daisyUI theme
- Auth: every API request sends `Authorization: tma <initData>`
- Storage: Telegram CloudStorage only — `localStorage` is never used

## Build (Render static site)

```bash
npm run build   # outputs to build/ (adapter-static SPA fallback)
```
