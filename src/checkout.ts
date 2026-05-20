import { getBearerToken } from './auth.js';
import { UCP_AGENT_PROFILE } from './ucp-config.js';
import { getBuyerIp, getUserAgent } from './request-context.js';

// Build UCP signals object for outgoing checkout payloads.
// Spec: ucp.dev — Signals is a top-level field of `checkout` (sibling of
// line_items, buyer, fulfillment, payment). Shopify rejects create_checkout
// without `dev.ucp.buyer_ip` even though its error message frames it as a
// missing HTTP header. Keys are dotted reverse-domain literals per the spec.
function buildSignals(): Record<string, string> | undefined {
  const buyerIp = getBuyerIp();
  const userAgent = getUserAgent();
  const signals: Record<string, string> = {};
  if (buyerIp) signals['dev.ucp.buyer_ip'] = buyerIp;
  if (userAgent) signals['dev.ucp.user_agent'] = userAgent;
  return Object.keys(signals).length > 0 ? signals : undefined;
}

// Thrown when a shop's /.well-known/ucp manifest is absent or missing the
// shopping service. Lets callers (e.g. server.ts) surface a clear
// "shop has not enabled UCP" message instead of bubbling up a raw HTTP code.
export class UcpNotSupportedError extends Error {
  constructor(public shopDomain: string, public reason: string) {
    super(`Shop ${shopDomain} has not enabled UCP Checkout MCP (${reason})`);
    this.name = 'UcpNotSupportedError';
  }
}

// Cache resolved endpoints in-memory so repeat calls in the same process
// don't re-fetch the manifest. Shops rarely change their UCP routing.
const endpointCache = new Map<string, string>();

