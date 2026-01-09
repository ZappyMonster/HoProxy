# HopGPT Anthropic API Proxy

A Node.js/Express proxy server that exposes Anthropic-compatible API endpoints (notably `/v1/messages`) and translates requests to the HopGPT backend at `https://chat.ai.jh.edu`. Includes browser credential extraction, TLS fingerprinting, conversation state, and automatic token refresh.

## Requirements

- Node.js 18+

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure authentication:**

   **Option A: Automatic extraction (recommended)**

   Run the extraction script to open a browser, log in, and save credentials to `.env`:
   ```bash
   npm run extract
   ```

   Optional flags:
   ```bash
   npm run extract -- --timeout 600 --env-path ./custom.env
   ```

   Optional environment variables for extraction:
   - `HOPGPT_PUPPETEER_CHANNEL` (default: `chrome`)
   - `HOPGPT_PUPPETEER_USER_DATA_DIR` (reuse a browser profile)

   **Option B: Manual extraction**

   Create a `.env` file and set values from your browser session:
   - Open HopGPT (`https://chat.ai.jh.edu`)
   - DevTools (F12) → Network tab
   - Send a message and inspect the request to `/api/agents/chat/AnthropicClaude`
   - Copy values from headers/cookies:
     - `Authorization` header → `HOPGPT_BEARER_TOKEN` (optional if refresh token is set)
     - `User-Agent` header → `HOPGPT_USER_AGENT`
     - `Cookie` header → individual cookie values

   Example `.env`:
   ```bash
   HOPGPT_COOKIE_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...
   HOPGPT_BEARER_TOKEN=eyJhbGciOiJIUzI1NiIs...
   HOPGPT_USER_AGENT="Mozilla/5.0 ..."
   HOPGPT_COOKIE_CF_CLEARANCE=...
   HOPGPT_COOKIE_CONNECT_SID=...
   HOPGPT_COOKIE_CF_BM=...
   HOPGPT_COOKIE_TOKEN_PROVIDER=librechat
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

   Or with auto-reload for development:
   ```bash
   npm run dev
   ```

   Set `PORT` to change the listening port (default: `3001`).

## Claude Code Setup

Configure Claude Code to talk to HoProxy's local Anthropic-compatible endpoint.

### 1) Install Claude Code

**macOS/Linux (recommended):**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**npm (requires Node.js 18+):**
```bash
npm install -g @anthropic-ai/claude-code
```

### 2) Extract HopGPT credentials

If you have not already done this in the main setup, run:
```bash
npm run extract
```

### 3) Configure Claude Code `settings.json`

Create or edit `~/.claude/settings.json`:
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3001",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5-thinking"
  }
}
```

Restart Claude Code after editing. HoProxy does not validate the auth token, but Claude Code requires a non-empty value.

### 4) Environment variable configuration

If you prefer shell environment variables instead of `settings.json`:
```bash
export ANTHROPIC_AUTH_TOKEN=test
export ANTHROPIC_BASE_URL=http://localhost:3001
export ANTHROPIC_MODEL=claude-sonnet-4-5-thinking
```

### 5) Troubleshooting common issues

- **Connection refused**: Ensure HoProxy is running and listening on `http://localhost:3001`.
- **`authentication_error` from HoProxy**: Your HopGPT cookies/tokens are missing or expired. Re-run `npm run extract` and restart the server.
- **401/403 from HopGPT**: The refresh token likely expired; re-authenticate and re-extract credentials.
- **Cloudflare "Attention Required" page**: Your Cloudflare cookies or user agent are missing/expired. Re-run `npm run extract` and restart the server.
- **Model warning or not found**: Use a supported model from the list below or call `GET /v1/models`.
- **Claude Code still calling Anthropic**: Confirm `ANTHROPIC_BASE_URL` is set and restart Claude Code.

### 6) Available models and their capabilities

| Model (canonical) | HopGPT backend | Capability notes | Max tokens |
|-------------------|----------------|------------------|------------|
| `claude-opus-4-5-thinking` | `claude-opus-4.5` | Highest quality; best for complex reasoning and long-form outputs. | 32768 |
| `claude-sonnet-4-5-thinking` | `claude-sonnet-4.5` | Balanced speed/quality; good default for most tasks. | 16384 |
| `claude-haiku-4-5-thinking` | `claude-haiku-4.5` | Fastest model; best for low-latency tasks. | 8192 |

Aliases accepted by the proxy include:
- `claude-opus-4-5`, `claude-opus-4.5`, `claude-opus-4.5-thinking`
- `claude-sonnet-4-5`, `claude-sonnet-4.5`, `claude-sonnet-4.5-thinking`
- `claude-haiku-4-5`, `claude-haiku-4.5`, `claude-haiku-4.5-thinking`

## OpenCode Setup

Configure OpenCode to use HoProxy with MCP tool call passthrough mode.

### MCP Tool Call Passthrough

OpenCode parses and executes tool calls directly from `<mcp_tool_call>` XML blocks in the text stream. By default, HoProxy converts these blocks to Anthropic `tool_use` format, which OpenCode doesn't execute.

