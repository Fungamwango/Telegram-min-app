/* ============================================================
   Tap Empire API — Cloudflare Worker + D1
   - POST /api/auth        validate initData, upsert user, return profile
   - POST /api/sync        sync game stats (leaderboard/display only)
   - POST /api/leaderboard top players + caller's rank
   - POST /api/withdraw    request payout of verified USD balance
   - POST /api/reminder    toggle daily reminder DMs
   - GET  /api/postback    Monetag server-to-server postback (credits USD)
   - GET  /api/admin/withdrawals?s=SECRET        list pending payouts
   - GET  /api/admin/paid?s=SECRET&id=N          mark a payout as paid
   - POST /webhook/<WEBHOOK_SECRET>              Telegram bot updates (/start)
   - scheduled()           daily streak-reminder DMs via the bot
   ============================================================ */

'use strict';

const enc = new TextEncoder();

/* ---------------- helpers ---------------- */

/* Secrets pasted into the dashboard often carry stray whitespace — trim
   every secret at the point of use so an invisible character can't break
   auth, webhooks, or postbacks. */
const sec = (v) => (v || '').trim();

function cors(env) {
    return {
        'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
    };
}

function json(env, data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', ...cors(env) },
    });
}

async function hmac(keyBytes, msgBytes) {
    const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Validate Telegram Mini App initData (HMAC per official docs).
 * Returns { user, startParam } or null.
 */
async function validateInitData(initData, botToken) {
    if (!initData || typeof initData !== 'string') return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
    const sig = toHex(await hmac(secret, enc.encode(dataCheckString)));
    if (sig !== hash) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86400) return null; // stale
    try {
        const user = JSON.parse(params.get('user') || 'null');
        if (!user || !user.id) return null;
        return { user, startParam: params.get('start_param') || '' };
    } catch (_) {
        return null;
    }
}

/* Authenticate a JSON request body ({ initData, ... }) */
async function authBody(request, env) {
    let body;
    try { body = await request.json(); } catch (_) { return { error: 'bad json' }; }
    if (!sec(env.BOT_TOKEN)) {
        console.log('AUTH FAIL: BOT_TOKEN secret is not set');
        return { error: 'server not configured' };
    }
    const auth = await validateInitData(body.initData, sec(env.BOT_TOKEN));
    if (!auth) {
        console.log('AUTH FAIL: initData rejected (hash/token mismatch or stale). len=',
            (body.initData || '').length);
        return { error: 'invalid initData' };
    }
    return { body, auth };
}

async function upsertUser(env, user, refBy) {
    const now = Date.now();
    await env.DB.prepare(
        `INSERT INTO users (telegram_id, username, first_name, ref_by, created_at, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(telegram_id) DO UPDATE SET
           username = ?2, first_name = ?3, last_seen = ?5`
    ).bind(user.id, user.username || null, user.first_name || null, refBy || null, now).run();
}

async function getUser(env, id) {
    return env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?1').bind(id).first();
}

async function rankOf(env, totalEarned) {
    const r = await env.DB.prepare(
        'SELECT COUNT(*) + 1 AS rank FROM users WHERE total_earned > ?1'
    ).bind(totalEarned).first();
    return r ? r.rank : null;
}

async function tgSend(env, chatId, text, extra = {}) {
    const res = await fetch(`https://api.telegram.org/bot${sec(env.BOT_TOKEN)}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    });
    return res.json().catch(() => ({}));
}

function appButton(env) {
    return {
        reply_markup: {
            inline_keyboard: [[{
                text: '🪙 Open Tap Empire',
                url: `https://t.me/${env.BOT_USERNAME}/${env.APP_SHORT_NAME}`,
            }]],
        },
    };
}

const clampNum = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(n, max)) : 0;
};

/* ---------------- route handlers ---------------- */

async function handleAuth(request, env) {
    const { body, auth, error } = await authBody(request, env);
    if (error) return json(env, { error }, 401);

    let refBy = null;
    if (auth.startParam.startsWith('ref_')) {
        const rid = Number(auth.startParam.slice(4));
        if (Number.isInteger(rid) && rid !== auth.user.id) refBy = rid;
    }
    await upsertUser(env, auth.user, refBy);
    const u = await getUser(env, auth.user.id);
    return json(env, {
        ok: true,
        usd_balance: u.usd_balance,
        usd_lifetime: u.usd_lifetime,
        verified_ads: u.verified_ads,
        reminder_enabled: Boolean(u.reminder_enabled),
        bot_started: Boolean(u.bot_started),
        min_withdraw: parseFloat(env.MIN_WITHDRAW_USD || '1'),
        rank: await rankOf(env, u.total_earned),
    });
}

