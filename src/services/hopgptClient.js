/**
 * HopGPT API Client
 * Handles authentication and communication with the HopGPT backend
 */
export class HopGPTClient {
  constructor(config = {}) {
    this.baseURL = config.baseURL || 'https://chat.ai.jh.edu';
    this.endpoint = config.endpoint || '/api/agents/chat/AnthropicClaude';
    this.bearerToken = config.bearerToken || process.env.HOPGPT_BEARER_TOKEN;
    this.cookies = {
      cf_clearance: config.cfClearance || process.env.HOPGPT_COOKIE_CF_CLEARANCE,
      connect_sid: config.connectSid || process.env.HOPGPT_COOKIE_CONNECT_SID,
      __cf_bm: config.cfBm || process.env.HOPGPT_COOKIE_CF_BM,
      refreshToken: config.refreshToken || process.env.HOPGPT_COOKIE_REFRESH_TOKEN
    };
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

    return cookies.join('; ');
  }

  /**
   * Send a message to HopGPT
   * @param {object} hopGPTRequest - Request body in HopGPT format
   * @returns {Response} Fetch response with SSE stream
   */
  async sendMessage(hopGPTRequest) {
    const url = `${this.baseURL}${this.endpoint}`;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(hopGPTRequest)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new HopGPTError(
        response.status,
        `HopGPT request failed: ${response.status} ${response.statusText}`,
        errorText
      );
    }

    return response;
  }

  /**
   * Validate that required authentication is configured
   * @returns {object} Validation result with status and missing fields
   */
  validateAuth() {
    const missing = [];

    if (!this.bearerToken) {
      missing.push('HOPGPT_BEARER_TOKEN');
    }
    if (!this.cookies.refreshToken) {
      missing.push('HOPGPT_COOKIE_REFRESH_TOKEN');
    }

    return {
      valid: missing.length === 0,
      missing
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