To enable passthrough mode, use one of these methods:

**Option A: HTTP Header**
```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-mcp-passthrough: true" \
  -d '{ ... }'
```

**Option B: Request metadata**
```json
{
  "model": "claude-sonnet-4-5-thinking",
  "metadata": {
    "mcp_passthrough": true
  },
  "messages": [...]
}
```

When passthrough mode is enabled:
- `<mcp_tool_call>` blocks remain in the text response for the client to parse
- No `tool_use` blocks are generated from the XML
- OpenCode can intercept and execute the tool calls directly

## Usage

### With Anthropic SDK (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="dummy",  # Not used, but required by the SDK
    base_url="http://localhost:3001"  # Or set ANTHROPIC_BASE_URL
)

message = client.messages.create(
    model="claude-sonnet-4-5-thinking",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content)
```

### With Anthropic SDK (JavaScript)

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'] || 'dummy',
  baseURL: 'http://localhost:3001'
});

const message = await client.messages.create({
  model: 'claude-sonnet-4-5-thinking',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(message.content);
```

If your SDK version does not support `baseURL`, use the `curl` example below instead.

### With curl

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-thinking",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-thinking",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### List available models

```bash
curl http://localhost:3001/v1/models
```

### Manually refresh the HopGPT token

```bash
curl -X POST http://localhost:3001/refresh-token
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3001) |
| `HOPGPT_BEARER_TOKEN` | JWT Bearer token from Authorization header (optional if refresh token is set) |
| `HOPGPT_USER_AGENT` | Browser User-Agent header (recommended to satisfy Cloudflare) |
| `HOPGPT_COOKIE_CF_CLEARANCE` | Cloudflare clearance cookie |
| `HOPGPT_COOKIE_CONNECT_SID` | Session ID cookie |
| `HOPGPT_COOKIE_CF_BM` | Cloudflare bot management cookie |
| `HOPGPT_COOKIE_REFRESH_TOKEN` | Refresh token cookie (required for auto-refresh) |
| `HOPGPT_COOKIE_TOKEN_PROVIDER` | Token provider (default: `librechat`) |
| `CONVERSATION_TTL_MS` | In-memory conversation state TTL in ms (default: 21600000) |

Extraction-only:
- `HOPGPT_PUPPETEER_CHANNEL`
- `HOPGPT_PUPPETEER_USER_DATA_DIR`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API (streaming and non-streaming) |
| `/v1/models` | GET | List available models |
| `/v1/models/:model_id` | GET | Fetch a specific model |
| `/refresh-token` | POST | Refresh HopGPT bearer token using refresh cookie |
| `/health` | GET | Health check |

## Conversation State

The proxy tracks HopGPT conversation threading in-memory so multi-turn requests can reuse context and cache keys.

- Provide a stable session key via `X-Session-Id` (or `X-SessionID`) or `metadata.session_id`, `metadata.sessionId`, `metadata.conversation_id`, or `metadata.conversationId`.
- If missing, the proxy generates a session ID and returns it in the `X-Session-Id` response header.
- Reset the session with `X-Conversation-Reset: true` or `metadata.conversation_reset`, `metadata.reset`, or `metadata.new_conversation` set to `true`.

Conversation state is stored in-memory and expires after `CONVERSATION_TTL_MS` (default 6 hours).

## Authentication Notes

### Automatic Token Refresh

When a request fails with a 401/403 authentication error, the proxy will:

1. Call the HopGPT refresh endpoint (`/api/auth/refresh`)
2. Obtain a new bearer token using the refresh token cookie
3. Retry the original request with the new token

This extends the effective session from ~15 minutes (bearer token lifespan) to ~7 days (refresh token lifespan).

### Token Lifespans

| Token | Lifespan | Notes |
|-------|----------|-------|
| Bearer Token | ~15 minutes | Automatically refreshed when expired |
| Refresh Token | ~7 days | Requires manual re-authentication when expired |
| Cloudflare cookies | Variable | May need to be refreshed if you encounter issues |

### Minimal Configuration

With auto-refresh enabled, you only need to provide the **refresh token**. The bearer token will be obtained automatically on the first request:

```bash
# Minimal .env configuration
HOPGPT_COOKIE_REFRESH_TOKEN=eyJhbGciOiJIUzI1NiIs...
```

## Project Structure

```
src/
├── index.js                    # Express server entry point
├── routes/
│   ├── messages.js             # /v1/messages endpoint
│   ├── models.js               # /v1/models endpoints
│   └── refreshToken.js         # /refresh-token endpoint
├── transformers/
│   ├── anthropicToHopGPT.js    # Request transformation
│   └── hopGPTToAnthropic.js    # SSE response transformation
├── services/
│   ├── browserCredentials.js   # Puppeteer credential extraction
│   ├── conversationStore.js    # In-memory session storage
│   ├── hopgptClient.js         # HopGPT API client
│   └── tlsClient.js            # TLS fingerprinted requests
└── utils/
    ├── modelMapping.js         # Model alias mapping
    └── sseParser.js            # SSE stream parsing
```

## Testing

```bash
npm test
```

## License

MIT
