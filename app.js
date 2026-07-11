/* ============================================================
   Tap Empire — Telegram Mini App
   Vanilla JS. Telegram WebApp SDK + Monetag rewarded ads.
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
   CONFIG — set your Monetag zone before deploying.
   Get a zone id at https://monetag.com (add your bot/mini app
   as a "Telegram Mini App" ad unit, copy the zone number).
   ------------------------------------------------------------ */
const CONFIG = {
    MONETAG_ZONE_ID: '11272175', // Monetag rewarded interstitial zone
    MONETAG_ENABLE_INAPP: true, // automatic in-app interstitials
    BOT_USERNAME: 'SageGames_bot', // used to build the invite link
    APP_SHORT_NAME: 'app',         // t.me/<bot>/<short_name> from BotFather
    REWARD_INTERSTITIAL: 500,
    REWARD_POPUP: 250,
    REWARD_DAILY: 200,
};

/* ============================================================
   Telegram SDK bootstrap
   ============================================================ */
const tg = window.Telegram?.WebApp;
const isTelegram = Boolean(tg && tg.initData);

/* ============================================================
   Game state
   ============================================================ */
const state = {
    balance: 0,
    totalTaps: 0,
    totalEarned: 0,
    adsWatched: 0,
    energy: 100,
    lastDaily: 0,          // timestamp of last daily claim
    upgrades: { multitap: 1, energy: 1, regen: 1 },
};

const perTap = () => state.upgrades.multitap;
const maxEnergy = () => 100 + (state.upgrades.energy - 1) * 50;
const regenPerSec = () => state.upgrades.regen;
const upgradeCost = (key) => ({ multitap: 500, energy: 750, regen: 1000 }[key]) *
    Math.pow(2, state.upgrades[key] - 1);

const RANKS = [
    [0, '🥉 Bronze'], [5000, '🥈 Silver'], [25000, '🥇 Gold'],
    [100000, '💎 Diamond'], [500000, '👑 Legend'],
];

/* ============================================================
   DOM helpers
   ============================================================ */
const $ = (id) => document.getElementById(id);
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
    : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K'
    : Math.floor(n).toLocaleString();

let toastTimer;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* Haptic wrappers — no-ops outside Telegram */
const haptic = {
    tap: () => tg?.HapticFeedback?.impactOccurred('light'),
    medium: () => tg?.HapticFeedback?.impactOccurred('medium'),
    success: () => tg?.HapticFeedback?.notificationOccurred('success'),
    error: () => tg?.HapticFeedback?.notificationOccurred('error'),
    warning: () => tg?.HapticFeedback?.notificationOccurred('warning'),
    select: () => tg?.HapticFeedback?.selectionChanged(),
};

/* Popup wrapper — falls back to alert/confirm in a plain browser */
function showPopup(opts, cb) {
    if (isTelegram && tg.showPopup) {
        try { tg.showPopup(opts, cb); return; } catch (_) { /* old client */ }
    }
    alert(`${opts.title ? opts.title + '\n\n' : ''}${opts.message}`);
    cb?.(null);
}

function showConfirm(message, cb) {
    if (isTelegram && tg.showConfirm) {
        try { tg.showConfirm(message, cb); return; } catch (_) { /* old client */ }
    }
    cb(confirm(message));
}

/* ============================================================
   Persistence — Telegram CloudStorage with localStorage fallback
   ============================================================ */
const SAVE_KEY = 'tap_empire_save_v1';

function serialize() {
    return JSON.stringify({
        balance: state.balance,
        totalTaps: state.totalTaps,
        totalEarned: state.totalEarned,
        adsWatched: state.adsWatched,
        energy: Math.floor(state.energy),
        lastDaily: state.lastDaily,
        upgrades: state.upgrades,
        savedAt: Date.now(),
    });
}

