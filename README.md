# 🪙 Tap Empire — Telegram Mini App

A tap-to-earn Telegram Mini App built with **vanilla HTML, CSS and JavaScript** — no frameworks, no build step. Includes deep Telegram WebApp SDK integration and **Monetag** rewarded ads.

## Features

**Game**
- Tap-to-earn coin clicker with floating "+N" animations
- Energy system with offline regeneration
- Upgrade shop (Multitap, Energy Limit, Regen Speed) with exponential pricing
- Ranks (Bronze → Legend), daily reward, referral/invite link

**Telegram SDK**
- `HapticFeedback` — impact on every tap, success/error/warning notifications
- `MainButton` / `BackButton` / `SettingsButton` — contextual per tab
- `showPopup` / `showConfirm` — native notification dialogs
- `CloudStorage` — progress synced to Telegram Cloud (localStorage fallback)
- `showScanQrPopup`, `requestContact`, `addToHomeScreen`, `openLink`, `openTelegramLink`
- Theme-aware UI via `--tg-theme-*` CSS variables + `themeChanged` event
- `expand()` / fullscreen, closing confirmation, safe-area insets

**Monetag ads**
- Rewarded interstitial (+500 🪙), rewarded popup (+250 🪙), ad-gated energy refill
- Optional automatic in-app interstitials (frequency-capped)
- Demo mode when no zone is configured, so everything is testable without ads

## Setup

### 1. Host the app (HTTPS required)
Any static host works — GitHub Pages, Cloudflare Pages, Netlify, Vercel:

```bash
# quick local test (not usable by Telegram — needs public HTTPS)
npx serve .
```

For local testing inside Telegram, tunnel with `ngrok http 3000` or use the [test environment](https://core.telegram.org/bots/webapps#testing-mini-apps).

### 2. Create the Mini App with @BotFather
1. `/newbot` → create your bot (or use an existing one)
2. `/newapp` → select the bot, set title/description/photo, and paste your **HTTPS URL**, choose a short name (e.g. `app`)
3. Your app is live at `t.me/<bot_username>/<short_name>`

### 3. Configure Monetag
1. Sign up at [monetag.com](https://monetag.com), add your Telegram Mini App as a zone
2. Copy the **zone id** and set it in [app.js](app.js):

```js
const CONFIG = {
    MONETAG_ZONE_ID: '123456',   // ← your zone id
    BOT_USERNAME: 'YourBot',     // ← your bot username (no @)
    APP_SHORT_NAME: 'app',       // ← short name from /newapp
    ...
};
```

With an empty `MONETAG_ZONE_ID` the app runs in **demo mode** — ad buttons simulate a short ad and still grant rewards, so the full flow is testable.

## Phase B backend (real earnings, leaderboard, reminders, withdrawals)

The `worker/` directory contains a Cloudflare Worker + D1 backend. Without it the app runs fully client-side; with it users get **verified USD earnings** (credited only by Monetag server postbacks), a global leaderboard, daily reminder DMs, and withdrawal requests.

### Deploy

```bash
cd worker
npx wrangler d1 create tap_empire          # paste the printed database_id into wrangler.toml
npx wrangler d1 execute tap_empire --remote --file=schema.sql
npx wrangler secret put BOT_TOKEN          # from @BotFather
npx wrangler secret put POSTBACK_SECRET    # any random string
npx wrangler secret put WEBHOOK_SECRET     # any random string
npx wrangler secret put ADMIN_CHAT_ID      # your Telegram user id
npx wrangler deploy                        # prints https://tap-empire-api.<you>.workers.dev
```

### Connect everything

1. **App → Worker**: set `API_BASE` in `app.js` to the Worker URL and redeploy the site.
2. **Telegram → Worker** (bot webhook, enables /start + reminder DMs):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker-url>/webhook/<WEBHOOK_SECRET>
   ```
3. **Monetag → Worker**: in the Monetag dashboard, set the zone's **postback URL** to:
   ```
   https://<worker-url>/api/postback?s=<POSTBACK_SECRET>&ymid={ymid}&event={event_type}&zone_id={zone_id}&estimated_price={estimated_price}&request_var={request_var}&telegram_id={telegram_id}
   ```
   (Insert the macros via the dashboard's token picker; names may vary slightly.)

### Economics & payouts

- Users are credited `estimated_price × REV_SHARE` (default 50%) per **server-confirmed** impression — client-side tricks can't mint money.
- Withdrawals: min `MIN_WITHDRAW_USD` (default $1), full balance per request, marked `pending` in D1 and DM'd to `ADMIN_CHAT_ID`. Pay manually (TON/USDT), then mark paid:
  ```
  https://<worker-url>/api/admin/withdrawals?s=<POSTBACK_SECRET>       # list pending
  https://<worker-url>/api/admin/paid?s=<POSTBACK_SECRET>&id=<id>      # mark paid (also DMs the user)
  ```
- Daily reminder DMs go out at 17:00 UTC to opted-in users who /start-ed the bot and haven't opened the app in 8+ hours.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup: splash, 5 tabs, modals (wheel, leaderboard, withdraw), bottom nav |
| `style.css` | Theme-aware styles using Telegram CSS variables |
| `app.js` | Game logic, Telegram SDK bindings, Monetag integration, persistence, server API client |
| `worker/` | Cloudflare Worker backend: auth, postbacks, leaderboard, reminders, withdrawals |
