import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchGlobalProducts, getGlobalProductDetails } from './catalog.js';

// Slim down a raw Catalog MCP product into essential fields only.
// Keeps the cheapest offer per product to minimise response size.
function formatProduct(p: Record<string, unknown>, index: number): string {
  // Each element in `offers` represents a product+shop combination.
  // Nested offers (multiple shops for same product) live in p.offers.
  const nestedOffers = (p.offers as Record<string, unknown>[] | undefined) ?? [];
  const firstOffer = nestedOffers[0] ?? p; // fall back to top-level if no nested offers
  const shop = (firstOffer.shop as Record<string, unknown> | undefined)
    ?? (p.shop as Record<string, unknown> | undefined)
    ?? {};

  const images = (p.images as Record<string, unknown>[] | undefined) ?? [];
  const image = images[0] ? `\n   Image: ${images[0].url}` : '';

  const productUrl = (firstOffer.onlineStoreUrl ?? p.onlineStoreUrl);
  const checkoutUrl = (firstOffer.checkoutUrl ?? p.checkoutUrl);
  const price = firstOffer.price ?? p.price;
  const currency = firstOffer.currency ?? p.currency ?? '';

  const priceStr = price != null ? `${price} ${currency}`.trim() : 'N/A';
  const desc = typeof p.description === 'string'
    ? p.description.slice(0, 120) + (p.description.length > 120 ? '…' : '')
    : '';

  return [
    `${index + 1}. **${p.title}** — ${priceStr}`,
    `   Shop: ${shop.name ?? shop.domain ?? 'Unknown'}`,
    desc ? `   ${desc}` : '',
    `   UPID: ${p.upid ?? 'N/A'}`,
    image,
    productUrl ? `\n   Product page: ${productUrl}` : '',
    checkoutUrl ? `\n   **Checkout: ${checkoutUrl}**` : '',
  ].filter(Boolean).join('\n');
}
import {
  createCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
} from './checkout.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'shopify-ucp-demo-mcp',
    version: '1.0.0',
  });

  // ----------------------------------------------------------------
  // Tool: search_products
  // Searches products globally across all Shopify merchants
  // ----------------------------------------------------------------
  server.tool(
    'search_products',
    'Search for products across all Shopify merchants worldwide. Returns product list with titles, prices, images, and checkout URLs.',
    {
      query: z.string().describe('Search query, e.g. "red sneakers" or "organic coffee beans"'),
      context: z.string().optional().describe("Additional context about the buyer's needs, preferences, demographics, or situation. When omitted, the query is used as context."),
      country: z.string().optional().describe('2-letter ISO country code for shipping location, e.g. "US", "JP"'),
      zip: z.string().optional().describe('Postal/ZIP code for shipping location'),
      price_min: z.number().optional().describe('Minimum price in the store currency'),
      price_max: z.number().optional().describe('Maximum price in the store currency'),
      limit: z.number().optional().describe('Maximum number of results to return (default: 10)'),
    },
    async ({ query, context, country, zip, price_min, price_max, limit }) => {
      const result = await searchGlobalProducts({
        query,
        context: context ?? query,
        ...(country && { location: { country, ...(zip && { zip }) } }),
        ...(price_min !== undefined && { price_min }),
        ...(price_max !== undefined && { price_max }),
        limit: limit ?? 5,
      });

      const raw = result as Record<string, unknown>;
      const products = (Array.isArray(raw?.offers) ? raw.offers : []) as Record<string, unknown>[];
      if (products.length > 0) {
        console.error('[search_products] first offer keys:', Object.keys(products[0]));
        console.error('[search_products] first offer sample:', JSON.stringify(products[0]).slice(0, 800));
      }

      const lines = products.map((p, i) => formatProduct(p, i));
      const text = lines.length > 0
        ? `Found ${lines.length} product(s):\n\n${lines.join('\n\n')}`
        : 'No products found for this query.';

      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: get_product_details
  // Retrieves full variant details + checkout URLs for a specific product
  // ----------------------------------------------------------------
  server.tool(
    'get_product_details',
    'Get detailed information about a specific product including all variants, pricing, and checkout URLs. Use the UPID (Universal Product ID) from search_products results.',
    {
      upid: z.string().describe('Universal Product ID returned by search_products'),
      color: z.string().optional().describe('Preferred color option, e.g. "red", "black"'),
      size: z.string().optional().describe('Preferred size option, e.g. "M", "42", "XL"'),
      shop_domains: z.array(z.string()).optional().describe('Filter results to specific shop domains'),
    },
    async ({ upid, color, size, shop_domains }) => {
      const options_preferences: Record<string, string> = {};
      if (color) options_preferences['color'] = color;
      if (size) options_preferences['size'] = size;

      const result = await getGlobalProductDetails({
        upid,
        ...(Object.keys(options_preferences).length > 0 && { options_preferences }),
        ...(shop_domains && { shop_domains }),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------------
  // Tool: create_checkout
  // Creates a checkout session on a specific Shopify merchant's store
  // ----------------------------------------------------------------
  server.tool(
    'create_checkout',
    'Create a checkout session for a product on a Shopify merchant store. Returns checkout status and a continue_url for the buyer to complete payment.',
    {
      shop_domain: z.string().describe('Shopify store domain, e.g. "example.myshopify.com"'),
      currency: z.string().describe('ISO 4217 currency code, e.g. "USD", "JPY"'),
      line_items: z.array(z.object({
        variant_id: z.string().describe('Product variant GID, e.g. "gid://shopify/ProductVariant/12345"'),
        quantity: z.number().int().min(1),
      })).describe('Items to purchase'),
      buyer_email: z.string().optional().describe('Buyer email for order confirmation'),
      buyer_first_name: z.string().optional(),
      buyer_last_name: z.string().optional(),
      shipping_address_line1: z.string().optional(),
      shipping_city: z.string().optional(),
      shipping_zip: z.string().optional(),
      shipping_country_code: z.string().optional().describe('2-letter ISO country code'),
    },
    async ({
      shop_domain,
      currency,
      line_items,
      buyer_email,
      buyer_first_name,
      buyer_last_name,
      shipping_address_line1,
      shipping_city,
      shipping_zip,
      shipping_country_code,
    }) => {
      const buyer =
        buyer_email || buyer_first_name || buyer_last_name
          ? {
              ...(buyer_email && { email: buyer_email }),
              ...(buyer_first_name && { first_name: buyer_first_name }),
              ...(buyer_last_name && { last_name: buyer_last_name }),
            }
          : undefined;

      const fulfillment =
        shipping_address_line1 && shipping_city && shipping_zip && shipping_country_code
          ? {
              destination: {
                address1: shipping_address_line1,
                city: shipping_city,
                zip: shipping_zip,
                country_code: shipping_country_code,
              },
            }
          : undefined;

      const result = await createCheckout(shop_domain, {
        currency,
        line_items,
        ...(buyer && { buyer }),
        ...(fulfillment && { fulfillment }),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------------
  // Tool: update_checkout
  // Updates an existing checkout session (add buyer info, shipping, etc.)
  // ----------------------------------------------------------------
  server.tool(
    'update_checkout',
    'Update an existing checkout session with buyer information, shipping address, or updated line items. Check the status field in the response to determine next steps.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      checkout_id: z.string().describe('Checkout session ID returned by create_checkout'),
      buyer_email: z.string().optional(),
      buyer_first_name: z.string().optional(),
      buyer_last_name: z.string().optional(),
      buyer_phone: z.string().optional(),
      shipping_first_name: z.string().optional(),
      shipping_last_name: z.string().optional(),
      shipping_address_line1: z.string().optional(),
      shipping_address_line2: z.string().optional(),
      shipping_city: z.string().optional(),
      shipping_province: z.string().optional(),
      shipping_zip: z.string().optional(),
      shipping_country_code: z.string().optional(),
      shipping_method_handle: z.string().optional().describe('Shipping method handle from checkout response'),
    },
    async ({
      shop_domain,
      checkout_id,
      buyer_email,
      buyer_first_name,
      buyer_last_name,
      buyer_phone,
      shipping_first_name,
      shipping_last_name,
      shipping_address_line1,
      shipping_address_line2,
      shipping_city,
      shipping_province,
      shipping_zip,
      shipping_country_code,
      shipping_method_handle,
    }) => {
      const buyer =
        buyer_email || buyer_first_name || buyer_last_name || buyer_phone
          ? {
              ...(buyer_email && { email: buyer_email }),
              ...(buyer_first_name && { first_name: buyer_first_name }),
              ...(buyer_last_name && { last_name: buyer_last_name }),
              ...(buyer_phone && { phone: buyer_phone }),
            }
          : undefined;

      const hasAddress =
        shipping_address_line1 && shipping_city && shipping_zip && shipping_country_code;
      const fulfillment = hasAddress
        ? {
            destination: {
              ...(shipping_first_name && { first_name: shipping_first_name }),
              ...(shipping_last_name && { last_name: shipping_last_name }),
              address1: shipping_address_line1!,
              ...(shipping_address_line2 && { address2: shipping_address_line2 }),
              city: shipping_city!,
              ...(shipping_province && { province: shipping_province }),
              zip: shipping_zip!,
              country_code: shipping_country_code!,
            },
            ...(shipping_method_handle && { shipping_method_handle }),
          }
        : shipping_method_handle
        ? { shipping_method_handle }
        : undefined;

      const updates = {
        ...(buyer && { buyer }),
        ...(fulfillment && { fulfillment }),
      };

      const result = await updateCheckout(shop_domain, checkout_id, updates);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------------
  // Tool: complete_checkout
  // Finalizes a checkout when status is ready_for_complete
  // ----------------------------------------------------------------
  server.tool(
    'complete_checkout',
    'Complete a checkout session and place the order. Only call this when checkout status is "ready_for_complete". Requires a unique idempotency key for safe retries.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      checkout_id: z.string().describe('Checkout session ID'),
      idempotency_key: z.string().describe('Unique UUID for this completion attempt (for safe retries)'),
    },
    async ({ shop_domain, checkout_id, idempotency_key }) => {
      const result = await completeCheckout(shop_domain, checkout_id, idempotency_key);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ----------------------------------------------------------------
  // Tool: cancel_checkout
  // Cancels an active checkout session
  // ----------------------------------------------------------------
  server.tool(
    'cancel_checkout',
    'Cancel an active checkout session. Use this when the buyer decides not to proceed.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      checkout_id: z.string().describe('Checkout session ID to cancel'),
    },
    async ({ shop_domain, checkout_id }) => {
      const result = await cancelCheckout(shop_domain, checkout_id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