function applySave(json) {
    try {
        const d = JSON.parse(json);
        state.balance = d.balance || 0;
        state.totalTaps = d.totalTaps || 0;
        state.totalEarned = d.totalEarned || 0;
        state.adsWatched = d.adsWatched || 0;
        state.lastDaily = d.lastDaily || 0;
        state.upgrades = Object.assign({ multitap: 1, energy: 1, regen: 1 }, d.upgrades);
        // Regenerate energy for time spent away
        const away = Math.max(0, (Date.now() - (d.savedAt || Date.now())) / 1000);
        state.energy = Math.min(maxEnergy(), (d.energy || 0) + away * regenPerSec());
        return true;
    } catch (_) {
        return false;
    }
}

function saveProgress(showFeedback) {
    const data = serialize();
    localStorage.setItem(SAVE_KEY, data);
    if (isTelegram && tg.CloudStorage) {
        tg.CloudStorage.setItem(SAVE_KEY, data, (err, ok) => {
            if (showFeedback) {
                if (!err && ok) { haptic.success(); toast('☁️ Saved to Telegram Cloud'); }
                else { haptic.error(); toast('⚠️ Cloud save failed (saved locally)'); }
            }
        });
    } else if (showFeedback) {
        toast('💾 Saved locally');
    }
}

function loadProgress(done) {
    const local = localStorage.getItem(SAVE_KEY);
    if (isTelegram && tg.CloudStorage) {
        tg.CloudStorage.getItem(SAVE_KEY, (err, value) => {
            if (!err && value) applySave(value);
            else if (local) applySave(local);
            done();
        });
        return;
    }
    if (local) applySave(local);
    done();
}

function resetProgress() {
    showConfirm('Reset ALL progress? This cannot be undone.', (ok) => {
        if (!ok) return;
        localStorage.removeItem(SAVE_KEY);
        if (isTelegram && tg.CloudStorage) tg.CloudStorage.removeItem(SAVE_KEY, () => {});
        Object.assign(state, {
            balance: 0, totalTaps: 0, totalEarned: 0, adsWatched: 0,
            energy: 100, lastDaily: 0, upgrades: { multitap: 1, energy: 1, regen: 1 },
        });
        haptic.warning();
        renderAll();
        toast('🗑️ Progress reset');
    });
}

/* ============================================================
   Monetag ads
   The SDK is injected at runtime using the configured zone id.
   It exposes a global function named `show_<ZONE_ID>`:
     show_XXXX()                      → rewarded interstitial (Promise)
     show_XXXX('pop')                 → rewarded popup (Promise)
     show_XXXX({ type:'inApp', ... }) → automatic in-app interstitials
   ============================================================ */
let monetagFn = null;
let adBusy = false;          // blocks double-taps while an ad is in flight
let preloadPromise = null;   // settles when the next rewarded ad is cached
let preloadPending = false;
let preloadYmid = null;      // ymid must match between preload and show

/* Unique event id so Monetag can attribute the impression to this user */
function adYmid() {
    const uid = tg?.initDataUnsafe?.user?.id || 'guest';
    return `${uid}_${Date.now()}`;
}

/* Cache the next rewarded interstitial so it starts instantly on tap */
function preloadNextAd() {
    if (typeof monetagFn !== 'function' || preloadPending) return;
    preloadPending = true;
    preloadYmid = adYmid();
    preloadPromise = Promise.resolve(monetagFn({ type: 'preload', ymid: preloadYmid }))
        .then(() => true)
        .catch(() => { preloadPromise = null; return false; })
        .finally(() => { preloadPending = false; });
}