// Strip protocol/path and return the bare host (e.g. "pojstudio.com").
function normalizeHost(input: string): string {
  return input.replace(/^https?:\/\//, '').split('/')[0];
}

// Resolve the canonical Checkout MCP endpoint via /.well-known/ucp.
//
// Why this exists: Catalog MCP often surfaces a shop's public custom domain
// (e.g. pojstudio.com), but the /api/ucp/mcp route is canonically hosted on
// the *.myshopify.com domain (e.g. pieces-of-japan.myshopify.com). The
// UCP spec defines /.well-known/ucp on the public domain as the discovery
// document that points to the actual endpoint, so we resolve it before
// every Checkout MCP call (cached after the first hit).
//
// Behavior:
//   manifest present  → use services["dev.ucp.shopping"][0].endpoint
//   manifest 404      → throw UcpNotSupportedError (shop hasn't enabled UCP)
//   network/timeout   → fall back to the naive heuristic so a flaky DNS
//                       lookup doesn't take the whole checkout flow down
export async function resolveCheckoutMcpUrl(shopDomain: string): Promise<string> {
  const host = normalizeHost(shopDomain);
  const cached = endpointCache.get(host);
  if (cached) return cached;

  const manifestUrl = `https://${host}/.well-known/ucp`;
  let response: Response;
  try {
    // Short timeout: discovery shouldn't block checkout flow indefinitely.
    response = await fetch(manifestUrl, {
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
  } catch (err) {
    console.error(`[checkout] /.well-known/ucp fetch failed for ${host}:`, err);
    // Network error — degrade to naive heuristic rather than failing hard.
    const fallback = `https://${host.includes('.') ? host : `${host}.myshopify.com`}/api/ucp/mcp`;
    endpointCache.set(host, fallback);
    return fallback;
  }

  if (response.status === 404) {
    throw new UcpNotSupportedError(host, 'no /.well-known/ucp manifest');
  }
  if (!response.ok) {
    console.error(`[checkout] /.well-known/ucp returned ${response.status} for ${host}`);
    const fallback = `https://${host.includes('.') ? host : `${host}.myshopify.com`}/api/ucp/mcp`;
    endpointCache.set(host, fallback);
    return fallback;
  }

  let manifest: {
    ucp?: {
      services?: {
        'dev.ucp.shopping'?: Array<{ transport?: string; endpoint?: string }>;
      };
    };
  };
  try {
    manifest = (await response.json()) as typeof manifest;
  } catch (err) {
    console.error(`[checkout] /.well-known/ucp JSON parse failed for ${host}:`, err);
    throw new UcpNotSupportedError(host, 'malformed manifest');
  }

  const services = manifest?.ucp?.services?.['dev.ucp.shopping'] ?? [];
  // Pick the MCP transport entry — UCP may advertise multiple transports
  // (mcp, embedded, etc.); we only speak MCP here.
  const mcpService = services.find((s) => s.transport === 'mcp' && s.endpoint);
  if (!mcpService?.endpoint) {
    throw new UcpNotSupportedError(host, 'manifest has no dev.ucp.shopping MCP endpoint');
  }

  endpointCache.set(host, mcpService.endpoint);
  console.error(`[checkout] resolved ${host} → ${mcpService.endpoint}`);
  return mcpService.endpoint;
}

let requestId = 0;

async function callCheckoutMcp(
  shopDomain: string,
  toolName: string,
  args: Record<string, unknown>
) {
  const token = await getBearerToken();
  // resolveCheckoutMcpUrl throws UcpNotSupportedError if /.well-known/ucp
  // is missing — callers (server.ts) translate that to the buyer-facing
  // "shop has not enabled UCP" message.
  const url = await resolveCheckoutMcpUrl(shopDomain);

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: ++requestId,
  };

  // Shopify Checkout MCP rejects requests with `AuthenticationFailed:
  // Missing required buyer IP header.` when the buyer IP is absent.
  // The exact header name isn't documented for Checkout MCP, so send
  // every plausible candidate at once — Shopify ignores unknown headers
  // and logs will tell us which one it actually honors. Mirror Shopify's
  // own Storefront API convention plus standard proxy/forwarding names.
  const buyerIp = getBuyerIp();
  const userAgent = getUserAgent();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (buyerIp) {
    headers['Shopify-Storefront-Buyer-IP'] = buyerIp;
    headers['Shopify-Buyer-IP'] = buyerIp;
    headers['X-Forwarded-For'] = buyerIp;
    headers['X-Real-IP'] = buyerIp;
    headers['Buyer-IP'] = buyerIp;
  }
  if (userAgent) headers['User-Agent'] = userAgent;

  // Full request dump so we can verify what Shopify actually receives —
  // matches the [catalog] args pattern from catalog.ts.
  console.error(`[checkout] ${toolName} -> ${url}`);
  console.error(`[checkout] ${toolName} headers:`, JSON.stringify(headers));
  console.error(`[checkout] ${toolName} body:`, JSON.stringify(body));

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Echo Shopify's response headers (and status) — sometimes Shopify
  // includes hints like 'x-required-headers' or 'www-authenticate' that
  // pinpoint the exact field they expected.
  const respHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });
  console.error(
    `[checkout] ${toolName} response: status=${response.status}`,
    JSON.stringify(respHeaders)
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Checkout MCP error (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    result?: {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`Checkout MCP tool error: ${json.error.message}`);
  }

  // Prefer structuredContent as per Shopify docs, fall back to text content
  if (json.result?.structuredContent) {
    return json.result.structuredContent;
  }

  const textContent = json.result?.content?.find((c) => c.type === 'text');
  if (textContent) {
    return JSON.parse(textContent.text);
  }

  throw new Error('No content in Checkout MCP response');
}

// UCP spec: line_items use item.id (not variant_id at top level)
export interface LineItem {
  variant_id: string;   // kept for caller convenience; mapped to item.id in request
  quantity: number;
}

export interface BuyerInfo {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

// UCP spec uses schema.org-style address fields
export interface Address {
  first_name?: string;
  last_name?: string;
  street_address: string;       // maps to street_address (not address1)
  address2?: string;
  address_locality: string;     // city
  address_region?: string;      // state/province
  postal_code: string;          // zip
  address_country: string;      // 2-letter ISO country code
  phone?: string;
}

export interface FulfillmentInfo {
  destinations?: Address[];
  shipping_method_handle?: string;
}

// Convert LineItem[] to UCP spec format: [{ quantity, item: { id } }]
function toUcpLineItems(items: LineItem[]): unknown[] {
  return items.map((li) => ({
    quantity: li.quantity,
    item: { id: li.variant_id },
  }));
}

// Build fulfillment object per UCP spec
function toUcpFulfillment(info: FulfillmentInfo): unknown {
  const result: Record<string, unknown> = {};
  if (info.destinations && info.destinations.length > 0) {
    result.methods = [{ type: 'shipping', destinations: info.destinations }];
  }
  if (info.shipping_method_handle) {
    result.shipping_method_handle = info.shipping_method_handle;
  }
  return result;
}

export async function createCheckout(
  shopDomain: string,
  params: {
    currency: string;
    line_items: LineItem[];
    buyer?: BuyerInfo;
    fulfillment?: FulfillmentInfo;
  }
) {
  const signals = buildSignals();
  const args: Record<string, unknown> = {
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout: {
      currency: params.currency,
      line_items: toUcpLineItems(params.line_items),
      ...(params.buyer && { buyer: params.buyer }),
      ...(params.fulfillment && { fulfillment: toUcpFulfillment(params.fulfillment) }),
      ...(signals && { signals }),
    },
  };

  return callCheckoutMcp(shopDomain, 'create_checkout', args);
}

// UCP update_checkout uses PUT semantics: the request body fully replaces
// the checkout state. Any field omitted from the payload is dropped.
// To preserve fields not being changed, we fetch current state with
// get_checkout and merge the diff before submitting.
export async function getCheckout(shopDomain: string, checkoutId: string) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
  };

  return callCheckoutMcp(shopDomain, 'get_checkout', args);
}

