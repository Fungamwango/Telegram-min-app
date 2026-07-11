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

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup: splash, 4 tabs (Home / Earn / Shop / Profile), bottom nav |
| `style.css` | Theme-aware styles using Telegram CSS variables |
| `app.js` | Game logic, Telegram SDK bindings, Monetag integration, persistence |
