# Testing with the UCP CLI

This sample wraps two underlying Shopify MCPs — the **Catalog MCP**
(`https://discover.shopifyapps.com/global/mcp`) and the **Checkout MCP**
(`https://{shop}/api/ucp/mcp`). The UCP CLI exercises those endpoints directly
using the canonical UCP tool names, so you can verify that the same flow this
sample drives end-to-end through an AI also works one tool call at a time from
the command line.

The CLI is published as `@ucpdev/ucp-cli` and lives at
[ucp.dev/docs/cli](https://ucp.dev/docs/cli). Install once:

```bash
npm install -g @ucpdev/ucp-cli   # or: pnpm add -g @ucpdev/ucp-cli
ucp --version
```

> ⚠️ The CLI calls Shopify's UCP endpoints directly — **not** this Render-hosted
> demo. The point is to verify the wire format and round-trip the spec tools.
> If a CLI command succeeds but the demo fails (or vice versa), the difference
> is in this server's wrapping logic, not in Shopify.

## 1. One-time setup — agent profile

The Catalog and Checkout MCPs both require a UCP agent profile URL in
`meta.ucp-agent.profile`. Initialize one for local testing:

```bash
ucp profile init --name "ucp-cli-tester" --capability search_catalog --capability checkout
```

This writes `~/.config/ucp/profile.json` and prints the URL the CLI will pass on
each call. To match what this sample sends, override it with the same default
this server uses:

```bash
export UCP_AGENT_PROFILE="https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json"
ucp profile use "$UCP_AGENT_PROFILE"
```

Confirm:

```bash
ucp profile show
```

## 2. Authentication

Both Shopify MCPs sit behind OAuth client-credentials. Export the same client ID
and secret you put in `.env` for this server:

```bash
export SHOPIFY_CLIENT_ID="shp_..."
export SHOPIFY_CLIENT_SECRET="..."
```

The CLI fetches the bearer from `https://api.shopify.com/auth/access_token` on
each command, just like [`src/auth.ts`](../src/auth.ts) does.

## 3. Catalog tests

### 3.1 `search_catalog` — basic query

The UCP spec name is `search_catalog`; Shopify's Catalog MCP exposes it as
`search_global_products` (see the mapping in the [README](../README.md)). The
CLI normalizes both:

```bash
ucp catalog search \
  --endpoint "https://discover.shopifyapps.com/global/mcp" \
  --query "American jeans" \
  --context "buyer in Tokyo, Japan, prefers premium denim, ships from US to JP" \
  --filter "ships_to.country=JP" \
  --filter "ships_from.country=US" \
  --filter "available_for_sale=true" \
  --limit 5
```

Expected: a list of universal offers. Each `offers[i].products[]` entry must
contain a `checkoutUrl` belonging to a US-based store that ships to JP.

### 3.2 `search_catalog` — price-bounded

```bash
ucp catalog search \
  --endpoint "https://discover.shopifyapps.com/global/mcp" \
  --query "organic Japanese skincare" \
  --context "buyer in Paris seeking natural ingredients" \
  --filter "ships_to.country=FR" \
  --filter "min_price=20" \
  --filter "max_price=80" \
  --limit 10
```

Expected: all returned `priceRange.min.amount` values fall in `[20, 80]`.

### 3.3 `get_product` — by UPID

`get_product` maps to `get_global_product_details`. Use the Base62 ID from
section 3.1's output (the `ID:` field, or the segment after `/p/` in any
`gid://shopify/p/...` string):

```bash
ucp catalog get-product \
  --endpoint "https://discover.shopifyapps.com/global/mcp" \
  --upid "AbC123XyZ" \
  --filter "ships_to.country=JP" \
  --product-option "Color=Indigo" \
  --product-option "Size=M"
```

Expected: `product.products[]` (or `product.variants[]` on the alternate
schema) contains one entry per shop that carries the requested variant.

## 4. Checkout tests

The Checkout MCP endpoint is per-shop. Pick a store from the catalog response
above — the `shop.onlineStoreUrl` or the host of `checkoutUrl` — and use it as
`{shop}` below.

> ℹ️ Many Shopify stores have **not** enabled UCP Checkout MCP yet. A 503 with
> `AuthenticationFailed` means exactly that — pick a different store, or use the
> standard `checkoutUrl` from `get_product` to send the buyer to the regular
> hosted checkout.

### 4.0 Discover the canonical endpoint — `/.well-known/ucp`

Catalog MCP often surfaces a shop's **public custom domain** (e.g.
`pojstudio.com`), but the `/api/ucp/mcp` route is canonically hosted on the
`*.myshopify.com` admin domain (e.g. `pieces-of-japan.myshopify.com`). The
UCP spec defines `/.well-known/ucp` on the public domain as the discovery
document that points to the real endpoint:

```bash
curl -s https://pojstudio.com/.well-known/ucp | jq '.ucp.services["dev.ucp.shopping"]'
# [
#   { "transport": "mcp", "endpoint": "https://pieces-of-japan.myshopify.com/api/ucp/mcp", ... },
#   { "transport": "embedded", ... }
# ]
```