function initMonetag() {
    const zone = CONFIG.MONETAG_ZONE_ID;
    if (!zone) {
        $('adsNote').textContent =
            'Demo mode: no Monetag zone configured. Set MONETAG_ZONE_ID in app.js to serve real ads.';
        return;
    }

    const setupInApp = () => {
        if (!CONFIG.MONETAG_ENABLE_INAPP) return;
        // Auto interstitials: max 3 per 30 min, ≥60 s apart, first after 10 s
        monetagFn({
            type: 'inApp',
            inAppSettings: {
                frequency: 3, capping: 0.5, interval: 60, timeout: 10, everyPage: false,
            },
        });
    };

    // SDK already loaded via a <script> tag in index.html — reuse it
    if (typeof window['show_' + zone] === 'function') {
        monetagFn = window['show_' + zone];
        setupInApp();
        preloadNextAd();
        return;
    }

    // Otherwise inject it ourselves
    const s = document.createElement('script');
    s.src = 'https://libtl.com/sdk.js';
    s.dataset.zone = zone;
    s.dataset.sdk = 'show_' + zone;
    s.onload = () => {
        monetagFn = window['show_' + zone];
        if (typeof monetagFn === 'function') { setupInApp(); preloadNextAd(); }
    };
    s.onerror = () => { $('adsNote').textContent = 'Ad SDK failed to load.'; };
    document.head.appendChild(s);
}

/**
 * Show a rewarded ad. `variant` is undefined (interstitial) or 'pop'.
 * Resolves the promise only when Monetag reports the ad was watched,
 * then grants the reward.
 */
async function showRewardedAd(variant, onRewarded) {
    if (typeof monetagFn !== 'function') {
        if (CONFIG.MONETAG_ZONE_ID) {
            // Zone configured but the SDK function never appeared (blocked / failed to load)
            haptic.error();
            toast('⚠️ Ad SDK not loaded — check connection or ad blocker');
            return;
        }
        // Demo mode: simulate an ad so the flow is testable end-to-end
        toast('🎬 Demo ad playing…');
        setTimeout(onRewarded, 1500);
        return;
    }

    if (adBusy) return;
    adBusy = true;
    toast('🎬 Loading ad…');
    try {
        if (variant === 'pop') {
            await monetagFn('pop');
        } else {
            let ymid = adYmid();
            if (preloadPromise) {
                ymid = preloadYmid; // reuse the id the ad was preloaded with
                // Wait max 12 s for the cached ad instead of hanging forever.
                // (The timeout only guards the *fetch* — once the video is
                // playing, completion is awaited without any time limit.)
                const ready = await Promise.race([
                    preloadPromise,
                    new Promise((res) => setTimeout(() => res('timeout'), 12000)),
                ]);
                if (ready === 'timeout') {
                    haptic.warning();
                    toast('😕 No ad ready yet — try again in a minute');
                    return;
                }
            }
            await monetagFn({ ymid });
        }
        onRewarded();
    } catch (err) {
        haptic.error();
        const reason = err && (err.message || err.reason) ? ` (${err.message || err.reason})` : '';
        toast('😕 No ad available / not completed' + reason);
        console.error('Monetag ad failed:', err);
    } finally {
        adBusy = false;
        if (variant !== 'pop') preloadNextAd();
    }
}

function grantAdReward(amount, label) {
    state.adsWatched += 1;
    addCoins(amount);
    haptic.success();
    showPopup({
        title: '🎉 Reward earned!',
        message: `You received ${amount.toLocaleString()} coins${label ? ' for ' + label : ''}.`,
        buttons: [{ type: 'ok' }],
    });
    renderAll();
    saveProgress(false);
}

/* ============================================================
   Game logic
   ============================================================ */
function addCoins(n) {
    state.balance += n;
    state.totalEarned += n;
}

function onTap(e) {
    if (state.energy < perTap()) {
        haptic.warning();
        toast('⚡ Out of energy! Refill in the Earn tab.');
        return;
    }
    state.energy -= perTap();
    state.totalTaps += 1;
    addCoins(perTap());
    haptic.tap();

    // Floating "+N" at the touch point
    const area = $('floaters');
    const rect = area.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'floater';
    f.textContent = '+' + perTap();
    const x = (e.clientX ?? rect.left + rect.width / 2) - rect.left;
    const y = (e.clientY ?? rect.top + rect.height / 2) - rect.top;
    f.style.left = (x - 12) + 'px';
    f.style.top = (y - 24) + 'px';
    area.appendChild(f);
    setTimeout(() => f.remove(), 900);

    renderGame();
}

