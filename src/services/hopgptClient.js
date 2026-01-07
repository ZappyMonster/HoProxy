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
    this.isRefreshing = false;
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

  /**
   * Send a message to HopGPT
   * @param {object} hopGPTRequest - Request body in HopGPT format
   * @param {boolean} isRetry - Whether this is a retry after token refresh
   * @returns {Response} Fetch-like response object with body as string (SSE data)
   */
  async sendMessage(hopGPTRequest, isRetry = false) {
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

    // Add Bearer token if configured
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    // Add cookies if configured
    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    // Use TLS client with browser fingerprint to bypass Cloudflare
    const response = await tlsFetch({
      url,
      method: 'POST',
      headers,
      body: hopGPTRequest,
      browserType
    });

    if (!response.ok) {
      // Check if this is an auth error and we can retry
      if ((response.status === 401 || response.status === 403) && this.autoRefresh && !isRetry) {
        console.log(`[HopGPT] Auth error (${response.status}), attempting token refresh...`);

        const refreshed = await this.refreshTokens();
        if (refreshed) {
          console.log('[HopGPT] Retrying request with new token...');
          return this.sendMessage(hopGPTRequest, true);
        }
      }

      const errorText = response.body;
      throw new HopGPTError(
        response.status,
        `HopGPT request failed: ${response.status} ${response.statusText}`,
        errorText
      );
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
  constructor(statusCode, message, responseBody = null) {
    super(message);
    this.name = 'HopGPTError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
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

    return {
      type: 'error',
      error: {
        type: errorType,
        message: this.message
      }
    };
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
