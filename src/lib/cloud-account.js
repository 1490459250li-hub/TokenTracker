"use strict";

// Account-aggregated (cross-device) cloud reads for the local server.
//
// The native menu-bar / tray popover talks only to the local CLI server and
// knows nothing about OAuth/JWT. To make the popover show the SAME cross-device
// totals the dashboard shows in "account view", the local server mints a
// short-lived access token from the InsForge refresh token it already relays
// (see local-api.js cookie relay) and proxies the `tokentracker-account-*` edge
// functions. Those functions mirror the local `tokentracker-usage-*` response
// schema exactly, so the popover renders the cloud payload unchanged.

const { DEFAULT_BASE_URL, DEFAULT_ANON_KEY } = require("./runtime-config");

// usage-* (local CLI) → account-* (cloud) slug map. Only these have a
// cross-device cloud equivalent; project-usage / usage-limits / category
// breakdown remain local-only and are intentionally absent here.
const USAGE_TO_ACCOUNT_SLUG = {
  "tokentracker-usage-summary": "tokentracker-account-summary",
  "tokentracker-usage-daily": "tokentracker-account-daily",
  "tokentracker-usage-hourly": "tokentracker-account-hourly",
  "tokentracker-usage-monthly": "tokentracker-account-monthly",
  "tokentracker-usage-heatmap": "tokentracker-account-heatmap",
  "tokentracker-usage-model-breakdown": "tokentracker-account-model-breakdown",
};

function accountSlugFor(usageSlug) {
  return USAGE_TO_ACCOUNT_SLUG[usageSlug] || null;
}

// Mirror of dashboard/src/contexts/InsforgeAuthContext.jsx
// `accessTokenFromRefreshPayload`: the refresh response may put the token at the
// top level or nested under `session`, in camelCase or snake_case.
function accessTokenFromRefreshPayload(data) {
  if (!data || typeof data !== "object") return null;
  const session = data.session && typeof data.session === "object" ? data.session : null;
  const raw =
    (typeof data.accessToken === "string" && data.accessToken) ||
    (typeof data.access_token === "string" && data.access_token) ||
    (session && typeof session.accessToken === "string" && session.accessToken) ||
    (session && typeof session.access_token === "string" && session.access_token) ||
    null;
  return raw && raw.length > 0 ? raw : null;
}

function refreshTokenFromRefreshPayload(data) {
  if (!data || typeof data !== "object") return null;
  const session = data.session && typeof data.session === "object" ? data.session : null;
  const raw =
    (typeof data.refreshToken === "string" && data.refreshToken) ||
    (typeof data.refresh_token === "string" && data.refresh_token) ||
    (session && typeof session.refreshToken === "string" && session.refreshToken) ||
    (session && typeof session.refresh_token === "string" && session.refresh_token) ||
    null;
  return raw && raw.length > 0 ? raw : null;
}

function decodeJwtExpMs(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return 0;
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json);
    if (payload && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    /* ignore */
  }
  return 0;
}

// Module-level access-token cache, keyed by the cloud base URL and refresh token
// that produced it.
// The popover polls frequently, so caching avoids hammering /api/auth/refresh.
let tokenCache = { cacheKey: null, accessToken: null, expMs: 0 };

// In-flight refresh de-duplication ("single flight"), keyed the same way as
// `tokenCache`. A full popover refresh fires six account reads concurrently; on
// a cold cache every one of them used to POST /api/auth/refresh with the SAME
// refresh token. When the backend rotates refresh tokens, the losers of that
// race present an already-consumed token and fail — which is exactly the
// intermittent "Activity silently dropped to this-machine data" symptom.
const mintInflight = new Map();

function __resetCloudAccountCacheForTests() {
  tokenCache = { cacheKey: null, accessToken: null, expMs: 0 };
  mintInflight.clear();
}

// Failure classes surfaced to local-api so it can tell an intentional local
// view ("signed out", "cloud sync off") apart from a temporary cloud outage.
class AccountAuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "AccountAuthError";
    this.code = code;
  }
}