function buyUpgrade(key) {
    const cost = upgradeCost(key);
    if (state.balance < cost) {
        haptic.error();
        toast('Not enough coins!');
        return;
    }
    state.balance -= cost;
    state.upgrades[key] += 1;
    if (key === 'energy') state.energy = maxEnergy(); // bonus: full refill
    haptic.success();
    toast('✅ Upgrade purchased!');
    renderAll();
    saveProgress(false);
}

function claimDaily() {
    const DAY = 24 * 60 * 60 * 1000;
    const remaining = state.lastDaily + DAY - Date.now();
    if (remaining > 0) {
        const h = Math.ceil(remaining / 3600000);
        haptic.warning();
        toast(`⏳ Come back in ~${h}h for your next reward`);
        return;
    }
    state.lastDaily = Date.now();
    addCoins(CONFIG.REWARD_DAILY);
    haptic.success();
    showPopup({
        title: '📅 Daily Reward',
        message: `+${CONFIG.REWARD_DAILY} coins! Come back tomorrow for more.`,
        buttons: [{ type: 'ok' }],
    });
    renderAll();
    saveProgress(false);
}

function inviteFriends() {
    const user = tg?.initDataUnsafe?.user;
    const link = `https://t.me/${CONFIG.BOT_USERNAME}/${CONFIG.APP_SHORT_NAME}?startapp=ref_${user?.id || 'guest'}`;
    const text = '🪙 Join me in Tap Empire and start earning coins!';
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (isTelegram) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl, '_blank');
    haptic.medium();
}

/* ============================================================
   Rendering
   ============================================================ */
function rankFor(earned) {
    let r = RANKS[0][1];
    for (const [threshold, name] of RANKS) if (earned >= threshold) r = name;
    return r;
}

function renderGame() {
    $('balance').textContent = fmt(state.balance);
    $('perTapLabel').textContent = `+${perTap()} per tap`;
    $('energyText').textContent = `${Math.floor(state.energy)} / ${maxEnergy()}`;
    $('energyFill').style.width = (state.energy / maxEnergy() * 100) + '%';
    $('tapCoin').classList.toggle('exhausted', state.energy < perTap());
    $('userRank').textContent = rankFor(state.totalEarned);
}

function renderShop() {
    $('lvlMultitap').textContent = state.upgrades.multitap;
    $('lvlEnergy').textContent = state.upgrades.energy;
    $('lvlRegen').textContent = state.upgrades.regen;
    $('costMultitap').textContent = fmt(upgradeCost('multitap'));
    $('costEnergy').textContent = fmt(upgradeCost('energy'));
    $('costRegen').textContent = fmt(upgradeCost('regen'));
    document.querySelectorAll('.buy-btn').forEach((btn) => {
        btn.disabled = state.balance < upgradeCost(btn.dataset.upgrade);
    });
}

function renderProfile() {
    $('statTaps').textContent = fmt(state.totalTaps);
    $('statEarned').textContent = fmt(state.totalEarned);
    $('statAds').textContent = fmt(state.adsWatched);
    $('statPlatform').textContent = isTelegram ? tg.platform : 'browser';
}

function renderAll() {
    renderGame();
    renderShop();
    renderProfile();
}

function renderUser() {
    const user = tg?.initDataUnsafe?.user;
    const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'Guest';
    const initial = (name[0] || '?').toUpperCase();

    $('userName').textContent = name;
    $('profileName').textContent = name;
    $('profileId').textContent = user ? `id: ${user.id}${user.username ? ' · @' + user.username : ''}` : 'Not inside Telegram';

    for (const el of [$('userAvatar'), $('profileAvatar')]) {
        if (user?.photo_url) {
            el.textContent = '';
            el.style.backgroundImage = `url(${user.photo_url})`;
        } else {
            el.textContent = initial;
        }
    }
}

/* ============================================================
   Navigation (tabs + Telegram BackButton / MainButton)
   ============================================================ */
