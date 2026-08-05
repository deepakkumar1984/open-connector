import type { CredentialValidationResult } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createHash } from "node:crypto";
import { optionalRecord, requiredString } from "../../core/cast.ts";
import { providerUserAgent, ProviderRequestError } from "../provider-runtime.ts";

export const helium10McpEndpoint = "https://mcp.helium10.com/mcp";
const requestTimeoutMs = 30_000;
const validator = new CfWorkerJsonSchemaValidator();
const readOnlyTools = new Set([
  "get_keywords_by_keyword",
  "get_keywords_by_asin",
  "compare_asin_keywords",
  "analyze_keywords",
  "list_my_products",
  "search_inactive_products",
  "get_listing_details",
  "get_listing_score",
  "compare_listings",
  "get_keywords_rank_history",
  "get_keywords_new_suggestion",
  "list_tracked_keywords",
  "list_tracked_competitor_keywords",
  "get_account_profit_and_loss_summary",
  "get_account_profit_and_loss_summary_series",
  "get_account_profit_and_loss_breakdown",
  "get_account_profit_and_loss_breakdown_series",
  "get_product_profit_and_loss_summary",
  "get_product_profit_and_loss_summary_series",
  "get_product_profit_and_loss_breakdown",
  "get_product_profit_and_loss_breakdown_series",
  "get_sales_velocity",
  "get_inventory_values",
  "get_fba_inventory_health_status",
  "get_search_query_performance",
  "get_brand_seller_profiles",
  "get_ads_query_platforms",
  "get_ads_query_list",
  "get_ads_query_schema",
  "get_ads_query_materials",
  "execute_ads_query",
  "get_top_keywords",
  "search_amazon_keywords",
  "get_competitor_overview",
]);

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

export const helium10ActionHandlers: Record<string, ProviderRuntimeHandler<OAuthProviderContext>> = {
  async list_tools(_input, context) {
    const tools = await listTools(context);
    return {
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    };
  },
  async call_tool(input, context) {
    const toolName = requiredString(input.toolName, "toolName", badRequest);
    const args = input.arguments === undefined ? {} : optionalRecord(input.arguments);
    if (!args) throw new ProviderRequestError(400, "arguments must be a JSON object");
    if (!readOnlyTools.has(toolName)) {
      throw new ProviderRequestError(400, `Helium 10 MCP tool is not approved for read-only access: ${toolName}`);
    }
    const tool = (await listTools(context)).find((candidate) => candidate.name === toolName);
    if (!tool) throw new ProviderRequestError(400, `Helium 10 MCP tool is not available for this account: ${toolName}`);
    validateArguments(tool, args);
    const result = await withClient(context, (client) =>
      client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: requestTimeoutMs,
        signal: context.signal,
      }),
    );
    return { result: normalizeResult(result) };
  },
};

export async function validateHelium10Credential(
  accessToken: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const tools = await listTools({ accessToken, fetcher, signal });
  if (tools.length === 0) throw new ProviderRequestError(502, "Helium 10 MCP did not expose any approved tools");
  const tokenHash = createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
  return {
    profile: { accountId: `helium10:mcp:${tokenHash}`, displayName: `Helium 10 MCP · ${tokenHash.slice(-6)}` },
    grantedScopes: ["mcp:tools"],
    metadata: { mcpEndpoint: helium10McpEndpoint, availableTools: tools.map((tool) => tool.name) },
  };
}

async function listTools(context: Pick<OAuthProviderContext, "accessToken" | "fetcher" | "signal">): Promise<Tool[]> {
  const result = await withClient(context, (client) =>
    client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal }),
  );
  return result.tools.filter((tool) => readOnlyTools.has(tool.name));
}

async function withClient<T>(
  context: Pick<OAuthProviderContext, "accessToken" | "fetcher" | "signal">,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(helium10McpEndpoint), {
    fetch: context.fetcher,
    requestInit: { headers: { authorization: `Bearer ${context.accessToken}`, "user-agent": providerUserAgent } },
  });
  const client = new Client({ name: "oomol-connect-helium10", version: "1.0.0" }, { jsonSchemaValidator: validator });
  try {
    await client.connect(transport, { timeout: requestTimeoutMs, signal: context.signal });
    return await run(client);
  } catch (error) {
    if (error instanceof UnauthorizedError)
      throw new ProviderRequestError(401, "Helium 10 authorization is invalid or expired");
    if (error instanceof StreamableHTTPError)
      throw new ProviderRequestError(
        error.code === 429 ? 429 : error.code === 401 || error.code === 403 ? 401 : 502,
        `Helium 10 MCP request failed: ${error.message}`,
      );
    if (error instanceof McpError)
      throw new ProviderRequestError(502, `Helium 10 MCP request failed: ${error.message}`);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function validateArguments(tool: Tool, args: Record<string, unknown>): void {
  const result = validator.getValidator<Record<string, unknown>>(tool.inputSchema as JsonSchemaType)(args);
  if (!result.valid)
    throw new ProviderRequestError(
      400,
      `Invalid arguments for Helium 10 MCP tool ${tool.name}: ${result.errorMessage}`,
    );
}

function normalizeResult(result: ToolResult): unknown {
  if ("toolResult" in result) return result;
  if (result.isError) throw new ProviderRequestError(502, "Helium 10 MCP tool returned an error", result);
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
