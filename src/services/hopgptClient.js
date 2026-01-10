import { tlsFetch } from './tlsClient.js';

/**
 * HopGPT API Client
 * Handles authentication and communication with the HopGPT backend
 * Uses node-tls-client to bypass Cloudflare TLS fingerprinting
 */
export class HopGPTClient {
  constructor(config = {}) {
    this.baseURL = config.baseURL || 'https://chat.ai.jh.edu';
    this.endpoint = config.endpoint || '/api/agents/chat/AnthropicClaude';
    this.bearerToken = config.bearerToken || process.env.HOPGPT_BEARER_TOKEN;
    this.userAgent = config.userAgent || process.env.HOPGPT_USER_AGENT;
    this.cookies = {
      cf_clearance: config.cfClearance || process.env.HOPGPT_COOKIE_CF_CLEARANCE,
      connect_sid: config.connectSid || process.env.HOPGPT_COOKIE_CONNECT_SID,
      __cf_bm: config.cfBm || process.env.HOPGPT_COOKIE_CF_BM,
      refreshToken: config.refreshToken || process.env.HOPGPT_COOKIE_REFRESH_TOKEN,
      token_provider: config.tokenProvider || process.env.HOPGPT_COOKIE_TOKEN_PROVIDER || 'librechat'
    };
    this.autoRefresh = config.autoRefresh !== false;
    this.streamingTransport = (config.streamingTransport ||
      process.env.HOPGPT_STREAMING_TRANSPORT ||
      'fetch').toLowerCase();
    this.isRefreshing = false;

    // Rate limiting configuration
    this.rateLimitConfig = {
      maxRetries: config.rateLimitMaxRetries ?? 3,
      baseDelayMs: config.rateLimitBaseDelayMs ?? 1000,
      maxDelayMs: config.rateLimitMaxDelayMs ?? 30000,
      maxWaitTimeMs: config.rateLimitMaxWaitTimeMs ?? 10000  // Wait for short limits (≤10 sec)
    };
  }

  /**
   * Extract retry delay from Retry-After header
   * @param {object} headers - Response headers
   * @returns {number|null} Delay in milliseconds, or null if not present
   */
  _extractRetryAfter(headers) {
    if (!headers) {
      return null;
    }

    const retryAfter = typeof headers.get === 'function'
      ? headers.get('retry-after')
      : headers['retry-after'] || headers['Retry-After'];
    if (!retryAfter) {
      return null;
    }

    // Retry-After can be either a number of seconds or an HTTP-date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as HTTP-date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const delayMs = date.getTime() - Date.now();
      return Math.max(0, delayMs);
    }