let currentTab = 'home';

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    $('tab-' + tab).classList.add('active');
    document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');
    haptic.select();

    if (!isTelegram) return;

    // BackButton returns to Home from any other tab
    if (tab === 'home') tg.BackButton.hide();
    else tg.BackButton.show();

    // Contextual MainButton
    if (tab === 'earn') {
        tg.MainButton.setParams({
            text: `🎬 WATCH AD  +${CONFIG.REWARD_INTERSTITIAL} 🪙`,
            is_visible: true,
        });
    } else {
        tg.MainButton.hide();
    }
}

/* ============================================================
   SDK playground buttons (Profile tab)
   ============================================================ */
function bindSdkButtons() {
    $('sdkPopup').onclick = () => showPopup({
        title: 'Hello 👋',
        message: 'This is a native Telegram popup with custom buttons.',
        buttons: [
            { id: 'nice', type: 'default', text: 'Nice!' },
            { type: 'cancel' },
        ],
    }, (id) => { if (id === 'nice') { haptic.success(); toast('You pressed Nice!'); } });

    $('sdkConfirm').onclick = () => showConfirm('Do you like Tap Empire?', (ok) => {
        ok ? (haptic.success(), toast('❤️ Thanks!')) : (haptic.warning(), toast('😢 We’ll do better'));
    });

    $('sdkHaptics').onclick = () => {
        // Little haptic melody
        const seq = ['light', 'medium', 'heavy', 'rigid', 'soft'];
        seq.forEach((style, i) => setTimeout(() => tg?.HapticFeedback?.impactOccurred(style), i * 150));
        setTimeout(() => haptic.success(), seq.length * 150);
        toast('📳 Haptic sequence played');
    };

    $('sdkQr').onclick = () => {
        if (!isTelegram || !tg.showScanQrPopup) return toast('QR scanner needs the Telegram app');
        try {
            tg.showScanQrPopup({ text: 'Scan any QR code' }, (data) => {
                tg.closeScanQrPopup();
                showPopup({ title: '📷 QR result', message: String(data).slice(0, 200), buttons: [{ type: 'ok' }] });
                return true;
            });
        } catch (_) { toast('QR scanner not supported on this client'); }
    };

    $('sdkLink').onclick = () => {
        if (isTelegram) tg.openLink('https://core.telegram.org/bots/webapps', { try_instant_view: true });
        else window.open('https://core.telegram.org/bots/webapps', '_blank');
    };

    $('sdkExpand').onclick = () => {
        if (!isTelegram) return toast('Only works inside Telegram');
        if (tg.isExpanded && tg.requestFullscreen) {
            try { tg.isFullscreen ? tg.exitFullscreen() : tg.requestFullscreen(); return; } catch (_) {}
        }
        tg.expand();
        toast('↕️ Viewport expanded');
    };

    $('sdkContact').onclick = () => {
        if (!isTelegram || !tg.requestContact) return toast('Only works inside Telegram');
        try {
            tg.requestContact((shared) => {
                shared ? (haptic.success(), toast('📱 Contact shared with the bot'))
                       : toast('Contact request declined');
            });
        } catch (_) { toast('Not supported on this client'); }
    };

    $('sdkHome').onclick = () => {
        if (!isTelegram || !tg.addToHomeScreen) return toast('Needs a recent Telegram app');
        try { tg.addToHomeScreen(); } catch (_) { toast('Not supported on this client'); }
    };

    $('sdkSave').onclick = () => saveProgress(true);
    $('sdkReset').onclick = resetProgress;

    $('btnTheme').onclick = () => showPopup({
        title: '🎨 Theme',
        message: `Color scheme: ${tg?.colorScheme || 'light'}\nThe app follows your Telegram theme automatically.`,
        buttons: [{ type: 'ok' }],
    });
}

/* ============================================================
   Init
   ============================================================ */
