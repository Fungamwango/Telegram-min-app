/* ============================================================
   Tap Empire — Telegram Mini App
   Vanilla JS. Telegram WebApp SDK + Monetag rewarded ads.
   Features: tap game, energy, upgrades, auto bot (passive +
   offline earnings), daily streak, quests, lucky wheel,
   golden-coin frenzy, rank-up celebrations, referrals.
   ============================================================ */

'use strict';

/* ------------------------------------------------------------
   CONFIG
   ------------------------------------------------------------ */
const CONFIG = {
    // Phase B backend (Cloudflare Worker URL, no trailing slash),
    // e.g. 'https://tap-empire-api.yourname.workers.dev'.
    // Leave empty to run fully client-side.
    API_BASE: 'https://tap-empire-api.sageemail1000.workers.dev',
    MONETAG_ZONE_ID: '11272175', // Monetag rewarded interstitial zone
    MONETAG_ENABLE_INAPP: true,  // automatic in-app interstitials
    BOT_USERNAME: 'SageGames_bot', // used to build the invite link
    APP_SHORT_NAME: 'app',         // t.me/<bot>/<short_name> from BotFather
    REWARD_INTERSTITIAL: 500,
    REWARD_POPUP: 250,
    // Home-screen "≈ $" motivator: estimated micro-earnings shown in real
    // time. Purely visual — the withdrawable number is the server-verified
    // balance on the Earn tab.
    SIM_USD_PER_TAP: 0.0000001,
    SIM_USD_PER_AD: 0.00004,
    REWARD_REFERRAL_WELCOME: 500,  // bonus for joining via a friend's link
    AUTO_RATE_PER_LEVEL: 250,      // coins per hour per Auto Bot level
    OFFLINE_CAP_HOURS: 3,          // max hours of offline earnings
    FRENZY_SECONDS: 15,
    FRENZY_MULTIPLIER: 5,
};

/* Escalating rewards for consecutive days (cycles after day 7) */
const STREAK_REWARDS = [200, 400, 800, 1500, 2500, 3500, 5000];

/* Daily quest pool — 3 are picked per day, rotating deterministically */
const QUEST_POOL = [
    { id: 'ads3',    icon: '🎬', label: 'Watch 3 ads',           key: 'ads',      target: 3,   reward: 600 },
    { id: 'taps500', icon: '👆', label: 'Tap 500 times',         key: 'taps',     target: 500, reward: 500 },
    { id: 'share1',  icon: '👥', label: 'Share with a friend',   key: 'shares',   target: 1,   reward: 800 },
    { id: 'upg1',    icon: '🛒', label: 'Buy an upgrade',        key: 'upgrades', target: 1,   reward: 700 },
    { id: 'spin1',   icon: '🎡', label: 'Spin the lucky wheel',  key: 'spins',    target: 1,   reward: 300 },
];

/* Lucky wheel: 8 segments, weighted odds */
const WHEEL_SEGMENTS = [
    { label: '100',  coins: 100,  weight: 20, color: '#f5b93c' },
    { label: '250',  coins: 250,  weight: 16, color: '#e67e22' },
    { label: '⚡',    energy: true, weight: 14, color: '#35c46f' },
    { label: '500',  coins: 500,  weight: 12, color: '#f5b93c' },
    { label: '150',  coins: 150,  weight: 16, color: '#e67e22' },
    { label: '1000', coins: 1000, weight: 8,  color: '#9b59b6' },
    { label: '300',  coins: 300,  weight: 12, color: '#f5b93c' },
    { label: '2500', coins: 2500, weight: 2,  color: '#e74c3c' },
];

const RANKS = [
    [0, '🥉', 'Bronze'], [5000, '🥈', 'Silver'], [25000, '🥇', 'Gold'],
    [100000, '💎', 'Diamond'], [500000, '👑', 'Legend'],
];

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
    upgrades: { multitap: 1, energy: 1, regen: 1, auto: 0 },
    // streak
    streak: 0,
    bestStreak: 0,
    streakLastClaim: '',   // 'YYYY-MM-DD' of last claim
    // daily counters (reset each day)
    daily: null,           // { date, taps, ads, shares, upgrades, spins, freeSpinUsed, claimed: {} }
    // misc
    lastRankIdx: 0,
    refBonusGiven: false,
    friendsShared: 0,
    simUsd: 0,   // estimated lifetime USD (display only; floored to server value)
};

