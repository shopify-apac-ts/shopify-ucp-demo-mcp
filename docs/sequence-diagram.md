# Sequence Diagram — Shopify UCP Demo MCP

This diagram shows the full interaction flow between the AI Agent, Demo MCP Server, and Shopify's Catalog/Checkout APIs.

```mermaid
sequenceDiagram
    participant A as AI Agent<br/>(Claude Code)
    participant M as Demo MCP Server<br/>(Render)
    participant T as Shopify Auth<br/>(api.shopify.com)
    participant C as Shopify Global Catalog MCP<br/>(catalog.shopify.com)
    participant K as Shopify Cart / Checkout MCP<br/>(merchant endpoint)

    Note over A,K: 1. Authentication — token cached until expires_in or 60min fallback, with a 5min buffer

    A->>M: POST /mcp · tools/call: search_products
    M->>T: POST /auth/access_token<br/>{client_id, client_secret, grant_type}
    T-->>M: {access_token, token_type, expires_in?}

    Note over A,K: 2. Product Search

    M->>C: POST /api/ucp/mcp · tools/call: search_catalog<br/>{catalog: {query, context, filters, pagination}}
    C-->>M: {products: [{id, title, options, price_range,<br/>variants[], media[], url}]}
    M-->>A: Found N products — titles, prices,<br/>merchant-defined options, Base62 UPIDs

    Note over A,K: 3. Product Detail

    A->>M: tools/call: get_product_details<br/>{upid, ships_to, options[]}
    M->>T: (use cached token or refresh)
    M->>C: POST /api/ucp/mcp · tools/call: get_product<br/>{catalog: {id, selected, filters}}
    C-->>M: {product: {id, description, options,<br/>variants: [{checkout_url, seller, price, availability}]}}
    M-->>A: Variant list with checkout URLs,<br/>prices, sellers, and availability

    Note over A,K: 4. Checkout — discovery via /.well-known/ucp

    opt Basket-building flow
        A->>M: tools/call: create_cart<br/>{shop_domain, line_items, context}
        M->>K: tools/call: create_cart<br/>{cart: {line_items, context}}
        K-->>M: {id, line_items, totals}
        M-->>A: Cart ID + totals
    end

    Note over A: AI carries currency + variant_id<br/>or cart_id from prior steps<br/>(do NOT infer currency<br/>from buyer country)
    A->>M: tools/call: create_checkout<br/>{shop_domain, cart_id}<br/>or {currency, line_items}

    Note over M: Resolve canonical Checkout MCP<br/>endpoint via UCP discovery<br/>(cached after first hit)
    M->>K: GET https://{shop}/.well-known/ucp

    alt UCP Checkout enabled (manifest present)
        K-->>M: 200 · {ucp.services["dev.ucp.shopping"]<br/>[{transport: "mcp", endpoint}]}

        Note over M,K: All Checkout MCP calls forward buyer IP<br/>via Shopify-Buyer-IP header (required) + body signal<br/>checkout.signals["dev.ucp.buyer_ip"] (spec-compliance)
        M->>K: POST {endpoint} · tools/call: create_checkout<br/>{meta: {ucp-agent: {profile}}, cart_id}<br/>or {checkout: {currency, line_items, signals}}
        K-->>M: {id, status: incomplete, continue_url}
        M-->>A: Status: incomplete · checkout_id<br/>(continue_url decorated with<br/>utm_source + skip_shop_pay=true)

        A->>M: tools/call: update_checkout<br/>{checkout_id, line_items, buyer, address}

        Note over M,K: UCP update_checkout is PUT-style — body fully<br/>replaces state. Fetch current, strip computed<br/>fields, merge updates, mirror buyer name/phone<br/>onto destinations.
        M->>K: tools/call: get_checkout {id}
        K-->>M: Full checkout state
        M->>K: tools/call: update_checkout<br/>{id, checkout: whitelisted-and-merged}
        K-->>M: {status: requires_escalation,<br/>continue_url, messages[]}
        M-->>A: Hand off to buyer via continue_url<br/>(decorated · payment input in browser)

        Note over A,K: Buyer completes payment in merchant UI

        A->>M: tools/call: complete_checkout<br/>{checkout_id, idempotency_key}
        M->>K: tools/call: complete_checkout<br/>{id, meta: {idempotency-key}}
        K-->>M: {status: completed, order: {id, permalink_url}}
        M-->>A: Order placed — order ID + permalink<br/>(utm_source appended)

    else UCP not enabled (no /.well-known/ucp manifest)
        K-->>M: HTTP 404
        Note over M: Throw UcpNotSupportedError
        M-->>A: "The store {shop} has not enabled UCP<br/>Checkout MCP." Use checkoutUrl from<br/>get_product_details instead.
    end
```

