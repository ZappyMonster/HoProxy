#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import messagesRouter from './routes/messages.js';
import modelsRouter from './routes/models.js';
import refreshTokenRouter from './routes/refreshToken.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS headers for API access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, x-session-id, x-conversation-reset, x-mcp-passthrough');
  res.header('Access-Control-Expose-Headers', 'x-session-id');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount Anthropic-compatible API routes
app.use('/v1', messagesRouter);
app.use('/v1', modelsRouter);
app.use(refreshTokenRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: `Not found: ${req.method} ${req.path}`
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Internal server error'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║          HopGPT Anthropic API Proxy                        ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                   ║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/messages  - Anthropic Messages API             ║
║    GET  /v1/models    - List available models              ║
║    POST /refresh-token - Refresh HopGPT session token      ║
║    GET  /health       - Health check                       ║
║                                                            ║
║  Usage with Anthropic SDK:                                 ║
║    export ANTHROPIC_BASE_URL=http://localhost:${PORT}         ║
╚════════════════════════════════════════════════════════════╝
  `);
});
