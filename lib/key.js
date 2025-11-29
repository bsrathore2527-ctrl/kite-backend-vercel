// Multi-user Redis key helper
// USER_ID = Zerodha client_id

export function kUser(userId, key) {
    return `user:${userId}:${key}`;
}

// Basic keys
export const USER_KEYS = {
    tradebook:  (id) => kUser(id, "tradebook"),
    sellbook:   (id) => kUser(id, "sellbook"),
    positions:  (id) => kUser(id, "positions"),
    watchlist:  (id) => kUser(id, "watchlist"),
    settings:   (id) => kUser(id, "settings"),
    state:      (id) => kUser(id, "state"),
    mtm:        (id) => kUser(id, "mtm"),
    risk:       (id) => kUser(id, "risk"),
};

// Global (shared)
export const GLOBAL_KEYS = {
    all_users:       "global:users",       // list of all client_ids using system
    ticker_tokens:   "ticker:tokens",      // combined token list
    ltp:            (token) => `ltp:${token}`, // global LTP
};
