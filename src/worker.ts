/// <reference types="@cloudflare/workers-types" />
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from './server.js';
import { requestContext, extractBuyerIp } from './request-context.js';

interface Env {
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  UCP_AGENT_PROFILE?: string;
}

// Verbatim mirror of shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json
// (fetched 2026-05-27). Served from /agent-profile.json so we can control the
// Cache-Control header and diagnose Shopify Checkout MCP's profile_malformed
// rejection ("Invalid cache control") of the canonical URL.
const EMBEDDED_PROFILE = `{
  "ucp": {
    "version": "2026-04-08",
    "services": {
      "dev.ucp.shopping": [
        {
          "version": "2026-04-08",
          "spec": "https://ucp.dev/2026-04-08/specification/overview",
          "transport": "rest",
          "schema": "https://ucp.dev/2026-04-08/services/shopping/rest.openapi.json",
          "endpoint": "https://business.example.com/ucp/v1"
        }
      ]
    },
    "capabilities": {
      "dev.ucp.shopping.checkout": [
        {
          "version": "2026-04-08"
        }
      ],
      "dev.ucp.shopping.fulfillment": [
        {
          "version": "2026-04-08",
          "extends": ["dev.ucp.shopping.checkout", "dev.ucp.shopping.cart"]
        }
      ],
      "dev.ucp.shopping.buyer_consent": [
        {
          "version": "2026-04-08",
          "extends": "dev.ucp.shopping.checkout"
        }
      ],
      "dev.ucp.shopping.discount": [
        {
          "version": "2026-04-08",
          "extends": ["dev.ucp.shopping.checkout", "dev.ucp.shopping.cart"]
        }
      ],
      "dev.ucp.shopping.cart": [
        {
          "version": "2026-04-08",
          "spec": "https://ucp.dev/2026-04-08/specification/cart",
          "schema": "https://ucp.dev/2026-04-08/schemas/shopping/cart.json"
        }
      ],
      "dev.ucp.shopping.order": [
        {
          "version": "2026-04-08",
          "spec": "https://ucp.dev/2026-04-08/specification/order",
          "schema": "https://ucp.dev/2026-04-08/schemas/shopping/order.json"
        }
      ],
      "dev.ucp.shopping.catalog.search": [
        {
          "version": "2026-04-08",
          "spec": "https://ucp.dev/2026-04-08/specification/catalog/search",
          "schema": "https://ucp.dev/2026-04-08/schemas/shopping/catalog_search.json"
        }
      ],
      "dev.ucp.shopping.catalog.lookup": [
        {
          "version": "2026-04-08",
          "spec": "https://ucp.dev/2026-04-08/specification/catalog/lookup",
          "schema": "https://ucp.dev/2026-04-08/schemas/shopping/catalog_lookup.json"
        }
      ],
      "dev.shopify.catalog": [
        {
          "version": "2026-04-08",
          "spec": "https://shopify.dev/docs/agents/catalog/storefront-catalog",
          "schema": "https://shopify.dev/ucp/schemas/2026-04-08/shopify_catalog.json",
          "extends": ["dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.catalog.search"]
        }
      ],
      "dev.shopify.catalog.global": [
        {
          "version": "2026-04-08",
          "spec": "https://shopify.dev/docs/agents/catalog/global-catalog",
          "schema": "https://shopify.dev/ucp/schemas/2026-04-08/shopify_catalog_global.json",
          "extends": ["dev.ucp.shopping.catalog.lookup", "dev.ucp.shopping.catalog.search"]
        }
      ]
    },
    "payment_handlers": {}
  }
}`;

// catalog.ts / checkout.ts / ucp-config.ts read `process.env.X` at the
// top of each fetch call. Workers' nodejs_compat shim provides an empty
// `process.env`; we must copy the per-request Env bindings into it
// before invoking the MCP server, otherwise Shopify auth fails.
function bridgeEnv(env: Env) {
  if (env.SHOPIFY_CLIENT_ID) process.env.SHOPIFY_CLIENT_ID = env.SHOPIFY_CLIENT_ID;
  if (env.SHOPIFY_CLIENT_SECRET) process.env.SHOPIFY_CLIENT_SECRET = env.SHOPIFY_CLIENT_SECRET;
  if (env.UCP_AGENT_PROFILE) process.env.UCP_AGENT_PROFILE = env.UCP_AGENT_PROFILE;
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    bridgeEnv(env);

    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({
        status: 'ok',
        service: 'shopify-ucp-demo-mcp',
        runtime: 'cloudflare-workers',
      });
    }

    // Self-hosted UCP agent profile for diagnosing Shopify's
    // "profile_malformed: Invalid cache control" rejection of shopify.dev's
    // canonical profile URL. Defaults to strict UCP-spec-compliant Cache-Control
    // (public, max-age=3600). Append `?swr=1` to mirror shopify.dev's header
    // exactly (adds stale-while-revalidate=7200) for A/B comparison.
    if (url.pathname === '/agent-profile.json' && request.method === 'GET') {
      const swr = url.searchParams.get('swr') === '1';
      const cacheControl = swr
        ? 'public, max-age=3600, stale-while-revalidate=7200'
        : 'public, max-age=3600';
      // Log inbound fetches so we can see who (Shopify Checkout MCP) hits us.
      console.error(
        `[agent-profile] swr=${swr} ua="${request.headers.get('user-agent') ?? ''}" cf-ray=${request.headers.get('cf-ray') ?? ''}`,
      );
      return new Response(EMBEDDED_PROFILE, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'cache-control': cacheControl,
        },
      });
    }

    if (url.pathname === '/mcp') {
      if (request.method === 'GET') {
        return new Response(
          JSON.stringify({
            error: 'Use POST /mcp for Streamable HTTP transport.',
            documentation:
              'https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http',
          }),
          { status: 405, headers: { 'content-type': 'application/json' } },
        );
      }
      if (request.method === 'DELETE') {
        return Response.json({ message: 'Session terminated' });
      }
      if (request.method === 'POST') {
        const headers = Object.fromEntries(request.headers);
        // On Workers, Cloudflare sets CF-Connecting-IP to the real client IP.
        // Pass it as the remoteAddr fallback for extractBuyerIp; XFF (which
        // Cloudflare also sets) takes precedence inside that helper.
        const cfIp = request.headers.get('cf-connecting-ip') ?? undefined;
        const buyerIp = extractBuyerIp(headers, cfIp);
        const userAgent = request.headers.get('user-agent') ?? undefined;

        return requestContext.run({ buyerIp, userAgent }, async () => {
          const server = createMcpServer();
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless: session state lives in the AI client
          });
          await server.connect(transport);
          return transport.handleRequest(request);
        });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

export default handler;
