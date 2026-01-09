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

  it('passes through mcp_tool_call blocks in text when mcpPassthrough is enabled', () => {
    const transformer = new HopGPTToAnthropicTransformer('claude-sonnet-4-5-thinking', {
      thinkingEnabled: false,
      mcpPassthrough: true
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

    // In passthrough mode, the mcp_tool_call should remain in text
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Before');
    expect(textDeltas).toContain('After');
    expect(textDeltas).toContain('<mcp_tool_call>');
    expect(textDeltas).toContain('<tool_name>Edit</tool_name>');

    // No tool_use blocks should be created
    const toolStart = events.find(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeFalsy();

    // Non-streaming response should also preserve the text
    const response = transformer.buildNonStreamingResponse();
    const textBlocks = response.content.filter(b => b.type === 'text');
    expect(textBlocks.length).toBeGreaterThan(0);
    const fullText = textBlocks.map(b => b.text).join('');
    expect(fullText).toContain('<mcp_tool_call>');

    // No tool_use in content
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(0);
  });

  it('extracts function_calls/invoke blocks from text and emits tool_use', () => {
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

    // OpenCode format with multiple tool calls
    const functionCalls = `<function_calls>
<invoke name="Glob">
<parameter name="pattern">**/</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">README.md</parameter>
</invoke>
</function_calls>`;

    pushEvents({ created: true, message: { id: 'msg-create' } });
    pushEvents({
      event: 'on_message_delta',
      data: {
        delta: {
          content: [
            { type: 'text', text: `Let me explore: ${functionCalls} Done.` }
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

    // Text should not contain the XML blocks
    const textDeltas = events
      .filter(evt => evt.event === 'content_block_delta' && evt.data?.delta?.type === 'text_delta')
      .map(evt => evt.data.delta.text)
      .join('');
    expect(textDeltas).toContain('Let me explore:');
    expect(textDeltas).toContain('Done.');
    expect(textDeltas).not.toContain('<function_calls>');
    expect(textDeltas).not.toContain('<invoke');

    // Both tool_use blocks should be created
    const toolStarts = events.filter(evt =>
      evt.event === 'content_block_start' &&
      evt.data?.content_block?.type === 'tool_use'
    );
    expect(toolStarts.length).toBe(2);
    expect(toolStarts[0].data.content_block.name).toBe('Glob');
    expect(toolStarts[1].data.content_block.name).toBe('Read');

    // Non-streaming response should have both tool_use blocks
    const response = transformer.buildNonStreamingResponse();
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    expect(toolUseBlocks.length).toBe(2);
    expect(toolUseBlocks[0].name).toBe('Glob');
    expect(toolUseBlocks[0].input).toEqual({ pattern: '**/' });
    expect(toolUseBlocks[1].name).toBe('Read');
    expect(toolUseBlocks[1].input).toEqual({ file_path: 'README.md' });
    expect(response.stop_reason).toBe('tool_use');
  });
});
