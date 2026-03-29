import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchGlobalProducts, getGlobalProductDetails } from './catalog.js';
import {
  createCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
} from './checkout.js';

// Response structure from Catalog MCP search_global_products:
// result.offers[] = universal products
//   .id, .title, .description, .images[].url
//   .priceRange.min.{ amount, currencyCode }
//   .products[] = per-shop offers
//     .checkoutUrl, .price.{ amount, currencyCode }
//     .shop.{ name, onlineStoreUrl }
//     .selectedProductVariant.{ id }
function formatSearchProduct(p: Record<string, unknown>, index: number): string {
  const perShopOffers = (p.products as Record<string, unknown>[] | undefined) ?? [];
  const firstOffer = perShopOffers[0] ?? {};
  const shop = (firstOffer.shop as Record<string, unknown> | undefined) ?? {};
  const variantPrice = firstOffer.price as Record<string, unknown> | undefined;
  const priceRange = p.priceRange as Record<string, Record<string, unknown>> | undefined;

  const priceStr = variantPrice
    ? `${variantPrice.amount} ${variantPrice.currencyCode ?? ''}`.trim()
    : priceRange?.min
    ? `${priceRange.min.amount} ${priceRange.min.currencyCode ?? ''}`.trim()
    : 'N/A';

  const images = (p.images as Record<string, unknown>[] | undefined) ?? [];
  const imageUrl = images[0]?.url as string | undefined;

  const desc = typeof p.description === 'string'
    ? p.description.slice(0, 120) + (p.description.length > 120 ? '…' : '')
    : '';

  const shopUrl = shop.onlineStoreUrl as string | undefined;
  const checkoutUrl = firstOffer.checkoutUrl as string | undefined;
  const shopName = shop.name as string | undefined;

  // Extract Base62 UPID for use with get_product_details
  const rawId = p.id as string | undefined;
  const base62 = rawId?.match(/\/p\/([^/?#]+)/)?.[1] ?? rawId ?? 'N/A';

  return [
    `${index + 1}. **${p.title}** — ${priceStr}`,
    shopName ? `   Shop: ${shopName}${shopUrl ? ` (${shopUrl})` : ''}` : '',
    desc ? `   ${desc}` : '',
    `   ID: ${base62}`,
    imageUrl ? `   Image: ${imageUrl}` : '',
    checkoutUrl ? `   **Checkout: ${checkoutUrl}**` : '',
  ].filter(Boolean).join('\n');
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'shopify-ucp-demo-mcp',
    version: '1.0.0',
  });

  // ----------------------------------------------------------------
  // Tool: search_products
  // ----------------------------------------------------------------
  server.tool(
    'search_products',
    'Search for products across all Shopify merchants worldwide. Returns product list with titles, prices, images, and checkout URLs.',
    {
      query: z.string().describe('Search query, e.g. "red sneakers" or "organic coffee beans"'),
      context: z.string().optional().describe("Additional context about the buyer's needs, preferences, or situation. When omitted, the query is used as context."),
      ships_to: z.string().optional().describe('2-letter ISO country code to filter products that ship to this country, e.g. "JP", "US"'),
      price_min: z.number().optional().describe('Minimum price'),
      price_max: z.number().optional().describe('Maximum price'),
      limit: z.number().optional().describe('Number of results (default: 5, max: 20)'),
    },
    async ({ query, context, ships_to, price_min, price_max, limit }) => {
      const result = await searchGlobalProducts({
        query,
        context: context ?? query,
        ...(ships_to && { ships_to }),
        ...(price_min !== undefined && { min_price: price_min }),
        ...(price_max !== undefined && { max_price: price_max }),
        limit: Math.min(limit ?? 5, 20),
      });

      const raw = result as Record<string, unknown>;
      const offers = (Array.isArray(raw?.offers) ? raw.offers : []) as Record<string, unknown>[];

      const lines = offers.map((p, i) => formatSearchProduct(p, i));
      const text = lines.length > 0
        ? `Found ${lines.length} product(s):\n\n${lines.join('\n\n')}`
        : 'No products found for this query.';

      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: get_product_details
  // ----------------------------------------------------------------
  server.tool(
    'get_product_details',
    'Get detailed information about a specific product including all variants, pricing, and checkout URLs. Use the ID from search_products results.',
    {
      upid: z.string().describe('Universal Product ID (the "ID:" field) from search_products results'),
      color: z.string().optional().describe('Preferred color option'),
      size: z.string().optional().describe('Preferred size option'),
      ships_to: z.string().optional().describe('2-letter ISO country code to filter shipping availability'),
    },
    async ({ upid, color, size, ships_to }) => {
      const product_options: Array<{ key: string; values: string[] }> = [];
      if (color) product_options.push({ key: 'Color', values: [color] });
      if (size) product_options.push({ key: 'Size', values: [size] });

      const result = await getGlobalProductDetails({
        upid,
        ...(product_options.length > 0 && { product_options }),
        ...(ships_to && { ships_to }),
      });

      const raw = result as Record<string, unknown>;
      const product = (raw?.product ?? raw) as Record<string, unknown>;
      const perShopOffers = (product.products as Record<string, unknown>[] | undefined) ?? [];

      const lines = perShopOffers.map((offer, i) => {
        const shop = (offer.shop as Record<string, unknown> | undefined) ?? {};
        const price = offer.price as Record<string, unknown> | undefined;
        const variant = (offer.selectedProductVariant as Record<string, unknown> | undefined) ?? {};
        const priceStr = price ? `${price.amount} ${price.currencyCode ?? ''}` : 'N/A';
        return [
          `${i + 1}. **${shop.name ?? 'Unknown'}** — ${priceStr}`,
          offer.checkoutUrl ? `   **Checkout: ${offer.checkoutUrl}**` : '',
          variant.id ? `   Variant ID: ${variant.id}` : '',
        ].filter(Boolean).join('\n');
      });

      const images = (product.images as Record<string, unknown>[] | undefined) ?? [];
      const imageUrl = images[0]?.url as string | undefined;

      const header = [
        `**${product.title}**`,
        typeof product.description === 'string' ? product.description.slice(0, 200) : '',
        imageUrl ? `Image: ${imageUrl}` : '',
        '',
        `Available at ${perShopOffers.length} shop(s):`,
      ].filter(Boolean).join('\n');

      const text = lines.length > 0
        ? `${header}\n\n${lines.join('\n\n')}`
        : 'No offers found for this product.';

      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: create_checkout
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

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: update_checkout
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

      const result = await updateCheckout(shop_domain, checkout_id, {
        ...(buyer && { buyer }),
        ...(fulfillment && { fulfillment }),
      });

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: complete_checkout
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: cancel_checkout
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
