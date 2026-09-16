import type { CloudflareEnv } from "./cloudflare-env.ts";

import { hashRuntimeToken } from "../storage/runtime-token-service.ts";

/**
 * Opt-in gate that conceals the public surface of the Worker.
 *
 * When enabled (env.OOMOL_CONNECT_PUBLIC_EXPOSURE === "hidden"), only the
 * anonymous-public allowlist and requests carrying a valid service token reach
 * the app. Every other anonymous request is answered with a bare 404 that
 * reveals no branding, and never falls through to env.ASSETS.
 */

const bearerPrefix = "Bearer ";

export function shouldHidePublicSurface(env: CloudflareEnv): boolean {
  return env.OOMOL_CONNECT_PUBLIC_EXPOSURE === "hidden";
}

/**
 * Paths that must stay anonymously reachable even when the gate is enabled.
 * This mirrors the auth.ts public-path exemption for the OAuth callback, which
 * the OAuth provider redirects the user's browser to with no Bearer token.
 */
export function isAnonymousPublicAllowed(method: string, pathname: string): boolean {
  if (method !== "GET") {
    return false;
  }

  return pathname === "/oauth/callback";
}

export function hasValidServiceToken(request: Request, env: CloudflareEnv): boolean {
  const token = readBearerToken(request);
  if (!token) {
    return false;
  }

  const adminToken = normalizeToken(env.OOMOL_CONNECT_ADMIN_TOKEN);
  if (adminToken && constantTimeEqual(token, adminToken)) {
    return true;
  }

  const runtimeToken = normalizeToken(env.OOMOL_CONNECT_RUNTIME_TOKEN);
  if (runtimeToken && constantTimeEqual(token, runtimeToken)) {
    return true;
  }

  return false;
}

/**
 * Persistent runtime tokens (`oct_…`) also pass the gate: the hash lookup is
 * one indexed D1 read, cached per isolate for 60s. Revocation therefore lags
 * by up to the TTL — the app layer still enforces the token's full policy on
 * every request. D1 outages fail closed without caching the outage.
 */
const persistentTokenPrefix = "oct_";
const persistentTokenCacheTtlMs = 60_000;
const persistentTokenCacheMaxEntries = 1000;
const persistentTokenCache = new Map<string, { ok: boolean; expiresAt: number }>();

export async function hasValidServiceTokenAsync(request: Request, env: CloudflareEnv): Promise<boolean> {
  if (hasValidServiceToken(request, env)) {
    return true;
  }

  const token = readBearerToken(request);
  if (!token || !token.startsWith(persistentTokenPrefix) || !env.DB) {
    return false;
  }

  const hash = hashRuntimeToken(token);
  const now = Date.now();
  const cached = persistentTokenCache.get(hash);
  if (cached && cached.expiresAt > now) {
    return cached.ok;
  }

  let ok: boolean;
  try {
    const row = await env.DB.prepare("select id from runtime_tokens where token_hash = ?").bind(hash).first();
    ok = row != null;
  } catch {
    return false;
  }
  if (persistentTokenCache.size >= persistentTokenCacheMaxEntries) {
    for (const [key, entry] of persistentTokenCache) {
      if (entry.expiresAt <= now) persistentTokenCache.delete(key);
    }
    if (persistentTokenCache.size >= persistentTokenCacheMaxEntries) persistentTokenCache.clear();
  }
  persistentTokenCache.set(hash, { ok, expiresAt: now + persistentTokenCacheTtlMs });
  return ok;
}

export function createConcealmentResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith(bearerPrefix) ? normalizeToken(authorization.slice(bearerPrefix.length)) : undefined;
}

function normalizeToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value ? value : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