/* Estimated-earnings ticker (Home screen motivator) */
function simEarn(amount) {
    state.simUsd += amount;
    const el = $('usdChip');
    if (el) el.textContent = `💵 ≈ $${state.simUsd.toFixed(7)}`;
}

/* Every path that counts a watched ad funnels through here */
function countAdWatched() {
    state.adsWatched += 1;
    ensureDaily().ads += 1;
    simEarn(CONFIG.SIM_USD_PER_AD * (0.5 + Math.random())); // ±50% realism
}

/* Frenzy (not persisted) */
let frenzyUntil = 0;
const frenzyActive = () => Date.now() < frenzyUntil;

const perTap = () => state.upgrades.multitap * (frenzyActive() ? CONFIG.FRENZY_MULTIPLIER : 1);
const tapCost = () => state.upgrades.multitap; // energy cost is never multiplied by frenzy
const maxEnergy = () => 100 + (state.upgrades.energy - 1) * 50;
const regenPerSec = () => state.upgrades.regen;
const autoPerHour = () => state.upgrades.auto * CONFIG.AUTO_RATE_PER_LEVEL;

const UPGRADE_BASE = { multitap: 500, energy: 750, regen: 1000, auto: 2000 };
function upgradeCost(key) {
    // auto starts at level 0, the others at level 1
    const lvl = key === 'auto' ? state.upgrades.auto : state.upgrades[key] - 1;
    return UPGRADE_BASE[key] * Math.pow(2, lvl);
}

/* ============================================================
   Date helpers (UTC days so timezone changes can't double-claim)
   ============================================================ */
const dayStr = (d) => d.toISOString().slice(0, 10);
const todayStr = () => dayStr(new Date());
const yesterdayStr = () => dayStr(new Date(Date.now() - 86400000));

function freshDaily() {
    return { date: todayStr(), taps: 0, ads: 0, shares: 0, upgrades: 0, spins: 0,
             freeSpinUsed: false, claimed: {} };
}

/* Reset daily counters when the date rolls over */
function ensureDaily() {
    if (!state.daily || state.daily.date !== todayStr()) {
        state.daily = freshDaily();
    }
    return state.daily;
}

/* Deterministic 3-quest selection for today (simple seeded shuffle) */
function todaysQuests() {
    let seed = 0;
    for (const c of todayStr()) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
    const idx = QUEST_POOL.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const j = seed % (i + 1);
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, 3).map((i) => QUEST_POOL[i]);
}

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
    heavy: () => tg?.HapticFeedback?.impactOccurred('heavy'),
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
const SAVE_KEY = 'tap_empire_save_v2';

function serialize() {
    return JSON.stringify({
        balance: state.balance,
        totalTaps: state.totalTaps,
        totalEarned: state.totalEarned,
        adsWatched: state.adsWatched,
        energy: Math.floor(state.energy),
        upgrades: state.upgrades,
        streak: state.streak,
        bestStreak: state.bestStreak,
        streakLastClaim: state.streakLastClaim,
        daily: state.daily,
        lastRankIdx: state.lastRankIdx,
        refBonusGiven: state.refBonusGiven,
        friendsShared: state.friendsShared,
        simUsd: state.simUsd,
        savedAt: Date.now(),
    });
}

let offlineEarnings = 0; // computed on load, offered via popup

