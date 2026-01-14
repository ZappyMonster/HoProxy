/**
 * Authentication error classes for token refresh failures
 */

/**
 * Base class for authentication errors
 */
export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Thrown when token refresh fails and the caller should handle it
 */
export class TokenRefreshError extends AuthError {
  constructor(message = 'Failed to refresh authentication token') {
    super(message, 'TOKEN_REFRESH_FAILED');
    this.name = 'TokenRefreshError';
  }
}

/**
 * Thrown when the refresh token has expired and re-authentication is required
 */
export class RefreshTokenExpiredError extends AuthError {
  constructor() {
    super('Refresh token expired, re-authentication required', 'REFRESH_EXPIRED');
    this.name = 'RefreshTokenExpiredError';
  }
}

/**
 * Thrown when Cloudflare blocks the request
 */
export class CloudflareBlockedError extends AuthError {
  constructor() {
    super('Request blocked by Cloudflare, may need new cf_clearance cookie', 'CF_BLOCKED');
    this.name = 'CloudflareBlockedError';
  }
}

/**
 * Thrown when a network error occurs during token refresh
 */
export class NetworkError extends AuthError {
  constructor(originalError) {
    super(`Network error during token refresh: ${originalError?.message || 'Unknown error'}`, 'NETWORK_ERROR');
    this.name = 'NetworkError';
    this.originalError = originalError;
  }
}
