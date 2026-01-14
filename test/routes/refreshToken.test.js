import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import refreshTokenRouter from '../../src/routes/refreshToken.js';
import { getDefaultClient } from '../../src/services/hopgptClient.js';
import { RefreshTokenExpiredError, CloudflareBlockedError } from '../../src/errors/authErrors.js';

vi.mock('../../src/services/hopgptClient.js', async () => {
  const actual = await vi.importActual('../../src/services/hopgptClient.js');
  return {
    ...actual,
    getDefaultClient: vi.fn()
  };
});

function createApp() {
  const app = express();
  app.use(refreshTokenRouter);
  return app;
}

describe('refresh-token route', () => {
  beforeEach(() => {
    getDefaultClient.mockReset();
  });

  it('returns authentication_error when refresh token expired', async () => {
    const mockClient = {
      cookies: { refreshToken: 'refresh-token' },
      refreshTokens: vi.fn()
    };
    mockClient.refreshTokens.mockRejectedValue(new RefreshTokenExpiredError());
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const response = await request(app).post('/refresh-token');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('returns api_error when Cloudflare blocks refresh', async () => {
    const mockClient = {
      cookies: { refreshToken: 'refresh-token' },
      refreshTokens: vi.fn()
    };
    mockClient.refreshTokens.mockRejectedValue(new CloudflareBlockedError());
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const response = await request(app).post('/refresh-token');

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.error.type).toBe('api_error');
  });
});
