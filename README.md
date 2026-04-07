# Shopify UCP Demo — Remote MCP Server

A Remote MCP server that lets any AI agent (Claude, ChatGPT, etc.) search Shopify's global product catalog and complete purchases using the [Universal Commerce Protocol (UCP)](https://ucp.dev).

## What it does

| Tool | Description |
|---|---|
| `search_products` | Search hundreds of millions of products across all Shopify merchants |
| `get_product_details` | Get full variant details and checkout URLs for a specific product |
| `create_checkout` | Start a checkout session on a merchant's store |
| `update_checkout` | Add buyer info, shipping address, select shipping method |
| `complete_checkout` | Place the order when checkout status is `ready_for_complete` |
| `cancel_checkout` | Cancel an active checkout session |

## Architecture

```
User's AI (Claude / ChatGPT / etc.)
    ↓  Remote MCP  (Streamable HTTP POST /mcp)
This Server  (Node.js on Render)
    ├──→  Shopify Catalog MCP  (https://discover.shopifyapps.com/global/mcp)
    └──→  Shopify Checkout MCP (https://{shop}/api/ucp/mcp)
```

For a detailed sequence diagram showing the full interaction flow between the AI Agent, Demo MCP Server, and Shopify APIs, see [docs/sequence-diagram.md](docs/sequence-diagram.md).

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
   - `UCP_AGENT_PROFILE` (your Render URL)
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

For Claude Code (CLI):

```bash
claude mcp add shopify-ucp --transport http https://your-app-name.onrender.com/mcp
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

| Prompt | What the AI does |
|---|---|
| Find me a spring parka available in Tokyo. | Detects "Tokyo" → `ships_to: "JP"` |
| Japanese spring fashion available in America. / アメリカで入手可能な日本風の春向けファッション | Detects "America" → `ships_to: "US"` |
| Traditional Japanese miscellaneous goods/sundries available in the United States. / アメリカで手に入る、日本の伝統的な雑貨 | Detects "United States" → `ships_to: "US"` |

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
- [Catalog MCP Reference](https://shopify.dev/docs/agents/catalog/mcp)
- [Checkout MCP Reference](https://shopify.dev/docs/agents/checkout/mcp)
- [MCP Specification](https://modelcontextprotocol.io)
