import { getBearerToken } from './auth.js';

const CATALOG_MCP_URL = 'https://discover.shopifyapps.com/global/mcp';

let requestId = 0;

async function callCatalogMcp(toolName: string, args: Record<string, unknown>) {
  const token = await getBearerToken();

  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: ++requestId,
  };

  const response = await fetch(CATALOG_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Catalog MCP error (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`Catalog MCP tool error: ${json.error.message}`);
  }

  const textContent = json.result?.content?.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error('No text content in Catalog MCP response');
  }

  return JSON.parse(textContent.text);
}

export interface SearchProductsParams {
  query: string;
  catalog_id?: string;
  location?: { country: string; zip?: string };
  price_min?: number;
  price_max?: number;
  limit?: number;
}

export async function searchGlobalProducts(params: SearchProductsParams) {
  return callCatalogMcp('search_global_products', params as unknown as Record<string, unknown>);
}

export interface GetProductDetailsParams {
  upid: string;
  options_preferences?: Record<string, string>;
  shop_domains?: string[];
}

export async function getGlobalProductDetails(params: GetProductDetailsParams) {
  return callCatalogMcp('get_global_product_details', params as unknown as Record<string, unknown>);
}
