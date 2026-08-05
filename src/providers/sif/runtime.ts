import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createHash } from "node:crypto";
import { optionalRecord, requiredString } from "../../core/cast.ts";
import { providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";

export const sifMcpOrigin: string = "https://mcp.sif.com";
export const sifMcpEndpoint: string = `${sifMcpOrigin}/mcp`;
const requestTimeoutMs = 60_000;
const controlTools = new Set(["ping", "sif_catalog"]);
const validator = new CfWorkerJsonSchemaValidator();
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const businessActionNames = [
  "market_get_keyword_history",
  "market_get_keyword_demand",
  "market_get_keyword_root_trend",
  "market_get_keyword_competition",
  "market_get_keyword_root_competitors",
  "market_screen_keyword_opportunities",
  "market_discover_competitors",
  "market_get_asin_profile",
  "market_get_asin_keyword_signals",
  "market_get_asin_aba_footprint",
];

export const sifActionHandlers: Record<string, ProviderRuntimeHandler<ApiKeyProviderContext>> = {
  async list_tools(_input, context) {
    return { tools: await listBusinessTools(context) };
  },
  async call_tool(input, context) {
    const toolName = requiredString(input.toolName, "toolName", badRequest);
    const args = input.arguments === undefined ? {} : optionalRecord(input.arguments);
    if (!args) throw new ProviderRequestError(400, "arguments must be a JSON object");
    return { result: normalizeResult(await callTool(context, toolName, args)) };
  },
};
for (const actionName of businessActionNames) {
  sifActionHandlers[actionName] = async (input, context) => ({
    result: normalizeResult(await callTool(context, actionName, input)),
  });
}

export async function validateSifCredential(
  apiKey: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const tools = await listBusinessTools({ apiKey, fetcher, signal });
  if (tools.length === 0)
    throw new ProviderRequestError(502, "Sif MCP did not expose any business tools for this account");
  const hash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return {
    profile: { accountId: `sif:mcp:${hash}`, displayName: `Sif MCP · ${hash.slice(-6)}` },
    grantedScopes: [],
    metadata: { mcpEndpoint: sifMcpEndpoint, discoveredToolCount: tools.length },
  };
}

async function listBusinessTools(context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">) {
  const result = await withClient(context, (client) =>
    client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal }),
  );
  return result.tools
    .filter((tool) => !controlTools.has(tool.name))
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }));
}

async function callTool(
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">,
  toolName: string,
  args: Record<string, unknown>,
) {
  return withClient(context, (client) =>
    client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: requestTimeoutMs,
      signal: context.signal,
    }),
  );
}

async function withClient<T>(
  context: Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal">,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(sifMcpEndpoint), {
    fetch: context.fetcher,
    requestInit: { headers: { "secret-key": context.apiKey, "user-agent": providerUserAgent } },
  });
  const client = new Client({ name: "oomol-connect-sif", version: "1.0.0" }, { jsonSchemaValidator: validator });
  try {
    await client.connect(transport, { timeout: requestTimeoutMs, signal: context.signal });
    return await run(client);
  } catch (error) {
    if (error instanceof UnauthorizedError) throw new ProviderRequestError(401, "Sif MCP key is invalid or expired");
    if (error instanceof StreamableHTTPError)
      throw new ProviderRequestError(
        error.code === 429 ? 429 : error.code === 401 || error.code === 403 ? 401 : 502,
        `Sif MCP request failed: ${error.message}`,
      );
    if (error instanceof McpError) throw new ProviderRequestError(502, `Sif MCP request failed: ${error.message}`);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function normalizeResult(result: ToolResult): unknown {
  if ("toolResult" in result) return result;
  if (result.isError) throw new ProviderRequestError(502, "Sif MCP tool returned an error", result);
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") return result;
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    return text.text;
  }
}

function badRequest(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
