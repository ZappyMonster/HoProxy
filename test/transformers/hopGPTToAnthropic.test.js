import { describe, it, expect } from 'vitest';
import {
  HopGPTToAnthropicTransformer,
  formatSSEEvent
} from '../../src/transformers/hopGPTToAnthropic.js';
import { readFixture } from '../helpers/fixtures.js';

describe('hopGPTToAnthropic transformer', () => {
  it('formats SSE events', () => {
    const formatted = formatSSEEvent({
      event: 'message_start',
      data: { type: 'message_start', message: { id: 'msg_1' } }
    });

    expect(formatted).toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n'
    );
  });

  it('transforms streaming thinking, text, and tool_use blocks', async () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: true,
      stopSequences: ['END']
    });

    const events = [];
    const pushEvents = (data) => {
      const result = transformer.transformEvent({
        event: 'message',
        data: JSON.stringify(data)
      });
      if (result) {
        events.push(...(Array.isArray(result) ? result : [result]));
      }
    };

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'thinking', thinking: 'Plan', signature: 'sig-1' }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: 'Hello' }
          ]
        }
      }
    });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'search',
              input: '{"q":"hi"}'
            }
          ]
        }
      }
    });

    const finalData = await readFixture('hopgpt-response-final.json');
    pushEvents(finalData);

    const eventNames = events.map(evt => evt.event);
    expect(eventNames).toContain('message_start');
    expect(eventNames).toContain('content_block_start');
    expect(eventNames).toContain('content_block_delta');
    expect(eventNames).toContain('message_stop');

    const thinkingDelta = events.find(evt => evt.event === 'content_block_delta' &&
      evt.data?.delta?.type === 'thinking_delta');
    const toolDelta = events.find(evt => evt.event === 'content_block_delta' &&
      evt.data?.delta?.type === 'input_json_delta');
    expect(thinkingDelta).toBeTruthy();
    expect(toolDelta).toBeTruthy();

    const response = transformer.buildNonStreamingResponse();
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'thinking', signature: 'sig-1' }),
        expect.objectContaining({ type: 'text', text: 'Hello' }),
        expect.objectContaining({ type: 'tool_use', name: 'get_weather' })
      ])
    );
    expect(response.stop_reason).toBe('tool_use');
  });
});
