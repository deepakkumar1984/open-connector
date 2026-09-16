import type { CloudflareEnv } from "./cloudflare-env.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRuntimeToken } from "../storage/runtime-token-service.ts";
import {
  createConcealmentResponse,
  hasValidServiceToken,
  hasValidServiceTokenAsync,
  isAnonymousPublicAllowed,
  shouldHidePublicSurface,
} from "./public-exposure-gate.ts";

const env = (overrides: Partial<CloudflareEnv> = {}): CloudflareEnv =>
  ({
    OOMOL_CONNECT_PUBLIC_EXPOSURE: "hidden",
    OOMOL_CONNECT_ADMIN_TOKEN: "stage-zero-admin-token",
    OOMOL_CONNECT_RUNTIME_TOKEN: "stage-zero-runtime-token",
    ...overrides,
  }) as CloudflareEnv;

const requestWithToken = (token?: string): Request =>
  new Request("https://connector.example.test/v1/health", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

/** Minimal D1 stub counting token-hash lookups. */
function stubDb(options: { foundHashes?: Set<string>; fail?: boolean; counter?: { count: number } }) {
  return {
    prepare: (_query: string) => ({
      bind: (hash: string) => ({
        first: async () => {
          if (options.counter) options.counter.count += 1;
          if (options.fail) throw new Error("d1 unavailable");
          return options.foundHashes?.has(hash) ? { id: "tok-1" } : null;
        },
      }),
    }),
  };
}

describe("public exposure gate", () => {
  it("is opt-in and only hides the hidden profile", () => {
    expect(shouldHidePublicSurface(env())).toBe(true);
    expect(shouldHidePublicSurface(env({ OOMOL_CONNECT_PUBLIC_EXPOSURE: "public" }))).toBe(false);
    expect(shouldHidePublicSurface(env({ OOMOL_CONNECT_PUBLIC_EXPOSURE: undefined }))).toBe(false);
  });

  it("only permits anonymous GET requests to the OAuth callback", () => {
    expect(isAnonymousPublicAllowed("GET", "/oauth/callback")).toBe(true);
    expect(isAnonymousPublicAllowed("GET", "/oauth/callback/provider")).toBe(false);
    expect(isAnonymousPublicAllowed("POST", "/oauth/callback")).toBe(false);
    expect(isAnonymousPublicAllowed("GET", "/health")).toBe(false);
  });

  it("accepts the exact admin or runtime bearer token", () => {
    for (const token of ["stage-zero-admin-token", "stage-zero-runtime-token"]) {
      const request = new Request("https://connector.example.test/v1/health", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(hasValidServiceToken(request, env())).toBe(true);
    }

    expect(
      hasValidServiceToken(
        new Request("https://connector.example.test/v1/health", {
          headers: { authorization: "Bearer stage-zero-runtime-token-wrong" },
        }),
        env(),
      ),
    ).toBe(false);
    expect(hasValidServiceToken(new Request("https://connector.example.test/v1/health"), env())).toBe(false);
  });

  it("returns a non-cacheable, branding-free concealment response", async () => {
    const response = createConcealmentResponse();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Not Found");
  });
});

describe("persistent runtime tokens at the gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts env service tokens without touching D1", async () => {
    const counter = { count: 0 };
    const workerEnv = env({ DB: stubDb({ counter }) as never });
    for (const token of ["stage-zero-admin-token", "stage-zero-runtime-token"]) {
      expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(true);
    }
    expect(counter.count).toBe(0);
  });

  it("accepts stored persistent tokens and caches the verdict per isolate", async () => {
    const token = `oct_${crypto.randomUUID().replace(/-/g, "")}-accept`;
    const counter = { count: 0 };
    const workerEnv = env({
      DB: stubDb({ foundHashes: new Set([hashRuntimeToken(token)]), counter }) as never,
    });
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(true);
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(true);
    expect(counter.count).toBe(1);
  });

  it("rejects unknown persistent tokens without repeated lookups", async () => {
    const token = `oct_${crypto.randomUUID().replace(/-/g, "")}-unknown`;
    const counter = { count: 0 };
    const workerEnv = env({ DB: stubDb({ foundHashes: new Set(), counter }) as never });
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(false);
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(false);
    expect(counter.count).toBe(1);
  });

  it("skips D1 for non-runtime-token bearers", async () => {
    const counter = { count: 0 };
    const workerEnv = env({ DB: stubDb({ counter }) as never });
    expect(await hasValidServiceTokenAsync(requestWithToken("not-a-runtime-token"), workerEnv)).toBe(false);
    expect(await hasValidServiceTokenAsync(requestWithToken(), workerEnv)).toBe(false);
    expect(counter.count).toBe(0);
  });

  it("fails closed when D1 errors, without caching the outage", async () => {
    const token = `oct_${crypto.randomUUID().replace(/-/g, "")}-outage`;
    const counter = { count: 0 };
    const failing = env({ DB: stubDb({ fail: true, counter }) as never });
    expect(await hasValidServiceTokenAsync(requestWithToken(token), failing)).toBe(false);
    const recovered = env({
      DB: stubDb({ foundHashes: new Set([hashRuntimeToken(token)]), counter }) as never,
    });
    expect(await hasValidServiceTokenAsync(requestWithToken(token), recovered)).toBe(true);
    expect(counter.count).toBe(2);
  });

  it("re-checks revoked tokens after the cache TTL", async () => {
    vi.useFakeTimers();
    const token = `oct_${crypto.randomUUID().replace(/-/g, "")}-revoke`;
    const foundHashes = new Set([hashRuntimeToken(token)]);
    const workerEnv = env({ DB: stubDb({ foundHashes }) as never });
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(true);
    foundHashes.clear();
    // Still cached: documented revocation lag.
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await hasValidServiceTokenAsync(requestWithToken(token), workerEnv)).toBe(false);
  });
});
