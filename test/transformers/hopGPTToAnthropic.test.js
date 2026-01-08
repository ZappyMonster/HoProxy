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

  it('extracts mcp_tool_call blocks from text and emits tool_use', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false
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

    const mcpCall = `<mcp_tool_call>
<server_name>opencode</server_name>
<tool_name>Edit</tool_name>
<arguments>
{
  "file_path": "example.ts",
  "new_string": "line 1\\nline 2\\nline 3"
}
</arguments>
</mcp_tool_call>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Before ${mcpCall} After` }
          ]
        }
      }
    });
    pushEvents({
      final: true,
      responseMessage: {
        messageId: 'msg-final',
        promptTokens: 0,
        tokenCount: 0,
        stopReason: 'stop',
        content: []
      }
    });

    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).not.toContain('<mcp_tool_call>');

    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use' &&
      evt.data?.content_block?.name === 'Edit'
    );
    expect(toolStart).toBeTruthy();

    const response = transformer.buildNonStreamingResponse();
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'example.ts',
            new_string: 'line 1\nline 2\nline 3'
          }
        })
      ])
    );
  });
});
