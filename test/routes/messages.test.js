import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import messagesRouter from '../../src/routes/messages.js';
import { readFixture } from '../helpers/fixtures.js';
import { createSseResponseFromEvents } from '../helpers/sse.js';
import { getDefaultClient, HopGPTError } from '../../src/services/hopgptClient.js';

vi.mock('../../src/services/hopgptClient.js', async () => {
  const actual = await vi.importActual('../../src/services/hopgptClient.js');
  return {
    ...actual,
    getDefaultClient: vi.fn()
  };
});

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/v1', messagesRouter);
  return app;
}

describe('messages routes', () => {
  beforeEach(() => {
    getDefaultClient.mockReset();
  });

  it('rejects invalid requests', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/v1/messages')
      .send({ messages: [] });

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request_error');
  });

  it('returns authentication errors when auth is missing', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: false, missing: ['HOPGPT_BEARER_TOKEN'] })
    };
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app)
      .post('/v1/messages')
      .send(requestBody);

    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('handles non-streaming requests', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn()
    };
    const finalData = await readFixture('hopgpt-response-final.json');
    mockClient.sendMessage.mockResolvedValue(
      createSseResponseFromEvents([{ event: 'message', data: finalData }])
    );
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app)
      .post('/v1/messages')
      .send(requestBody);

    expect(response.status).toBe(200);
    expect(response.headers['x-session-id']).toBe('sess-123');
    expect(response.body.type).toBe('message');
    expect(response.body.stop_reason).toBe('tool_use');
    expect(response.body.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thinking' }),
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({ type: 'tool_use' })
      ])
    );
  });

  it('streams SSE responses', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn()
    };
    const streamEvents = [
      { event: 'message', data: { created: true, message: { id: 'msg-1' } } },
      {
        event: 'message',
        data: {
          event: 'on_message_delta',
          data: { delta: { content: [{ type: 'text', text: 'Hello' }] } }
        }
      },
      {
        event: 'message',
        data: {
          final: true,
          responseMessage: {
            messageId: 'msg-final',
            tokenCount: 1,
            content: [{ type: 'text', text: 'Hello' }]
          }
        }
      }
    ];
    mockClient.sendMessage.mockResolvedValue(createSseResponseFromEvents(streamEvents));
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-tools.json');
    
    // Use custom parser for SSE streams to handle req.on('close') listener properly
    const response = await request(app)
      .post('/v1/messages')
      .send(requestBody)
      .buffer(false)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => callback(null, data));
        res.on('error', callback);
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain('event: content_block_delta');
    expect(response.body).toContain('event: message_stop');
  });

  it('converts HopGPT errors to Anthropic error formats', async () => {
    const mockClient = {
      validateAuth: () => ({ valid: true, missing: [], warnings: [] }),
      sendMessage: vi.fn()
    };
    mockClient.sendMessage.mockRejectedValue(new HopGPTError(429, 'Rate limited'));
    getDefaultClient.mockReturnValue(mockClient);

    const app = createApp();
    const requestBody = await readFixture('anthropic-request-basic.json');
    const response = await request(app)
      .post('/v1/messages')
      .send(requestBody);

    expect(response.status).toBe(429);
    expect(response.body.error.type).toBe('rate_limit_error');
  });
});
