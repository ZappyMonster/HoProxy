import { Router } from 'express';
import { getDefaultClient, getTokenExpiryInfo } from '../services/hopgptClient.js';
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
});

export default router;
