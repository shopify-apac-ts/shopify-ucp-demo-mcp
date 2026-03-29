import { getBearerToken } from './auth.js';

const CATALOG_MCP_URL = 'https://discover.shopifyapps.com/global/mcp';
const MCP_PROTOCOL_VERSION = '2024-11-05';

let requestId = 0;

function nextId() {
  return ++requestId;
}

// Parse MCP response — Streamable HTTP may return either plain JSON
// or a newline-delimited SSE stream ("data: {...}\n\n").
async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (contentType.includes('text/event-stream')) {
    const dataLines = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim())
      .filter(Boolean);
    if (dataLines.length === 0) {
      throw new Error(`Empty SSE stream from Catalog MCP`);
    }
    return JSON.parse(dataLines[dataLines.length - 1]);
  }

  return JSON.parse(text);
}

// Perform the MCP initialize handshake and return the session ID (if any).
async function initSession(token: string): Promise<string | null> {
  const body = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'shopify-ucp-demo-mcp', version: '1.0.0' },
    },
    id: nextId(),
  };

  const response = await fetch(CATALOG_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Catalog MCP initialize failed (${response.status}): ${text}`);
  }

  return response.headers.get('mcp-session-id');
}

async function callCatalogMcp(toolName: string, args: Record<string, unknown>) {
  const token = await getBearerToken();
  const sessionId = await initSession(token);

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: nextId(),
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(CATALOG_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Catalog MCP error (${response.status}): ${text}`);
  }

  const json = (await parseResponse(response)) as {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { code: number; message: string; data?: unknown };
  };

  if (json.error) {
    const detail = json.error.data ? ` | data: ${JSON.stringify(json.error.data)}` : '';
    throw new Error(
      `Catalog MCP tool error [${json.error.code}]: ${json.error.message}${detail}`
    );
  }

  const textContent = json.result?.content?.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error(`No text content in Catalog MCP response: ${JSON.stringify(json)}`);
  }

  return JSON.parse(textContent.text);
}

export interface SearchProductsParams {
  query: string;
  context: string;
  ships_to?: string;     // ISO 2-letter country code
  min_price?: number;
  max_price?: number;
  limit?: number;
}

export async function searchGlobalProducts(params: SearchProductsParams) {
  const savedCatalog = process.env.SHOPIFY_CATALOG_ID;
  const args: Record<string, unknown> = {
    query: params.query,
    context: params.context,
    ...(params.ships_to && { ships_to: params.ships_to }),
    ...(params.min_price !== undefined && { min_price: params.min_price }),
    ...(params.max_price !== undefined && { max_price: params.max_price }),
    ...(params.limit !== undefined && { limit: params.limit }),
    ...(savedCatalog && { saved_catalog: savedCatalog }),
  };
  return callCatalogMcp('search_global_products', args);
}

export interface GetProductDetailsParams {
  upid: string;
  product_options?: Array<{ key: string; values: string[] }>;
  ships_to?: string;
  limit?: number;
}

export async function getGlobalProductDetails(params: GetProductDetailsParams) {
  const args: Record<string, unknown> = {
    upid: params.upid,
    ...(params.product_options && { product_options: params.product_options }),
    ...(params.ships_to && { ships_to: params.ships_to }),
    ...(params.limit !== undefined && { limit: params.limit }),
  };
  return callCatalogMcp('get_global_product_details', args);
}
