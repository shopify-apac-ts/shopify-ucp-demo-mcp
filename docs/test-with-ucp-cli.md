# Testing with the UCP CLI

This sample wraps two underlying Shopify MCPs — the **Catalog MCP**
(`https://discover.shopifyapps.com/global/mcp`) and the per-shop
**Checkout MCP** (`https://{shop}/api/ucp/mcp`, discovered via
`/.well-known/ucp`). Shopify ships an official CLI,
[`@shopify/ucp-cli`](https://github.com/Shopify/ucp-cli), that talks to
those endpoints directly using the canonical UCP tool names — so you can
verify that the same flow this sample drives end-to-end through an AI also
works one tool call at a time from the command line.

The full quickstart lives at
[shopify.dev/docs/agents/get-started/quickstart](https://shopify.dev/docs/agents/get-started/quickstart).

> ⚠️ The CLI calls Shopify's UCP endpoints directly — **not** this
> Render-hosted demo. The point is to verify the wire format and round-trip
> the spec tools. If a CLI command succeeds but the demo fails (or vice
> versa), the difference is in this server's wrapping logic, not in Shopify.

## 1. Install

```bash
npm install -g @shopify/ucp-cli   # or: pnpm add -g @shopify/ucp-cli
ucp --version
```

(Optional, for use inside Claude Code with the Shopify AI Toolkit plugin.)

```bash
claude plugin install shopify-ai-toolkit@claude-plugins-official
```

## 2. One-time profile setup

```bash
ucp profile init --name shopper      # writes ~/.ucp/profiles/shopper.yaml
ucp doctor                           # sanity-check setup
```

Optional: install the bundled SKILL file so your AI host knows how to drive
the CLI.

```bash
ucp skills add
```

## 3. Configure the merchant scope

Almost every command other than global catalog search takes `--business`
pointing at the merchant's public storefront URL. The CLI handles
`/.well-known/ucp` discovery itself — you don't need to substitute the
`*.myshopify.com` admin domain manually, the same way this sample's
[`resolveCheckoutMcpUrl`](../src/checkout.ts) does internally.

```bash
export UCP_BUSINESS="https://pojstudio.com"   # one merchant, used as default
```

You can also pass `--business` on every call instead.

## 4. Catalog tests

### 4.1 `catalog search` — basic query

The UCP spec name is `search_catalog`; the Catalog MCP exposes it as
`search_global_products` and this server wraps it as `search_products`
(see the [README](../README.md) mapping). The CLI invokes the spec form:

```bash
ucp catalog search \
  --set /query='American jeans' \
  --set /context='buyer in Tokyo, Japan, prefers premium denim, ships from US to JP' \
  --set /context/address_country=JP \
  --view :compact \
  --format md
```

Expected: a list of universal offers. Each `offers[i].products[]` entry
should contain a `checkoutUrl` belonging to a US-based store that ships to
JP.

> 💡 `--input-schema` on any subcommand prints the live JSON schema — use
> it to discover the exact filter keys your version of the spec accepts.
> `ucp catalog search --input-schema`

### 4.2 `catalog search` — price-bounded

```bash
ucp catalog search \
  --set /query='organic Japanese skincare' \
  --set /context='buyer in Paris seeking natural ingredients' \
  --set /context/address_country=FR \
  --set /filters/min_price=20 \
  --set /filters/max_price=80 \
  --view :compact
```

Expected: all returned `priceRange.min.amount` values fall in `[20, 80]`.

### 4.3 `catalog get_product` — by UPID

Spec name is `get_product`; Catalog MCP calls it `get_global_product_details`
and this sample wraps it as `get_product_details`. Use the Base62 ID from
4.1's output (the `ID:` field, or the segment after `/p/` in any
`gid://shopify/p/...` string):

```bash
ucp catalog get_product AbC123XyZ \
  --set /context/address_country=JP \
  --set /product_options/Color=Indigo \
  --set /product_options/Size=M \
  --view :compact
```

Expected: `product.products[]` (or `product.variants[]` on the alternate
schema) contains one entry per shop that carries the requested variant.

### 4.4 `discover` — what does this merchant actually offer?

```bash
ucp discover --business "$UCP_BUSINESS"
```

Returns the merchant's `/.well-known/ucp` services. If the response is
empty for `dev.ucp.shopping`, the shop hasn't enabled Checkout MCP — the
sections below will fail with `AuthenticationFailed` until they do.

## 5. Checkout tests

Pick a shop from the catalog response above (the `shop.onlineStoreUrl`
field). If the merchant hasn't enabled Checkout MCP, the standard
`checkoutUrl` from `get_product` still works as a regular hosted checkout —
this server's
[`formatCheckoutResponse`](../src/server.ts) falls back to surfacing that
URL.

### 5.1 `checkout create` — empty buyer + address

> ℹ️ **The buyer IP is required.** Some merchants reject `create_checkout`
> with `AuthenticationFailed: Missing required buyer IP header.` if the
> caller doesn't forward the buyer's IP. The CLI sets it from your local
> connection; this sample plumbs it from the incoming `/mcp` request via
> [`request-context.ts`](../src/request-context.ts) and also includes
> `checkout.signals["dev.ucp.buyer_ip"]` per UCP spec. In real agentic
> commerce, the AI host (not this server) is responsible for passing the
> buyer's true IP.

```bash
ucp checkout create --business "$UCP_BUSINESS" \
  --input '{
    "currency":"USD",
    "line_items":[{"item":{"id":"gid://shopify/ProductVariant/12345"},"quantity":1}]
  }'
```

Expected status: `incomplete` (no buyer info or shipping address yet). The
response contains a `checkout.id` — save it for the next call.

```bash
CHECKOUT_ID="..."   # from the create response
```

### 5.2 `checkout update` — PUT semantics, full payload

UCP's `update_checkout` is **PUT-style** — the body replaces the checkout
state. Inspect the live schema first so you know what's writable on this
checkout, then send the full payload:

```bash
ucp checkout update "$CHECKOUT_ID" --input-schema --business "$UCP_BUSINESS"

ucp checkout update "$CHECKOUT_ID" --business "$UCP_BUSINESS" \
  --input '{
    "line_items":[{"item":{"id":"gid://shopify/ProductVariant/12345"},"quantity":1}],
    "buyer":{"email":"alice@example.com","first_name":"Alice","last_name":"Doe","phone":"+81-90-1234-5678"},
    "fulfillment":{"methods":[{"type":"shipping","destinations":[{
      "first_name":"Alice","last_name":"Doe","phone":"+81-90-1234-5678",
      "street_address":"1-1-1 Chiyoda","address_locality":"Chiyoda-ku",
      "address_region":"Tokyo","postal_code":"100-0001","address_country":"JP"
    }]}]}
  }'
```

> 💡 Only send the **writable** fields shown by `--input-schema`. This
> demo's [`mergeCheckout`](../src/checkout.ts) does the same — it fetches
> the current state with `get_checkout` but strips computed/read-only
> fields (the `ucp` capabilities block, `messages`, `totals`,
> `methods[].groups`, `methods[].id`, `destinations[].id`, etc.) before
> re-sending. Echoing those back triggers `Invalid params`.

Expected status: usually `requires_escalation`. The response will include a
`checkout.continue_url` for the buyer to finish payment in their browser
and one or more `messages[]` with `severity` starting with
`requires_buyer_*`. See [escalation.md](./escalation.md) for what each
state means.

### 5.3 Handle escalation automatically

Once you've seen the `continue_url` once, wire up the escalation hook so
the CLI launches it for you on subsequent runs:

```bash
export UCP_ON_ESCALATION='jq -r .url | xargs open'   # macOS
# Linux: replace `open` with `xdg-open`
# Persist by editing `escalation.command` in ~/.ucp/config.yaml
```

### 5.4 `checkout get` — round-trip the state

```bash
ucp checkout get "$CHECKOUT_ID" --business "$UCP_BUSINESS"
```

Expected: the full checkout payload from 5.2, including any
`shipping_method_handle` options the merchant offers. Use this to pick a
shipping method for a follow-up `checkout update`.

### 5.5 `checkout complete` — only when status is `ready_for_complete`

Once the buyer has finished the merchant-hosted step (or once enough fields
are filled to bypass escalation), status flips to `ready_for_complete`.
The CLI generates an idempotency key by default:

```bash
ucp checkout complete "$CHECKOUT_ID" --business "$UCP_BUSINESS"
```

Expected status: `completed`, with an `order.id` and a `permalink_url`
receipt. This sample's
[`complete_checkout`](../src/server.ts) wrapper accepts the same shape
(taking an explicit `idempotency_key` arg for caller-supplied retries).

### 5.6 `checkout cancel` — idempotency required

```bash
ucp checkout cancel "$CHECKOUT_ID" --business "$UCP_BUSINESS"
```

Expected status: `canceled`. Calling cancel twice with the same internal
idempotency key returns the same payload — this is the property the demo's
[`cancel_checkout`](../src/server.ts) wrapper enforces.

## 6. Cross-check against this server

If you have this demo running locally on port 3000, you can compare the
wire format the AI sees against what the CLI sends:

```bash
# Catalog: this server (spec name wrapped)
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"search_products","arguments":{"query":"American jeans","context":"buyer in JP","ships_to":"JP","ships_from":"US","limit":3}},"id":1}'

# Catalog: CLI hitting Shopify directly, raw JSON
ucp catalog search \
  --set /query='American jeans' \
  --set /context='buyer in JP' \
  --set /context/address_country=JP \
  --format json
```

The Shopify-side payload should match byte-for-byte except for the
wrapping this server does (rendering offers as Markdown bullets vs the
CLI's `--format json` dump).

`--dry-run` on any UCP command prints the payload the CLI would send
without actually sending it — useful for diffing against the
`[checkout] ... body:` lines this server logs.

## 7. What this sample doesn't exercise

The UCP CLI also covers tools this sample deliberately skips. Listed here
so you know they exist and can test them against Shopify directly:

| UCP CLI command | Purpose | Why this sample skips it |
|---|---|---|
| `cart create` / `cart get` / `cart update` / `cart cancel` | Cart resource between catalog and checkout | This demo goes straight to `checkout create`; see the "No cart layer" note in the [README](../README.md). |
| `order get` | Fetch an order after `checkout complete` returns | Out of scope for the demo flow; receipts are surfaced via `permalink_url`. |
| Order webhooks | Push notifications when an order's state changes | The demo finishes at `checkout complete`; no listener is wired. |

## References

- [Shopify UCP CLI quickstart](https://shopify.dev/docs/agents/get-started/quickstart)
- [`@shopify/ucp-cli` on GitHub](https://github.com/Shopify/ucp-cli)
- [Shopify Catalog MCP reference](https://shopify.dev/docs/agents/catalog/mcp)
- [Shopify Checkout MCP reference](https://shopify.dev/docs/agents/checkout/mcp)
- [UCP specification (ucp.dev)](https://ucp.dev/)
- This sample's [escalation walkthrough](./escalation.md) — what statuses
  the CLI tests above will surface and what the buyer experience looks
  like at each step.