function bindGameEvents() {
    // pointerdown feels snappier than click for a tap game
    $('tapCoin').addEventListener('pointerdown', onTap);

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.querySelectorAll('[data-ad]').forEach((btn) => {
        btn.addEventListener('click', () => {
            haptic.medium();
            const kind = btn.dataset.ad;
            if (kind === 'interstitial') {
                showRewardedAd(undefined, () => grantAdReward(CONFIG.REWARD_INTERSTITIAL, 'watching a video'));
            } else if (kind === 'popup') {
                showRewardedAd('pop', () => grantAdReward(CONFIG.REWARD_POPUP, 'the ad boost'));
            } else if (kind === 'energy') {
                showRewardedAd(undefined, () => {
                    state.energy = maxEnergy();
                    state.adsWatched += 1;
                    haptic.success();
                    toast('⚡ Energy fully refilled!');
                    renderAll();
                    saveProgress(false);
                });
            }
        });
    });

    document.querySelectorAll('.buy-btn').forEach((btn) => {
        btn.addEventListener('click', () => buyUpgrade(btn.dataset.upgrade));
    });

    $('btnInvite').addEventListener('click', inviteFriends);
    $('btnDaily').addEventListener('click', claimDaily);
}

function bindTelegramEvents() {
    if (!isTelegram) return;

    tg.BackButton.onClick(() => switchTab('home'));
    tg.MainButton.onClick(() => {
        if (currentTab === 'earn') {
            haptic.medium();
            showRewardedAd(undefined, () => grantAdReward(CONFIG.REWARD_INTERSTITIAL, 'watching a video'));
        }
    });

    // SettingsButton (⋯ menu) → quick settings popup
    if (tg.SettingsButton) {
        try {
            tg.SettingsButton.show();
            tg.SettingsButton.onClick(() => showPopup({
                title: '⚙️ Settings',
                message: 'What would you like to do?',
                buttons: [
                    { id: 'save', type: 'default', text: '💾 Save progress' },
                    { id: 'reset', type: 'destructive', text: '🗑️ Reset progress' },
                    { type: 'cancel' },
                ],
            }, (id) => {
                if (id === 'save') saveProgress(true);
                if (id === 'reset') resetProgress();
            }));
        } catch (_) { /* older clients */ }
    }

    tg.onEvent('themeChanged', () => {
        // CSS vars update automatically; refresh the chrome colors
        tg.setHeaderColor(tg.themeParams.bg_color || '#18222d');
        tg.setBackgroundColor(tg.themeParams.bg_color || '#18222d');
    });

    tg.onEvent('viewportChanged', (e) => {
        if (e.isStateStable) document.documentElement.style.setProperty(
            '--tg-viewport-height', tg.viewportStableHeight + 'px');
    });

    // Save when the app is about to close / hide
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveProgress(false);
    });
}

function startLoops() {
    // Energy regen (4 ticks/sec for smoothness)
    setInterval(() => {
        if (state.energy < maxEnergy()) {
            state.energy = Math.min(maxEnergy(), state.energy + regenPerSec() / 4);
            renderGame();
        }
    }, 250);

    // Autosave every 30 s
    setInterval(() => saveProgress(false), 30000);
}

function init() {
    // On-device debug console: open the app URL with ?debug=1
    if (/[?&]debug/.test(location.search)) {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/eruda';
        s.onload = () => window.eruda && window.eruda.init();
        document.head.appendChild(s);
    }

    if (isTelegram) {
        tg.ready();
        tg.expand();
        try { tg.setHeaderColor(tg.themeParams.bg_color || '#18222d'); } catch (_) {}
        try { tg.setBackgroundColor(tg.themeParams.bg_color || '#18222d'); } catch (_) {}
        try { tg.enableClosingConfirmation(); } catch (_) {}
        try { tg.disableVerticalSwipes?.(); } catch (_) {}
    }

    renderUser();
    bindGameEvents();
    bindSdkButtons();
    bindTelegramEvents();
    initMonetag();

    loadProgress(() => {
        renderAll();
        startLoops();
        // Reveal the app
        setTimeout(() => {
            $('splash').classList.add('hidden');
            $('app').classList.remove('hidden');
            if (!isTelegram) {
                toast('⚠️ Running outside Telegram — SDK features are simulated');
            }
        }, 400);
    });
}

document.addEventListener('DOMContentLoaded', init);
