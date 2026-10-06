/**
 * Connection lifecycle webhook delivery.
 *
 * `OOMOL_CONNECT_WEBHOOK_URL` pushes OAuth connection-request outcomes to an
 * API consumer so it can stop polling `GET /v1/connection-requests/:id`.
 * Payloads carry identifiers only — never credentials or tokens — and
 * delivery is best-effort: failures and timeouts log while the request flow
 * continues, so consumers keep polling as the fallback and treat deliveries
 * as at-least-once (dedupe on terminal request state). Superseded requests
 * and derived states (`expired`, `reauth_required`) emit no event. See
 * docs/configuration.md, "Connection lifecycle webhooks".
 */
import type { Logger } from "./logger.ts";

import { createHmac } from "node:crypto";
import { createGuardedFetch } from "../core/guarded-fetch.ts";
import { isPrivateNetworkAccessAllowed } from "../core/request.ts";
import { randomUUIDv7 } from "../core/uuid-v7.ts";

/** Connection outcomes that emit an event; polling covers every other state. */
export type ConnectionEventType = "connection.connected" | "connection.failed";

/**
 * Identifiers describing one connection-request outcome. `appId` is set on
 * `connection.connected`; `errorCode` and `errorMessage` on
 * `connection.failed`.
 */
export interface ConnectionEventData {
  connectionRequestId: string;
  service: string;
  connectionName: string;
  owner: string;
  appId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** The delivered envelope, exactly the POST body the consumer receives. */
export interface ConnectionEvent {
  id: string;
  type: ConnectionEventType;
  occurredAt: string;
  data: ConnectionEventData;
}

/** Event handed to a dispatcher; the dispatcher stamps the delivery id and time. */
export interface ConnectionEventDispatchInput {
  type: ConnectionEventType;
  data: ConnectionEventData;
}

/** Pushes connection lifecycle outcomes; delivery failures never throw. */
export interface ConnectionEventDispatcher {
  dispatch(event: ConnectionEventDispatchInput): Promise<void>;
}

export interface ConnectionEventDispatcherOptions {
  /** Endpoint receiving the POST delivery. */
  url: string;
  /** HMAC-SHA256 signing secret; deliveries without one are signed `sha256=unsigned`. */
  secret?: string;
  /** Base transport; defaults to the shared SSRF-guarded fetch. Tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Sink for best-effort delivery failures. */
  logger?: Logger;
}

/** Whole-delivery budget; see docs/configuration.md. */
const deliveryTimeoutMs = 5_000;

export function createConnectionEventDispatcher(options: ConnectionEventDispatcherOptions): ConnectionEventDispatcher {
  // The webhook host is deployment-configured, not user input, so it gets the
  // shared public-URL guard with the deployment's private-network opt-in — the
  // same posture as a self-hosted provider instance host.
  const fetchImpl = createGuardedFetch({
    fetch: options.fetchImpl,
    allowPrivateNetwork: () => isPrivateNetworkAccessAllowed(),
  });
  return {
    async dispatch(event: ConnectionEventDispatchInput): Promise<void> {
      const envelope: ConnectionEvent = {
        id: `evt_${randomUUIDv7()}`,
        type: event.type,
        occurredAt: new Date().toISOString(),
        data: event.data,
      };
      const body = JSON.stringify(envelope);
      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-oomol-connect-event": envelope.type,
            "x-oomol-connect-delivery": envelope.id,
            "x-oomol-connect-signature": connectionEventSignature(body, options.secret),
          },
          body,
          signal: AbortSignal.timeout(deliveryTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`the endpoint responded with HTTP ${response.status}`);
        }
      } catch (error) {
        options.logger?.warn(
          { deliveryId: envelope.id, eventType: envelope.type, err: error },
          "connection event delivery failed",
        );
      }
    },
  };
}

export interface ResolveConnectionEventDispatcherOptions {
  /** `OOMOL_CONNECT_WEBHOOK_URL`; unset or empty disables delivery. */
  url?: string;
  /** `OOMOL_CONNECT_WEBHOOK_SECRET`. */
  secret?: string;
  logger?: Logger;
}

/**
 * Resolve the deployment's webhook dispatcher from the
 * `OOMOL_CONNECT_WEBHOOK_*` environment values, or undefined when no URL is
 * configured and delivery is off.
 */
export function resolveConnectionEventDispatcher(
  options: ResolveConnectionEventDispatcherOptions,
): ConnectionEventDispatcher | undefined {
  if (!options.url) {
    return undefined;
  }
  return createConnectionEventDispatcher({ url: options.url, secret: options.secret, logger: options.logger });
}

/** `sha256=<hex HMAC-SHA256 of the raw body>` under the secret, `sha256=unsigned` without one. */
function connectionEventSignature(body: string, secret: string | undefined): string {
  if (!secret) {
    return "sha256=unsigned";
  }
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
