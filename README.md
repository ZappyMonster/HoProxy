# HopGPT Anthropic API Proxy

A Node.js/Express proxy server that exposes Anthropic-compatible API endpoints (`/v1/messages`) and translates requests to the HopGPT backend.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure authentication:**

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
   ```bash
   npm start
   ```

   Or with auto-reload for development:
   ```bash
   npm run dev
   ```

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
| `HOPGPT_BEARER_TOKEN` | JWT Bearer token from Authorization header |
| `HOPGPT_COOKIE_CF_CLEARANCE` | Cloudflare clearance cookie |
| `HOPGPT_COOKIE_CONNECT_SID` | Session ID cookie |
| `HOPGPT_COOKIE_CF_BM` | Cloudflare bot management cookie |
| `HOPGPT_COOKIE_REFRESH_TOKEN` | Refresh token cookie |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API |
| `/health` | GET | Health check |

## Authentication Notes

- The Bearer token expires frequently (~15 minutes)
- You may need to refresh credentials periodically
- Cloudflare cookies (`cf_clearance`, `__cf_bm`) may also expire

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
