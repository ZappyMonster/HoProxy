# AGENTS.md

HoProxy is a Node.js/Express proxy that exposes Anthropic-compatible API endpoints and translates them to the HopGPT backend at `https://chat.ai.jh.edu`. It enables Claude Code, OpenCode, and other Anthropic SDK clients to use HopGPT models.

Key capabilities: Anthropic Messages API (`/v1/messages`), tool use (XML to `tool_use` blocks), extended thinking, automatic token refresh (~7 days), TLS fingerprinting for Cloudflare.

## Build / Test / Development Commands

```bash
npm install           # Install dependencies
npm start             # Start server (port 3001)
npm run dev           # Development with auto-reload
npm run extract       # Extract browser credentials to .env
npm test              # Run all tests (Vitest)
npm run test:watch    # Run tests in watch mode

# Run a specific test file
npx vitest test/routes/messages.test.js

# Run tests matching a pattern
npx vitest -t "streams SSE responses"

# Run tests for a specific module
npx vitest test/transformers/
```

## Architecture

```
src/
├── index.js                  # Express app entry point
├── routes/                   # API route handlers
│   ├── messages.js           # POST /v1/messages
│   ├── models.js             # GET /v1/models
│   └── refreshToken.js       # Token refresh endpoints
├── transformers/             # Request/response transformation
│   ├── anthropicToHopGPT.js  # Anthropic -> HopGPT request
│   ├── hopGPTToAnthropic.js  # HopGPT -> Anthropic response
│   ├── thinkingUtils.js      # Thinking block handling
│   └── signatureCache.js     # Signature caching
├── services/                 # Business logic
│   ├── hopgptClient.js       # HopGPT API client with auth
│   ├── tlsClient.js          # Cloudflare bypass
│   ├── conversationStore.js  # Session state management
│   └── browserCredentials.js # Puppeteer credential extraction
├── utils/                    # Shared utilities
│   ├── logger.js             # Structured logging
│   ├── modelMapping.js       # Model name aliases
│   └── sseParser.js          # SSE stream parsing
└── errors/                   # Custom error classes
    └── authErrors.js         # Auth-related errors

test/
├── fixtures/                 # JSON test fixtures
├── helpers/                  # Test utilities (fixtures.js, sse.js)
└── {routes,transformers,services,utils}/  # Tests mirroring src/
```

## Code Style Guidelines

### Module System
- **ES modules only** (`import`/`export`), no CommonJS
- Node.js 18+ required

### Formatting
- 2-space indentation
- Semicolons required
- Single quotes for strings (except when string contains single quote)
- No trailing commas in function parameters

### Naming Conventions
- **camelCase** for functions, variables, methods
- **PascalCase** for classes (e.g., `HopGPTClient`, `AuthError`)
- **Concise module names**: `hopgptClient.js`, not `HopGPTClientService.js`
- **Test files**: `*.test.js` mirroring source structure

### Imports
```javascript
// Node.js built-ins first
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'crypto';

// External packages
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

// Internal modules (relative paths with .js extension)
import { createLogger } from '../utils/logger.js';
import { HopGPTError } from '../services/hopgptClient.js';
```

### Error Handling
- Use custom error classes from `src/errors/` for domain-specific errors
- Error classes should extend a base class and include an error code:
```javascript
export class TokenRefreshError extends AuthError {
  constructor(message = 'Failed to refresh authentication token') {
    super(message, 'TOKEN_REFRESH_FAILED');
    this.name = 'TokenRefreshError';
  }
}
```
- Convert errors to Anthropic-compatible format before sending to clients
- Use `instanceof` checks for error handling, not error messages

### Logging
- Use the centralized logger from `src/utils/logger.js`
- Create module-specific loggers: `const log = createLogger('ModuleName');`
- Or use pre-configured loggers: `import { loggers } from '../utils/logger.js';`
- Log levels: `debug`, `info`, `warn`, `error`
- Include structured data as second argument: `log.info('Message', { key: value });`

### Route Handlers
- Place in `src/routes/`, export a Router instance as default
- Validate requests before processing
- Return Anthropic-compatible error responses:
```javascript
res.status(400).json({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Descriptive error message'
  }
});
```

### Testing
- Use Vitest for testing, Supertest for HTTP tests
- Test files in `test/` mirroring `src/` structure
- Use fixtures from `test/fixtures/` via `readFixture()` helper
- Mock external services with `vi.mock()`
- Test both success and error paths

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

describe('feature name', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it('describes expected behavior', async () => { /* Arrange, Act, Assert */ });
});
```

## Environment Variables

- `HOPGPT_COOKIE_REFRESH_TOKEN` - Required for token refresh
- `PORT` - Server port (default: 3001)
- `HOPGPT_BEARER_TOKEN` - JWT token (auto-refreshed if refresh token is set)
- `HOPGPT_USER_AGENT` - Browser User-Agent for Cloudflare
- `HOPGPT_DEBUG` - Enable debug logging (true/false)
- `HOPGPT_LOG_LEVEL` - Log level (debug/info/warn/error/silent)

## Key Technical Details

**Tool Injection**: HopGPT doesn't support Anthropic tools natively. Tools are injected into the system prompt as XML format instructions. Model output containing `<tool_call>` XML is parsed and converted to Anthropic `tool_use` content blocks.

**Session Management**: Use `X-Session-Id` header or `metadata.session_id` to maintain conversation threading via `parentMessageId`. Reset with `X-Conversation-Reset: true` header.

**MCP Passthrough**: Enable with `x-mcp-passthrough: true` header to keep tool call XML in text instead of converting to `tool_use` blocks.
