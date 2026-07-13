# Shopify UCP Demo — Remote MCP Server

A Remote MCP server that lets any AI agent (Claude, ChatGPT, etc.) search Shopify's global product catalog and complete purchases using the [Universal Commerce Protocol (UCP)](https://ucp.dev).

## What it does

| Tool | Description |
|---|---|
| `search_products` | Search Shopify's Global Catalog by text or image similarity, optionally scoped by a saved Catalog |
| `lookup_products` | Refresh known Catalog product or variant IDs without running a new search |
| `get_product_details` | Get variant options, matching offers, and checkout URLs for a specific product |
| `create_cart` | Create a merchant cart for basket building |
| `get_cart` | Retrieve an existing merchant cart |
| `update_cart` | Replace the full cart line-item state |
| `cancel_cart` | Cancel an active cart |
| `create_checkout` | Start a checkout session on a merchant's store |
| `get_checkout` | Retrieve an existing checkout state |
| `update_checkout` | Add buyer info, shipping address, select shipping method |
| `complete_checkout` | Place the order when checkout is ready and already has usable payment state |
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

Every outgoing call carries `meta.ucp-agent.profile`.
Operations that require idempotency (`cancel_cart`, `complete_checkout`, and
`cancel_checkout`) also carry `meta.idempotency-key` so retries are safe.

### Global Catalog extension data

`search_products`, `lookup_products`, and `get_product_details` return two
representations of the same Catalog result:

- `content` contains concise Markdown for buyer-facing chat and mobile clients.
- `structuredContent` preserves the complete upstream Catalog response,
  including the `dev.shopify.catalog.global` extension.

Agents can therefore use Shopify-specific fields such as
`metadata.attributes`, `metadata.top_features`,
`metadata.unique_selling_points`, `condition`,
`eligible.native_checkout`, `availability.running_low`, `requires`, and
seller identity or policy links without displaying the entire raw response to
the buyer.

### Product option selection

Shopify product option names are merchant-defined, so `get_product_details`
accepts a generic `options` array for selections such as `Color`, `Style`,
`Material`, `カラー`, or any other Catalog-returned option name. The older
`color` and `size` arguments remain as convenience shortcuts, but the server
does not hardcode translated option-name aliases. If option names do not match,
the response formatter falls back to normalized option-value matching and
shows the closest offers instead of guessing.

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

The server rejects placeholder-sized image payloads before calling Catalog. A
real similarity-search image must decode to at least 512 bytes and match the
declared MIME type. Catalog calls also time out after 30 seconds by default
(`CATALOG_MCP_TIMEOUT_MS`) so a bad upstream image request does not leave the
client waiting indefinitely.

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

For a simplified, presentation-ready visual overview of the UCP buyer journey, see [docs/index.html](docs/index.html). A Japanese version is available at [docs/ja/](docs/ja/).

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
- Global Catalog extension capability and field coverage
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

Run the Global Catalog extension coverage case:

```bash
pnpm run self-test -- --case harness/cases/global-catalog-extension.json
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
server as a custom connector.

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