function applySave(json) {
    try {
        const d = JSON.parse(json);
        state.balance = d.balance || 0;
        state.totalTaps = d.totalTaps || 0;
        state.totalEarned = d.totalEarned || 0;
        state.adsWatched = d.adsWatched || 0;
        state.upgrades = Object.assign({ multitap: 1, energy: 1, regen: 1, auto: 0 }, d.upgrades);
        state.streak = d.streak || 0;
        state.bestStreak = d.bestStreak || 0;
        state.streakLastClaim = d.streakLastClaim || '';
        state.daily = d.daily || null;
        // v1 saves have no lastRankIdx — derive it so migration doesn't
        // fire a rank-up celebration for ranks earned long ago
        state.lastRankIdx = d.lastRankIdx !== undefined
            ? d.lastRankIdx : rankIdxFor(d.totalEarned || 0);
        state.refBonusGiven = Boolean(d.refBonusGiven);
        state.friendsShared = d.friendsShared || 0;
        state.simUsd = d.simUsd || 0;

        const awaySec = Math.max(0, (Date.now() - (d.savedAt || Date.now())) / 1000);
        // Energy regenerates while away
        state.energy = Math.min(maxEnergy(), (d.energy || 0) + awaySec * regenPerSec());
        // Auto Bot earns while away (capped)
        const cappedSec = Math.min(awaySec, CONFIG.OFFLINE_CAP_HOURS * 3600);
        offlineEarnings = Math.floor(cappedSec * autoPerHour() / 3600);
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

const SAVE_KEY_V1 = 'tap_empire_save_v1';

function loadProgress(done) {
    const local = localStorage.getItem(SAVE_KEY) || localStorage.getItem(SAVE_KEY_V1);
    if (isTelegram && tg.CloudStorage) {
        tg.CloudStorage.getItems([SAVE_KEY, SAVE_KEY_V1], (err, values) => {
            const value = !err && values && (values[SAVE_KEY] || values[SAVE_KEY_V1]);
            if (value) applySave(value);
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
            energy: 100, upgrades: { multitap: 1, energy: 1, regen: 1, auto: 0 },
            streak: 0, bestStreak: 0, streakLastClaim: '', daily: freshDaily(),
            lastRankIdx: 0, refBonusGiven: false, friendsShared: 0, simUsd: 0,
        });
        haptic.warning();
        renderAll();
        toast('🗑️ Progress reset');
    });
}

/* ============================================================
   Monetag ads
   The SDK exposes a global function named `show_<ZONE_ID>`:
     show_XXXX({ ymid })              → rewarded interstitial (Promise)
     show_XXXX('pop')                 → rewarded popup (Promise)
     show_XXXX({ type:'preload' })    → cache the next ad
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

async function showRewardedAd(variant, onRewarded) {
    if (typeof monetagFn !== 'function') {
        if (CONFIG.MONETAG_ZONE_ID) {
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
    countAdWatched();
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
   Core game logic
   ============================================================ */
function addCoins(n) {
    state.balance += n;
    state.totalEarned += n;
    checkRankUp();
}

function onTap(e) {
    if (state.energy < tapCost()) {
        haptic.warning();
        toast('⚡ Out of energy! Refill in the Earn tab.');
        return;
    }
    state.energy -= tapCost();
    state.totalTaps += 1;
    ensureDaily().taps += 1;
    const gain = perTap();
    addCoins(gain);
    simEarn(CONFIG.SIM_USD_PER_TAP);
    frenzyActive() ? haptic.medium() : haptic.tap();

    // Floating "+N" at the touch point
    const area = $('floaters');
    const rect = area.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'floater' + (frenzyActive() ? ' frenzy-floater' : '');
    f.textContent = '+' + gain;
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
    ensureDaily().upgrades += 1;
    haptic.success();
    toast('✅ Upgrade purchased!');
    renderAll();
    saveProgress(false);
}

/* ============================================================
   Daily streak
   ============================================================ */
function streakClaimableToday() {
    return state.streakLastClaim !== todayStr();
}

function claimStreak() {
    if (!streakClaimableToday()) {
        haptic.warning();
        toast('✅ Already claimed today — come back tomorrow!');
        return;
    }
    // Continue the streak only if yesterday was claimed
    state.streak = (state.streakLastClaim === yesterdayStr()) ? state.streak + 1 : 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
    state.streakLastClaim = todayStr();

    const reward = STREAK_REWARDS[(state.streak - 1) % STREAK_REWARDS.length];
    addCoins(reward);
    haptic.success();
    showPopup({
        title: `🔥 Day ${state.streak} streak!`,
        message: `+${reward.toLocaleString()} coins. Come back tomorrow — day ${state.streak + 1} pays even more!`,
        buttons: [{ type: 'ok' }],
    });
    renderAll();
    saveProgress(false);
}

function renderStreak() {
    const claimable = streakClaimableToday();
    $('btnStreak').disabled = !claimable;
    $('btnStreak').textContent = claimable ? 'Claim' : 'Done ✓';
    $('streakSub').textContent = state.streak > 0
        ? `🔥 ${state.streak}-day streak${claimable ? ' — claim to keep it!' : ' — see you tomorrow!'}`
        : 'Claim every day — miss a day and it resets!';

    // 7-cell calendar for the current cycle
    const cal = $('streakCal');
    cal.innerHTML = '';
    // A missed day means the next claim restarts the cycle at day 1
    const broken = claimable && state.streak > 0 && state.streakLastClaim !== yesterdayStr();
    const effStreak = broken ? 0 : state.streak;
    let doneCount = effStreak === 0 ? 0 : ((effStreak - 1) % 7) + 1;
    if (claimable && doneCount === 7) doneCount = 0; // finished cycle → fresh row
    for (let i = 0; i < 7; i++) {
        const cell = document.createElement('div');
        const isDone = i < doneCount;
        const isNext = i === doneCount && claimable;
        cell.className = 'streak-day' + (isDone ? ' done' : '') + (isNext ? ' next' : '');
        cell.innerHTML = `<span class="sd-day">D${i + 1}</span><span class="sd-val">${isDone ? '✓' : fmt(STREAK_REWARDS[i])}</span>`;
        cal.appendChild(cell);
    }
}

/* ============================================================
   Daily quests
   ============================================================ */
function renderQuests() {
    const list = $('questList');
    if (!list) return;
    const daily = ensureDaily();
    const quests = todaysQuests();
    list.innerHTML = '';
    for (const q of quests) {
        const progress = Math.min(daily[q.key] || 0, q.target);
        const complete = progress >= q.target;
        const claimed = Boolean(daily.claimed[q.id]);
        const row = document.createElement('div');
        row.className = 'card quest-card';
        row.innerHTML = `
            <div class="card-icon">${q.icon}</div>
            <div class="card-body">
                <div class="card-title">${q.label}</div>
                <div class="quest-bar"><div class="quest-fill" style="width:${progress / q.target * 100}%"></div></div>
                <div class="card-sub">${fmt(progress)} / ${fmt(q.target)} · +${fmt(q.reward)} 🪙</div>
            </div>
            <button class="card-btn quest-btn" data-quest="${q.id}"
                ${claimed ? 'disabled' : complete ? '' : 'disabled'}>
                ${claimed ? '✓' : complete ? 'Claim' : '…'}
            </button>`;
        list.appendChild(row);
    }
    list.querySelectorAll('.quest-btn:not([disabled])').forEach((btn) => {
        btn.addEventListener('click', () => claimQuest(btn.dataset.quest));
    });
}

function claimQuest(id) {
    const daily = ensureDaily();
    const q = QUEST_POOL.find((x) => x.id === id);
    if (!q || daily.claimed[id] || (daily[q.key] || 0) < q.target) return;
    daily.claimed[id] = true;
    addCoins(q.reward);
    haptic.success();
    toast(`🎯 Quest complete! +${fmt(q.reward)} 🪙`);
    renderAll();
    saveProgress(false);
}

/* ============================================================
   Lucky wheel
   ============================================================ */
let wheelSpinning = false;

function buildWheel() {
    const wheel = $('wheel');
    const n = WHEEL_SEGMENTS.length;
    const seg = 360 / n;
    // conic-gradient background
    let stops = [];
    WHEEL_SEGMENTS.forEach((s, i) => {
        stops.push(`${s.color} ${i * seg}deg ${(i + 1) * seg}deg`);
    });
    wheel.style.background = `conic-gradient(${stops.join(',')})`;
    // labels
    WHEEL_SEGMENTS.forEach((s, i) => {
        const lab = document.createElement('div');
        lab.className = 'wheel-label';
        lab.textContent = s.label;
        lab.style.transform = `rotate(${i * seg + seg / 2}deg) translateY(-78px)`;
        wheel.appendChild(lab);
    });
}

function pickWheelPrize() {
    const total = WHEEL_SEGMENTS.reduce((a, s) => a + s.weight, 0);
    let r = Math.random() * total;
    for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
        r -= WHEEL_SEGMENTS[i].weight;
        if (r <= 0) return i;
    }
    return 0;
}

