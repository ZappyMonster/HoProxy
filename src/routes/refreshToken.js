import { Router } from 'express';
import { getDefaultClient } from '../services/hopgptClient.js';

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

    return {
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000))
    };
  } catch (error) {
    return null;
  }
}

/**
 * POST /refresh-token
 * Manually refresh HopGPT session tokens
 */
router.post('/refresh-token', async (req, res) => {
  const client = getDefaultClient();

  if (!client.cookies?.refreshToken) {
    return res.status(400).json({
      success: false,
      error: {
        message: 'Missing refresh token configuration (HOPGPT_COOKIE_REFRESH_TOKEN).'
      }
    });
  }

  const refreshed = await client.refreshTokens();
  const tokenExpiry = refreshed ? getTokenExpiryInfo(client.bearerToken) : null;

  return res.status(refreshed ? 200 : 502).json({
    success: refreshed,
    tokenExpiry: tokenExpiry || undefined
  });
});

export default router;