async function handleSync(request, env) {
    const { body, auth, error } = await authBody(request, env);
    if (error) return json(env, { error }, 401);
    await upsertUser(env, auth.user, null);
    // Sanity caps keep absurd forged values out of the leaderboard
    await env.DB.prepare(
        `UPDATE users SET
           game_balance = ?2,
           total_earned = MAX(total_earned, ?3),
           total_taps   = MAX(total_taps, ?4),
           streak       = ?5,
           last_seen    = ?6
         WHERE telegram_id = ?1`
    ).bind(
        auth.user.id,
        clampNum(body.balance, 1e12),
        clampNum(body.totalEarned, 1e12),
        Math.floor(clampNum(body.totalTaps, 1e9)),
        Math.floor(clampNum(body.streak, 100000)),
        Date.now()
    ).run();
    const u = await getUser(env, auth.user.id);
    return json(env, { ok: true, usd_balance: u.usd_balance, verified_ads: u.verified_ads });
}

async function handleLeaderboard(request, env) {
    const { auth, error } = await authBody(request, env);
    if (error) return json(env, { error }, 401);
    const top = await env.DB.prepare(
        `SELECT telegram_id, first_name, username, total_earned, streak
         FROM users ORDER BY total_earned DESC LIMIT 25`
    ).all();
    const me = await getUser(env, auth.user.id);
    return json(env, {
        ok: true,
        top: (top.results || []).map((r, i) => ({
            rank: i + 1,
            id: r.telegram_id,
            name: r.first_name || r.username || 'Player',
            earned: r.total_earned,
            streak: r.streak,
        })),
        me: me ? { rank: await rankOf(env, me.total_earned), earned: me.total_earned } : null,
    });
}