function openWheel() {
    $('wheelModal').classList.remove('hidden');
    updateSpinButton();
}

function updateSpinButton() {
    const daily = ensureDaily();
    const btn = $('btnSpinNow');
    btn.disabled = wheelSpinning;
    btn.textContent = daily.freeSpinUsed ? '🎬 SPIN (watch ad)' : '🎁 FREE SPIN';
    $('wheelSub').textContent = daily.freeSpinUsed
        ? 'Free spin used — extra spins via ads'
        : '1 free spin ready!';
}

function doSpin() {
    if (wheelSpinning) return;
    const daily = ensureDaily();
    if (!daily.freeSpinUsed) {
        daily.freeSpinUsed = true;
        spinWheel();
    } else {
        showRewardedAd(undefined, () => {
            countAdWatched();
            spinWheel();
        });
    }
}

function spinWheel() {
    wheelSpinning = true;
    updateSpinButton();
    const prizeIdx = pickWheelPrize();
    const seg = 360 / WHEEL_SEGMENTS.length;
    // Land the middle of the prize segment under the top pointer
    const target = 360 * 5 + (360 - (prizeIdx * seg + seg / 2));
    const wheel = $('wheel');
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    void wheel.offsetWidth; // reflow so the reset takes effect
    wheel.style.transition = 'transform 4s cubic-bezier(0.12, 0.7, 0.1, 1)';
    wheel.style.transform = `rotate(${target}deg)`;
    haptic.medium();

    setTimeout(() => {
        wheelSpinning = false;
        const prize = WHEEL_SEGMENTS[prizeIdx];
        const daily = ensureDaily();
        daily.spins += 1;
        if (prize.energy) {
            state.energy = maxEnergy();
            toast('⚡ Energy fully refilled!');
        } else {
            addCoins(prize.coins);
            toast(`🎡 You won ${fmt(prize.coins)} 🪙!`);
        }
        haptic.success();
        updateSpinButton();
        renderAll();
        saveProgress(false);
    }, 4200);
}

