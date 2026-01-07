import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HopGPTClient, HopGPTError } from '../../src/services/hopgptClient.js';
import * as tlsClient from '../../src/services/tlsClient.js';

function createMockTLSResponse({
  ok = true,
  status = 200,
  statusText = 'OK',
  body = '',
  headers = {}
} = {}) {
  return {
    ok,
    status,
    statusText,
    body,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body || '{}')
  };
}

describe('HopGPTClient', () => {
  let tlsFetchSpy;

  beforeEach(() => {
    // Mock tlsFetch instead of global fetch
    tlsFetchSpy = vi.spyOn(tlsClient, 'tlsFetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when refresh token is missing', async () => {
    const client = new HopGPTClient({ bearerToken: 'token', refreshToken: null });
    const refreshed = await client.refreshTokens();

    expect(refreshed).toBe(false);
  });

  it('refreshes tokens and retries on auth errors', async () => {
    const requestResponse = createMockTLSResponse({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: 'unauthorized'
    });
    const refreshResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: JSON.stringify({ token: 'new-token' }),
      headers: {
        'set-cookie': ['refreshToken=new-refresh; Path=/;']
      }
    });
    const retryResponse = createMockTLSResponse({
      ok: true,
      status: 200,
      body: 'data: {"type":"text"}\n\n'
    });

    let callCount = 0;
    tlsFetchSpy.mockImplementation(async (options) => {
      callCount += 1;
      if (options.url.endsWith('/api/auth/refresh')) {
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
    expect(tlsFetchSpy).toHaveBeenCalledTimes(3);
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
