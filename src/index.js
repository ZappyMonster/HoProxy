#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import messagesRouter from './routes/messages.js';
import modelsRouter from './routes/models.js';
import refreshTokenRouter from './routes/refreshToken.js';
import { requestLoggerMiddleware, createLogger } from './utils/logger.js';

const log = createLogger('Server');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS headers for API access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, x-session-id, x-sessionid, x-conversation-reset, x-mcp-passthrough');
  res.header('Access-Control-Expose-Headers', 'x-session-id');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logging with tracing
app.use(requestLoggerMiddleware());

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
  log.error('Unhandled error', {
    requestId: req.id,
    error: err.message,
    stack: process.env.HOPGPT_DEBUG === 'true' ? err.stack : undefined
  });
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
  log.info(`Server started on port ${PORT}`);
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
║    GET  /token-status  - Check token expiry status         ║
║    GET  /health       - Health check                       ║
║                                                            ║
║  Usage with Anthropic SDK:                                 ║
║    export ANTHROPIC_BASE_URL=http://localhost:${PORT}         ║
╚════════════════════════════════════════════════════════════╝
  `);
});