/* ============================================================
   Golden coin frenzy
   ============================================================ */
let frenzyTicker = null;

function maybeSpawnGoldenCoin() {
    if (currentTab !== 'home' || frenzyActive() || !$('goldenCoin').classList.contains('hidden')) return;
    if (Math.random() > 0.35) return;
    const gc = $('goldenCoin');
    gc.style.left = (10 + Math.random() * 70) + '%';
    gc.style.top = (10 + Math.random() * 70) + '%';
    gc.classList.remove('hidden');
    haptic.medium();
    setTimeout(() => gc.classList.add('hidden'), 6000);
}

function startFrenzy() {
    $('goldenCoin').classList.add('hidden');
    frenzyUntil = Date.now() + CONFIG.FRENZY_SECONDS * 1000;
    haptic.heavy();
    document.body.classList.add('frenzy');
    $('frenzyBanner').classList.remove('hidden');
    toast(`🔥 FRENZY! ×${CONFIG.FRENZY_MULTIPLIER} coins for ${CONFIG.FRENZY_SECONDS}s!`);
    clearInterval(frenzyTicker);
    frenzyTicker = setInterval(() => {
        const left = Math.ceil((frenzyUntil - Date.now()) / 1000);
        if (left <= 0) {
            clearInterval(frenzyTicker);
            document.body.classList.remove('frenzy');
            $('frenzyBanner').classList.add('hidden');
            renderGame();
        } else {
            $('frenzyTimer').textContent = left;
        }
    }, 250);
    renderGame();
}

/* ============================================================
   Ranks & celebration
   ============================================================ */
function rankIdxFor(earned) {
    let idx = 0;
    RANKS.forEach(([threshold], i) => { if (earned >= threshold) idx = i; });
    return idx;
}

function checkRankUp() {
    const idx = rankIdxFor(state.totalEarned);
    if (idx > state.lastRankIdx) {
        state.lastRankIdx = idx;
        celebrateRank(idx);
    }
}

function celebrateRank(idx) {
    const [, icon, name] = RANKS[idx];
    $('rankBigIcon').textContent = icon;
    $('rankNewName').textContent = name;
    $('rankOverlay').classList.remove('hidden');
    haptic.success();
    setTimeout(() => haptic.heavy(), 200);

    // Confetti burst
    const box = $('confetti');
    box.innerHTML = '';
    const emojis = ['🎉', '✨', '🪙', '⭐', '🎊'];
    for (let i = 0; i < 40; i++) {
        const p = document.createElement('span');
        p.className = 'confetti-bit';
        p.textContent = emojis[i % emojis.length];
        p.style.left = Math.random() * 100 + '%';
        p.style.animationDelay = (Math.random() * 0.8) + 's';
        p.style.animationDuration = (1.5 + Math.random() * 1.5) + 's';
        p.style.fontSize = (14 + Math.random() * 16) + 'px';
        box.appendChild(p);
    }
}

function shareRank() {
    const idx = state.lastRankIdx;
    const [, icon, name] = RANKS[idx];
    const link = inviteLink();
    const text = `${icon} I just reached ${name} rank in Tap Empire! Can you beat me?`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (isTelegram) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl, '_blank');
    haptic.medium();
}

/* ============================================================
   Referrals
   ============================================================ */
function inviteLink() {
    const user = tg?.initDataUnsafe?.user;
    return `https://t.me/${CONFIG.BOT_USERNAME}/${CONFIG.APP_SHORT_NAME}?startapp=ref_${user?.id || 'guest'}`;
}

