import type { CloudflareEnv } from "./cloudflare-env.ts";

import { describe, expect, it } from "vitest";
import {
  createConcealmentResponse,
  hasValidServiceToken,
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
