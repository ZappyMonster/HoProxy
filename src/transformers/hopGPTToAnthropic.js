import { v4 as uuidv4 } from 'uuid';

/**
 * Transformer class to convert HopGPT SSE events to Anthropic SSE format
 */
export class HopGPTToAnthropicTransformer {
  constructor(model = 'claude-sonnet-4-20250514') {
    this.messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    this.model = model;
    this.hasStarted = false;
    this.accumulatedText = '';
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.conversationId = null;
    this.responseMessageId = null;
  }

  /**
   * Transform a HopGPT SSE event to Anthropic SSE event(s)
   * @param {object} event - Parsed SSE event with 'event' and 'data' fields
   * @returns {Array|null} Array of Anthropic SSE events or null if event should be skipped
   */
  transformEvent(event) {
    try {
      const data = JSON.parse(event.data);
      return this._transformData(data);
    } catch (error) {
      console.error('Failed to parse SSE event:', error);
      return null;
    }
  }

  _transformData(data) {
    // Event type 1: Initial message created
    if (data.created && data.message) {
      return this._createMessageStart();
    }

    // Event type 2: on_run_step - skip (internal HopGPT event)
    if (data.event === 'on_run_step') {
      return null;
    }

    // Event type 3: on_message_delta - text chunks
    if (data.event === 'on_message_delta') {
      const deltaContent = data.data?.delta?.content;
      if (deltaContent && deltaContent.length > 0) {
        const textDelta = deltaContent.find(c => c.type === 'text');
        if (textDelta && textDelta.text) {
          return this._createContentDelta(textDelta.text);
        }
      }
      return null;
    }

    // Event type 4: final - end of stream
    if (data.final) {
      this.conversationId = data.conversation?.conversationId;
      this.responseMessageId = data.responseMessage?.messageId;
      this.inputTokens = data.responseMessage?.promptTokens || 0;
      this.outputTokens = data.responseMessage?.tokenCount || 0;
      return this._createMessageStop();
    }

    return null;
  }

  _createMessageStart() {
    if (this.hasStarted) {
      return null;
    }
    this.hasStarted = true;

    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: this.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0
            }
          }
        }
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: ''
          }
        }
      }
    ];
  }

  _createContentDelta(text) {
    this.accumulatedText += text;

    // If we haven't sent the start events yet, send them first
    const events = [];
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) {
        events.push(...startEvents);
      }
    }

    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text
        }
      }
    });

    return events;
  }

  _createMessageStop() {
    return [
      {
        event: 'content_block_stop',
        data: {
          type: 'content_block_stop',
          index: 0
        }
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: 'end_turn',
            stop_sequence: null
          },
          usage: {
            output_tokens: this.outputTokens
          }
        }
      },
      {
        event: 'message_stop',
        data: {
          type: 'message_stop'
        }
      }
    ];
  }

  /**
   * Build a complete non-streaming response from accumulated data
   * @returns {object} Anthropic Messages API response
   */
  buildNonStreamingResponse() {
    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: this.accumulatedText
        }
      ],
      model: this.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens
      }
    };
  }

  /**
   * Get conversation state for multi-turn conversations
   * @returns {object} Conversation state
   */
  getConversationState() {
    return {
      conversationId: this.conversationId,
      lastAssistantMessageId: this.responseMessageId
    };
  }
}

/**
 * Format SSE event for writing to response
 * @param {object} event - Event with 'event' and 'data' fields
 * @returns {string} Formatted SSE string
 */
export function formatSSEEvent(event) {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