// Fields update_checkout accepts in the `checkout` body (UCP spec).
// Anything else returned by get_checkout (`ucp` capabilities, `messages`,
// `totals`, `expires_at`, `links`, `status`, `continue_url`, ...) is
// response-only metadata — echoing it back triggers `Invalid params`.
const WRITABLE_CHECKOUT_FIELDS = [
  'currency',
  'line_items',
  'buyer',
  'fulfillment',
  'payment',
  'signals',
] as const;

// Strip computed fulfillment subfields (`groups`, `line_item_ids`,
// per-destination computed IDs, etc.) so we only send the writable shape:
// `methods[]` and `shipping_method_handle`.
function sanitizeFulfillment(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(src.methods)) out.methods = src.methods;
  if (typeof src.shipping_method_handle === 'string') {
    out.shipping_method_handle = src.shipping_method_handle;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Apply the buyer's name/phone to any destination that doesn't already
// specify them. Shopify returns recoverable `delivery_first_name_required`
// / `delivery_last_name_required` / `delivery_phone_number_required` errors
// otherwise — UCP keeps buyer identity and shipping recipient as separate
// fields, but in agent commerce they're almost always the same person.
function mirrorBuyerToDestinations(
  fulfillment: Record<string, unknown> | undefined,
  buyer: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fulfillment || !buyer) return fulfillment;
  const methods = fulfillment.methods;
  if (!Array.isArray(methods)) return fulfillment;
  const patchedMethods = methods.map((method) => {
    if (!method || typeof method !== 'object') return method;
    const m = method as Record<string, unknown>;
    const destinations = m.destinations;
    if (!Array.isArray(destinations)) return method;
    const patched = destinations.map((d) => {
      if (!d || typeof d !== 'object') return d;
      const dest = d as Record<string, unknown>;
      const next = { ...dest };
      if (!next.first_name && buyer.first_name) next.first_name = buyer.first_name;
      if (!next.last_name && buyer.last_name) next.last_name = buyer.last_name;
      if (!next.phone && buyer.phone) next.phone = buyer.phone;
      return next;
    });
    return { ...m, destinations: patched };
  });
  return { ...fulfillment, methods: patchedMethods };
}

