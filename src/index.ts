import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import { searchGlobalProducts, getGlobalProductDetails } from './catalog.js';
import { requestContext, extractBuyerIp } from './request-context.js';

const app = express();
app.use(express.json());

// Trust X-Forwarded-For from Render's reverse proxy so req.ip resolves
// to the original caller. Safe because Render terminates TLS in front
// of this process — only their proxy can set XFF.
app.set('trust proxy', true);

const PORT = process.env.PORT ?? 3000;

// Health check — Render uses this to verify the service is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'shopify-ucp-demo-mcp', commit: process.env.RENDER_GIT_COMMIT ?? 'local' });
});

// MCP endpoint — accepts Streamable HTTP transport (JSON-RPC 2.0 over POST)
// Each request creates a fresh transport+server pair (stateless design).
// This is intentional: the MCP session state (checkout IDs etc.) lives in the
// AI client, not on this server.
app.post('/mcp', async (req, res) => {
  // Capture buyer-side context so the Checkout MCP layer can forward the
  // Shopify-Buyer-IP HTTP header (required by Shopify — without it,
  // Shopify returns HTTP 422 "Missing required buyer IP header.") and
  // also populate checkout.signals.dev.ucp.buyer_ip in the body for
  // UCP-spec compliance.
  const buyerIp = extractBuyerIp(req.headers, req.socket.remoteAddress);
  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;

  await requestContext.run({ buyerIp, userAgent }, async () => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session persistence
    });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
});

// Debug endpoints — return raw Catalog MCP responses for local diagnosis.
// Disabled when NODE_ENV=production to avoid letting anonymous traffic
// burn Shopify Catalog API quota on the deployed server.
// Usage: GET /debug/search?q=kimono&ships_to=US
//        GET /debug/detail?upid=ABC123&ships_to=US
app.use('/debug', (_req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).end();
    return;
  }
  next();
});

app.get('/debug/search', async (req, res) => {
  const q = String(req.query.q ?? 'Japanese spring fashion');
  const ships_to = req.query.ships_to ? String(req.query.ships_to) : undefined;
  try {
    const result = await searchGlobalProducts({
      query: q, context: q,
      ...(ships_to && { ships_to }),
      limit: 3,
    });
    res.json({ query: q, ships_to, result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/debug/detail', async (req, res) => {
  const upid = String(req.query.upid ?? '');
  const ships_to = req.query.ships_to ? String(req.query.ships_to) : undefined;
  if (!upid) { res.status(400).json({ error: 'upid required' }); return; }
  try {
    const result = await getGlobalProductDetails({ upid, ...(ships_to && { ships_to }) });
    res.json({ upid, ships_to, result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// SSE upgrade endpoint — required by some MCP clients that use SSE transport
// (e.g., older Claude Desktop versions, some third-party integrations)
app.get('/mcp', async (req, res) => {
  res.status(405).json({
    error: 'Use POST /mcp for Streamable HTTP transport.',
    documentation: 'https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http',
  });
});

// DELETE /mcp — used by Streamable HTTP clients to signal session termination
app.delete('/mcp', async (req, res) => {
  res.status(200).json({ message: 'Session terminated' });
});

app.listen(PORT, () => {
  console.log(`Shopify UCP Demo MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: POST http://localhost:${PORT}/mcp`);
  console.log(`Health check: GET  http://localhost:${PORT}/health`);
});
