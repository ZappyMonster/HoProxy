import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HopGPTClient, HopGPTError } from '../../src/services/hopgptClient.js';

function createMockResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  json = async () => ({}),
  text = async () => '',
  headers = { getSetCookie: () => [] }
} = {}) {
  return {
    ok,
    status,
    statusText,
    json,
    text,
    headers
  };
}

describe('HopGPTClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns false when refresh token is missing', async () => {
    const client = new HopGPTClient({ bearerToken: 'token', refreshToken: null });
    const refreshed = await client.refreshTokens();

    expect(refreshed).toBe(false);
  });

  it('refreshes tokens and retries on auth errors', async () => {
    const fetchMock = globalThis.fetch;
    const requestResponse = createMockResponse({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'unauthorized'
    });
    const refreshResponse = createMockResponse({
      ok: true,
      status: 200,
      json: async () => ({ token: 'new-token' }),
      headers: {
        getSetCookie: () => ['refreshToken=new-refresh; Path=/;']
      }
    });
    const retryResponse = createMockResponse({
      ok: true,
      status: 200
    });

    let callCount = 0;
    fetchMock.mockImplementation(async (url) => {
      callCount += 1;
      if (url.endsWith('/api/auth/refresh')) {
        return refreshResponse;
      }
      if (callCount === 1) {
        return requestResponse;
      }
      return retryResponse;
    });

    const client = new HopGPTClient({
      baseURL: 'https://example.com',
      bearerToken: 'old-token',
      refreshToken: 'refresh-token'
    });

    const response = await client.sendMessage({ text: 'hello' });
    expect(response.ok).toBe(true);
    expect(client.bearerToken).toBe('new-token');
    expect(client.cookies.refreshToken).toBe('new-refresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps HopGPT errors to Anthropic error formats', () => {
    const authError = new HopGPTError(401, 'Unauthorized');
    expect(authError.toAnthropicError()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'Unauthorized' }
    });

    const rateError = new HopGPTError(429, 'Too many requests');
    expect(rateError.toAnthropicError()).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Too many requests' }
    });
  });
});