// Merge incoming changes into the existing checkout payload from get_checkout.
// Returns the merged checkout object to send to update_checkout.
//
// Critical: we copy only WRITABLE_CHECKOUT_FIELDS from `existing`. Spreading
// the whole get_checkout response back into update_checkout causes Shopify
// to reject the call with `Invalid params` (response-only fields like `ucp`,
// `messages`, `totals`, `status`, `continue_url` are not accepted as input).
function mergeCheckout(
  existing: Record<string, unknown> | undefined,
  updates: {
    buyer?: BuyerInfo;
    fulfillment?: FulfillmentInfo;
    line_items?: LineItem[];
  }
): Record<string, unknown> {
  const base = existing ?? {};
  const merged: Record<string, unknown> = {};

  // Whitelist copy from previous state.
  for (const key of WRITABLE_CHECKOUT_FIELDS) {
    if (base[key] !== undefined) merged[key] = base[key];
  }
  // discounts: only `codes` is writable; `applied` is computed.
  if (base.discounts && typeof base.discounts === 'object') {
    const codes = (base.discounts as Record<string, unknown>).codes;
    if (codes !== undefined) merged.discounts = { codes };
  }
  // Sanitize any prior fulfillment so we don't ship computed subfields back.
  const sanitized = sanitizeFulfillment(merged.fulfillment);
  if (sanitized) merged.fulfillment = sanitized;
  else delete merged.fulfillment;

  // line_items: full replacement when supplied (caller already builds the full list)
  if (updates.line_items) {
    merged.line_items = toUcpLineItems(updates.line_items);
  }

  // buyer: shallow merge over existing buyer
  if (updates.buyer) {
    const existingBuyer = (merged.buyer as Record<string, unknown> | undefined) ?? {};
    merged.buyer = { ...existingBuyer, ...updates.buyer };
  }

  // fulfillment: replace methods/handle when supplied, dropping computed fields.
  if (updates.fulfillment) {
    const incoming = sanitizeFulfillment(toUcpFulfillment(updates.fulfillment)) ?? {};
    const existingFulfillment = (merged.fulfillment as Record<string, unknown> | undefined) ?? {};
    merged.fulfillment = { ...existingFulfillment, ...incoming };
  }

  // Mirror buyer name/phone into destinations to avoid recoverable
  // delivery_*_required errors when the caller passed only the buyer.
  const mirroredFulfillment = mirrorBuyerToDestinations(
    merged.fulfillment as Record<string, unknown> | undefined,
    merged.buyer as Record<string, unknown> | undefined,
  );
  if (mirroredFulfillment) merged.fulfillment = mirroredFulfillment;

  return merged;
}

export async function updateCheckout(
  shopDomain: string,
  checkoutId: string,
  updates: {
    buyer?: BuyerInfo;
    fulfillment?: FulfillmentInfo;
    line_items?: LineItem[];
  }
) {
  // Fetch current checkout state so we can PUT a full payload (UCP spec).
  // If get_checkout fails we still attempt the update with just the supplied
  // fields — degraded but better than failing the whole call.
  let existingCheckout: Record<string, unknown> | undefined;
  try {
    const current = (await getCheckout(shopDomain, checkoutId)) as Record<string, unknown>;
    existingCheckout = (current?.checkout as Record<string, unknown> | undefined) ?? current;
  } catch (err) {
    console.error('[checkout] get_checkout failed, proceeding with partial update:', err);
  }

  const checkout = mergeCheckout(existingCheckout, updates);

  // Refresh signals on every update — buyer IP / UA may legitimately
  // change between calls in the same session, and PUT semantics mean
  // any field we omit is dropped server-side.
  const signals = buildSignals();
  if (signals) checkout.signals = signals;

  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout,
  };

  return callCheckoutMcp(shopDomain, 'update_checkout', args);
}

export async function completeCheckout(
  shopDomain: string,
  checkoutId: string,
  idempotencyKey: string,
  payment?: Record<string, unknown>
) {
  const signals = buildSignals();
  // Always send a checkout body if we have signals to attach, even when
  // payment is undefined — the spec's complete_checkout examples include
  // signals at this stage for fraud signals at order-creation time.
  const checkout: Record<string, unknown> = {
    ...(payment && { payment }),
    ...(signals && { signals }),
  };
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: {
      'ucp-agent': { profile: UCP_AGENT_PROFILE },
      'idempotency-key': idempotencyKey,
    },
    ...(Object.keys(checkout).length > 0 && { checkout }),
  };

  return callCheckoutMcp(shopDomain, 'complete_checkout', args);
}

// UCP spec: cancel_checkout requires meta.idempotency-key so retries are safe.
export async function cancelCheckout(
  shopDomain: string,
  checkoutId: string,
  idempotencyKey: string,
) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: {
      'ucp-agent': { profile: UCP_AGENT_PROFILE },
      'idempotency-key': idempotencyKey,
    },
  };

  return callCheckoutMcp(shopDomain, 'cancel_checkout', args);
}
