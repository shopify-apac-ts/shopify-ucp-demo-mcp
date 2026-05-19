import { getBearerToken } from './auth.js';

// Checkout MCP endpoint is per-shop: https://{shop-domain}/api/ucp/mcp
function checkoutMcpUrl(shopDomain: string): string {
  const host = shopDomain.includes('.')
    ? shopDomain
    : `${shopDomain}.myshopify.com`;
  return `https://${host}/api/ucp/mcp`;
}

let requestId = 0;

// Default to Shopify's published reference UCP agent profile. A bare root URL
// (e.g. https://example.onrender.com) is not spec-compliant — the URL must
// resolve to a valid UCP profile JSON document.
const UCP_AGENT_PROFILE =
  process.env.UCP_AGENT_PROFILE ??
  'https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json';

async function callCheckoutMcp(
  shopDomain: string,
  toolName: string,
  args: Record<string, unknown>
) {
  const token = await getBearerToken();
  const url = checkoutMcpUrl(shopDomain);

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: ++requestId,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

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
  const args: Record<string, unknown> = {
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout: {
      currency: params.currency,
      line_items: toUcpLineItems(params.line_items),
      ...(params.buyer && { buyer: params.buyer }),
      ...(params.fulfillment && { fulfillment: toUcpFulfillment(params.fulfillment) }),
    },
  };

  return callCheckoutMcp(shopDomain, 'create_checkout', args);
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
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
    checkout: {
      ...(updates.line_items && { line_items: toUcpLineItems(updates.line_items) }),
      ...(updates.buyer && { buyer: updates.buyer }),
      ...(updates.fulfillment && { fulfillment: toUcpFulfillment(updates.fulfillment) }),
    },
  };

  return callCheckoutMcp(shopDomain, 'update_checkout', args);
}

export async function completeCheckout(
  shopDomain: string,
  checkoutId: string,
  idempotencyKey: string,
  payment?: Record<string, unknown>
) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: {
      'ucp-agent': { profile: UCP_AGENT_PROFILE },
      'idempotency-key': idempotencyKey,
    },
    ...(payment && { checkout: { payment } }),
  };

  return callCheckoutMcp(shopDomain, 'complete_checkout', args);
}

export async function cancelCheckout(shopDomain: string, checkoutId: string) {
  const args: Record<string, unknown> = {
    id: checkoutId,
    meta: { 'ucp-agent': { profile: UCP_AGENT_PROFILE } },
  };

  return callCheckoutMcp(shopDomain, 'cancel_checkout', args);
}
