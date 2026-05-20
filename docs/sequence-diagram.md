# Sequence Diagram — Shopify UCP Demo MCP

This diagram shows the full interaction flow between the AI Agent, Demo MCP Server, and Shopify's Catalog/Checkout APIs.

```mermaid
sequenceDiagram
    participant A as AI Agent<br/>(Claude Code)
    participant M as Demo MCP Server<br/>(Render)
    participant T as Shopify Auth<br/>(api.shopify.com)
    participant C as Shopify Catalog MCP<br/>(discover.shopifyapps.com)
    participant K as Shopify Checkout MCP<br/>({shop}.myshopify.com)

    Note over A,K: 1. Authentication — token cached 55min (60min TTL − 5min buffer)

    A->>M: POST /mcp · tools/call: search_products
    M->>T: POST /auth/access_token<br/>{client_id, client_secret, grant_type}
    T-->>M: {access_token, token_type}<br/>(no expires_in — hardcode 60min TTL)

    Note over A,K: 2. Product Search

    M->>C: POST /global/mcp · tools/call: search_global_products<br/>{query, context, ships_to, limit}
    C-->>M: {offers: [{id, title, options, priceRange,<br/>products[], variants[], url}]}
    M-->>A: Found N products — titles, prices,<br/>options (size/color), Base62 UPIDs

    Note over A,K: 3. Product Detail

    A->>M: tools/call: get_product_details<br/>{upid, ships_to, color, size}
    M->>T: (use cached token or refresh)
    M->>C: POST /global/mcp · tools/call: get_global_product_details<br/>{upid, ships_to, product_options}
    C-->>M: {product: {id, description, options,<br/>variants: [{checkoutUrl, displayName, price}]}}
    M-->>A: Variant list with checkoutUrls,<br/>prices, and availability

    Note over A,K: 4. Checkout — discovery via /.well-known/ucp

    Note over A: AI carries currency + variant_id<br/>from the get_product_details<br/>response (do NOT infer currency<br/>from buyer country)
    A->>M: tools/call: create_checkout<br/>{shop_domain, currency, line_items}

    Note over M: Resolve canonical Checkout MCP<br/>endpoint via UCP discovery<br/>(cached after first hit)
    M->>K: GET https://{shop}/.well-known/ucp

    alt UCP Checkout enabled (manifest present)
        K-->>M: 200 · {ucp.services["dev.ucp.shopping"]<br/>[{transport: "mcp", endpoint}]}

        Note over M,K: All Checkout MCP calls forward buyer IP<br/>via 5 candidate headers + body signal<br/>checkout.signals["dev.ucp.buyer_ip"]
        M->>K: POST {endpoint} · tools/call: create_checkout<br/>{meta: {ucp-agent: {profile}},<br/>checkout: {currency, line_items, signals}}
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

The Demo MCP Server caches the bearer token from `api.shopify.com/auth/access_token` for 55 minutes (5-minute buffer before the documented 60-minute expiry). The `/auth/access_token` response does not include an `expires_in` field — measured 2026-05-19, response keys are only `[access_token, token_type]` — so the TTL is hardcoded against Shopify's documented value. If the cached token is still valid, the auth request is skipped on subsequent calls. The same token is used for both the Catalog MCP and the Checkout MCP.

### Catalog MCP — no initialize handshake

Calls to the Catalog MCP go straight to `tools/call` with no prior `initialize` handshake. Measured 2026-05-19: `tools/call` returns HTTP 200 in ~390ms with no `mcp-session-id` header issued or required. Skipping `initialize` halves the round-trips per user request.

### Dual response schema from Catalog MCP

`get_global_product_details` may return per-shop offers as either:
- `product.products[]` — documented schema (shop name, checkoutUrl, selectedProductVariant)
- `product.variants[]` — alternate schema observed in practice (displayName, checkoutUrl, price)

The server handles both and extracts `checkoutUrl` from whichever is present.

### Checkout MCP discovery and fallback

The canonical Checkout MCP endpoint is discovered via the UCP manifest at `https://{shop}/.well-known/ucp` (see `src/checkout.ts` `resolveCheckoutMcpUrl`). The manifest is required because the Catalog MCP often surfaces a shop's public custom domain (e.g. `pojstudio.com`), while the actual `/api/ucp/mcp` route lives on the `*.myshopify.com` host — only the manifest tells us the mapping. Resolved endpoints are cached in-process so repeat calls don't re-fetch.

If the manifest returns **HTTP 404** (or is missing the `dev.ucp.shopping` MCP transport), the server throws `UcpNotSupportedError` and the `create_checkout` tool responds with a buyer-facing message telling the AI to fall back to the standard `checkoutUrl` cart permalink from the Catalog MCP response.

### Buyer IP propagation

Shopify's Checkout MCP rejects `create_checkout` with `AuthenticationFailed: Missing required buyer IP header.` if the caller doesn't forward the buyer's IP. The exact field name isn't documented, so this server sends every plausible candidate at once: HTTP headers `Shopify-Storefront-Buyer-IP`, `Shopify-Buyer-IP`, `X-Forwarded-For`, `X-Real-IP`, `Buyer-IP`, **and** the UCP-spec body signal `checkout.signals["dev.ucp.buyer_ip"]`. The buyer IP comes from `req.ip` (Express `trust proxy` set so Render's `X-Forwarded-For` is honored) and is propagated through the request via `AsyncLocalStorage` in `src/request-context.ts`.

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
