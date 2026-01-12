# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HoProxy is a Node.js/Express proxy that exposes Anthropic-compatible API endpoints and translates them to the HopGPT backend at `https://chat.ai.jh.edu`. It enables Claude Code and other Anthropic SDK clients to use HopGPT models.

Key capabilities:
- Anthropic Messages API compatibility (`/v1/messages`)
- Tool use support (converts XML tool calls from model output to Anthropic `tool_use` blocks)
- Extended thinking support for thinking models
- Automatic token refresh (extends sessions from ~15 min to ~7 days)
- TLS fingerprinting to bypass Cloudflare protection

## Build, Test, and Development Commands

```bash
npm install              # Install dependencies
npm start                # Start server (port 3001 by default)
npm run dev              # Start with auto-reload (--watch)
npm run extract          # Extract browser credentials to .env

npm test                 # Run all tests once (Vitest)
npm run test:watch       # Run tests in watch mode
npx vitest test/routes/messages.test.js  # Run a specific test file
```

## Architecture

```
Anthropic SDK Client
        │
        ▼
┌─────────────────────────────────────────┐
│  Routes (src/routes/)                   │
│  • messages.js - /v1/messages           │
│  • models.js - /v1/models               │
│  • refreshToken.js - /refresh-token     │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  Transformers (src/transformers/)       │
│  • anthropicToHopGPT.js - Request xform │
│  • hopGPTToAnthropic.js - Response xform│
│  • thinkingUtils.js - Thinking blocks   │
│  • signatureCache.js - Signature cache  │
└─────────────────┬───────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  Services (src/services/)               │
│  • hopgptClient.js - API client w/ auth │
│  • tlsClient.js - Cloudflare bypass     │
│  • conversationStore.js - Session state │
│  • browserCredentials.js - Puppeteer    │
└─────────────────┬───────────────────────┘
                  ▼
         HopGPT Backend
```

**Data flow**: Anthropic request → `anthropicToHopGPT.js` (injects tools into prompt) → HopGPT API → SSE stream → `hopGPTToAnthropic.js` (parses XML tool calls, handles thinking blocks) → Anthropic response

## Key Technical Details

**Tool Injection**: HopGPT doesn't natively support Anthropic tools, so `anthropicToHopGPT.js` injects tool definitions into the prompt. The model outputs tool calls as XML, which `hopGPTToAnthropic.js` parses and converts to Anthropic `tool_use` blocks.

**Supported XML formats** (all converted to `tool_use` blocks):
- `<mcp_tool_call>` - MCP format
- `<function_calls><invoke name="...">` - Claude Code / OpenCode format
- `<tool_call>{JSON}</tool_call>` - JSON format

**Session Management**: Uses `X-Session-Id` header or `metadata.session_id` to maintain conversation threading via `parentMessageId`.

**Model Aliases**: Flexible naming via `modelMapping.js` (e.g., `claude-opus-4-5-thinking`, `claude-opus-4.5`, `claude-4.5` all resolve correctly).

## Coding Style

- ES modules (`import`/`export`), Node.js 18+
- 2-space indentation with semicolons
- camelCase for functions/variables
- Concise module names (`hopgptClient.js`, not `HopGPTClientService.js`)
- Route handlers in `src/routes/`, shared logic in `src/services/` or `src/utils/`

## Testing

- Tests use Vitest + Supertest, mirroring source structure under `test/`
- Fixtures in `test/fixtures/`, helpers in `test/helpers/`
- Name test files `*.test.js`

## Environment Variables

Minimum required: `HOPGPT_COOKIE_REFRESH_TOKEN`

Key variables:
- `PORT` - Server port (default: 3001)
- `HOPGPT_BEARER_TOKEN` - JWT token (auto-refreshed if refresh token is set)
- `HOPGPT_USER_AGENT` - Browser User-Agent for Cloudflare
- `HOPGPT_DEBUG` - Enable debug logging
- `CONVERSATION_TTL_MS` - Session state TTL (default: 6 hours)
