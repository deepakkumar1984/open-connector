import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { ImaRuntimeContext } from "./runtime.ts";

import { defineProviderExecutors, ProviderRequestError, requireCustomCredential } from "../provider-runtime.ts";
import { imaActionHandlers, validateImaCredential } from "./runtime.ts";

const service = "ima";

export const executors: ProviderExecutors = defineProviderExecutors<ImaRuntimeContext>({
  service,
  handlers: imaActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<ImaRuntimeContext> {
    const credential = await requireCustomCredential(context, service);
    const clientId = credential.values.clientId;
    const apiKey = credential.values.apiKey;
    if (!clientId || !apiKey) {
      throw new ProviderRequestError(401, "Configure ima clientId and apiKey credentials first.");
    }
    const runtimeContext: ImaRuntimeContext = {
      clientId,
      apiKey,
      fetcher,
      signal: context.signal,
    };
    if (context.transitFiles) {
      runtimeContext.transitFiles = context.transitFiles;
    }
    return runtimeContext;
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }) {
    return validateImaCredential(input.values, { fetcher, signal });
  },
};
