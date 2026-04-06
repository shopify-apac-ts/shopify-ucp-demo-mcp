import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

const app = express();
app.use(express.json());

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