function inviteFriends() {
    const text = '🪙 Join me in Tap Empire and start earning coins! You get +500 🪙 to start.';
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink())}&text=${encodeURIComponent(text)}`;
    if (isTelegram) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl, '_blank');
    state.friendsShared += 1;
    ensureDaily().shares += 1;
    haptic.medium();
    renderQuests();
    saveProgress(false);
}

/* Welcome bonus when arriving through a friend's link */
function checkReferralWelcome() {
    const sp = tg?.initDataUnsafe?.start_param;
    if (!sp || !sp.startsWith('ref_') || state.refBonusGiven) return;
    const myId = String(tg?.initDataUnsafe?.user?.id || '');
    if (sp === 'ref_' + myId) return; // can't refer yourself
    state.refBonusGiven = true;
    addCoins(CONFIG.REWARD_REFERRAL_WELCOME);
    haptic.success();
    showPopup({
        title: '🎁 Welcome gift!',
        message: `A friend invited you — here's +${CONFIG.REWARD_REFERRAL_WELCOME} coins to get started!`,
        buttons: [{ type: 'ok' }],
    });
    saveProgress(false);
}

/* ============================================================
   Phase B server (Cloudflare Worker): verified earnings,
   leaderboard, withdrawals, reminder DMs.
   All of this silently no-ops when CONFIG.API_BASE is empty.
   ============================================================ */
const server = {
    connected: false,
    usdBalance: 0,
    verifiedAds: 0,
    minWithdraw: 1,
    reminderEnabled: true,
    botStarted: false,
    rank: null,
};

