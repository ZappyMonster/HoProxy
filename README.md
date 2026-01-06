# HopGPT Anthropic API Proxy

A Node.js/Express proxy server that exposes Anthropic-compatible API endpoints (`/v1/messages`) and translates requests to the HopGPT backend.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure authentication:**

   **Option A: Automatic extraction (recommended)**

   Run the extraction script to automatically open a browser, log in, and extract credentials:
   ```bash
   npm run extract
   ```

   This will:
   - Open a browser window to the HopGPT login page
   - Wait for you to complete the login process
   - Automatically extract all necessary credentials
   - Save them to a `.env` file

   **Option B: Manual extraction**

   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your HopGPT credentials from your browser session:
   - Open HopGPT (chat.ai.jh.edu) in your browser
   - Open Developer Tools (F12) → Network tab
   - Send a message and find the request to `/api/agents/chat/AnthropicClaude`
   - Copy the values from:
     - `Authorization` header → `HOPGPT_BEARER_TOKEN`
     - `Cookie` header → extract individual cookie values

3. **Start the server:**

   With npx (no install, uses `.env` in the current directory):
   ```bash
   npx hopgpt-anthropic-proxy start
   ```

   With a local install:
   ```bash
   npm start
   ```

   Or with auto-reload for development:
   ```bash
   npm run dev
   ```

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

This writes a `.env` file with the required HopGPT cookies/tokens. If you need the manual path, follow the steps in the main **Setup** section above.

### 3) Configure Claude Code `settings.json`

Create or edit `~/.claude/settings.json`:
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "test",
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_MODEL": "claude-sonnet-4-20250514"
  }
}
```

Restart Claude Code after editing. HoProxy does not validate the auth token, but Claude Code requires a non-empty value.

### 4) Environment variable configuration

If you prefer shell environment variables instead of `settings.json`:
```bash
export ANTHROPIC_AUTH_TOKEN=test
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### 5) Troubleshooting common issues

- **Connection refused**: Ensure HoProxy is running and listening on `http://localhost:3000`.
- **`authentication_error` from HoProxy**: Your HopGPT cookies/tokens are missing or expired. Re-run `npm run extract` and restart the server.
- **401/403 from HopGPT**: The refresh token likely expired; re-authenticate and re-extract credentials.
- **Model warning or not found**: Use a supported model from the list below or update `ANTHROPIC_MODEL`.
- **Claude Code still calling Anthropic**: Confirm `ANTHROPIC_BASE_URL` is set and restart Claude Code.

### 6) Available models and their capabilities

| Model (canonical) | HopGPT backend | Capability notes |
|-------------------|----------------|------------------|
| `claude-opus-4-5-thinking` | `claude-opus-4.5` | Highest quality; best for complex reasoning and long-form outputs. |
| `claude-sonnet-4-5-thinking` | `claude-sonnet-4.5` | Balanced speed/quality; good default for most tasks. |

Aliases accepted by the proxy include:
- `claude-opus-4-5`, `claude-opus-4.5`, `claude-opus-4.5-thinking`
- `claude-sonnet-4-5`, `claude-sonnet-4.5`, `claude-sonnet-4.5-thinking`

## Usage

### With Anthropic SDK (Python)

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3000",
    api_key="dummy"  # Not used, but required by SDK
)

response = client.messages.create(
    model="claude-opus-4.5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.content[0].text)
```

### With Anthropic SDK (JavaScript)

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:3000',
  apiKey: 'dummy'
});

const response = await client.messages.create({
  model: 'claude-opus-4.5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }]
});
console.log(response.content[0].text);
```

### With curl

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4.5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4.5",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `HOPGPT_BEARER_TOKEN` | JWT Bearer token from Authorization header (optional if refresh token is set) |
| `HOPGPT_COOKIE_CF_CLEARANCE` | Cloudflare clearance cookie |
| `HOPGPT_COOKIE_CONNECT_SID` | Session ID cookie |
| `HOPGPT_COOKIE_CF_BM` | Cloudflare bot management cookie |
| `HOPGPT_COOKIE_REFRESH_TOKEN` | Refresh token cookie (required for auto-refresh) |
| `HOPGPT_COOKIE_TOKEN_PROVIDER` | Token provider (default: `librechat`) |
| `CONVERSATION_TTL_MS` | In-memory conversation state TTL in milliseconds (default: 21600000) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API |
| `/health` | GET | Health check |

## Conversation State

The proxy tracks HopGPT conversation threading in-memory so multi-turn requests can reuse context and cache keys.

- Provide a stable session key via `X-Session-Id` or `metadata.session_id` / `metadata.conversation_id`.
- If missing, the proxy generates a session ID and returns it in the `X-Session-Id` response header.
- Reset the session with `X-Conversation-Reset: true` or `metadata.conversation_reset: true`.

Conversation state is stored in-memory and expires after `CONVERSATION_TTL_MS` (default 6 hours).

## Authentication Notes

### Automatic Token Refresh

The proxy now includes **automatic token refresh**. When a request fails with a 401/403 authentication error, the proxy will:

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
│   └── messages.js             # /v1/messages endpoint
├── transformers/
│   ├── anthropicToHopGPT.js    # Request transformation
│   └── hopGPTToAnthropic.js    # SSE response transformation
├── services/
│   └── hopgptClient.js         # HopGPT API client
└── utils/
    └── sseParser.js            # SSE stream parsing
```

## License

MIT
