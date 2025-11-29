import { kv } from "../api/_lib/kv.js";
import { USER_KEYS, GLOBAL_KEYS } from "./keys.js";

/**
 * Read user's watchlist
 */
export async function getUserWatchlist(userId) {
    let wl = await kv.get(USER_KEYS.watchlist(userId));

    try { wl = JSON.parse(wl); }
    catch { wl = []; }

    return Array.isArray(wl) ? wl : [];
}

/**
 * Add token to a user's watchlist
 */
export async function addToken(userId, token) {
    token = Number(token);
    if (!token) return;

    let wl = await getUserWatchlist(userId);

    if (!wl.includes(token)) {
        wl.push(token);
        await kv.set(USER_KEYS.watchlist(userId), JSON.stringify(wl));
    }

    // Add user to active user list
    await kv.sadd(GLOBAL_KEYS.all_users, userId);

    return wl;
}

/**
 * Remove token from a user's watchlist
 */
export async function removeToken(userId, token) {
    token = Number(token);

    let wl = await getUserWatchlist(userId);
    wl = wl.filter(t => t !== token);

    await kv.set(USER_KEYS.watchlist(userId), JSON.stringify(wl));
    return wl;
}

/**
 * Rebuild the global ticker watchlist (union of all users)
 */
export async function rebuildGlobalWatchlist() {
    const allUsers = await kv.smembers(GLOBAL_KEYS.all_users);
    let finalSet = new Set();

    for (let uid of allUsers) {
        let wl = await getUserWatchlist(uid);
        wl.forEach(t => finalSet.add(Number(t)));
    }

    const arr = [...finalSet];
    await kv.set(GLOBAL_KEYS.ticker_tokens, JSON.stringify(arr));

    return arr;
}

/**
 * Get the global ticker token list
 */
export async function getGlobalWatchlist() {
    let wl = await kv.get(GLOBAL_KEYS.ticker_tokens);

    try { wl = JSON.parse(wl); }
    catch { wl = []; }

    return Array.isArray(wl) ? wl : [];
}