async function api(path, payload = {}) {
    if (!CONFIG.API_BASE || !isTelegram) return null;
    try {
        const res = await fetch(CONFIG.API_BASE + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ initData: tg.initData, ...payload }),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

async function initServer() {
    const d = await api('/api/auth');
    if (!d || !d.ok) return; // offline / not configured — app stays client-only
    server.connected = true;
    server.usdBalance = d.usd_balance || 0;
    server.verifiedAds = d.verified_ads || 0;
    server.minWithdraw = d.min_withdraw || 1;
    server.reminderEnabled = Boolean(d.reminder_enabled);
    server.botStarted = Boolean(d.bot_started);
    server.rank = d.rank;
    // The estimate never displays less than what's actually been verified
    if ((d.usd_lifetime || 0) > state.simUsd) {
        state.simUsd = d.usd_lifetime;
        renderGame();
    }
    // Reveal the server-backed UI
    $('btnBoard').classList.remove('hidden');
    $('cardWallet').classList.remove('hidden');
    $('sdkBell').classList.remove('hidden');
    renderServer();
    syncServer();
}

let lastSync = 0;
async function syncServer(force) {
    if (!server.connected) return;
    if (!force && Date.now() - lastSync < 45000) return; // throttle
    lastSync = Date.now();
    const d = await api('/api/sync', {
        balance: Math.floor(state.balance),
        totalEarned: Math.floor(state.totalEarned),
        totalTaps: state.totalTaps,
        streak: state.streak,
    });
    if (d && d.ok) {
        server.usdBalance = d.usd_balance || 0;
        server.verifiedAds = d.verified_ads || 0;
        renderServer();
    }
}

function renderServer() {
    if (!server.connected) return;
    $('walletSub').textContent =
        `$${server.usdBalance.toFixed(4)} verified · min payout $${server.minWithdraw.toFixed(2)}`;
    $('btnWithdraw').disabled = server.usdBalance < server.minWithdraw;
    $('sdkBell').textContent = `🔔 Reminders: ${server.reminderEnabled ? 'ON' : 'OFF'}`;
}

async function openLeaderboard() {
    $('boardModal').classList.remove('hidden');
    $('boardList').textContent = 'Loading…';
    $('boardMe').textContent = '';
    const d = await api('/api/leaderboard');
    if (!d || !d.ok) {
        $('boardList').textContent = 'Could not load the leaderboard.';
        return;
    }
    const myId = tg?.initDataUnsafe?.user?.id;
    if (d.me) $('boardMe').textContent = `Your rank: #${d.me.rank} · ${fmt(d.me.earned)} 🪙`;
    const list = $('boardList');
    list.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    for (const row of d.top) {
        const el = document.createElement('div');
        el.className = 'board-row' + (row.id === myId ? ' me' : '');
        el.innerHTML = `
            <span class="board-rank">${medals[row.rank - 1] || '#' + row.rank}</span>
            <span class="board-name"></span>
            <span class="board-score">${fmt(row.earned)} 🪙</span>`;
        el.querySelector('.board-name').textContent =
            row.name + (row.streak > 1 ? ` 🔥${row.streak}` : '');
        list.appendChild(el);
    }
}

function openWithdraw() {
    if (server.usdBalance < server.minWithdraw) {
        haptic.warning();
        toast(`Minimum payout is $${server.minWithdraw.toFixed(2)} — keep watching ads!`);
        return;
    }
    $('withdrawInfo').textContent =
        `Your full verified balance of $${server.usdBalance.toFixed(4)} will be paid out. Payouts are processed manually within 48 h.`;
    $('withdrawModal').classList.remove('hidden');
}

async function confirmWithdraw() {
    const wallet = $('walletInput').value.trim();
    if (wallet.length < 10) {
        haptic.error();
        toast('Please enter a valid wallet address');
        return;
    }
    $('btnWithdrawConfirm').disabled = true;
    const d = await api('/api/withdraw', { wallet });
    $('btnWithdrawConfirm').disabled = false;
    if (d && d.ok) {
        server.usdBalance = 0;
        renderServer();
        $('withdrawModal').classList.add('hidden');
        haptic.success();
        showPopup({
            title: '💸 Payout requested!',
            message: `$${d.amount} is on its way to your wallet. You'll get a Telegram message when it's sent.`,
            buttons: [{ type: 'ok' }],
        });
    } else {
        haptic.error();
        toast((d && d.error) || 'Withdrawal failed — try again later');
    }
}

async function toggleReminders() {
    const enable = !server.reminderEnabled;
    const d = await api('/api/reminder', { enabled: enable });
    if (d && d.ok) {
        server.reminderEnabled = enable;
        renderServer();
        toast(enable ? '🔔 Daily reminders on' : '🔕 Reminders off');
        // The bot can only DM users who pressed Start at least once
        if (enable && !server.botStarted) {
            showConfirm('To receive reminders, you need to start the bot once. Open the chat now?', (ok) => {
                if (ok) tg.openTelegramLink(`https://t.me/${CONFIG.BOT_USERNAME}?start=notify`);
            });
        }
    }
}

/* Offer offline earnings (computed in applySave) with an ad doubler */
function offerOfflineEarnings() {
    if (offlineEarnings < 20) return;
    const amount = offlineEarnings;
    offlineEarnings = 0;
    showPopup({
        title: '🤖 While you were away…',
        message: `Your Auto Bots earned ${amount.toLocaleString()} coins!\nWatch an ad to DOUBLE it.`,
        buttons: [
            { id: 'double', type: 'default', text: `🎬 Claim ×2 (${(amount * 2).toLocaleString()})` },
            { id: 'claim', type: 'default', text: `Claim ${amount.toLocaleString()}` },
        ],
    }, (id) => {
        if (id === 'double') {
            showRewardedAd(undefined, () => {
                countAdWatched();
                addCoins(amount * 2);
                haptic.success();
                toast(`🤖 +${fmt(amount * 2)} 🪙 collected (doubled)!`);
                renderAll();
                saveProgress(false);
            });
        } else {
            addCoins(amount);
            haptic.success();
            toast(`🤖 +${fmt(amount)} 🪙 collected!`);
            renderAll();
            saveProgress(false);
        }
    });
}

/* ============================================================
   Rendering
   ============================================================ */
function renderGame() {
    $('balance').textContent = fmt(state.balance);
    $('perTapLabel').textContent = frenzyActive()
        ? `🔥 +${perTap()} per tap`
        : `👆 +${perTap()} per tap`;
    $('profitChip').textContent = `⚙️ +${fmt(autoPerHour())}/hr`;
    $('usdChip').textContent = `💵 ≈ $${state.simUsd.toFixed(7)}`;
    $('energyText').textContent = `${Math.floor(state.energy)} / ${maxEnergy()}`;
    $('energyFill').style.width = (state.energy / maxEnergy() * 100) + '%';
    $('tapCoin').classList.toggle('exhausted', state.energy < tapCost());
    const [, icon, name] = RANKS[rankIdxFor(state.totalEarned)];
    $('userRank').textContent = `${icon} ${name}`;
}

function renderShop() {
    $('lvlMultitap').textContent = state.upgrades.multitap;
    $('lvlEnergy').textContent = state.upgrades.energy;
    $('lvlRegen').textContent = state.upgrades.regen;
    $('lvlAuto').textContent = state.upgrades.auto;
    $('costMultitap').textContent = fmt(upgradeCost('multitap'));
    $('costEnergy').textContent = fmt(upgradeCost('energy'));
    $('costRegen').textContent = fmt(upgradeCost('regen'));
    $('costAuto').textContent = fmt(upgradeCost('auto'));
    document.querySelectorAll('.buy-btn').forEach((btn) => {
        btn.disabled = state.balance < upgradeCost(btn.dataset.upgrade);
    });
}

function renderProfile() {
    $('statTaps').textContent = fmt(state.totalTaps);
    $('statEarned').textContent = fmt(state.totalEarned);
    $('statAds').textContent = fmt(state.adsWatched);
    $('statStreak').textContent = fmt(state.bestStreak);
}

function renderAll() {
    renderGame();
    renderShop();
    renderProfile();
    renderStreak();
    renderQuests();
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
    if (tab === 'daily') { renderStreak(); renderQuests(); }

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
    $('goldenCoin').addEventListener('pointerdown', startFrenzy);

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
                    countAdWatched();
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

    $('usdChip').addEventListener('click', () => showPopup({
        title: '💵 Estimated earnings',
        message: 'This live counter estimates the value your activity generates — it grows as you tap and watch ads.\n\nYour real, withdrawable balance is verified by the ad network and shown on the Earn tab.',
        buttons: [{ type: 'ok' }],
    }));

    $('btnInvite').addEventListener('click', inviteFriends);
    $('btnStreak').addEventListener('click', claimStreak);
    $('btnWheel').addEventListener('click', openWheel);
    $('btnSpinNow').addEventListener('click', doSpin);
    $('btnWheelClose').addEventListener('click', () => $('wheelModal').classList.add('hidden'));
    $('btnRankShare').addEventListener('click', shareRank);
    $('btnRankClose').addEventListener('click', () => $('rankOverlay').classList.add('hidden'));

    // Phase B (server) UI
    $('btnBoard').addEventListener('click', openLeaderboard);
    $('btnBoardClose').addEventListener('click', () => $('boardModal').classList.add('hidden'));
    $('btnWithdraw').addEventListener('click', openWithdraw);
    $('btnWithdrawConfirm').addEventListener('click', confirmWithdraw);
    $('btnWithdrawClose').addEventListener('click', () => $('withdrawModal').classList.add('hidden'));
    $('sdkBell').addEventListener('click', toggleReminders);
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
        tg.setHeaderColor(tg.themeParams.bg_color || '#18222d');
        tg.setBackgroundColor(tg.themeParams.bg_color || '#18222d');
    });

    tg.onEvent('viewportChanged', (e) => {
        if (e.isStateStable) document.documentElement.style.setProperty(
            '--tg-viewport-height', tg.viewportStableHeight + 'px');
    });

    // Save when the app is about to close / hide
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveProgress(false);
            syncServer(true);
        }
    });
}

