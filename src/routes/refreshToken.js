import { Router } from 'express';
import { getDefaultClient } from '../services/hopgptClient.js';
import { loggers } from '../utils/logger.js';

const log = loggers.auth;
const router = Router();

function getTokenExpiryInfo(token) {
  if (!token) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = Buffer.from(paddedPayload, 'base64').toString('utf8');
    const data = JSON.parse(decoded);

    if (typeof data.exp !== 'number') {
      return null;
    }

    const expiresAtMs = data.exp * 1000;
    if (!Number.isFinite(expiresAtMs)) {
      return null;
    }

    const expiresAt = new Date(expiresAtMs);
    if (Number.isNaN(expiresAt.getTime())) {
      return null;
    }

    const expiresInSeconds = Math.floor((expiresAtMs - Date.now()) / 1000);
    const isExpired = expiresInSeconds <= 0;

    return {
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.max(0, expiresInSeconds),
      isExpired
    };
  } catch (error) {
    return null;
  }
}

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