    return null;
  }

  /**
   * Calculate exponential backoff delay
   * @param {number} attempt - Current retry attempt (0-indexed)
   * @param {number|null} retryAfterMs - Retry-After header value in milliseconds
   * @returns {number} Delay in milliseconds
   */
  _calculateBackoffDelay(attempt, retryAfterMs) {
    // If Retry-After is provided and within our max wait time, use it
    if (retryAfterMs !== null && retryAfterMs <= this.rateLimitConfig.maxWaitTimeMs) {
      return retryAfterMs;
    }

    // Otherwise, use exponential backoff: baseDelay * 2^attempt with jitter
    const exponentialDelay = this.rateLimitConfig.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    const delay = Math.min(exponentialDelay + jitter, this.rateLimitConfig.maxDelayMs);

    return Math.round(delay);
  }

  /**
   * Sleep for a specified duration
   * @param {number} ms - Duration in milliseconds
   */
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Build browser-like headers to pass Cloudflare bot detection
   * Headers are ordered to match real browser request patterns
   * @param {string} browserType - 'firefox' or 'chrome' to match the browser used for cookie extraction
   * @returns {object} Headers object with browser-like values
   */
  buildBrowserHeaders(browserType = 'firefox') {
    // Detect browser type from User-Agent if available
    const detectedBrowser = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';
    const browser = browserType || detectedBrowser;

    if (browser === 'firefox') {
      // Firefox-specific headers (matching HAR capture exactly)
      const headers = {
        'User-Agent': this.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Connection': 'keep-alive',
        'Priority': 'u=0',
        'TE': 'trailers'
      };
      return headers;
    } else {
      // Chrome-specific headers
      const headers = {
        'User-Agent': this.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Connection': 'keep-alive',
        'Priority': 'u=4, i'
      };
      return headers;
    }
  }

  /**
   * Build the cookie header string from configured cookies
   * @returns {string} Cookie header value
   */
  buildCookieHeader() {
    const cookies = [];

    if (this.cookies.cf_clearance) {
      cookies.push(`cf_clearance=${this.cookies.cf_clearance}`);
    }
    if (this.cookies.connect_sid) {
      cookies.push(`connect.sid=${this.cookies.connect_sid}`);
    }
    if (this.cookies.__cf_bm) {
      cookies.push(`__cf_bm=${this.cookies.__cf_bm}`);
    }
    if (this.cookies.refreshToken) {
      cookies.push(`refreshToken=${this.cookies.refreshToken}`);
    }
    if (this.cookies.token_provider) {
      cookies.push(`token_provider=${this.cookies.token_provider}`);
    }

    return cookies.join('; ');
  }

  /**
   * Parse Set-Cookie headers and update internal cookie state
   * @param {Headers} headers - Response headers (native fetch Headers object)
   */
  updateCookiesFromResponse(headers) {
    const setCookieHeaders = headers.getSetCookie?.() || [];
    this._parseCookies(setCookieHeaders);
  }

  /**
   * Parse Set-Cookie headers from TLS client response
   * @param {object} headers - Response headers object from TLS client
   */
  updateCookiesFromTLSResponse(headers) {
    // TLS client returns headers as an object, Set-Cookie may be a string or array
    let setCookieHeaders = headers['set-cookie'] || headers['Set-Cookie'] || [];
    if (typeof setCookieHeaders === 'string') {
      setCookieHeaders = [setCookieHeaders];
    }
    this._parseCookies(setCookieHeaders);
  }

  /**
   * Parse cookie strings and update internal state
   * @param {string[]} setCookieHeaders - Array of Set-Cookie header values
   */
  _parseCookies(setCookieHeaders) {
    for (const cookieStr of setCookieHeaders) {
      const [cookiePart] = cookieStr.split(';');
      const [name, value] = cookiePart.split('=');

      if (name === 'refreshToken') {
        this.cookies.refreshToken = value;
        console.log('[HopGPT] Refresh token updated');
      } else if (name === 'connect.sid') {
        this.cookies.connect_sid = value;
      } else if (name === 'cf_clearance') {
        this.cookies.cf_clearance = value;
      } else if (name === '__cf_bm') {
        this.cookies.__cf_bm = value;
      }
    }
  }

  /**
   * Refresh the bearer token using the refresh token
   * @returns {Promise<boolean>} True if refresh succeeded
   */
  async refreshTokens() {
    if (this.isRefreshing) {
      // Wait for ongoing refresh to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      return !!this.bearerToken;
    }

    if (!this.cookies.refreshToken) {
      console.error('[HopGPT] No refresh token available');
      return false;
    }

    this.isRefreshing = true;
    console.log('[HopGPT] Attempting to refresh tokens...');

    try {
      const url = `${this.baseURL}/api/auth/refresh`;

      // Detect browser type from User-Agent
      const browserType = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';

      // Start with browser-like headers to pass Cloudflare
      // Use the same headers as real browser requests
      const headers = {
        ...this.buildBrowserHeaders(),
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': this.baseURL,
        'Referer': `${this.baseURL}/`
      };

      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      // Use TLS client with browser fingerprint to bypass Cloudflare
      const response = await tlsFetch({
        url,
        method: 'POST',
        headers,
        body: '{}',
        browserType
      });

      if (!response.ok) {
        const errorText = response.body;
        console.error(`[HopGPT] Token refresh failed: ${response.status} ${response.statusText}`, errorText);
        return false;
      }

      // Parse the response to get the new bearer token
      const data = await response.json();

      if (data.token) {
        this.bearerToken = data.token;
        console.log('[HopGPT] Bearer token refreshed successfully');
      }

      // Update cookies from Set-Cookie headers (includes rotated refresh token)
      this.updateCookiesFromTLSResponse(response.headers);

      return true;
    } catch (error) {
      console.error('[HopGPT] Token refresh error:', error.message);
      return false;
    } finally {
      this.isRefreshing = false;
    }
  }

  _shouldUseFetchForStreaming() {
    if (this.streamingTransport === 'tls') {
      return false;
    }

    if (typeof fetch !== 'function') {
      if (process.env.HOPGPT_DEBUG === 'true') {
        console.warn('[HopGPT] fetch is not available; falling back to TLS client for streaming');
      }
      return false;
    }

    return true;
  }

  _sanitizeHeadersForFetch(headers) {
    const forbidden = new Set([
      'connection',
      'content-length',
      'accept-encoding',
      'transfer-encoding',
      'upgrade',
      'host',
      'keep-alive',
      'proxy-connection',
      'te',
      'trailer'
    ]);

    const sanitized = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!forbidden.has(key.toLowerCase())) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async _fetchStream(url, headers, body) {
    const sanitizedHeaders = this._sanitizeHeadersForFetch(headers);

    return fetch(url, {
      method: 'POST',
      headers: sanitizedHeaders,
      body: JSON.stringify(body)
    });
  }

  async _readResponseText(response) {
    if (!response) {
      return '';
    }

    if (typeof response.text === 'function') {
      try {
        return await response.text();
      } catch (error) {
        return '';
      }
    }

    return response.body || '';
  }

  /**
   * Send a message to HopGPT
   * @param {object} hopGPTRequest - Request body in HopGPT format
   * @param {object} requestOptions - Request options
   * @param {object} retryState - Internal retry state
   * @returns {Response} Fetch-like response object with body as string (SSE data)
   */
  async sendMessage(
    hopGPTRequest,
    requestOptions = {},
    retryState = { isAuthRetry: false, rateLimitAttempt: 0 }
  ) {
    const url = `${this.baseURL}${this.endpoint}`;

    // Detect browser type from User-Agent
    const browserType = this.userAgent?.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';

    // Start with browser-like headers to pass Cloudflare
    // Accept: */* matches real browser behavior for this endpoint (from HAR capture)
    const headers = {
      ...this.buildBrowserHeaders(),
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': this.baseURL,
      'Referer': `${this.baseURL}/c/new`
    };

    const isStreaming = requestOptions.stream === true;
    if (isStreaming) {
      headers['Accept'] = 'text/event-stream';
      headers['Cache-Control'] = 'no-cache';
      headers['Pragma'] = 'no-cache';
    }

    // Add Bearer token if configured
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    // Add cookies if configured
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    let useFetchForStreaming = isStreaming && this._shouldUseFetchForStreaming();
    let response;

    if (useFetchForStreaming) {
      try {
        response = await this._fetchStream(url, headers, hopGPTRequest);
      } catch (error) {
        useFetchForStreaming = false;
        if (process.env.HOPGPT_DEBUG === 'true') {
          console.warn(`[HopGPT] Streaming fetch failed (${error.message}), falling back to TLS client`);
        }
      }
    }

    if (!useFetchForStreaming) {
      response = await tlsFetch({
        url,
        method: 'POST',
        headers,
        body: hopGPTRequest,
        browserType
      });
    }

    if (!response.ok) {
      const errorText = await this._readResponseText(response);

      // Handle rate limiting (429)
      if (response.status === 429) {
        const retryAfterMs = this._extractRetryAfter(response.headers);
        const { rateLimitAttempt } = retryState;

        console.log(`[HopGPT] Rate limited (429). Attempt ${rateLimitAttempt + 1}/${this.rateLimitConfig.maxRetries}. ` +
          `Retry-After: ${retryAfterMs !== null ? `${retryAfterMs}ms` : 'not specified'}`);

        // Check if we should retry
        const canRetry = rateLimitAttempt < this.rateLimitConfig.maxRetries;
        const waitTime = this._calculateBackoffDelay(rateLimitAttempt, retryAfterMs);

        // If Retry-After exceeds our max wait time, don't retry
        if (retryAfterMs !== null && retryAfterMs > this.rateLimitConfig.maxWaitTimeMs) {
          console.log(`[HopGPT] Rate limit wait time (${retryAfterMs}ms) exceeds max wait time ` +
            `(${this.rateLimitConfig.maxWaitTimeMs}ms). Returning error to client.`);
          throw new HopGPTError(
            response.status,
            `Rate limited. Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`,
            errorText,
            retryAfterMs
          );
        }

        if (canRetry) {
          console.log(`[HopGPT] Waiting ${waitTime}ms before retry...`);
          await this._sleep(waitTime);

          return this.sendMessage(hopGPTRequest, requestOptions, {
            ...retryState,
            rateLimitAttempt: rateLimitAttempt + 1
          });
        }

        // Retries exhausted
        console.log(`[HopGPT] Rate limit retries exhausted after ${rateLimitAttempt + 1} attempts.`);
        throw new HopGPTError(
          response.status,
          'Rate limit retries exhausted. Please try again later.',
          errorText,
          retryAfterMs
        );
      }

      // Check if this is an auth error and we can retry
      if ((response.status === 401 || response.status === 403) && this.autoRefresh && !retryState.isAuthRetry) {
        console.log(`[HopGPT] Auth error (${response.status}), attempting token refresh...`);

        const refreshed = await this.refreshTokens();
        if (refreshed) {
          console.log('[HopGPT] Retrying request with new token...');
          return this.sendMessage(hopGPTRequest, requestOptions, { ...retryState, isAuthRetry: true });
        }
      }

      throw new HopGPTError(
        response.status,
        `HopGPT request failed: ${response.status} ${response.statusText}`,
        errorText
      );
    }

    if (useFetchForStreaming) {
      return response;
    }

    // Return a response-like object that the SSE parser can work with
    // The body is the SSE text, we'll create a readable stream from it
    return this._createStreamResponse(response);
  }

  /**
   * Create a fetch-like Response object from TLS client response
   * Converts the string body to a ReadableStream for SSE parsing
   * @param {object} tlsResponse - TLS client response
   * @returns {object} Fetch-like Response object
   */
  _createStreamResponse(tlsResponse) {
    const body = tlsResponse.body || '';

    // Create a ReadableStream from the string
    const stream = new ReadableStream({
      start(controller) {
        // Encode the string as bytes and enqueue
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    });

    return {
      ok: tlsResponse.ok,
      status: tlsResponse.status,
      statusText: tlsResponse.statusText,
      headers: tlsResponse.headers,
      body: stream,
      // Also provide the raw body text for non-streaming use
      _rawBody: body,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  }

  /**
   * Validate that required authentication is configured
   * @returns {object} Validation result with status and missing fields
   */
  validateAuth() {
    const missing = [];
    const warnings = [];

    // Refresh token is required for auto-refresh to work
    if (!this.cookies.refreshToken) {
      missing.push('HOPGPT_COOKIE_REFRESH_TOKEN');
    }

    if (!this.cookies.cf_clearance) {
      warnings.push('HOPGPT_COOKIE_CF_CLEARANCE not set; Cloudflare may block requests');
    }

    if (!this.cookies.__cf_bm) {
      warnings.push('HOPGPT_COOKIE_CF_BM not set; Cloudflare may block requests');
    }

    if (!this.userAgent) {
      warnings.push('HOPGPT_USER_AGENT not set; Cloudflare may require a browser user agent');
    }

    // Bearer token is optional if refresh token is available (we can refresh it)
    if (!this.bearerToken) {
      if (this.cookies.refreshToken) {
        warnings.push('HOPGPT_BEARER_TOKEN not set, will attempt to refresh on first request');
      } else {
        missing.push('HOPGPT_BEARER_TOKEN');
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      warnings
    };
  }
}

/**
 * Custom error class for HopGPT API errors
 */
export class HopGPTError extends Error {
  constructor(statusCode, message, responseBody = null, retryAfterMs = null) {
    super(message);
    this.name = 'HopGPTError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
  }

  /**
   * Convert to Anthropic-compatible error format
   * @returns {object} Anthropic error response
   */
  toAnthropicError() {
    let errorType = 'api_error';

    if (this.statusCode === 401 || this.statusCode === 403) {
      errorType = 'authentication_error';
    } else if (this.statusCode === 400) {
      errorType = 'invalid_request_error';
    } else if (this.statusCode === 429) {
      errorType = 'rate_limit_error';
    } else if (this.statusCode >= 500) {
      errorType = 'api_error';
    }

    const error = {
      type: 'error',
      error: {
        type: errorType,
        message: this.message
      }
    };

    // Include retry-after information for rate limit errors
    if (this.statusCode === 429 && this.retryAfterMs !== null) {
      error.error.retry_after_seconds = Math.ceil(this.retryAfterMs / 1000);
    }

    return error;
  }
}

// Export a default client instance
let defaultClient = null;

export function getDefaultClient() {
  if (!defaultClient) {
    defaultClient = new HopGPTClient();
  }
  return defaultClient;
}

export function resetDefaultClient() {
  defaultClient = null;
}