## Notes

### Token caching

The Demo MCP Server caches the bearer token from `api.shopify.com/auth/access_token` until `expires_in` when present, otherwise for Shopify's documented 60-minute expiry, with a 5-minute refresh buffer. If the cached token is still valid, the auth request is skipped on subsequent calls. The same token is used for Catalog, Cart, and Checkout MCP calls.

### Catalog MCP — no initialize handshake

Calls to the Global Catalog MCP go straight to `tools/call` with no prior `initialize` handshake. Skipping `initialize` halves the round-trips per user request in this sample.

### Dual response schema from Catalog MCP

Catalog responses may return per-shop offers as either:
- `products[]` / `product.products[]` — older schema (shop name, checkoutUrl, selectedProductVariant)
- `products[].variants[]` / `product.variants[]` — current schema (seller, checkout_url, price, availability)

The server handles both and extracts `checkoutUrl` / `checkout_url` from whichever is present.

### Checkout MCP discovery and fallback

The canonical Checkout MCP endpoint is discovered via the UCP manifest at `https://{shop}/.well-known/ucp` (see `src/checkout.ts` `resolveCheckoutMcpUrl`). The manifest is required because the Catalog MCP often surfaces a shop's public custom domain, while the actual `/api/ucp/mcp` route may live on a different `*.myshopify.com` host — only the manifest tells us the mapping. Resolved endpoints are cached in-process so repeat calls don't re-fetch.

If the manifest returns **HTTP 404** (or is missing the `dev.ucp.shopping` MCP transport), the server throws `UcpNotSupportedError` and the `create_checkout` tool responds with a buyer-facing message telling the AI to fall back to the standard `checkoutUrl` cart permalink from the Catalog MCP response.

### Buyer IP propagation

Shopify's Checkout MCP requires the `Shopify-Buyer-IP` HTTP header with a valid IPv4 or IPv6 address when calling tools that mutate cart state under a trusted authentication method — omitting it returns HTTP 422 with `Missing required buyer IP header.` (observed empirically). This server forwards the IP via the `Shopify-Buyer-IP` header **and** the UCP-spec body signal `checkout.signals["dev.ucp.buyer_ip"]` (the header is what Shopify currently enforces on; the body signal is kept for spec compliance and forward compatibility). The buyer IP comes from `req.ip` (Express `trust proxy` set so Render's `X-Forwarded-For` is honored) and is propagated through the request via `AsyncLocalStorage` in `src/request-context.ts`. In this Remote MCP topology the captured IP is the AI provider's, not the buyer's true client IP; production deployments serving real buyer traffic should pass the buyer's true IP.

### continue_url decoration

Before handing `continue_url` back to the AI, the server appends two query params:

- `utm_source=ucp_demo_app` — lets the merchant attribute traffic from this sample in their analytics.
- `skip_shop_pay=true` — community-verified workaround that disables Shopify's "auto Shop Pay login" default. Without it, when the buyer's email matches an existing Shop Pay account, the hosted checkout opens straight into an OTP prompt and ignores the address/buyer fields the agent already filled via `update_checkout`.

The receipt `permalink_url` returned on `status: completed` is similarly tagged with `utm_source` (no `skip_shop_pay` needed there).

### Checkout status flow

```
create_checkout
    ↓
status: incomplete       → update_checkout (add missing buyer/address info)
    ↓
status: requires_escalation → show continue_url to buyer (payment UI)
    ↓
status: ready_for_complete  → complete_checkout
    ↓
status: completed ✓
```
