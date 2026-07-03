import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  searchGlobalProducts,
  getGlobalProductDetails,
  lookupCatalog,
  extractBase62,
} from './catalog.js';
import {
  createCart,
  getCart,
  updateCart,
  cancelCart,
  createCheckout,
  getCheckout,
  updateCheckout,
  completeCheckout,
  cancelCheckout,
  UcpNotSupportedError,
} from './checkout.js';

const MAX_SELECTED_DETAIL_OFFERS = 3;
const MAX_UNSELECTED_DETAIL_OFFERS = 8;
const MIN_SIMILAR_IMAGE_BYTES = 512;

// Extract currency code from a price object — API uses both 'currencyCode' and 'currency'
function getCurrency(price: Record<string, unknown>): string {
  return (price.currencyCode ?? price.currency ?? '') as string;
}

// Append a query parameter, but only if the key isn't already present.
function appendQuery(url: string, key: string, value: string): string {
  if (!url) return url;
  if (new RegExp(`[?&]${key}=`).test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `${key}=${value}`;
}

function imageUrlFrom(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 2) return undefined;
  const record = value as Record<string, unknown>;

  for (const key of ['url', 'src', 'originalSrc', 'transformedSrc']) {
    const url = record[key];
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
  }

  for (const key of ['image', 'featuredImage', 'previewImage', 'mediaImage']) {
    const url = imageUrlFrom(record[key], depth + 1);
    if (url) return url;
  }

  for (const key of ['images', 'media']) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      const url = imageUrlFrom(item, depth + 1);
      if (url) return url;
    }
  }

  return undefined;
}

function firstImageUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    const url = imageUrlFrom(value);
    if (url) return url;
  }
  return undefined;
}

async function imageUrlToBase64(url: string): Promise<{ content_type: string; data: string }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status}) for ${url}`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error(`image_url must return an image content type, got ${contentType}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  validateImageBytes(buffer, contentType, 'image_url');
  return { content_type: contentType, data: buffer.toString('base64') };
}

function decodeImageBase64(data: string): Buffer {
  const normalized = data.trim().replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('image_base64 must be raw base64 image data, without Markdown, URL text, or a data: URL prefix');
  }
  return Buffer.from(normalized, 'base64');
}

function validateImageBytes(buffer: Buffer, contentType: string, source: 'image_base64' | 'image_url') {
  if (buffer.length < MIN_SIMILAR_IMAGE_BYTES) {
    throw new Error(`${source} is too small to be a real product photo (${buffer.length} bytes decoded). Pass a full JPEG/PNG/WebP image, or use image_url when the client cannot provide image bytes.`);
  }

  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const expectedTypeMatches =
    (contentType === 'image/jpeg' && isJpeg) ||
    (contentType === 'image/png' && isPng) ||
    (contentType === 'image/webp' && isWebp);

  if (['image/jpeg', 'image/png', 'image/webp'].includes(contentType) && !expectedTypeMatches) {
    throw new Error(`${source} content does not look like ${contentType}. Pass the correct image_content_type or a valid image_url.`);
  }
}

function validateImageBase64(data: string, contentType: string) {
  validateImageBytes(decodeImageBase64(data), contentType, 'image_base64');
}

function priceString(price: unknown): string | undefined {
  if (!price || typeof price !== 'object') return undefined;
  const record = price as Record<string, unknown>;
  const amount = record.amount;
  const currency = getCurrency(record);
  if (amount === undefined && !currency) return undefined;
  return `${amount ?? ''} ${currency}`.trim();
}

function descriptionText(description: unknown, max = 120): string {
  const text = typeof description === 'string'
    ? description
    : description && typeof description === 'object'
    ? ((description as Record<string, unknown>).plain ?? (description as Record<string, unknown>).html)
    : undefined;
  if (typeof text !== 'string') return '';
  return text.slice(0, max) + (text.length > max ? '...' : '');
}

function productArrayFromCatalogResult(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(raw.products)) return raw.products as Record<string, unknown>[];
  if (Array.isArray(raw.offers)) return raw.offers as Record<string, unknown>[];
  return [];
}

function variantsOrProducts(product: Record<string, unknown>): Record<string, unknown>[] {
  const products = (product.products as Record<string, unknown>[] | undefined) ?? [];
  const variants = (product.variants as Record<string, unknown>[] | undefined) ?? [];
  return products.length > 0 ? products : variants;
}

type RequestedOption = { key: string; values: string[] };
type DetailOfferSelection = {
  displayedOffers: Record<string, unknown>[];
  sourceOfferCount: number;
  matchingOfferCount: number;
  partialOfferCount: number;
  hiddenOfferCount: number;
  usedOptionFilter: boolean;
  matchedRequestedOptions: boolean;
};

const OPTION_NAME_ALIASES: Record<string, string[]> = {
  color: ['color', 'colour', 'カラー', '色'],
  size: ['size', 'サイズ', '寸法'],
};