function startLoops() {
    // Energy regen + Auto Bot passive income (4 ticks/sec for smoothness)
    setInterval(() => {
        let dirty = false;
        if (state.energy < maxEnergy()) {
            state.energy = Math.min(maxEnergy(), state.energy + regenPerSec() / 4);
            dirty = true;
        }
        if (state.upgrades.auto > 0) {
            const gain = autoPerHour() / 3600 / 4;
            state.balance += gain;
            state.totalEarned += gain;
            dirty = true;
        }
        if (dirty) renderGame();
    }, 250);

    // Rank check for passive income (cheap, once a second)
    setInterval(checkRankUp, 1000);

    // Golden coin spawn check every 25 s
    setInterval(maybeSpawnGoldenCoin, 25000);

    // Autosave every 30 s; server sync throttles itself to ≥45 s
    setInterval(() => { saveProgress(false); syncServer(); }, 30000);
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
    buildWheel();
    initMonetag();

    loadProgress(() => {
        ensureDaily();
        checkReferralWelcome();
        renderAll();
        startLoops();
        initServer();
        // Reveal the app
        setTimeout(() => {
            $('splash').classList.add('hidden');
            $('app').classList.remove('hidden');
            offerOfflineEarnings();
            if (!isTelegram) {
                toast('⚠️ Running outside Telegram — SDK features are simulated');
            }
        }, 400);
    });
}

document.addEventListener('DOMContentLoaded', init);
