# Shopify UCP Demo — Remote MCP Server

A Remote MCP server that lets any AI agent (Claude, ChatGPT, etc.) search Shopify's global product catalog and complete purchases using the [Universal Commerce Protocol (UCP)](https://ucp.dev).

## What it does

| Tool | Description |
|---|---|
| `search_products` | Search hundreds of millions of products across all Shopify merchants by text or image similarity |
| `lookup_products` | Refresh known Catalog product or variant IDs without running a new search |
| `get_product_details` | Get full variant details and checkout URLs for a specific product |
| `create_cart` | Create a merchant cart for basket building |
| `get_cart` | Retrieve an existing merchant cart |
| `update_cart` | Replace the full cart line-item state |
| `cancel_cart` | Cancel an active cart |
| `create_checkout` | Start a checkout session on a merchant's store |
| `get_checkout` | Retrieve an existing checkout state |
| `update_checkout` | Add buyer info, shipping address, select shipping method |
| `complete_checkout` | Place the order when checkout status is `ready_for_complete` |
| `cancel_checkout` | Cancel an active checkout session |

### UCP-spec tool mapping

This sample exposes its own tool names (above) but each one is a thin wrapper around the
canonical Universal Commerce Protocol tools defined by Shopify. The mapping is:

| This server | UCP / Shopify spec tool | Endpoint |
|---|---|---|
| `search_products` | [`search_catalog`](https://shopify.dev/docs/agents/catalog/global-catalog#search_catalog) | Global Catalog MCP — `https://catalog.shopify.com/api/ucp/mcp` |
| `lookup_products` | [`lookup_catalog`](https://shopify.dev/docs/agents/catalog/global-catalog#lookup_catalog) | Global Catalog MCP — `https://catalog.shopify.com/api/ucp/mcp` |
| `get_product_details` | [`get_product`](https://shopify.dev/docs/agents/catalog/global-catalog#get_product) | Global Catalog MCP — `https://catalog.shopify.com/api/ucp/mcp` |
| `create_cart` | [`create_cart`](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp#create_cart) | Cart MCP — discovered via `/.well-known/ucp` |
| `get_cart` | [`get_cart`](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp#get_cart) | Cart MCP — discovered via `/.well-known/ucp` |
| `update_cart` | [`update_cart`](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp#update_cart) (full replacement) | Cart MCP — discovered via `/.well-known/ucp` |
| `cancel_cart` | [`cancel_cart`](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp#cancel_cart) | Cart MCP — discovered via `/.well-known/ucp` |
| `create_checkout` | [`create_checkout`](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp#create_checkout) | Checkout MCP — discovered via `/.well-known/ucp` |
| `get_checkout` | [`get_checkout`](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp#get_checkout) | Checkout MCP — discovered via `/.well-known/ucp` |
| `update_checkout` | [`update_checkout`](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp#update_checkout) (PUT semantics) | Checkout MCP — discovered via `/.well-known/ucp` |
| `complete_checkout` | [`complete_checkout`](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp#complete_checkout) | Checkout MCP — discovered via `/.well-known/ucp` |
| `cancel_checkout` | [`cancel_checkout`](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp#cancel_checkout) | Checkout MCP — discovered via `/.well-known/ucp` |

Every outgoing call carries `meta.ucp-agent.profile` (see `UCP_AGENT_PROFILE` below).
Calls that mutate state (`cancel_cart`, `complete_checkout`, `cancel_checkout`) also carry
`meta.idempotency-key` so retries are safe.

### Image similarity search

`search_products` supports Shopify Global Catalog similarity search by accepting
a base64-encoded image:

- `image_base64` — raw base64 image data, without a `data:` URL prefix
- `image_content_type` — MIME type such as `image/jpeg`, `image/png`, or
  `image/webp`
- `image_url` — optional HTTP(S) image URL fallback for clients that can render
  or pass Markdown image URLs but do not pass binary attachments as base64 tool
  arguments

When `query` is also provided, Catalog uses the text to narrow the visual
similarity search. When only an image is provided, Catalog searches for visually
similar products. Continue to pass `context` and `ships_to` so results are
relevant and shippable for the buyer.

### Cart layer

The full UCP spec defines a cart resource (`create_cart` / `get_cart` /
`update_cart` / `cancel_cart`) between catalog search and checkout. This sample
now exposes those tools as thin wrappers for basket-building demos. You can
still skip cart for a single-item buy-now flow by calling `create_checkout` with
direct `line_items`.

For multi-step shopping, prefer:

1. `search_products` / `get_product_details`
2. `create_cart`
3. `get_cart` / `update_cart` while the buyer iterates
4. `create_checkout` with `cart_id`

## Architecture

```
User's AI (Claude / ChatGPT / etc.)
    ↓  Remote MCP  (Streamable HTTP POST /mcp)
This Server  (Node.js on Render)
    ├──→  Shopify Global Catalog MCP  (https://catalog.shopify.com/api/ucp/mcp)
    └──→  Shopify Cart / Checkout MCP (discovered via /.well-known/ucp)
```

For a detailed sequence diagram showing the full interaction flow between the AI Agent, Demo MCP Server, and Shopify APIs, see [docs/sequence-diagram.md](docs/sequence-diagram.md).

For an explanation of UCP escalation — what this sample demos, what it doesn't, and how its tools map to the buyer-experience modes — see [docs/escalation.md](docs/escalation.md).

For implementation tips on improving search quality, ratings, and checkout handling, see [docs/tips.md](docs/tips.md).

To verify the wire format using Shopify's official [`@shopify/ucp-cli`](https://shopify.dev/docs/agents/get-started/quickstart) — including the spec-named tools (`search_catalog`, `get_product`, `create_checkout`, etc.) that this sample wraps — see [docs/test-with-ucp-cli.md](docs/test-with-ucp-cli.md).

## UCP Demo Self-Test

The historically named `harness/` directory contains lightweight self-tests and
diagnostics for demo-quality checks. It runs saved buyer-intent cases against the
same Catalog and Checkout discovery code used by the MCP server, then writes a
JSON and Markdown report with:

- Catalog payloads and response summaries
- `products[]` vs `variants[]` response-shape detection
- checkout URL and merchant host coverage
- `/.well-known/ucp` discovery classification
- likely issue codes such as `catalog_no_match`,
  `shipping_filter_too_strict`, `response_shape_changed`, and
  `checkout_ucp_unsupported`

Committed self-test cases do not hardcode specific merchant names or domains.
Merchant discovery checks use merchants returned by live Catalog results, and
reports redact live merchant domains and endpoints by default. If you need to
debug a specific merchant, keep that case under ignored `harness/private/` and
run with `--include-merchant-details` only for local diagnosis.

Run every sample case:

```bash
pnpm run self-test
```

Run one case:

```bash
pnpm run self-test -- --case harness/cases/us-made-denim-to-jp.json
```

List cases without making network calls:

```bash
pnpm run self-test -- --list
```

Reports are written to `harness/reports/` and are intentionally ignored by Git.
Use them to debug cases where an expected product, merchant, checkout URL, or
UCP shopping endpoint does not appear.

To include live merchant domains and endpoints in local-only reports:

```bash
pnpm run self-test -- --include-merchant-details
```

`pnpm run harness` remains as a backward-compatible alias for older local
notes and scripts.

## Setup

### 1. Get Shopify API credentials

1. Go to [Shopify Dev Dashboard](https://dev.shopify.com/dashboard)
2. Navigate to **Catalogs** → **Get an API key**
3. Create a key and copy your **client ID** and **client secret**

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run locally

```bash
pnpm install
pnpm run dev
```

The MCP endpoint is available at `http://localhost:3000/mcp`.

### 4. Deploy to Render

1. Push to GitHub (triggers auto-deploy via Render)
2. Set the **Build Command** in Render dashboard to:
   ```
   pnpm install --prod=false && pnpm run build
   ```
3. Set **Start Command** to:
   ```
   node dist/index.js
   ```
4. Set environment variables in Render dashboard:
   - `SHOPIFY_CLIENT_ID`
   - `SHOPIFY_CLIENT_SECRET`
   - `UCP_AGENT_PROFILE` *(optional)* — defaults to Shopify's published reference profile JSON. Override only if you self-host a custom UCP profile document.
   - `SHOPIFY_CATALOG_ID` *(optional)* — saved catalog slug from Dev Dashboard

## Connect your AI to this MCP server

Add the following to your AI's MCP configuration:

```json
{
  "mcpServers": {
    "shopify-ucp": {
      "url": "https://your-app-name.onrender.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shopify-ucp": {
      "url": "https://your-app-name.onrender.com/mcp"
    }
  }
}
```

For Claude mobile app via Claude web Custom Connector:

1. Open Claude web with the same account you use in the mobile app.
2. Go to **Settings** → **Connectors**.
3. Add a **Custom Connector**.
4. Use a clear name such as `Shopify UCP Demo`.
5. Set the connector endpoint to:
   ```text
   https://your-app-name.onrender.com/mcp
   ```
6. Save the connector, then open Claude mobile app and select it from the
   connector list before asking product discovery or checkout questions.
   [Check Demo](../../wiki#demo).

For Claude Code (CLI):

```bash
claude mcp add shopify-ucp --transport http https://your-app-name.onrender.com/mcp
```

## Demo

See the [Wiki](../../wiki) for a video walkthrough of Claude mobile using this
server as a custom connector. The demo starts with this prompt:

> **中年男性向けの夏のシャツをUCPで探して**

The video then continues with follow-up prompts for product images, item
selection, variant selection, shipping details, and checkout handoff:

```text
商品画像
リネンシャツ
ブラックM
名前は山田太郎、メールアドレスは test@example.com 配送先は東京都のWeWork アイスバーグで。
1F, 6丁目-12-18 神宮前 渋谷区 東京都 150-0001
氏名は山田太郎、電話番号は、09012345678
```

## Example conversation

> **User:** Find me a spring parka available in Tokyo.
>
> **AI:** *(detects "Tokyo" → `ships_to: "JP"`, calls `search_products`)*
> Here are 5 parkas that ship to Japan...
>
> **User:** Tell me more about the first one.
>
> **AI:** *(calls `get_product_details` with `ships_to: "JP"`)*
> Available sizes: S / M / L / XL. Checkout: [url]
>
> **User:** I'll take size M.
>
> **AI:** *(calls `create_checkout` with the variant ID)*
> Checkout started. What's your shipping address?
>
> **User:** 〒100-0001 東京都千代田区...
>
> **AI:** *(calls `update_checkout` with address)*
> Ready to complete. Please proceed to payment: [continue_url]

### More sample prompts

These prompts go beyond search — each one expects the AI to pick a product, pre-fill saved buyer info, and hand back a payment-ready `continue_url` in a single turn.

| Scenario | Prompt (EN) | Prompt (JP) |
|---|---|---|
| US-made → ship to JP | American-made selvedge denim jeans (W32 L32), around $200, that can ship to Tokyo. Pick one, use my usual address and email, and get it ready so I just need to pay. | 東京に発送できる、アメリカ製セルビッジデニム (W32 L32) を $200 前後で 1 本選んで。いつもの住所と連絡先で、あとは支払うだけの状態にして。 |
| JP-style → ship within US | A Japanese-style cotton sashiko jacket in size M, under $150, that ships within the US. Pick one and set it up to ship to my California address — I just want to pay and be done. | アメリカ国内で買える、日本風のサシコ・ジャケット (M, $150 以下) を 1 着。カリフォルニアの住所に送るかたちで、あとはお支払いするだけにしておいて。 |
| Gift to a US friend | I want to send a traditional Japanese ceramic mug (under $40) to my friend in Brooklyn as a gift. Pick one from a US shop, ship to [friend's address], and take me straight to the payment page. | ブルックリンの友人へのギフトに、日本の伝統的な陶器マグ ($40 以下) を 1 つ贈りたい。US 国内発送のショップから選んで、配送先は [friend's address]、そのまま支払いに進めるところまでお願い。 |
| Ready-to-buy | Order a 12oz bag of single-origin coffee roasted in Maine, around $20, shipped to my usual US address. One pick is fine — take me to payment. | メイン州焙煎のシングルオリジンコーヒー (12oz, $20 前後) を、いつもの US 住所宛に 1 袋注文したい。1 件で OK、そのままお支払いまで連れて行って。 |
| Re-order | Reorder the same Patagonia Better Sweater Fleece I bought before (Men's, Black, size M). Ship to my home — I just want to pay. | 前に買った Patagonia Better Sweater Fleece (Men's, Black, size M) をもう 1 着。自宅宛で、あとは支払うだけの状態にしておいて。 |

### Location handling

The AI agent automatically extracts the shipping country from the user's query:

| Mentioned | `ships_to` |
|---|---|
| Tokyo, 東京, Japan, 日本 | `JP` |
| New York, US, USA | `US` |
| London, UK, England | `GB` |

If no location can be inferred, the AI asks: *"What country are you shopping from?"* before searching.

## Checkout flow

The checkout follows a status-driven workflow as defined by UCP:

```
create_checkout
    ↓
status: incomplete → update_checkout (add missing info)
    ↓
status: requires_escalation → show continue_url to buyer (payment UI)
    ↓
status: ready_for_complete → complete_checkout
    ↓
status: completed ✓
```

## Development

```bash
pnpm install          # install dependencies
pnpm run dev          # start with hot-reload (tsx watch)
pnpm run build        # compile TypeScript → dist/
pnpm run typecheck    # type-check without emitting
```

## References

- [Shopify Agentic Commerce Docs](https://shopify.dev/docs/agents)
- [Universal Commerce Protocol](https://ucp.dev)
- [Global Catalog MCP](https://shopify.dev/docs/agents/catalog/global-catalog)
- [Cart MCP](https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp)
- [Checkout MCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp)
- [MCP Specification](https://modelcontextprotocol.io)

## Disclaimer

This sample is provided for testing and educational purposes only. It is **not** an official Shopify product or endorsed solution. The author makes no warranties and accepts no responsibility for any issues, bugs, or damages arising from its use. Content and behavior may change without notice.