function normalizeOptionText(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function optionNameMatches(actualName: unknown, requestedName: unknown): boolean {
  const actualNorm = normalizeOptionText(actualName);
  const requestedNorm = normalizeOptionText(requestedName);
  if (!actualNorm || !requestedNorm) return false;
  if (actualNorm === requestedNorm) return true;

  const aliases = OPTION_NAME_ALIASES[requestedNorm] ?? [];
  return aliases.some((alias) => normalizeOptionText(alias) === actualNorm);
}

function optionValuePieces(value: unknown): string[] {
  if (value == null) return [];
  return String(value)
    .split(/[\/,|;]+/)
    .map((piece) => normalizeOptionText(piece))
    .filter(Boolean);
}

function hasNumber(value: string): boolean {
  return /\p{Number}/u.test(value);
}

function optionValueMatches(actual: unknown, requested: unknown): boolean {
  const actualNorm = normalizeOptionText(actual);
  const requestedNorm = normalizeOptionText(requested);
  if (!actualNorm || !requestedNorm) return false;
  if (actualNorm === requestedNorm) return true;

  if (requestedNorm.includes(actualNorm)) return true;
  if (!hasNumber(actualNorm) && !hasNumber(requestedNorm) && actualNorm.includes(requestedNorm)) {
    return true;
  }

  const actualPieces = optionValuePieces(actual);
  const requestedPieces = optionValuePieces(requested);
  return actualPieces.some((actualPiece) =>
    requestedPieces.some((requestedPiece) => {
      if (actualPiece === requestedPiece) return true;
      if (requestedPiece.includes(actualPiece)) return true;
      return !hasNumber(actualPiece) && !hasNumber(requestedPiece) && actualPiece.includes(requestedPiece);
    })
  );
}

function optionEntriesFrom(record: Record<string, unknown> | undefined): Array<{ name?: string; value: unknown }> {
  if (!record) return [];
  const entries: Array<{ name?: string; value: unknown }> = [];

  for (const key of ['options', 'selectedOptions', 'selected_options']) {
    const options = record[key];
    if (!Array.isArray(options)) continue;
    for (const option of options) {
      if (!option || typeof option !== 'object') continue;
      const item = option as Record<string, unknown>;
      const name = item.name ?? item.key ?? item.optionName ?? item.option_name;
      const value = item.label ?? item.value ?? item.optionValue ?? item.option_value;
      if (value != null) {
        entries.push({
          ...(typeof name === 'string' && { name }),
          value,
        });
      }
    }
  }

  return entries;
}

function displayTextFromOffer(offer: Record<string, unknown>): string {
  const selectedVariant = offer.selectedProductVariant as Record<string, unknown> | undefined;
  return [
    offer.displayName,
    offer.title,
    selectedVariant?.displayName,
    selectedVariant?.title,
  ].filter((value): value is string => typeof value === 'string').join(' ');
}

function offerMatchesRequestedOption(offer: Record<string, unknown>, requested: RequestedOption): boolean {
  const selectedVariant = offer.selectedProductVariant as Record<string, unknown> | undefined;
  const entries = [
    ...optionEntriesFrom(selectedVariant),
    ...optionEntriesFrom(offer),
  ];
  const fallbackText = displayTextFromOffer(offer);

  const namedEntries = entries.filter((entry) => optionNameMatches(entry.name, requested.key));
  const candidateEntries = namedEntries.length > 0 ? namedEntries : entries;
  const candidateValues = candidateEntries.map((entry) => entry.value);

  if (candidateValues.some((candidate) =>
    requested.values.some((requestedValue) => optionValueMatches(candidate, requestedValue))
  )) {
    return true;
  }

  // Some Catalog variants only expose displayName/title text. Use it as a
  // last-resort match so selected Color/Size can still reduce mobile output.
  return fallbackText
    ? requested.values.some((requestedValue) => optionValueMatches(fallbackText, requestedValue))
    : false;
}

function requestedOptionMatchCount(offer: Record<string, unknown>, requestedOptions: RequestedOption[]): number {
  return requestedOptions.filter((requested) => offerMatchesRequestedOption(offer, requested)).length;
}

function offerMatchesRequestedOptions(offer: Record<string, unknown>, requestedOptions: RequestedOption[]): boolean {
  if (requestedOptions.length === 0) return true;
  return requestedOptionMatchCount(offer, requestedOptions) === requestedOptions.length;
}

function requestedOptionsText(requestedOptions: RequestedOption[]): string {
  return requestedOptions
    .map((option) => `${option.key}: ${option.values.join(' / ')}`)
    .join(', ');
}

function partialDetailOffersForDisplay(
  offers: Record<string, unknown>[],
  requestedOptions: RequestedOption[],
  limit: number
): Record<string, unknown>[] {
  const selected: Record<string, unknown>[] = [];
  const addOffer = (offer: Record<string, unknown> | undefined) => {
    if (!offer || selected.includes(offer) || selected.length >= limit) return;
    selected.push(offer);
  };

  // Preserve coverage across requested dimensions. For Color+Size misses, this
  // surfaces one color match and one size match instead of only the first color.
  for (const requested of requestedOptions) {
    addOffer(offers.find((offer) => offerMatchesRequestedOption(offer, requested)));
  }

  const ranked = offers
    .map((offer, index) => ({ offer, index, score: requestedOptionMatchCount(offer, requestedOptions) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const item of ranked) addOffer(item.offer);
  for (const offer of offers) addOffer(offer);

  return selected;
}

function selectDetailOffersForDisplay(
  offers: Record<string, unknown>[],
  requestedOptions: RequestedOption[]
): DetailOfferSelection {
  const hasRequestedOptions = requestedOptions.length > 0;
  const limit = hasRequestedOptions ? MAX_SELECTED_DETAIL_OFFERS : MAX_UNSELECTED_DETAIL_OFFERS;
  const matchingOffers = hasRequestedOptions
    ? offers.filter((offer) => offerMatchesRequestedOptions(offer, requestedOptions))
    : offers;
  const partialOfferCount = hasRequestedOptions
    ? offers.filter((offer) => requestedOptionMatchCount(offer, requestedOptions) > 0).length
    : offers.length;
  const matchedRequestedOptions = !hasRequestedOptions || matchingOffers.length > 0;
  const sourceOffers = hasRequestedOptions && matchingOffers.length > 0 ? matchingOffers : offers;
  const displayedOffers = hasRequestedOptions && matchingOffers.length === 0
    ? partialDetailOffersForDisplay(offers, requestedOptions, limit)
    : sourceOffers.slice(0, limit);

  return {
    displayedOffers,
    sourceOfferCount: offers.length,
    matchingOfferCount: matchingOffers.length,
    partialOfferCount,
    hiddenOfferCount: Math.max(0, sourceOffers.length - displayedOffers.length),
    usedOptionFilter: hasRequestedOptions,
    matchedRequestedOptions,
  };
}

function detailOfferSelectionNote(selection: DetailOfferSelection, requestedOptions: RequestedOption[]): string {
  if (selection.usedOptionFilter) {
    const requested = requestedOptionsText(requestedOptions);
    if (selection.matchedRequestedOptions) {
      const hidden = selection.hiddenOfferCount > 0 ? ` ${selection.hiddenOfferCount} more matching offer(s) were omitted to keep the mobile response concise.` : '';
      return `\nMatched requested options (${requested}). Showing ${selection.displayedOffers.length} of ${selection.matchingOfferCount} matching offer(s).${hidden}`;
    }
    if (selection.partialOfferCount > 0) {
      return `\nCould not find one offer matching all requested options (${requested}). Showing ${selection.displayedOffers.length} closest Catalog-returned offer(s) that match at least part of the request; ask the buyer to confirm before checkout.`;
    }
    return `\nCould not find offers matching the requested options (${requested}). Showing ${selection.displayedOffers.length} Catalog-returned offer(s); ask the buyer to confirm before checkout.`;
  }

  if (selection.hiddenOfferCount > 0) {
    return `\nShowing ${selection.displayedOffers.length} of ${selection.sourceOfferCount} returned offer(s) to keep the mobile response concise.`;
  }

  return '';
}

// Decorate the buyer-facing continue_url before handing it to the AI:
//   - utm_source=ucp_demo_app : per Checkout MCP docs, agents brand the
//     handoff URL so merchants can attribute traffic from this sample.
//   - skip_shop_pay=true : community-verified workaround that disables
//     Shopify's "auto Shop Pay login" default. Without it, when the buyer's
//     email matches an existing Shop Pay account, the hosted checkout
//     opens straight into the OTP prompt and ignores the shipping address /
//     buyer fields the agent already filled via update_checkout. See
//     https://community.shopify.com/t/stop-checkout-from-defaulting-to-shop-pay/303011
function decorateContinueUrl(url: string): string {
  let out = appendQuery(url, 'utm_source', 'ucp_demo_app');
  out = appendQuery(out, 'skip_shop_pay', 'true');
  return out;
}

// Format a Checkout MCP response (returned from create/update/complete_checkout)
// into status-aware human-readable text so the AI can act on it directly
// instead of re-parsing raw JSON. Always appends the full payload in a
// collapsible block so any field is still inspectable downstream.
function formatCheckoutResponse(result: unknown): string {
  const root = (result as Record<string, unknown> | null) ?? {};
  const checkout = ((root.checkout as Record<string, unknown> | undefined) ?? root) as Record<string, unknown>;
  const status = checkout.status as string | undefined;
  const id = checkout.id as string | undefined;
  const continueUrl = checkout.continue_url as string | undefined;
  const messages = (checkout.messages as Array<Record<string, unknown>> | undefined) ?? [];
  const totals = (checkout.totals as Array<Record<string, unknown>> | undefined) ?? [];
  const order = checkout.order as { id?: string; permalink_url?: string } | undefined;

  const continueUrlDecorated = continueUrl ? decorateContinueUrl(continueUrl) : undefined;
  const totalEntry =
    totals.find((t) => t.type === 'total') ?? totals[totals.length - 1];
  const totalText =
    (totalEntry?.display_text as string | undefined) ??
    (totalEntry?.amount != null ? String(totalEntry.amount) : undefined);

  const lines: string[] = [];
  lines.push(`**Status: ${status ?? 'unknown'}**`);
  if (id) lines.push(`Checkout ID: \`${id}\``);
  if (totalText) lines.push(`Total: ${totalText}`);

  switch (status) {
    case 'incomplete':
      lines.push('');
      lines.push('Missing information. Collect buyer email / name and shipping address, then call `update_checkout`.');
      break;
    case 'requires_escalation':
      lines.push('');
      lines.push('**Buyer must finish in their browser. Send them this URL:**');
      lines.push(continueUrlDecorated ?? '(no continue_url returned)');
      if (messages.length > 0) {
        const buyerMsgs = messages.filter((m) => {
          const sev = m.severity as string | undefined;
          return sev?.startsWith('requires_buyer');
        });
        if (buyerMsgs.length > 0) {
          lines.push('');
          lines.push('Reasons:');
          buyerMsgs.forEach((m) => {
            const sev = (m.severity as string) ?? 'unspecified';
            const detail =
              (m.display_text as string | undefined) ??
              (m.type as string | undefined) ??
              '(no detail)';
            lines.push(`- ${sev}: ${detail}`);
          });
        }
      }
      lines.push('');
      lines.push('After the buyer completes the merchant-hosted step, call `get_checkout` if you need to inspect state. Some flows finish in the browser; only call `complete_checkout` if the checkout later reports `ready_for_complete`.');
      break;
    case 'ready_for_complete':
      lines.push('');
      lines.push('Checkout is ready. Call `complete_checkout` with a fresh `idempotency_key` (UUID) to place the order.');
      break;
    case 'completed':
      lines.push('');
      lines.push('Order placed.');
      if (order?.id) lines.push(`Order ID: \`${order.id}\``);
      if (order?.permalink_url)
        lines.push(`Receipt: ${appendQuery(order.permalink_url, 'utm_source', 'ucp_demo_app')}`);
      break;
    case 'canceled':
      lines.push('');
      lines.push('Checkout canceled.');
      break;
    default:
      // Unknown status — fall through and rely on the raw payload below.
      break;
  }

  // Always include the raw payload so downstream code (or a debugging human)
  // can read every field. Kept collapsed to avoid drowning the AI prompt.
  lines.push('');
  lines.push('<details><summary>Raw response</summary>');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(result, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('</details>');

  return lines.join('\n');
}

function formatCartResponse(result: unknown): string {
  const root = (result as Record<string, unknown> | null) ?? {};
  const cart = ((root.cart as Record<string, unknown> | undefined) ?? root) as Record<string, unknown>;
  const id = cart.id as string | undefined;
  const status = cart.status as string | undefined;
  const currency = cart.currency as string | undefined;
  const continueUrl = cart.continue_url as string | undefined;
  const totals = (cart.totals as Array<Record<string, unknown>> | undefined) ?? [];
  const lineItems = (cart.line_items as unknown[] | undefined) ?? [];
  const totalEntry = totals.find((t) => t.type === 'total') ?? totals[totals.length - 1];
  const totalText =
    (totalEntry?.display_text as string | undefined) ??
    (totalEntry?.amount != null ? `${totalEntry.amount}${currency ? ` ${currency}` : ''}` : undefined);

  const lines: string[] = [];
  lines.push(`**Cart: ${status ?? 'active'}**`);
  if (id) lines.push(`Cart ID: \`${id}\``);
  lines.push(`Line items: ${lineItems.length}`);
  if (totalText) lines.push(`Total: ${totalText}`);
  if (continueUrl) lines.push(`Continue URL: ${decorateContinueUrl(continueUrl)}`);
  lines.push('');
  lines.push('Use `create_checkout` with this `cart_id` when the buyer is ready to check out.');
  lines.push('');
  lines.push('<details><summary>Raw response</summary>');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(result, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

function formatSearchProduct(p: Record<string, unknown>, index: number): string {
  const perShopOffers = (p.products as Record<string, unknown>[] | undefined) ?? [];
  const variants = (p.variants as Record<string, unknown>[] | undefined) ?? [];

  const firstOffer = perShopOffers[0] ?? variants[0] ?? {};
  const isVariantSchema = perShopOffers.length === 0 && variants.length > 0;

  const shop = isVariantSchema ? {} : ((firstOffer.shop as Record<string, unknown> | undefined) ?? {});
  const seller = (firstOffer.seller as Record<string, unknown> | undefined) ?? {};
  const variantPrice = firstOffer.price as Record<string, unknown> | undefined;
  const priceRange = (p.priceRange ?? p.price_range) as Record<string, Record<string, unknown>> | undefined;

  const priceStr = priceString(variantPrice) ?? (priceRange?.min ? priceString(priceRange.min) : undefined) ?? 'N/A';

  const ratingRecord = (firstOffer.rating ?? p.rating) as { value?: number; count?: number } | undefined;
  const ratingStr = ratingRecord?.value
    ? `rating ${ratingRecord.value.toFixed(1)}${ratingRecord.count ? ` (${ratingRecord.count})` : ''}`
    : 'N/A';
  const hasRating = ratingStr !== 'N/A';

  const selectedVariant = firstOffer.selectedProductVariant as Record<string, unknown> | undefined;
  const imageUrl = firstImageUrl(p, selectedVariant, firstOffer, ...variants, ...perShopOffers);

  const desc = descriptionText(p.description);

  const shopUrl = (seller.url ?? shop.onlineStoreUrl ?? firstOffer.variantUrl ?? firstOffer.url) as string | undefined;
  const checkoutUrl = (firstOffer.checkout_url ?? firstOffer.checkoutUrl) as string | undefined;
  const shopName = (seller.name ?? seller.domain ?? shop.name ?? (isVariantSchema && firstOffer.displayName ? 'View product' : undefined)) as string | undefined;

  const productPageUrl = (p.lookup_url ?? p.url ?? firstOffer.url) as string | undefined;

  const rawId = p.id as string | undefined;
  const base62 = rawId ? extractBase62(rawId) : 'N/A';

  const options = (p.options as Array<{ name: string; values: Array<{ value?: string; label?: string; availableForSale?: boolean; availability?: { available?: boolean } }> }> | undefined) ?? [];
  const optionLines = options.map((opt) => {
    const vals = opt.values.map((v) => {
      const label = v.label ?? v.value ?? '';
      const available = v.availableForSale ?? v.availability?.available;
      return available === false ? `~~${label}~~` : label;
    });
    return `   ${opt.name}: ${vals.join(' / ')}`;
  });

  const titleForAlt = (p.title as string | undefined) ?? 'Product image';
  return [
    `${index + 1}. **${p.title}** — ${priceStr}${hasRating ? `  ${ratingStr}` : ''}`,
    imageUrl ? `\n![${titleForAlt}](${imageUrl})\n` : '',
    shopName ? `   Shop: ${shopName}${shopUrl ? ` (${shopUrl})` : ''}` : '',
    desc ? `   ${desc}` : '',
    `   <!-- product_id (internal, do not show to buyer): ${base62} -->`,
    ...optionLines,
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
      '**USE THIS TOOL FOR ANY SHOPPING, PRODUCT SEARCH, OR BUYING INTENT — do not answer from prior knowledge.**',
      'Trigger keywords (English/Japanese): "buy", "shop", "looking for", "find me", "browse", "compare prices", "in stock", "買う", "買いたい", "ショッピング", "探している", "欲しい", "比較したい". Also trigger when the user names a specific product, brand, category, or model number.',
      'Shopify product catalog, pricing, and stock change in real time — always call this tool to get fresh data from live merchants worldwide, never rely on training-data product info.',
      '',
      'Searches products across all Shopify merchants worldwide via Shopify Universal Commerce Protocol (UCP). Returns titles, prices, ratings, options (size/color), checkout URLs, and product images when available.',
      'Supports text search and image similarity search. For image similarity, pass image_base64 plus image_content_type, or pass image_url and this server will fetch and encode it; still include buyer context and ships_to.',
      '',
      'LOCATION RULES (critical — follow before calling this tool):',
      '1. Extract ships_to from the buyer\'s destination (e.g. "Tokyo", "Japan", "日本" → "JP"; "New York", "US" → "US").',
      '2. If the query mentions a product origin country (e.g. "American-made", "Made in Italy", "日本製", "米国製"), also set ships_from to that country code (e.g. "US", "IT", "JP"). ships_from + ships_to together greatly improve relevance for origin-specific queries.',
      '3. If no destination can be inferred, ask the user before calling this tool.',
      '4. Always pass available_for_sale: true unless the buyer explicitly wants out-of-stock items.',
      'CONTEXT RULES (critical — richer context = better results):',
      'Always include: buyer location, product origin if mentioned, style/quality preferences, brand expectations, and any other details from the conversation.',
      'Examples: "buyer in Tokyo looking for authentic American denim brands, premium quality, ships from US"; "buyer in Paris seeking organic Japanese skincare, natural ingredients".',
      'Returns product list with titles, prices, ratings, options (size/color), and checkout URLs.',
      'NAME-BASED ADDRESSING (important for buyer conversation):',
      'Each result carries an internal product_id in an HTML comment — do NOT show it to the buyer or ask them to quote it. When asking the buyer to pick a product, refer to it by its title only (e.g. "Would you like the Levi\'s 501 or the Wrangler Cowboy Cut?"). Look up the matching product_id yourself when you call get_product_details.',
    ].join('\n'),
    {
      query: z.string().optional().describe('Search query, e.g. "American jeans" or "Japanese skincare". Optional when image_base64 is provided for visual similarity search.'),
      context: z.string().describe(
        'Detailed buyer context — ALWAYS include: (1) buyer location, (2) product origin if mentioned, (3) style/quality preferences, (4) brand expectations. ' +
        'Example: "buyer in Tokyo, Japan looking for authentic American-made premium denim jeans, prefers well-known US brands like Levi\'s or Wrangler, ships from US to JP"'
      ),
      image_base64: z.string().optional().describe(
        'Base64-encoded image data for visual similarity search. Pass raw base64 only, without a data: URL prefix.'
      ),
      image_content_type: z.string().optional().describe(
        'MIME type for image_base64, e.g. "image/jpeg", "image/png", or "image/webp". Required when image_base64 is provided.'
      ),
      image_url: z.string().url().optional().describe(
        'HTTP(S) image URL for visual similarity search. Use this when the client can provide an image URL or Markdown image URL but cannot pass base64. The server fetches it and forwards base64 to Shopify Catalog.'
      ),
      ships_to: z.string().describe('2-letter ISO country code for the buyer\'s location / shipping destination (REQUIRED). e.g. "JP", "US", "GB"'),
      ships_from: z.string().optional().describe(
        'ISO country code for the product\'s shipping origin — use when the query mentions product origin. ' +
        'e.g. "American-made" / "米国製" → "US"; "Made in Italy" → "IT"; "Japanese products" / "日本製" → "JP"'
      ),
      available_for_sale: z.boolean().optional().describe('Only return in-stock purchasable products (default: true)'),
      price_min: z.number().optional().describe('Minimum price in minor currency units, e.g. 5000 for $50.00 USD'),
      price_max: z.number().optional().describe('Maximum price in minor currency units, e.g. 15000 for $150.00 USD'),
      limit: z.number().optional().describe('Number of results (default: 5, max: 20)'),
    },
    async ({ query, context, image_base64, image_content_type, image_url, ships_to, ships_from, available_for_sale, price_min, price_max, limit }) => {
      const startedAt = Date.now();
      if (!query && !image_base64 && !image_url) {
        throw new Error('search_products requires either query, image_base64, or image_url');
      }
      if (image_base64 && !image_content_type) {
        throw new Error('image_content_type is required when image_base64 is provided');
      }
      if (image_content_type && !image_base64 && !image_url) {
        throw new Error('image_base64 is required when image_content_type is provided');
      }
      if (image_base64 && image_url) {
        throw new Error('Pass either image_base64 or image_url, not both');
      }
      if (image_base64 && image_content_type) {
        validateImageBase64(image_base64, image_content_type);
      }

      // Enrich context with location info
      let enrichedContext = context;
      if (ships_to && !context.includes(ships_to)) enrichedContext += ` [ships_to: ${ships_to}]`;
      if (ships_from && !context.includes(ships_from)) enrichedContext += ` [ships_from: ${ships_from}]`;

      const image = image_base64 && image_content_type
        ? { content_type: image_content_type, data: image_base64 }
        : image_url
        ? await imageUrlToBase64(image_url)
        : undefined;

      const result = await searchGlobalProducts({
        ...(query && { query }),
        context: enrichedContext,
        ...(image && { similar_image: image }),
        ships_to,
        ...(ships_from && { ships_from }),
        available_for_sale: available_for_sale !== false, // default true
        ...(price_min !== undefined && { min_price: price_min }),
        ...(price_max !== undefined && { max_price: price_max }),
        limit: Math.min(limit ?? 5, 20),
      });

      const raw = result as Record<string, unknown>;
      const offers = productArrayFromCatalogResult(raw);

      const lines = offers.map((p, i) => formatSearchProduct(p, i));
      const text = lines.length > 0
        ? `Found ${lines.length} product(s):\n\n${lines.join('\n\n')}`
        : 'No products found for this query.';

      console.error(`[server] search_products completed: offers=${offers.length} has_image=${Boolean(image)} text_chars=${text.length} duration_ms=${Date.now() - startedAt}`);
      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: get_product_details
  // ----------------------------------------------------------------
  server.tool(
    'get_product_details',
    [
      '**USE THIS TOOL whenever the buyer wants more info on a product from a prior search_products result, or before create_checkout to obtain the variant_id, currency, and shop_domain.**',
      'Trigger phrases: "tell me more about X", "what sizes / colors are available", "show me variants", "show details", "詳細を見せて", "サイズは？", "色は何がある？", "在庫はある？", as well as any time the buyer picks a specific item to purchase.',
      '',
      'Returns variant options, availability, pricing, and per-shop checkout URLs for the selected product. When color or size is provided, the response is narrowed to the best matching offers and capped for mobile clients.',
      'NAME → ID LOOKUP: The buyer will refer to the product by its title (e.g. "the first one", "the Levi\'s 501"). Match that to the corresponding entry in your previous search_products result and pass that entry\'s internal product_id (the Base62 value in the HTML comment) as upid. Never ask the buyer to provide an ID.',
      'IMPORTANT: Always pass the same ships_to country code used in the preceding search_products call so only offers that ship to the buyer\'s country are shown.',
      'Do NOT pass available_for_sale — the tool shows variant availability status so the buyer can choose.',
    ].join('\n'),
    {
      upid: z.string().describe('Universal Product ID (Base62) — read from the HTML comment in the previous search_products result; never ask the buyer for it'),
      context: z.string().optional().describe("Buyer context including location, e.g. 'buyer in Tokyo, Japan looking for size M in yellow'"),
      ships_to: z.string().optional().describe('2-letter ISO country code — MUST match the ships_to used in search_products (e.g. "JP", "US")'),
      color: z.string().optional().describe('Preferred color option'),
      size: z.string().optional().describe('Preferred size option'),
    },
    async ({ upid, context, ships_to, color, size }) => {
      const startedAt = Date.now();
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

      let perShopOffers = variantsOrProducts(product);

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
        perShopOffers = variantsOrProducts(fallbackProduct);
        usedFallback = true;
      }

      const selection = selectDetailOffersForDisplay(perShopOffers, product_options);
      const displayOffers = selection.displayedOffers;

      const formatOffer = (offer: Record<string, unknown>, i: number): string => {
        const hasShop = Boolean(offer.shop);
        const shop = hasShop ? ((offer.shop as Record<string, unknown> | undefined) ?? {}) : {};
        const seller = (offer.seller as Record<string, unknown> | undefined) ?? {};
        const price = offer.price as Record<string, unknown> | undefined;
        const variant = hasShop
          ? ((offer.selectedProductVariant as Record<string, unknown> | undefined) ?? {})
          : offer;
        const variantOptions = (variant.options as Array<{ name: string; value?: string; label?: string }> | undefined) ?? [];
        const priceStr = priceString(price) ?? 'N/A';
        const displayName = (offer.displayName ?? seller.name ?? seller.domain ?? shop.name) as string | undefined;
        const optStr = variantOptions.length > 0
          ? variantOptions.map((o) => `${o.name}: ${o.label ?? o.value ?? ''}`).join(', ')
          : typeof offer.displayName === 'string' ? offer.displayName : '';
        const available = (offer.availability as Record<string, unknown> | undefined)?.available ?? offer.availableForSale;
        const availStr = available === false ? ' (sold out)' : '';
        const storeUrl = (seller.url ?? shop.onlineStoreUrl ?? offer.variantUrl ?? offer.url) as string | undefined;
        const variantId = (variant.id ?? offer.id) as string | undefined;
        const checkoutUrl = (offer.checkout_url ?? offer.checkoutUrl) as string | undefined;
        return [
          `${i + 1}. **${displayName ?? 'Offer'}** — ${priceStr}${optStr ? ` (${optStr})` : ''}${availStr}`,
          checkoutUrl && available !== false
            ? `   **Checkout: ${checkoutUrl}**`
            : checkoutUrl
            ? `   Checkout (out of stock): ${checkoutUrl}`
            : '',
          storeUrl ? `   Store: ${storeUrl}` : '',
          variantId ? `   Variant ID: ${variantId}` : '',
        ].filter(Boolean).join('\n');
      };

      const lines = displayOffers.map((offer, i) => formatOffer(offer, i));

      // Product-level options (all available variants)
      const productOptions = (product.options as Array<{ name: string; values: Array<{ value?: string; label?: string; availableForSale?: boolean; availability?: { available?: boolean } }> }> | undefined) ?? [];
      const optionSummary = productOptions.map((opt) => {
        const vals = opt.values.map((v) => {
          const label = v.label ?? v.value ?? '';
          const available = v.availableForSale ?? v.availability?.available;
          return available === false ? `~~${label}~~` : label;
        });
        return `**${opt.name}**: ${vals.join(' / ')}`;
      }).join('\n');

      const detailVariants = perShopOffers.map((offer) => {
        const selected = (offer.selectedProductVariant as Record<string, unknown> | undefined) ?? offer;
        return selected;
      });
      const imageUrl = firstImageUrl(product, ...detailVariants, ...perShopOffers);
      const topFeatures = (product.topFeatures as string[] | undefined) ?? [];

      // Get product title — may be missing in some API responses; fall back to description snippet
      const productTitle = (product.title && product.title !== 'None')
        ? String(product.title)
        : (descriptionText(product.description, 60) || upid);

      const shippingNote = usedFallback
        ? `\n⚠️ No offers found shipping to ${ships_to}. Catalog fallback returned ${perShopOffers.length} global offer(s):`
        : ships_to
        ? `\nCatalog returned ${perShopOffers.length} offer(s) shipping to ${ships_to}:`
        : `\nCatalog returned ${perShopOffers.length} offer(s):`;

      const selectionNote = detailOfferSelectionNote(selection, product_options);

      const header = [
        `**${productTitle}**`,
        // Render as markdown thumbnail so clients that support image rendering
        // display it inline; falls back to a plain URL on text-only clients.
        imageUrl ? `\n![${productTitle}](${imageUrl})` : '',
        descriptionText(product.description, 300),
        optionSummary ? `\n${optionSummary}` : '',
        topFeatures.length > 0 ? `\nFeatures:\n${topFeatures.map((f) => `• ${f}`).join('\n')}` : '',
        selectionNote,
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

      console.error(`[server] get_product_details completed: upid=${extractBase62(upid)} raw_offers=${perShopOffers.length} displayed_offers=${lines.length} matching_offers=${selection.matchingOfferCount} partial_offers=${selection.partialOfferCount} selected_options=${product_options.length} used_shipping_fallback=${usedFallback} text_chars=${text.length} duration_ms=${Date.now() - startedAt}`);
      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: lookup_products
  // ----------------------------------------------------------------
  server.tool(
    'lookup_products',
    [
      'Lookup fresh Catalog data for known Shopify Catalog product or variant IDs.',
      'Use this when you already have product IDs from a previous search, saved reference, shared link, or cart flow and need current product / variant data without running a new text search.',
      'This wraps Shopify Catalog MCP `lookup_catalog` while preserving this demo server\'s friendly tool naming.',
    ].join('\n'),
    {
      ids: z.array(z.string()).min(1).max(50).describe('Catalog product or variant IDs. Global Catalog resolves up to 50 identifiers per request.'),
      context: z.string().optional().describe('Buyer context, e.g. location and intent.'),
      ships_to: z.string().optional().describe('2-letter ISO destination country code, e.g. "US" or "JP".'),
    },
    async ({ ids, context, ships_to }) => {
      const result = await lookupCatalog({
        ids,
        ...(context && { context }),
        ...(ships_to && { ships_to }),
      });
      const raw = result as Record<string, unknown>;
      const products = productArrayFromCatalogResult(raw);
      const lines = products.map((p, i) => formatSearchProduct(p, i));
      const text = lines.length > 0
        ? `Found ${lines.length} product(s):\n\n${lines.join('\n\n')}`
        : `No products resolved.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: create_cart
  // ----------------------------------------------------------------
  server.tool(
    'create_cart',
    [
      'Create a merchant cart for basket-building before checkout.',
      'Use this when the buyer wants to add items, compare totals, or keep shopping before paying. Cart line_items are full UCP item IDs from get_product_details.',
      'When the buyer is ready, call create_checkout with the returned cart_id.',
    ].join('\n'),
    {
      shop_domain: z.string().describe('Shopify store domain, e.g. "example.myshopify.com"'),
      currency: z.string().optional().describe('Merchant currency from product details, if known.'),
      line_items: z.array(z.object({
        variant_id: z.string().describe('Product variant GID'),
        quantity: z.number().int().min(1),
      })).min(1).describe('Cart items to add'),
      address_country: z.string().optional().describe('2-letter ISO country code for localization, e.g. "US" or "JP".'),
      language: z.string().optional().describe('Optional BCP 47 language tag, e.g. "en-US" or "ja-JP".'),
    },
    async ({ shop_domain, currency, line_items, address_country, language }) => {
      const result = await createCart(shop_domain, {
        ...(currency && { currency }),
        line_items,
        ...((address_country || currency || language) && {
          context: {
            ...(address_country && { address_country }),
            ...(currency && { currency }),
            ...(language && { language }),
          },
        }),
      });
      return { content: [{ type: 'text', text: formatCartResponse(result) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: get_cart
  // ----------------------------------------------------------------
  server.tool(
    'get_cart',
    'Get a merchant cart by ID. Use this before update_cart when you need to preserve the full line_items list.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      cart_id: z.string().describe('Cart ID returned by create_cart'),
    },
    async ({ shop_domain, cart_id }) => {
      const result = await getCart(shop_domain, cart_id);
      return { content: [{ type: 'text', text: formatCartResponse(result) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: update_cart
  // ----------------------------------------------------------------
  server.tool(
    'update_cart',
    'Update a merchant cart. IMPORTANT: UCP cart update is full-replace; always include every line_item that should remain in the cart, not only the changed item.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      cart_id: z.string().describe('Cart ID returned by create_cart'),
      currency: z.string().optional().describe('Merchant currency, if known.'),
      line_items: z.array(z.object({
        variant_id: z.string().describe('Product variant GID'),
        quantity: z.number().int().min(0),
      })).describe('Complete replacement line_items list. Use quantity 0 only if the merchant schema accepts it; otherwise omit removed items.'),
      address_country: z.string().optional().describe('2-letter ISO country code for localization.'),
      language: z.string().optional().describe('Optional BCP 47 language tag.'),
    },
    async ({ shop_domain, cart_id, currency, line_items, address_country, language }) => {
      const result = await updateCart(shop_domain, cart_id, {
        ...(currency && { currency }),
        line_items,
        ...((address_country || currency || language) && {
          context: {
            ...(address_country && { address_country }),
            ...(currency && { currency }),
            ...(language && { language }),
          },
        }),
      });
      return { content: [{ type: 'text', text: formatCartResponse(result) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: cancel_cart
  // ----------------------------------------------------------------
  server.tool(
    'cancel_cart',
    'Cancel an active merchant cart. Requires a unique idempotency_key (UUID) so retries are safe.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      cart_id: z.string().describe('Cart ID returned by create_cart'),
      idempotency_key: z.string().describe('Unique UUID for this cancellation attempt'),
    },
    async ({ shop_domain, cart_id, idempotency_key }) => {
      const result = await cancelCart(shop_domain, cart_id, idempotency_key);
      return { content: [{ type: 'text', text: formatCartResponse(result) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: create_checkout
  // ----------------------------------------------------------------
  server.tool(
    'create_checkout',
    [
      '**USE THIS TOOL whenever the buyer indicates intent to purchase, place an order, or check out an item from a prior get_product_details result.**',
      'Trigger phrases: "buy this", "purchase", "order it", "check out", "I\'ll take it", "add to cart and pay", "買う", "購入", "注文", "これにします", "決済して", "チェックアウト".',
      '',
      'Creates a checkout session for a product on a Shopify merchant store. Returns checkout status and a continue_url for the buyer to complete payment.',
      'If a cart was created first, prefer passing cart_id to convert the cart into a checkout. Use direct line_items only for buy-now flows.',
      'CURRENCY RULE: Pass the currency shown for the selected offer in the preceding get_product_details output (the second token of the price string, e.g. "59.00 USD" → "USD"). Do NOT infer from the buyer\'s country — a US-based store may only price/accept USD even when the buyer is in Japan; passing JPY will fail.',
      'IMPORTANT: The shop may not have enabled UCP Checkout MCP. If this tool responds with a message that says "has not enabled UCP Checkout MCP", show the buyer the checkoutUrl from get_product_details results instead — do not retry create_checkout for that shop.',
      'Extract shop_domain from the checkoutUrl hostname (e.g. "store.myshopify.com") or onlineStoreUrl.',
    ].join('\n'),
    {
      shop_domain: z.string().describe('Shopify store domain, e.g. "example.myshopify.com" — extract from checkoutUrl or onlineStoreUrl'),
      cart_id: z.string().optional().describe('Cart ID returned by create_cart. Prefer this when converting an existing cart to checkout.'),
      currency: z.string().optional().describe('ISO 4217 currency code from the selected offer in get_product_details. Required for direct line_items checkout; not needed when cart_id is provided.'),
      line_items: z.array(z.object({
        variant_id: z.string().describe('Product variant GID, e.g. "gid://shopify/ProductVariant/12345"'),
        quantity: z.number().int().min(1),
      })).optional().describe('Items to purchase for direct buy-now checkout. Omit when cart_id is provided.'),
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
      cart_id,
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
      if (!cart_id && (!line_items || line_items.length === 0)) {
        throw new Error('create_checkout requires either cart_id or line_items');
      }
      if (!cart_id && !currency) {
        throw new Error('currency is required when creating checkout directly from line_items');
      }
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
          ...(cart_id && { cart_id }),
          ...(currency && { currency }),
          ...(line_items && { line_items }),
          ...(buyer && { buyer }),
          ...(fulfillment && { fulfillment }),
        });
        return { content: [{ type: 'text', text: formatCheckoutResponse(result) }] };
      } catch (e) {
        // UcpNotSupportedError is the spec-correct signal that this shop has
        // no /.well-known/ucp manifest (or no MCP transport in it). Map it to
        // the buyer-facing "use the standard checkoutUrl" fallback. Any other
        // error (auth, network, malformed payload) is a real failure and
        // should propagate so the user can see it.
        if (e instanceof UcpNotSupportedError) {
          console.error(`[server] create_checkout UCP-unsupported on ${shop_domain}: ${e.message}`);
          return {
            content: [{
              type: 'text',
              text: `The store "${shop_domain}" has not enabled UCP Checkout MCP. Please use the checkoutUrl from the get_product_details result to direct the buyer to the merchant's standard checkout.`,
            }],
          };
        }
        throw e;
      }
    }
  );

  // ----------------------------------------------------------------
  // Tool: get_checkout
  // ----------------------------------------------------------------
  server.tool(
    'get_checkout',
    'Get the latest state for an existing checkout. Use this after buyer handoff or before deciding whether complete_checkout is allowed.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      checkout_id: z.string().describe('Checkout session ID returned by create_checkout'),
    },
    async ({ shop_domain, checkout_id }) => {
      const result = await getCheckout(shop_domain, checkout_id);
      return { content: [{ type: 'text', text: formatCheckoutResponse(result) }] };
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

      return { content: [{ type: 'text', text: formatCheckoutResponse(result) }] };
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
      return { content: [{ type: 'text', text: formatCheckoutResponse(result) }] };
    }
  );

  // ----------------------------------------------------------------
  // Tool: cancel_checkout
  // ----------------------------------------------------------------
  server.tool(
    'cancel_checkout',
    'Cancel an active checkout session. Use this when the buyer decides not to proceed. UCP spec requires a unique idempotency_key (UUID) so retries do not double-cancel.',
    {
      shop_domain: z.string().describe('Shopify store domain'),
      checkout_id: z.string().describe('Checkout session ID to cancel'),
      idempotency_key: z.string().describe('Unique UUID for this cancellation attempt (required by UCP spec for safe retries)'),
    },
    async ({ shop_domain, checkout_id, idempotency_key }) => {
      const result = await cancelCheckout(shop_domain, checkout_id, idempotency_key);
      return { content: [{ type: 'text', text: formatCheckoutResponse(result) }] };
    }
  );

  return server;
}