If `/.well-known/ucp` returns 404, the shop hasn't enabled UCP Checkout — fall
back to the standard `checkoutUrl` from the Catalog response and let the buyer
finish in the merchant's regular hosted checkout. This sample's
[`resolveCheckoutMcpUrl`](../src/checkout.ts) does the same lookup before
every Checkout MCP call (cached in-process).

### 4.1 `create_checkout` — empty buyer + address

```bash
# Use the endpoint from 4.0, NOT the buyer-facing custom domain
SHOP="pieces-of-japan.myshopify.com"

ucp checkout create \
  --endpoint "https://$SHOP/api/ucp/mcp" \
  --currency USD \
  --line-item "id=gid://shopify/ProductVariant/12345,quantity=1"
```

Expected status: `incomplete` (no buyer info or shipping address yet). The
response contains a `checkout.id` — save it as `CHECKOUT_ID` for the next call.

### 4.2 `update_checkout` — PUT semantics, full payload

UCP's `update_checkout` is **PUT-style** — the body replaces the checkout
state. The CLI re-sends `line_items` on every update; this sample's
[`mergeCheckout`](../src/checkout.ts) does the same by fetching with
`get_checkout` first.

```bash
CHECKOUT_ID="..."   # from 4.1

ucp checkout update \
  --endpoint "https://$SHOP/api/ucp/mcp" \
  --id "$CHECKOUT_ID" \
  --line-item "id=gid://shopify/ProductVariant/12345,quantity=1" \
  --buyer "email=alice@example.com,first_name=Alice,last_name=Doe" \
  --destination "street_address=1-1-1 Chiyoda,address_locality=Chiyoda-ku,address_region=Tokyo,postal_code=100-0001,address_country=JP"
```

Expected status: usually `requires_escalation`. The response will include a
`checkout.continue_url` for the buyer to finish payment in their browser, and
one or more `messages[]` with `severity` starting with `requires_buyer_*`.
This server's [`formatCheckoutResponse`](../src/server.ts) surfaces exactly
that URL plus those messages — verifying via the CLI confirms the underlying
payload shape.

### 4.3 `get_checkout` — round-trip the state

```bash
ucp checkout get \
  --endpoint "https://$SHOP/api/ucp/mcp" \
  --id "$CHECKOUT_ID"
```

Expected: the full checkout payload from 4.2, including any
`shipping_method_handle` options the merchant offers. Use this to pick a
shipping method for a follow-up `update_checkout`.

### 4.4 `complete_checkout` — only when status is `ready_for_complete`

Once the buyer has finished the merchant-hosted step (or once enough fields
are filled to bypass escalation), status flips to `ready_for_complete`. The
spec requires an `idempotency-key`:

```bash
ucp checkout complete \
  --endpoint "https://$SHOP/api/ucp/mcp" \
  --id "$CHECKOUT_ID" \
  --idempotency-key "$(uuidgen)"
```

Expected status: `completed`, with an `order.id` and a `permalink_url` receipt.

### 4.5 `cancel_checkout` — idempotency required

```bash
ucp checkout cancel \
  --endpoint "https://$SHOP/api/ucp/mcp" \
  --id "$CHECKOUT_ID" \
  --idempotency-key "$(uuidgen)"
```

Expected status: `canceled`. Calling cancel twice with the **same** key should
return the same payload (no 409, no double-cancel) — this is the property the
demo's [`cancel_checkout`](../src/server.ts) wrapper enforces.

## 5. Cross-check against this server

If you have this demo running locally on port 3000, you can compare the wire
format the AI sees against what the CLI sends:

```bash
# Catalog: this server
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_products","arguments":{"query":"American jeans","context":"buyer in JP","ships_to":"JP","ships_from":"US","limit":3}},"id":1}'

# Catalog: CLI hitting Shopify directly
ucp catalog search \
  --endpoint "https://discover.shopifyapps.com/global/mcp" \
  --query "American jeans" \
  --context "buyer in JP" \
  --filter "ships_to.country=JP" \
  --filter "ships_from.country=US" \
  --limit 3 \
  --raw
```

The Shopify-side payload should match byte-for-byte except for the wrapping
this server does (rendering offers as Markdown bullets vs the CLI's `--raw`
JSON dump).

## 6. What this sample doesn't exercise

The UCP CLI also covers tools this sample deliberately skips. Listed here so
you know they exist and can test them against Shopify directly:

| UCP tool | Purpose | Why this sample skips it |
|---|---|---|
| `create_cart` / `get_cart` / `update_cart` / `cancel_cart` | Cart resource between catalog and checkout | This demo goes straight to `create_checkout`; see the "No cart layer" note in the [README](../README.md). |
| `get_order` | Fetch an order after `complete_checkout` returns | Out of scope for the demo flow; receipts are surfaced via `permalink_url`. |
| `get_order` companion: order webhooks | Push notifications when an order's state changes | The demo finishes at `complete_checkout`; no listener is wired. |

## References

- [UCP CLI documentation](https://ucp.dev/docs/cli)
- [Shopify Catalog MCP reference](https://shopify.dev/docs/agents/catalog/mcp)
- [Shopify Checkout MCP reference](https://shopify.dev/docs/agents/checkout/mcp)
- [UCP agent profile spec](https://ucp.dev/docs/agent-profile)
- This sample's [escalation walkthrough](./escalation.md) — what statuses the
  CLI tests above will surface and what the buyer experience looks like at each
  step.