function csrfTokenFromRefreshPayload(data) {
  if (!data || typeof data !== "object") return null;
  const raw =
    (typeof data.csrfToken === "string" && data.csrfToken) ||
    (typeof data.csrf_token === "string" && data.csrf_token) ||
    null;
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Perform the actual refresh POST. Throws a classified `AccountAuthError` on
 * every failure so callers can distinguish a transient outage (timeout,
 * offline, rotated-token rejection) from an intentionally local view.
 */
async function performMint({ root, cacheKey, anonKey, refreshToken, fetchImpl, now, timeoutMs }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (anonKey) headers.apikey = anonKey;

  let timeoutId;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;

  if (controller && timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  }

  let res;
  try {
    res = await fetchImpl(`${root}/api/auth/refresh?client_type=mobile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal,
    });
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    throw new AccountAuthError(
      aborted ? "auth_timeout" : "auth_network",
      e?.message || "token refresh failed",
    );
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
  if (!res || !res.ok) {
    const err = new AccountAuthError(
      "auth_rejected",
      `token refresh failed with HTTP ${res ? res.status : "?"}`,
    );
    err.status = res ? res.status : 0;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    throw new AccountAuthError("auth_invalid", e?.message || "token refresh returned invalid JSON");
  }

  const accessToken = accessTokenFromRefreshPayload(data);
  if (!accessToken) {
    throw new AccountAuthError("auth_invalid", "token refresh returned no access token");
  }

  const expMs = decodeJwtExpMs(accessToken) || now() + 10 * 60_000;
  tokenCache = { cacheKey, accessToken, expMs };

  const rotated = refreshTokenFromRefreshPayload(data);
  return {
    accessToken,
    refreshToken: rotated && rotated !== refreshToken ? rotated : null,
    // Rotating the refresh token can invalidate the csrf token paired with the
    // previous session state. Surface the fresh one so the caller can keep the
    // relayed (refresh, csrf) pair in sync — a stale relayed csrf breaks the
    // dashboard's cookie-path refresh with 403 Invalid CSRF.
    csrfToken: csrfTokenFromRefreshPayload(data),
  };
}

/**
 * Mint (or reuse a cached) InsForge access token from a refresh token.
 *
 * Concurrent callers with the same (baseUrl, refreshToken) share ONE in-flight
 * refresh; see `mintInflight`.
 *
 * @param {boolean} [throwOnFailure] when true, reject with a classified
 *   `AccountAuthError` instead of resolving to `null`.
 * @returns {Promise<{accessToken: string, refreshToken: string|null, csrfToken: string|null}|null>}
 *   null when no refresh token is available or the refresh failed.
 */
async function mintAccessToken({
  baseUrl,
  anonKey,
  refreshToken,
  fetchImpl = fetch,
  now = Date.now,
  skewMs = 60_000,
  timeoutMs,
  throwOnFailure = false,
} = {}) {
  if (!refreshToken) {
    if (throwOnFailure) throw new AccountAuthError("auth_missing_refresh_token", "not signed in");
    return null;
  }
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const cacheKey = `${root}\0${refreshToken}`;
  if (
    tokenCache.cacheKey === cacheKey &&
    tokenCache.accessToken &&
    tokenCache.expMs - skewMs > now()
  ) {
    return { accessToken: tokenCache.accessToken, refreshToken: null, csrfToken: null };
  }

  let inflight = mintInflight.get(cacheKey);
  if (!inflight) {
    inflight = performMint({ root, cacheKey, anonKey, refreshToken, fetchImpl, now, timeoutMs })
      .finally(() => {
        // Only clear our own entry: a later caller may already have started a
        // fresh mint after this one settled.
        if (mintInflight.get(cacheKey) === inflight) mintInflight.delete(cacheKey);
      });
    mintInflight.set(cacheKey, inflight);
  }

  try {
    return await inflight;
  } catch (e) {
    if (throwOnFailure) throw e;
    return null;
  }
}

/**
 * GET a `tokentracker-account-*` edge function, forwarding the popover's query
 * params (minus `account`/`scope`, which are local-only routing knobs).
 */
async function fetchAccountFunction({
  baseUrl,
  anonKey,
  accessToken,
  slug,
  searchParams,
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = new URL(`${root}/functions/${slug}`);
  if (searchParams && typeof searchParams.entries === "function") {
    for (const [key, value] of searchParams.entries()) {
      if (key === "account" || key === "scope") continue;
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }
  const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}` };
  if (anonKey) headers.apikey = anonKey;

  let timeoutId;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;

  if (controller && timeoutMs && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  }

  try {
    const res = await fetchImpl(url.toString(), { method: "GET", headers, signal });
    if (!res || !res.ok) {
      const err = new Error(`Account fetch failed with HTTP ${res ? res.status : "?"}`);
      err.status = res ? res.status : 0;
      throw err;
    }
    const data = await res.json();
    return data;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * High-level helper used by local-api: mint a token from `refreshToken`, then
 * fetch the cross-device aggregate matching `usageSlug`.
 *
 * @returns {Promise<{data: any, rotatedRefreshToken: string|null, rotatedCsrfToken: string|null}|null>}
 *   null when there is no cloud equivalent, no refresh token, or the refresh
 *   failed. Throws only when the account endpoint itself errors (so callers can
 *   distinguish "not signed in" from "cloud request failed").
 */
async function fetchAccountUsage({
  usageSlug,
  searchParams,
  baseUrl = DEFAULT_BASE_URL,
  anonKey = DEFAULT_ANON_KEY,
  refreshToken,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs,
} = {}) {
  const slug = accountSlugFor(usageSlug);
  if (!slug) return null;
  if (!refreshToken) return null;

  const startTime = now();
  const getRemainingTimeout = () => {
    if (!timeoutMs) return undefined;
    const elapsed = now() - startTime;
    const remaining = timeoutMs - elapsed;
    return remaining > 0 ? remaining : 1;
  };

  // `throwOnFailure` keeps "not signed in" (null, handled above) distinct from
  // "signed in but the refresh call failed" (throws) so the caller does not
  // silently downgrade an account view into a this-machine view.
  const minted = await mintAccessToken({
    baseUrl,
    anonKey,
    refreshToken,
    fetchImpl,
    now,
    timeoutMs: getRemainingTimeout(),
    throwOnFailure: true,
  });
  if (!minted) return null;

  const data = await fetchAccountFunction({
    baseUrl,
    anonKey,
    accessToken: minted.accessToken,
    slug,
    searchParams,
    fetchImpl,
    timeoutMs: getRemainingTimeout(),
  });
  return { data, rotatedRefreshToken: minted.refreshToken, rotatedCsrfToken: minted.csrfToken };
}

module.exports = {
  AccountAuthError,
  USAGE_TO_ACCOUNT_SLUG,
  accountSlugFor,
  accessTokenFromRefreshPayload,
  refreshTokenFromRefreshPayload,
  decodeJwtExpMs,
  mintAccessToken,
  fetchAccountFunction,
  fetchAccountUsage,
  __resetCloudAccountCacheForTests,
};
