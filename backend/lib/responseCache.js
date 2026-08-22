/**
 * responseCache.js — caches assistant responses for exact-repeat first-turn
 * questions (no prior conversation history) via kv.js, so a second visitor
 * asking the exact same starter-chip question gets an instant answer
 * instead of paying for a fresh KB search + LLM call.
 *
 * Deliberately scoped to FIRST-TURN questions only (no conversation
 * history) — a follow-up's correct answer depends on everything said
 * before it in that specific conversation, which this cache has no way to
 * account for, and follow-ups are far less likely to repeat verbatim
 * across different visitors anyway. The exact starter-chip questions are
 * the highest-value target this exists for: many different visitors
 * clicking the same suggested question, all currently paying full KB
 * search + LLM cost for an answer that's identical every time.
 *
 * Invalidation: generational, not enumerative. Redis has no cheap "delete
 * every key matching this tenant" primitive without SCAN (which kv.js
 * doesn't expose, and SCAN-ing in production Redis has its own footguns),
 * so instead each tenant has a "cache generation" number baked into every
 * cache key. Ingesting new KB content bumps the generation, which makes
 * every previously-cached entry for that tenant unreachable in one write,
 * without enumerating or deleting anything — old entries just expire via
 * their normal TTL and are never read again in the meantime.
 */
const crypto = require("crypto");
const { kvGet, kvSet } = require("./kv");

// 6 hours: long enough to actually pay off across a day's real traffic
// (the whole point), short enough that a stale answer — from an edit that
// didn't happen to trigger invalidation, or from an admin editing prompt/
// persona config rather than KB content — doesn't linger for days.
const TTL_SECONDS = 6 * 60 * 60;
const GEN_PREFIX = "respcache:gen:";
const ENTRY_PREFIX = "respcache:entry:";

function normalizeMessage(message) {
  return (message || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function getGeneration(tenantId) {
  const gen = await kvGet(GEN_PREFIX + tenantId);
  return typeof gen === "number" ? gen : 0;
}

async function buildKey(tenantId, message) {
  const gen = await getGeneration(tenantId);
  const hash = crypto.createHash("sha256").update(normalizeMessage(message)).digest("hex").slice(0, 32);
  return ENTRY_PREFIX + tenantId + ":" + gen + ":" + hash;
}

// Caller's responsibility to only call this for messages with no prior
// conversation history in the same session — see the file comment for why.
// Cache errors never propagate — a cache miss (real or due to a Redis
// hiccup) just means "fall through to a real KB search + LLM call", the
// same as if caching didn't exist at all.
async function getCachedResponse(tenantId, message) {
  try {
    const key = await buildKey(tenantId, message);
    return await kvGet(key);
  } catch (err) {
    return null;
  }
}

async function setCachedResponse(tenantId, message, entry) {
  try {
    const key = await buildKey(tenantId, message);
    await kvSet(key, entry, TTL_SECONDS);
  } catch (err) {
    // Fire-and-forget by design — a failed cache write is invisible to the
    // user, who already has their real, correct answer either way.
  }
}

// Call after any KB content change for a tenant (upload, batch upload,
// delete, reindex) so a cached answer can never outlive the content it was
// actually grounded in.
async function invalidateTenantCache(tenantId) {
  try {
    const gen = await getGeneration(tenantId);
    await kvSet(GEN_PREFIX + tenantId, gen + 1, 30 * 24 * 60 * 60);
  } catch (err) {
    console.error(`❌ Failed to invalidate response cache for tenant "${tenantId}":`, err.message);
  }
}

module.exports = { getCachedResponse, setCachedResponse, invalidateTenantCache };
