# Tips & Best Practices — Shopify UCP Demo MCP

This document covers implementation tips for getting better results from the Shopify Catalog and Checkout MCPs. All of these are implemented in this sample repository and can be used as a reference for your own UCP agent.

## 1. Combine `ships_to` and `ships_from` for origin-specific queries

`ships_to` alone filters to stores that ship to the buyer's country. For queries that mention a product origin (e.g. "American-made jeans", "Japanese skincare"), also pass `ships_from` to narrow results to stores that ship *from* that origin country.

| Query | `ships_to` | `ships_from` |
|---|---|---|
| American-made jeans available in Tokyo | `JP` | `US` |
| Japanese traditional goods in the US | `US` | `JP` |
| Italian leather bags shipping to France | `FR` | `IT` |

```json
{
  "name": "search_global_products",
  "arguments": {
    "query": "American-made denim jeans",
    "context": "buyer in Tokyo looking for authentic US denim brands",
    "ships_to": "JP",
    "ships_from": "US"
  }
}
```

Using only `ships_to: "JP"` would return any store worldwide that ships to Japan. Adding `ships_from: "US"` restricts results to US-based stores shipping to Japan — far more relevant for origin-specific queries.

## 2. Write rich `context` — it is marked "critical" in the Catalog MCP spec

The `context` parameter has a significant impact on result quality. Shopify's Catalog MCP documentation marks it as **Required (critical)**. A detailed context helps the AI and the Catalog engine surface more relevant products.

**Poor context:**
```
"buyer in Japan"
```

**Rich context:**
```
"buyer in Tokyo, Japan looking for authentic American-made premium denim jeans,
prefers well-known US brands, quality over price, ships from US to JP"
```

Always include:
- Buyer's location (city and country)
- Product origin if mentioned in the query
- Style or quality preferences
- Brand expectations (premium, budget, specific brands)
- Any other details from the conversation

## 3. Show product ratings to help buyers choose

The `search_global_products` response includes `rating: { value, count }` at both the universal product level and the per-shop offer level (`products[].rating`). Surface this in your UI so buyers can prioritize highly rated products.

```json
// In the search response:
{
  "offers": [{
    "title": "Levi's 501 Original Jeans",
    "rating": { "value": 4.8, "count": 312 },
    "products": [{
      "rating": { "value": 4.9, "count": 87 },
      ...
    }]
  }]
}
```

This sample server displays ratings inline in search results:
```
1. **Levi's 501 Original Jeans** — 89.00 USD  ⭐ 4.8 (312)
```

## 4. `products_limit` is capped at 10

The `products_limit` parameter controls how many per-shop offers are returned per universal product. The API maximum is **10** (default: 10). There is no way to retrieve more than 10 per-shop offers per product in a single call.

If you need to compare more shops for a single product, consider calling `get_global_product_details` with different `ships_to` / `ships_from` combinations.

## 5. Discover Checkout MCP via /.well-known/ucp and fall back gracefully

Not every Shopify store has enabled the UCP Checkout MCP. The UCP spec defines `https://{shop}/.well-known/ucp` as the discovery document — fetch it once per shop and read `ucp.services["dev.ucp.shopping"][].endpoint` to find the canonical Checkout MCP URL. This matters because the Catalog MCP usually surfaces the shop's public custom domain (e.g. `pojstudio.com`), while the actual `/api/ucp/mcp` route lives on the `*.myshopify.com` host — only the manifest tells you the mapping.

When the manifest returns **HTTP 404** (or omits the `dev.ucp.shopping` MCP transport), treat it as a clear "UCP not enabled on this shop" signal. Throw a typed error (see `UcpNotSupportedError` in [src/checkout.ts](../src/checkout.ts)) so the caller can catch it and fall back to the `checkoutUrl` cart permalink from the Catalog MCP response.

```
/.well-known/ucp present     →  create_checkout → update_checkout → continue_url
/.well-known/ucp returns 404 →  show checkoutUrl from search/detail results
```

The `checkoutUrl` is a standard Shopify cart permalink that works for all stores, regardless of UCP support:
```
https://store.myshopify.com/cart/VARIANT_ID:QUANTITY?_gsid=...
```

Two practical refinements this sample uses:

- **In-process cache** the resolved endpoint per shop — shops rarely change their UCP routing and discovery shouldn't be re-fetched on every checkout call.
- **Short timeout (5s) on the manifest fetch** with a degraded fallback to the naive `*.myshopify.com/api/ucp/mcp` heuristic on network errors, so a flaky DNS lookup doesn't take the whole checkout flow down. A genuine 404 still throws `UcpNotSupportedError`.

## 6. Carry currency from product details into checkout

The `currency` argument for `create_checkout` must match the **merchant's pricing currency**, not the buyer's country. A US-based store can sell to a JP buyer but may only price and accept payment in USD — passing `JPY` in that case will fail. Take the currency directly from the offer returned by `get_product_details`:

```json
// In the get_product_details response:
{
  "products": [{
    "price": { "amount": "59.00", "currencyCode": "USD" },
    "checkoutUrl": "..."
  }]
}
```

```json
// Pass that currency through to create_checkout:
{
  "name": "create_checkout",
  "arguments": {
    "shop_domain": "store.myshopify.com",
    "currency": "USD",
    "line_items": [{ "variant_id": "...", "quantity": 1 }]
  }
}
```

This sample server's `create_checkout` tool description tells the AI explicitly: *"Pass the currency shown for the selected offer in the preceding get_product_details output. Do NOT infer from the buyer's country."* The sequence diagram in [sequence-diagram.md](sequence-diagram.md) also marks this handoff.

## 7. Token caching — hardcode the TTL

The bearer token from `api.shopify.com/auth/access_token` is documented as valid for 60 minutes, but the response body **does not include an `expires_in` field** — measured 2026-05-19, the only keys returned are `access_token` and `token_type`. A naive `Date.now() + data.expires_in * 1000` becomes `NaN` and your cache never hits.

Hardcode the documented 60-minute TTL and refresh with a 5-minute buffer:

```ts
const TOKEN_TTL_MS = 60 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// On successful fetch:
tokenExpiresAt = Date.now() + TOKEN_TTL_MS;

// On every getBearerToken() call:
if (cachedToken && Date.now() < tokenExpiresAt - EXPIRY_BUFFER_MS) {
  return cachedToken;
}
```

The same token is used for both the Catalog MCP and the Checkout MCP — no separate credentials are needed.

## 8. Skip the Catalog MCP `initialize` handshake

The MCP spec describes an `initialize` request that returns an `mcp-session-id` header used by subsequent `tools/call` requests. Measured 2026-05-19, the Catalog MCP at `https://discover.shopifyapps.com/global/mcp` accepts `tools/call` **directly** with no prior `initialize` and no session header — and returns HTTP 200 in ~390ms.

Sending `initialize` first doubles the round-trips for every search and detail call without any functional benefit. Go straight to `tools/call`:

```ts
const response = await fetch(CATALOG_MCP_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'search_global_products', arguments: { ... } },
    id: 1,
  }),
});
```

## References

- [Catalog MCP Reference](https://shopify.dev/docs/agents/catalog/mcp)
- [Checkout MCP Reference](https://shopify.dev/docs/agents/checkout/mcp)
- [About Shopify Catalog](https://shopify.dev/docs/agents/catalog)
- [Universal Commerce Protocol](https://ucp.dev)
