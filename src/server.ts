import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { searchGlobalProducts, getGlobalProductDetails, extractBase62 } from './catalog.js';
import {
  createCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
} from './checkout.js';

// Extract currency code from a price object — API uses both 'currencyCode' and 'currency'
function getCurrency(price: Record<string, unknown>): string {
  return (price.currencyCode ?? price.currency ?? '') as string;
}

// Response structure from Catalog MCP search_global_products:
// result.offers[] = universal products
//   .id, .title, .description, .images[].url
//   .priceRange.min.{ amount, currencyCode }
//   .options[].{ name, values[].{ value, availableForSale } }
//   .url  — product page URL on Shopify discovery
//   .products[] = per-shop offers (may be empty when no offers match ship filter)
//     .checkoutUrl, .price.{ amount, currencyCode }
//     .shop.{ name, onlineStoreUrl }
//     .selectedProductVariant.{ id, options[].{ name, value } }
//     .availableForSale
// Fallback: .variants[] = per-shop variant offers (alternate schema used by some responses)
//   .id, .displayName, .checkoutUrl, .variantUrl, .price.{ amount, currencyCode }
function formatSearchProduct(p: Record<string, unknown>, index: number): string {
  const perShopOffers = (p.products as Record<string, unknown>[] | undefined) ?? [];
  // Fallback: some Catalog MCP responses use variants[] instead of products[]
  const variants = (p.variants as Record<string, unknown>[] | undefined) ?? [];

  const firstOffer = perShopOffers[0] ?? variants[0] ?? {};
  const isVariantSchema = perShopOffers.length === 0 && variants.length > 0;

  const shop = isVariantSchema ? {} : ((firstOffer.shop as Record<string, unknown> | undefined) ?? {});
  const variantPrice = firstOffer.price as Record<string, unknown> | undefined;
  const priceRange = p.priceRange as Record<string, Record<string, unknown>> | undefined;

  const priceStr = variantPrice
    ? `${variantPrice.amount} ${getCurrency(variantPrice)}`.trim()
    : priceRange?.min
    ? `${priceRange.min.amount} ${getCurrency(priceRange.min)}`.trim()
    : 'N/A';

  // Rating: prefer per-shop offer rating, fall back to universal product rating
  const offerRating = (firstOffer.rating ?? p.rating) as { value?: number; count?: number } | undefined;
  const ratingStr = offerRating?.value
    ? `⭐ ${offerRating.value.toFixed(1)}${offerRating.count ? ` (${offerRating.count})` : ''}`
    : '';

  const images = (p.images as Record<string, unknown>[] | undefined) ?? [];
  const imageUrl = images[0]?.url as string | undefined;

  const desc = typeof p.description === 'string'
    ? p.description.slice(0, 120) + (p.description.length > 120 ? '…' : '')
    : '';

  const shopUrl = (shop.onlineStoreUrl ?? firstOffer.variantUrl) as string | undefined;
  const checkoutUrl = firstOffer.checkoutUrl as string | undefined;
  const shopName = (shop.name ?? (isVariantSchema && firstOffer.displayName ? 'View product' : undefined)) as string | undefined;

  // Product page URL (for when products[] is empty)
  const productPageUrl = p.url as string | undefined;

  // Extract Base62 UPID for use with get_product_details
  const rawId = p.id as string | undefined;
  const base62 = rawId ? extractBase62(rawId) : 'N/A';

  // Show available options (e.g. sizes, colors)
  const options = (p.options as Array<{ name: string; values: Array<{ value: string; availableForSale?: boolean }> }> | undefined) ?? [];
  const optionLines = options.map((opt) => {
    const vals = opt.values.map((v) => v.availableForSale === false ? `~~${v.value}~~` : v.value);
    return `   ${opt.name}: ${vals.join(' / ')}`;
  });

  return [
    `${index + 1}. **${p.title}** — ${priceStr}${ratingStr ? `  ${ratingStr}` : ''}`,
    shopName ? `   Shop: ${shopName}${shopUrl ? ` (${shopUrl})` : ''}` : '',
    desc ? `   ${desc}` : '',
    `   ID: ${base62}`,
    ...optionLines,
    imageUrl ? `   Image: ${imageUrl}` : '',
    checkoutUrl
      ? `   **Checkout: ${checkoutUrl}**`
      : productPageUrl
      ? `   Product page: ${productPageUrl} _(call get_product_details for checkout URL)_`
      : '',
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
    [
      'Search for products across all Shopify merchants worldwide.',
      'LOCATION RULES (critical — follow before calling this tool):',
      '1. Extract ships_to from the buyer\'s destination (e.g. "Tokyo", "Japan", "日本" → "JP"; "New York", "US" → "US").',
      '2. If the query mentions a product origin country (e.g. "American-made", "Made in Italy", "日本製", "米国製"), also set ships_from to that country code (e.g. "US", "IT", "JP"). ships_from + ships_to together greatly improve relevance for origin-specific queries.',
      '3. If no destination can be inferred, ask the user before calling this tool.',
      '4. Always pass available_for_sale: true unless the buyer explicitly wants out-of-stock items.',
      'CONTEXT RULES (critical — richer context = better results):',
      'Always include: buyer location, product origin if mentioned, style/quality preferences, brand expectations, and any other details from the conversation.',
      'Examples: "buyer in Tokyo looking for authentic American denim brands, premium quality, ships from US"; "buyer in Paris seeking organic Japanese skincare, natural ingredients".',
      'Returns product list with titles, prices, ratings, options (size/color), and checkout URLs.',
    ].join('\n'),
    {
      query: z.string().describe('Search query, e.g. "American jeans" or "Japanese skincare"'),
      context: z.string().describe(
        'Detailed buyer context — ALWAYS include: (1) buyer location, (2) product origin if mentioned, (3) style/quality preferences, (4) brand expectations. ' +
        'Example: "buyer in Tokyo, Japan looking for authentic American-made premium denim jeans, prefers well-known US brands like Levi\'s or Wrangler, ships from US to JP"'
      ),
      ships_to: z.string().describe('2-letter ISO country code for the buyer\'s location / shipping destination (REQUIRED). e.g. "JP", "US", "GB"'),
      ships_from: z.string().optional().describe(
        'ISO country code for the product\'s shipping origin — use when the query mentions product origin. ' +
        'e.g. "American-made" / "米国製" → "US"; "Made in Italy" → "IT"; "Japanese products" / "日本製" → "JP"'
      ),
      available_for_sale: z.boolean().optional().describe('Only return in-stock purchasable products (default: true)'),
      price_min: z.number().optional().describe('Minimum price'),
      price_max: z.number().optional().describe('Maximum price'),
      limit: z.number().optional().describe('Number of results (default: 5, max: 20)'),
    },
    async ({ query, context, ships_to, ships_from, available_for_sale, price_min, price_max, limit }) => {
      // Enrich context with location info
      let enrichedContext = context;
      if (ships_to && !context.includes(ships_to)) enrichedContext += ` [ships_to: ${ships_to}]`;
      if (ships_from && !context.includes(ships_from)) enrichedContext += ` [ships_from: ${ships_from}]`;

      const result = await searchGlobalProducts({
        query,
        context: enrichedContext,
        ships_to,
        ...(ships_from && { ships_from }),
        available_for_sale: available_for_sale !== false, // default true
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
    [
      'Get detailed information about a specific product: all variants, sizes, colors, pricing, and per-shop checkout URLs.',
      'Use the Base62 ID from the "ID:" field in search_products results.',
      'IMPORTANT: Always pass the same ships_to country code used in the preceding search_products call so only offers that ship to the buyer\'s country are shown.',
      'Do NOT pass available_for_sale — the tool shows all variants with their availability status so the buyer can choose.',
    ].join('\n'),
    {
      upid: z.string().describe('Universal Product ID (Base62) from the "ID:" field in search_products results'),
      context: z.string().optional().describe("Buyer context including location, e.g. 'buyer in Tokyo, Japan looking for size M in yellow'"),
      ships_to: z.string().optional().describe('2-letter ISO country code — MUST match the ships_to used in search_products (e.g. "JP", "US")'),
      color: z.string().optional().describe('Preferred color option'),
      size: z.string().optional().describe('Preferred size option'),
    },
    async ({ upid, context, ships_to, color, size }) => {
      const product_options: Array<{ key: string; values: string[] }> = [];
      if (color) product_options.push({ key: 'Color', values: [color] });
      if (size) product_options.push({ key: 'Size', values: [size] });

      // First call: with ships_to filter (if provided)
      const result = await getGlobalProductDetails({
        upid,
        ...(context && { context }),
        ...(product_options.length > 0 && { product_options }),
        ...(ships_to && { ships_to }),
        // Do NOT pass available_for_sale — we want all offers to show variant availability
      });

      const raw = result as Record<string, unknown>;
      const product = (raw?.product ?? raw) as Record<string, unknown>;

      // Try products[] (standard MCP schema), then variants[] (actual response schema)
      let perShopOffers = (product.products as Record<string, unknown>[] | undefined) ?? [];
      const isVariantSchema = perShopOffers.length === 0 && Array.isArray(product.variants);
      if (isVariantSchema) {
        perShopOffers = (product.variants as Record<string, unknown>[]);
      }

      // Fallback: if ships_to filtering returned 0 offers, retry without it
      let usedFallback = false;
      if (perShopOffers.length === 0 && ships_to) {
        console.error(`[server] get_product_details: 0 offers with ships_to=${ships_to}, retrying without filter`);
        const fallbackResult = await getGlobalProductDetails({
          upid,
          ...(context && { context }),
          ...(product_options.length > 0 && { product_options }),
        });
        const fallbackRaw = fallbackResult as Record<string, unknown>;
        const fallbackProduct = (fallbackRaw?.product ?? fallbackRaw) as Record<string, unknown>;
        perShopOffers = (fallbackProduct.products as Record<string, unknown>[] | undefined) ?? [];
        if (perShopOffers.length === 0 && Array.isArray(fallbackProduct.variants)) {
          perShopOffers = fallbackProduct.variants as Record<string, unknown>[];
        }
        usedFallback = true;
      }

      // Format a per-shop offer — handles both products[] schema and variants[] schema
      const formatOffer = (offer: Record<string, unknown>, i: number): string => {
        // products[] schema: offer has .shop, .selectedProductVariant, .availableForSale
        // variants[] schema: offer has .displayName, .variantUrl, .price directly
        const hasShop = Boolean(offer.shop);
        const shop = hasShop ? ((offer.shop as Record<string, unknown> | undefined) ?? {}) : {};
        const price = offer.price as Record<string, unknown> | undefined;
        const variant = hasShop
          ? ((offer.selectedProductVariant as Record<string, unknown> | undefined) ?? {})
          : offer; // in variants[] schema, the variant IS the offer
        const variantOptions = (variant.options as Array<{ name: string; value: string }> | undefined) ?? [];
        const priceStr = price ? `${price.amount} ${getCurrency(price)}` : 'N/A';
        const displayName = (offer.displayName ?? shop.name) as string | undefined;
        const optStr = variantOptions.length > 0
          ? variantOptions.map((o) => `${o.name}: ${o.value}`).join(', ')
          : typeof offer.displayName === 'string' ? offer.displayName : '';
        const availStr = offer.availableForSale === false ? ' ⚠️ sold out' : '';
        const storeUrl = (shop.onlineStoreUrl ?? offer.variantUrl) as string | undefined;
        const variantId = (variant.id ?? offer.id) as string | undefined;
        return [
          `${i + 1}. **${displayName ?? 'Offer'}** — ${priceStr}${optStr ? ` (${optStr})` : ''}${availStr}`,
          offer.checkoutUrl && offer.availableForSale !== false
            ? `   **Checkout: ${offer.checkoutUrl}**`
            : offer.checkoutUrl
            ? `   Checkout (out of stock): ${offer.checkoutUrl}`
            : '',
          storeUrl ? `   Store: ${storeUrl}` : '',
          variantId ? `   Variant ID: ${variantId}` : '',
        ].filter(Boolean).join('\n');
      };

      const lines = perShopOffers.map((offer, i) => formatOffer(offer, i));

      // Product-level options (all available variants)
      const productOptions = (product.options as Array<{ name: string; values: Array<{ value: string; availableForSale?: boolean }> }> | undefined) ?? [];
      const optionSummary = productOptions.map((opt) => {
        const vals = opt.values.map((v) => v.availableForSale === false ? `~~${v.value}~~` : v.value);
        return `**${opt.name}**: ${vals.join(' / ')}`;
      }).join('\n');

      const images = (product.images as Record<string, unknown>[] | undefined) ?? [];
      const imageUrl = images[0]?.url as string | undefined;
      const topFeatures = (product.topFeatures as string[] | undefined) ?? [];

      // Get product title — may be missing in some API responses; fall back to description snippet
      const productTitle = (product.title && product.title !== 'None')
        ? String(product.title)
        : (typeof product.description === 'string' ? product.description.slice(0, 60) : upid);

      const shippingNote = usedFallback
        ? `\n⚠️ No offers found shipping to ${ships_to}. Showing all available offers globally:`
        : ships_to
        ? `\nAvailable at ${perShopOffers.length} shop(s) shipping to ${ships_to}:`
        : `\nAvailable at ${perShopOffers.length} shop(s):`;

      const header = [
        `**${productTitle}**`,
        typeof product.description === 'string' ? product.description.slice(0, 300) : '',
        imageUrl ? `\nImage: ${imageUrl}` : '',
        optionSummary ? `\n${optionSummary}` : '',
        topFeatures.length > 0 ? `\nFeatures:\n${topFeatures.map((f) => `• ${f}`).join('\n')}` : '',
        shippingNote,
      ].filter(Boolean).join('\n');

      // Debug: dump raw response structure when no offers returned
      if (lines.length === 0) {
        console.error('[server] get_product_details 0 offers. raw keys:', Object.keys(raw));
        console.error('[server] product keys:', Object.keys(product));
        console.error('[server] product.title:', product.title);
        console.error('[server] product.products type:', typeof product.products, Array.isArray(product.products) ? `len=${(product.products as unknown[]).length}` : JSON.stringify(product.products)?.slice(0, 100));
      }

      const text = lines.length > 0
        ? `${header}\n\n${lines.join('\n\n')}`
        : `Product found but no shop offers returned. This may be a temporary API issue. UPID: ${upid}`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: create_checkout
  // ----------------------------------------------------------------
  server.tool(
    'create_checkout',
    [
      'Create a checkout session for a product on a Shopify merchant store.',
      'Returns checkout status and a continue_url for the buyer to complete payment.',
      'IMPORTANT: The shop may not support UCP Checkout MCP (503 AuthenticationFailed means the shop has not enabled UCP).',
      'If this tool fails with a 503 error, show the buyer the checkoutUrl from get_product_details results instead.',
      'Extract shop_domain from the checkoutUrl hostname (e.g. "store.myshopify.com") or onlineStoreUrl.',
    ].join('\n'),
    {
      shop_domain: z.string().describe('Shopify store domain, e.g. "example.myshopify.com" — extract from checkoutUrl or onlineStoreUrl'),
      currency: z.string().describe('ISO 4217 currency code, e.g. "USD", "JPY"'),
      line_items: z.array(z.object({
        variant_id: z.string().describe('Product variant GID, e.g. "gid://shopify/ProductVariant/12345"'),
        quantity: z.number().int().min(1),
      })).describe('Items to purchase'),
      buyer_email: z.string().optional().describe('Buyer email for order confirmation'),
      buyer_first_name: z.string().optional(),
      buyer_last_name: z.string().optional(),
      shipping_street: z.string().optional().describe('Street address (e.g. "123 Main St")'),
      shipping_city: z.string().optional().describe('City / address locality'),
      shipping_region: z.string().optional().describe('State or province code (e.g. "CA", "NY")'),
      shipping_postal_code: z.string().optional().describe('Postal / zip code'),
      shipping_country: z.string().optional().describe('2-letter ISO country code, e.g. "US", "JP"'),
    },
    async ({
      shop_domain,
      currency,
      line_items,
      buyer_email,
      buyer_first_name,
      buyer_last_name,
      shipping_street,
      shipping_city,
      shipping_region,
      shipping_postal_code,
      shipping_country,
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
        shipping_street && shipping_city && shipping_postal_code && shipping_country
          ? {
              destinations: [{
                street_address: shipping_street,
                address_locality: shipping_city,
                ...(shipping_region && { address_region: shipping_region }),
                postal_code: shipping_postal_code,
                address_country: shipping_country,
              }],
            }
          : undefined;

      try {
        const result = await createCheckout(shop_domain, {
          currency,
          line_items,
          ...(buyer && { buyer }),
          ...(fulfillment && { fulfillment }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = String(e);
        if (msg.includes('503') || msg.includes('AuthenticationFailed') || msg.includes('Service temporarily unavailable')) {
          return {
            content: [{
              type: 'text',
              text: `The store "${shop_domain}" does not support UCP Checkout MCP (${msg.slice(0, 120)}).\n\nPlease use the checkoutUrl from the product details to proceed with purchase directly.`,
            }],
          };
        }
        throw e;
      }
    }
  );

  // ----------------------------------------------------------------
  // Tool: update_checkout
  // ----------------------------------------------------------------
  server.tool(
    'update_checkout',
    'Update an existing checkout session with buyer information, shipping address, or updated line items. IMPORTANT: This replaces the entire checkout state — always include all line_items even if unchanged. Check the status field in the response to determine next steps.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      checkout_id: z.string().describe('Checkout session ID returned by create_checkout'),
      line_items: z.array(z.object({
        variant_id: z.string(),
        quantity: z.number().int().min(1),
      })).describe('Complete list of items (replaces existing — include all items, not just changes)'),
      buyer_email: z.string().optional(),
      buyer_first_name: z.string().optional(),
      buyer_last_name: z.string().optional(),
      buyer_phone: z.string().optional(),
      shipping_first_name: z.string().optional(),
      shipping_last_name: z.string().optional(),
      shipping_street: z.string().optional().describe('Street address'),
      shipping_city: z.string().optional().describe('City / address locality'),
      shipping_region: z.string().optional().describe('State or province code'),
      shipping_postal_code: z.string().optional().describe('Postal / zip code'),
      shipping_country: z.string().optional().describe('2-letter ISO country code'),
      shipping_method_handle: z.string().optional().describe('Shipping method handle from checkout response'),
    },
    async ({
      shop_domain,
      checkout_id,
      line_items,
      buyer_email,
      buyer_first_name,
      buyer_last_name,
      buyer_phone,
      shipping_first_name,
      shipping_last_name,
      shipping_street,
      shipping_city,
      shipping_region,
      shipping_postal_code,
      shipping_country,
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

      const hasAddress = shipping_street && shipping_city && shipping_postal_code && shipping_country;
      const fulfillment = hasAddress
        ? {
            destinations: [{
              ...(shipping_first_name && { first_name: shipping_first_name }),
              ...(shipping_last_name && { last_name: shipping_last_name }),
              street_address: shipping_street!,
              address_locality: shipping_city!,
              ...(shipping_region && { address_region: shipping_region }),
              postal_code: shipping_postal_code!,
              address_country: shipping_country!,
            }],
            ...(shipping_method_handle && { shipping_method_handle }),
          }
        : shipping_method_handle
        ? { shipping_method_handle }
        : undefined;

      const result = await updateCheckout(shop_domain, checkout_id, {
        line_items,
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