async function handleWithdraw(request, env) {
    const { body, auth, error } = await authBody(request, env);
    if (error) return json(env, { error }, 401);
    const wallet = String(body.wallet || '').trim();
    if (wallet.length < 10 || wallet.length > 128) {
        return json(env, { error: 'Invalid wallet address' }, 400);
    }
    const u = await getUser(env, auth.user.id);
    const min = parseFloat(env.MIN_WITHDRAW_USD || '1');
    if (!u || u.usd_balance < min) {
        return json(env, { error: `Minimum withdrawal is $${min.toFixed(2)}` }, 400);
    }
    const amount = Math.round(u.usd_balance * 10000) / 10000;
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO withdrawals (telegram_id, amount_usd, wallet, created_at)
             VALUES (?1, ?2, ?3, ?4)`
        ).bind(u.telegram_id, amount, wallet, Date.now()),
        env.DB.prepare(
            'UPDATE users SET usd_balance = 0 WHERE telegram_id = ?1'
        ).bind(u.telegram_id),
    ]);
    if (env.ADMIN_CHAT_ID) {
        await tgSend(env, env.ADMIN_CHAT_ID,
            `💸 <b>Withdrawal request</b>\nUser: ${u.first_name || ''} @${u.username || '—'} (id ${u.telegram_id})\nAmount: $${amount}\nWallet: <code>${wallet}</code>`);
    }
    return json(env, { ok: true, amount });
}

async function handleReminder(request, env) {
    const { body, auth, error } = await authBody(request, env);
    if (error) return json(env, { error }, 401);
    await upsertUser(env, auth.user, null);
    await env.DB.prepare(
        'UPDATE users SET reminder_enabled = ?2 WHERE telegram_id = ?1'
    ).bind(auth.user.id, body.enabled ? 1 : 0).run();
    return json(env, { ok: true, enabled: Boolean(body.enabled) });
}

/**
 * Monetag server-to-server postback. Configure in the Monetag dashboard as:
 *   https://<worker-url>/api/postback?s=<POSTBACK_SECRET>&ymid={ymid}
 *     &event={event_type}&zone_id={zone_id}&estimated_price={estimated_price}
 *     &request_var={request_var}&telegram_id={telegram_id}
 * Idempotent per (ymid, event) — retries can't double-credit.
 */
async function handlePostback(url, env) {
    if (url.searchParams.get('s') !== sec(env.POSTBACK_SECRET)) {
        console.log('POSTBACK FAIL: wrong secret — update the URL in the Monetag dashboard');
        return new Response('forbidden', { status: 403 });
    }
    let ymid = url.searchParams.get('ymid') || '';
    const event = url.searchParams.get('event') || 'impression';
    // ymid is "<telegram_id>_<timestamp>" (set by the app)
    let tid = Number(url.searchParams.get('telegram_id') || ymid.split('_')[0]);
    if (!Number.isInteger(tid) || tid <= 0) tid = null;
    // Automatic in-app interstitials arrive without a ymid; substitute a
    // unique one so the (ymid, event) dedup doesn't collapse them all
    if (!ymid) ymid = `auto_${tid || 'anon'}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const price = Math.max(0, parseFloat(url.searchParams.get('estimated_price') || '0') || 0);

    const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO postbacks (ymid, telegram_id, event, zone_id, estimated_price, request_var, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(ymid, tid, event, url.searchParams.get('zone_id') || '',
           price, url.searchParams.get('request_var') || '', Date.now()).run();

    // Credit only on first insert (dedup) and only for known users
    if (ins.meta.changes > 0 && tid) {
        const share = Math.min(1, Math.max(0, parseFloat(env.REV_SHARE || '0.5')));
        const credit = price * share;
        await env.DB.prepare(
            `UPDATE users SET
               usd_balance  = usd_balance + ?2,
               usd_lifetime = usd_lifetime + ?2,
               verified_ads = verified_ads + ?3
             WHERE telegram_id = ?1`
        ).bind(tid, credit, event === 'impression' ? 1 : 0).run();
    }
    return new Response('OK');
}

/* Telegram bot webhook: registers users for DMs, answers /start */
async function handleWebhook(request, env) {
    let update;
    try { update = await request.json(); } catch (_) { return new Response('OK'); }
    const msg = update.message;
    if (msg && msg.from && msg.text && msg.text.startsWith('/start')) {
        await upsertUser(env, msg.from, null);
        await env.DB.prepare(
            'UPDATE users SET bot_started = 1 WHERE telegram_id = ?1'
        ).bind(msg.from.id).run();
        await tgSend(env, msg.chat.id,
            `👋 Welcome to <b>Tap Empire</b>, ${msg.from.first_name || 'player'}!\n\n` +
            `🪙 Tap to earn coins\n🎬 Watch ads for real verified earnings\n🔥 Keep your daily streak alive\n\n` +
            `I'll also remind you before your streak expires.`,
            appButton(env));
    }
    return new Response('OK');
}

async function handleAdmin(url, env) {
    if (url.searchParams.get('s') !== sec(env.POSTBACK_SECRET)) {
        return new Response('forbidden', { status: 403 });
    }
    if (url.pathname === '/api/admin/withdrawals') {
        const rows = await env.DB.prepare(
            `SELECT w.*, u.username, u.first_name FROM withdrawals w
             LEFT JOIN users u ON u.telegram_id = w.telegram_id
             WHERE w.status = 'pending' ORDER BY w.created_at`
        ).all();
        return json(env, rows.results || []);
    }
    if (url.pathname === '/api/admin/paid') {
        const id = Number(url.searchParams.get('id'));
        const res = await env.DB.prepare(
            `UPDATE withdrawals SET status = 'paid', paid_at = ?2 WHERE id = ?1 AND status = 'pending'`
        ).bind(id, Date.now()).run();
        // Tell the user their payout was sent
        if (res.meta.changes > 0) {
            const w = await env.DB.prepare('SELECT * FROM withdrawals WHERE id = ?1').bind(id).first();
            if (w) await tgSend(env, w.telegram_id, `✅ Your withdrawal of $${w.amount_usd} has been paid out!`);
        }
        return json(env, { ok: true, updated: res.meta.changes });
    }
    return new Response('not found', { status: 404 });
}

/* ---------------- entry points ---------------- */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors(env) });
        }

        try {
            if (request.method === 'POST') {
                if (path === '/api/auth') return handleAuth(request, env);
                if (path === '/api/sync') return handleSync(request, env);
                if (path === '/api/leaderboard') return handleLeaderboard(request, env);
                if (path === '/api/withdraw') return handleWithdraw(request, env);
                if (path === '/api/reminder') return handleReminder(request, env);
                if (path === `/webhook/${sec(env.WEBHOOK_SECRET)}`) return handleWebhook(request, env);
                if (path.startsWith('/webhook/')) {
                    console.log('WEBHOOK FAIL: path secret mismatch — re-run setWebhook with the current WEBHOOK_SECRET');
                    // 200 so Telegram stops retrying a permanently-wrong path
                    return new Response('OK');
                }
            }
            if (request.method === 'GET') {
                if (path === '/api/postback') return handlePostback(url, env);
                if (path.startsWith('/api/admin/')) return handleAdmin(url, env);
                if (path === '/') return json(env, { ok: true, service: 'tap-empire-api' });
            }
        } catch (err) {
            console.error('worker error:', err);
            return json(env, { error: 'internal error' }, 500);
        }
        return new Response('not found', { status: 404 });
    },

    /* Daily reminder DMs (cron). Only users who /start-ed the bot can be
       messaged; skip anyone active in the last 8 h; drop blockers. */
    async scheduled(_event, env) {
        const now = Date.now();
        const users = await env.DB.prepare(
            `SELECT telegram_id, first_name, streak FROM users
             WHERE bot_started = 1 AND reminder_enabled = 1
               AND last_seen > ?1 AND last_seen < ?2
             ORDER BY last_seen DESC LIMIT 500`
        ).bind(now - 14 * 86400000, now - 8 * 3600000).all();

        for (const u of (users.results || [])) {
            const text = u.streak > 0
                ? `🔥 ${u.first_name || 'Hey'}, your <b>${u.streak}-day streak</b> is about to expire! Claim today's reward before midnight.`
                : `⚡ ${u.first_name || 'Hey'}, your energy is full and today's rewards are waiting!`;
            const res = await tgSend(env, u.telegram_id, text, appButton(env));
            if (res && res.ok === false && res.error_code === 403) {
                // user blocked the bot — stop trying
                await env.DB.prepare(
                    'UPDATE users SET bot_started = 0 WHERE telegram_id = ?1'
                ).bind(u.telegram_id).run();
            }
        }
    },
};
