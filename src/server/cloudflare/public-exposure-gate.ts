import type { CloudflareEnv } from "./cloudflare-env.ts";

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
