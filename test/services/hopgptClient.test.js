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

  it('includes retry_after_seconds in rate limit error when retryAfterMs is provided', () => {
    const rateError = new HopGPTError(429, 'Rate limited', null, 5000);
    expect(rateError.toAnthropicError()).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limited',
        retry_after_seconds: 5
      }
    });
  });

  describe('rate limiting', () => {
    it('retries on 429 with exponential backoff', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: { 'retry-after': '1' }
      });
      const successResponse = createMockTLSResponse({
        ok: true,
        status: 200,
        body: 'data: {"type":"text"}\n\n'
      });

      let callCount = 0;
      tlsFetchSpy.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return rateLimitResponse;
        }
        return successResponse;
      });

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        refreshToken: 'refresh-token',
        rateLimitMaxRetries: 3,
        rateLimitBaseDelayMs: 10  // Use short delay for tests
      });

      const response = await client.sendMessage({ text: 'hello' });
      expect(response.ok).toBe(true);
      expect(tlsFetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws error when rate limit retries are exhausted', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: {}
      });

      tlsFetchSpy.mockResolvedValue(rateLimitResponse);

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        refreshToken: 'refresh-token',
        rateLimitMaxRetries: 2,
        rateLimitBaseDelayMs: 10
      });

      await expect(client.sendMessage({ text: 'hello' })).rejects.toThrow(
        'Rate limit retries exhausted. Please try again later.'
      );
      // Initial attempt + 2 retries = 3 calls
      expect(tlsFetchSpy).toHaveBeenCalledTimes(3);
    });

    it('does not retry when Retry-After exceeds maxWaitTimeMs', async () => {
      const rateLimitResponse = createMockTLSResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: 'rate limited',
        headers: { 'retry-after': '60' }  // 60 seconds
      });

      tlsFetchSpy.mockResolvedValue(rateLimitResponse);

      const client = new HopGPTClient({
        baseURL: 'https://example.com',
        bearerToken: 'token',
        refreshToken: 'refresh-token',
        rateLimitMaxRetries: 3,
        rateLimitMaxWaitTimeMs: 10000  // 10 seconds max
      });

      await expect(client.sendMessage({ text: 'hello' })).rejects.toThrow(
        'Rate limited. Retry after 60 seconds.'
      );
      // Should only call once since Retry-After exceeds max wait time
      expect(tlsFetchSpy).toHaveBeenCalledTimes(1);
    });

    it('extracts numeric Retry-After header', () => {
      const client = new HopGPTClient();

      expect(client._extractRetryAfter({ 'retry-after': '5' })).toBe(5000);
      expect(client._extractRetryAfter({ 'Retry-After': '10' })).toBe(10000);
      expect(client._extractRetryAfter({})).toBe(null);
    });

    it('calculates backoff delay with jitter', () => {
      const client = new HopGPTClient({
        rateLimitBaseDelayMs: 1000,
        rateLimitMaxDelayMs: 30000
      });

      // With Retry-After within max wait time, use Retry-After
      expect(client._calculateBackoffDelay(0, 5000)).toBe(5000);

      // Without Retry-After, use exponential backoff
      const delay0 = client._calculateBackoffDelay(0, null);
      expect(delay0).toBeGreaterThanOrEqual(1000);
      expect(delay0).toBeLessThanOrEqual(1300);  // Base + 30% jitter

      const delay1 = client._calculateBackoffDelay(1, null);
      expect(delay1).toBeGreaterThanOrEqual(2000);
      expect(delay1).toBeLessThanOrEqual(2600);
    });
  });
});
