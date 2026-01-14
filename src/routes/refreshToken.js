import { Router } from 'express';
import { getDefaultClient, getTokenExpiryInfo } from '../services/hopgptClient.js';
import {
  AuthError,
  RefreshTokenExpiredError,
  TokenRefreshError,
  CloudflareBlockedError,
  NetworkError
} from '../errors/authErrors.js';
import { loggers } from '../utils/logger.js';

const log = loggers.auth;
const router = Router();

/**
 * GET /token-status
 * Get current token expiry status without triggering a refresh
 */
router.get('/token-status', (req, res) => {
  const client = getDefaultClient();
  log.debug('Checking token status');

  const bearerTokenInfo = getTokenExpiryInfo(client.bearerToken);
  const refreshTokenInfo = getTokenExpiryInfo(client.cookies?.refreshToken);

  const status = {
    bearerToken: bearerTokenInfo ? {
      ...bearerTokenInfo,
      present: true
    } : {
      present: !!client.bearerToken,
      isExpired: null,
      note: client.bearerToken ? 'Token is not a decodable JWT' : 'No bearer token configured'
    },
    refreshToken: refreshTokenInfo ? {
      ...refreshTokenInfo,
      present: true
    } : {
      present: !!client.cookies?.refreshToken,
      isExpired: null,
      note: client.cookies?.refreshToken ? 'Token is not a decodable JWT' : 'No refresh token configured'
    },
    autoRefresh: client.autoRefresh,
    timestamp: new Date().toISOString()
  };

  res.json(status);
});

/**
 * POST /refresh-token
 * Manually refresh HopGPT session tokens
 */
router.post('/refresh-token', async (req, res) => {
  const client = getDefaultClient();
  log.info('Manual token refresh requested');

  if (!client.cookies?.refreshToken) {
    log.warn('Token refresh failed: no refresh token configured');
    return res.status(400).json({
      success: false,
      error: {
        message: 'Missing refresh token configuration (HOPGPT_COOKIE_REFRESH_TOKEN).'
      }
    });
  }

  try {
    const refreshed = await client.refreshTokens();
    const tokenExpiry = refreshed ? getTokenExpiryInfo(client.bearerToken) : null;

    if (refreshed) {
      log.info('Token refresh successful', {
        expiresIn: tokenExpiry?.expiresInSeconds ? `${Math.floor(tokenExpiry.expiresInSeconds / 60)}m` : 'unknown'
      });
    } else {
      log.error('Token refresh failed');
    }

    return res.status(refreshed ? 200 : 502).json({
      success: refreshed,
      tokenExpiry: tokenExpiry || undefined
    });
  } catch (error) {
    if (error instanceof AuthError) {
      const { statusCode, errorType } = mapAuthErrorStatus(error);
      log.warn('Token refresh failed', { error: error.message, type: error.constructor.name });
      return res.status(statusCode).json({
        success: false,
        error: {
          type: errorType,
          message: error.message
        }
      });
    }

    log.error('Token refresh error', { error: error.message });
    return res.status(502).json({
      success: false,
      error: {
        type: 'api_error',
        message: error.message || 'Token refresh failed'
      }
    });
  }
});

export default router;

function mapAuthErrorStatus(error) {
  if (error instanceof RefreshTokenExpiredError || error instanceof TokenRefreshError) {
    return { statusCode: 401, errorType: 'authentication_error' };
  }
  if (error instanceof CloudflareBlockedError) {
    return { statusCode: 503, errorType: 'api_error' };
  }
  if (error instanceof NetworkError) {
    return { statusCode: 502, errorType: 'api_error' };
  }
  return { statusCode: 500, errorType: 'api_error' };
}
