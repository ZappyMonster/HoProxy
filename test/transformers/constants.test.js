import { describe, it, expect } from 'vitest';
import { HopGPTToAnthropicTransformer } from '../../src/transformers/hopGPTToAnthropic.js';

describe('HopGPTToAnthropicTransformer Constants Verification', () => {
  it('correctly buffers split <antml:function_calls> tag', () => {
    const transformer = new HopGPTToAnthropicTransformer();

    // 1. Send first part: "<antml"
    // If bug exists, this would not match any constant and would be emitted as text immediately
    const event1 = {
      event: 'on_message_delta',
      data: JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: '<antml' }]
          }
        }
      })
    };

    const result1 = transformer.transformEvent(event1);

    // With correct buffering, we should get NO text delta for "<antml"
    // Result might contain message_start or content_block_start for text if text came before
    // But since we just sent "<antml", it should be buffered.

    // However, the transformer might emit an empty text block start if it's the first thing.
    // Let's check what events are returned.

    // If it did NOT buffer, we would see a text_delta with "<antml".
    const hasTextDeltaWithPartialTag = result1?.some(e =>
      e.event === 'content_block_delta' &&
      e.data.delta.text === '<antml'
    );

    expect(hasTextDeltaWithPartialTag).toBeFalsy();

    // 2. Send second part: ":function_calls>"
    // Plus the actual tool invocation content to make it a valid block
    const restOfTag = ':function_calls><invoke name="test_tool"><parameter name="arg">value</parameter></invoke></antml:function_calls>';

    const event2 = {
      event: 'on_message_delta',
      data: JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: restOfTag }]
          }
        }
      })
    };

    const result2 = transformer.transformEvent(event2);

    // Now we should see a tool_use block start
    const hasToolUseStart = result2?.some(e =>
      e.event === 'content_block_start' &&
      e.data.content_block.type === 'tool_use'
    );

    expect(hasToolUseStart).toBeTruthy();

    // And we should see the tool name
    const toolUseStart = result2?.find(e =>
        e.event === 'content_block_start' &&
        e.data.content_block.type === 'tool_use'
    );
    expect(toolUseStart.data.content_block.name).toBe('test_tool');
  });

  it('correctly buffers split <antml:invoke> tag', () => {
    const transformer = new HopGPTToAnthropicTransformer();

    // 1. Send first part: "<antml"
    const event1 = {
      event: 'on_message_delta',
      data: JSON.stringify({
        event: 'on_message_delta',
        data: {
          delta: {
            content: [{ type: 'text', text: '<function_calls><antml' }]
          }
        }
      })
    };

    const result1 = transformer.transformEvent(event1);

    // Should NOT see "<antml" in text delta
    // But we might see "<function_calls>" processed if it was complete?
    // Wait, <function_calls> is opening tag.

    // Let's simplify. Just <antml:invoke>

    const simpleEvent1 = {
        event: 'on_message_delta',
        data: JSON.stringify({
          event: 'on_message_delta',
          data: {
            delta: {
              content: [{ type: 'text', text: '<antml' }]
            }
          }
        })
      };

    const simpleResult1 = transformer.transformEvent(simpleEvent1);
    const hasTextDeltaWithPartialTag = simpleResult1?.some(e =>
        e.event === 'content_block_delta' &&
        e.data.delta.text === '<antml'
    );
    expect(hasTextDeltaWithPartialTag).toBeFalsy();

    // 2. Send rest: ":invoke name="test"></antml:invoke>"
    // Note: this tag usually appears inside function_calls, but the parser might handle it standalone?
    // ANY_TOOL_CALL_BLOCK_RE includes <(?:antml:)?invoke...

    const rest = ':invoke name="test"></antml:invoke>';
    const event2 = {
        event: 'on_message_delta',
        data: JSON.stringify({
          event: 'on_message_delta',
          data: {
            delta: {
              content: [{ type: 'text', text: rest }]
            }
          }
        })
      };

    const result2 = transformer.transformEvent(event2);

    const hasToolUseStart = result2?.some(e =>
        e.event === 'content_block_start' &&
        e.data.content_block.type === 'tool_use'
    );

    expect(hasToolUseStart).toBeTruthy();
  });
});
