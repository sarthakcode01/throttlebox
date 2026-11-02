/**
 * Redis Lua script for atomic sliding-window rate limiting.
 *
 * Algorithm:
 *  - Uses a Sorted Set with score = timestamp (in milliseconds).
 *  - ARGV[1] = window_ms (window duration in milliseconds, e.g. 3600000).
 *  - ARGV[2] = limit (max requests allowed in window, e.g. 100).
 *  - ARGV[3] = member_id (unique request identifier to ensure uniqueness).
 *  - ARGV[4] = optional simulated now_ms (0 or omitted = use Redis server time).
 *
 * Returns an array:
 *  [1] allowed (1 for allowed, 0 for rejected)
 *  [2] limit (effective limit)
 *  [3] remaining (remaining quota in current window)
 *  [4] reset_at (epoch timestamp in seconds when the window resets or current slot frees up)
 *  [5] retry_after (seconds until capacity frees up; 0 if allowed)
 */

export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member_id = ARGV[3]

local now_ms
local now_sec

if ARGV[4] and tonumber(ARGV[4]) > 0 then
    now_ms = tonumber(ARGV[4])
    now_sec = math.floor(now_ms / 1000)
else
    local time = redis.call('TIME')
    now_sec = tonumber(time[1])
    now_ms = now_sec * 1000 + math.floor(tonumber(time[2]) / 1000)
end

-- 1. Remove entries older than (now_ms - window_ms)
local clear_before = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', clear_before)

-- 2. Count requests currently in sliding window
local count = redis.call('ZCARD', key)

if count < limit then
    -- Allowed: insert request
    redis.call('ZADD', key, now_ms, member_id)
    -- Expire bucket when idle so Redis memory cleans up automatically
    redis.call('PEXPIRE', key, window_ms)

    local remaining = limit - count - 1
    local reset_at = math.ceil((now_ms + window_ms) / 1000)
    return {1, limit, remaining, reset_at, 0}
else
    -- Refresh TTL so bucket persists while client is being throttled
    redis.call('PEXPIRE', key, window_ms)

    -- Denied: find oldest score in current window to calculate Retry-After
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local reset_at = now_sec + math.ceil(window_ms / 1000)
    local retry_after = 1

    if oldest and #oldest >= 2 then
        local oldest_ms = tonumber(oldest[2])
        local earliest_free_ms = oldest_ms + window_ms
        retry_after = math.max(1, math.ceil((earliest_free_ms - now_ms) / 1000))
        reset_at = math.ceil(earliest_free_ms / 1000)
    end

    return {0, limit, 0, reset_at, retry_after}
end
`;
