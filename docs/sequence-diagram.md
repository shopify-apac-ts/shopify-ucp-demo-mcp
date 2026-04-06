# Sequence Diagram — Shopify UCP Demo MCP

This diagram shows the full interaction flow between the AI Agent, Demo MCP Server, and Shopify's Catalog/Checkout APIs.

```mermaid
sequenceDiagram
    participant A as AI Agent<br/>(Claude Code)
    participant M as Demo MCP Server<br/>(Render)
    participant T as Shopify Auth<br/>(api.shopify.com)
    participant C as Shopify Catalog MCP<br/>(discover.shopifyapps.com)
    participant K as Shopify Checkout MCP<br/>({shop}.myshopify.com)

    Note over A,K: 1. Authentication — token cached for 60 minutes

    A->>M: POST /mcp · tools/call: search_products
    M->>T: POST /auth/access_token<br/>{client_id, client_secret, grant_type}
    T-->>M: {access_token, expires_in: 3600}

    Note over A,K: 2. Product Search

    M->>C: POST /global/mcp · initialize
    C-->>M: mcp-session-id
    M->>C: tools/call: search_global_products<br/>{query, context, ships_to, limit}
    C-->>M: {offers: [{id, title, options, priceRange,<br/>products[], variants[], url}]}
    M-->>A: Found N products — titles, prices,<br/>options (size/color), Base62 UPIDs

    Note over A,K: 3. Product Detail

    A->>M: tools/call: get_product_details<br/>{upid, ships_to, color, size}
    M->>T: (use cached token or refresh)
    M->>C: POST /global/mcp · initialize
    C-->>M: mcp-session-id
    M->>C: tools/call: get_global_product_details<br/>{upid, ships_to, product_options}
    C-->>M: {product: {id, description, options,<br/>variants: [{checkoutUrl, displayName, price}]}}
    M-->>A: Variant list with checkoutUrls,<br/>prices, and availability

    Note over A,K: 4. Checkout — UCP-enabled shops only

    A->>M: tools/call: create_checkout<br/>{shop_domain, currency, line_items}
    M->>K: POST /api/ucp/mcp · tools/call: create_checkout<br/>{meta: {ucp-agent: {profile}},<br/>checkout: {currency, line_items: [{quantity, item: {id}}]}}

    alt UCP Checkout supported
        K-->>M: {id, status: incomplete, continue_url}
        M-->>A: Checkout created — status + continue_url

        A->>M: tools/call: update_checkout<br/>{checkout_id, line_items, buyer, address}
        M->>K: tools/call: update_checkout<br/>{id, checkout: {line_items, buyer, fulfillment}}
        K-->>M: {status: requires_escalation, continue_url}
        M-->>A: Hand off to buyer via continue_url<br/>for payment input

        Note over A,K: Buyer completes payment in merchant UI

        A->>M: tools/call: complete_checkout<br/>{checkout_id, idempotency_key}
        M->>K: tools/call: complete_checkout<br/>{id, meta: {idempotency-key}}
        K-->>M: {status: completed, order: {id, permalink_url}}
        M-->>A: Order placed — order ID + permalink

    else 503 AuthenticationFailed (UCP not enabled on shop)
        K-->>M: HTTP 503 · {error: {message: AuthenticationFailed}}
        M-->>A: UCP Checkout not supported on this shop.<br/>Use checkoutUrl from product details instead.
    end
```

## Notes

### Token caching

The Demo MCP Server caches the bearer token from `api.shopify.com/auth/access_token` for up to 55 minutes (5-minute buffer before the 60-minute expiry). If the cached token is still valid, the auth request is skipped on subsequent calls.

### Catalog MCP session

Each call to the Catalog MCP (`search_global_products`, `get_global_product_details`) starts with an MCP `initialize` handshake. If the server returns an `mcp-session-id` header, subsequent requests in that call include it. The server is stateless — no session is persisted across user requests.

### Dual response schema from Catalog MCP

`get_global_product_details` may return per-shop offers as either:
- `product.products[]` — documented schema (shop name, checkoutUrl, selectedProductVariant)
- `product.variants[]` — alternate schema observed in practice (displayName, checkoutUrl, price)

The server handles both and extracts `checkoutUrl` from whichever is present.

### Checkout MCP fallback

The Checkout MCP endpoint (`https://{shop}.myshopify.com/api/ucp/mcp`) is only available on shops that have enabled UCP. If the call returns HTTP 503 / `AuthenticationFailed`, the server catches this and returns the cart permalink (`checkoutUrl`) from the Catalog MCP response as a direct fallback link.

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
