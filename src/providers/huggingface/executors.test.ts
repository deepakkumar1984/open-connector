import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyCredential } from "../provider-proxy-loader.test-helpers.ts";
import { executors } from "./executors.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hugging Face executors", () => {
  it("executes current user requests with API key credentials", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({
            id: "user-1",
            name: "ada",
            fullname: "Ada Lovelace",
            email: "ada@example.com",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetcher);

    const result = await executors["huggingface.get_current_user"]?.(
      {},
      {
        getCredential: async () => apiKeyCredential("hf-token"),
      },
    );

    expect(result).toEqual({
      ok: true,
      output: {
        id: "user-1",
        preferredUsername: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        profileUrl: "https://huggingface.co/ada",
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://huggingface.co/api/whoami-v2",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer hf-token",
        }),
      }),
    );
  });
});
