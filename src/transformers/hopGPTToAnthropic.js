import { v4 as uuidv4 } from 'uuid';

/**
 * Check if a model supports extended thinking
 * @param {string} model - Model name
 * @returns {boolean} True if model supports thinking
 */
export function isThinkingModel(model) {
  if (!model) return false;
  const modelLower = model.toLowerCase();
  // Models with "-thinking" suffix or explicit thinking models
  return modelLower.includes('-thinking') ||
         modelLower.includes('thinking') ||
         // Claude Opus 4.5 models may support thinking with explicit parameter
         modelLower.includes('opus-4.5') ||
         modelLower.includes('opus-4-5');
}

/**
 * Transformer class to convert HopGPT SSE events to Anthropic SSE format
 * Supports extended thinking for compatible models
 */
export class HopGPTToAnthropicTransformer {
  constructor(model = 'claude-sonnet-4-20250514', options = {}) {
    this.messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    this.model = model;
    this.hasStarted = false;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.conversationId = null;
    this.responseMessageId = null;

    // Thinking support
    this.thinkingEnabled = options.thinkingEnabled ?? isThinkingModel(model);
    this.currentBlockIndex = -1;  // Will be incremented when blocks start
    this.currentBlockType = null; // 'thinking' or 'text'
    this.blockStarted = false;    // Track if current block has started

    // Accumulated content for non-streaming responses
    this.contentBlocks = [];      // Array of {type, content, signature?}
    this.accumulatedText = '';    // For backward compatibility
    this.accumulatedThinking = '';
    this.thinkingSignature = null;
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

    // Event type 3: on_message_delta - content chunks (text or thinking)
    if (data.event === 'on_message_delta') {
      const deltaContent = data.data?.delta?.content;
      if (deltaContent && deltaContent.length > 0) {
        const events = [];

        // Process all content blocks (may include thinking and text)
        for (const block of deltaContent) {
          const blockEvents = this._processContentBlock(block);
          if (blockEvents) {
            events.push(...blockEvents);
          }
        }

        // Also check for thoughtSignature in the delta
        if (data.data?.delta?.thoughtSignature) {
          this.thinkingSignature = data.data.delta.thoughtSignature;
        }

        return events.length > 0 ? events : null;
      }
      return null;
    }

    // Event type 4: final - end of stream
    if (data.final) {
      this.conversationId = data.conversation?.conversationId;
      this.responseMessageId = data.responseMessage?.messageId;
      this.inputTokens = data.responseMessage?.promptTokens || 0;
      this.outputTokens = data.responseMessage?.tokenCount || 0;

      // Check for thoughtSignature in final response
      if (data.responseMessage?.thoughtSignature) {
        this.thinkingSignature = data.responseMessage.thoughtSignature;
      }

      // Extract content blocks from final message for non-streaming
      if (data.responseMessage?.content) {
        this._extractFinalContent(data.responseMessage.content);
      }

      return this._createMessageStop();
    }

    return null;
  }

  /**
   * Process a single content block from delta
   */
  _processContentBlock(block) {
    const events = [];

    // Handle thinking blocks
    if (block.type === 'thinking' && block.thinking) {
      // If we were in a different block type, close it first
      if (this.blockStarted && this.currentBlockType !== 'thinking') {
        events.push(this._createBlockStop());
      }

      // Start thinking block if needed
      if (!this.blockStarted || this.currentBlockType !== 'thinking') {
        const startEvent = this._createBlockStart('thinking');
        if (startEvent) events.push(startEvent);
      }

      // Add thinking delta
      this.accumulatedThinking += block.thinking;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: block.thinking
          }
        }
      });

      // Capture signature if present
      if (block.signature) {
        this.thinkingSignature = block.signature;
      }

      return events;
    }

    // Handle text blocks
    if (block.type === 'text' && block.text) {
      // If we were in a thinking block, close it first
      if (this.blockStarted && this.currentBlockType === 'thinking') {
        events.push(this._createBlockStop());
      }

      // Start text block if needed
      if (!this.blockStarted || this.currentBlockType !== 'text') {
        const startEvent = this._createBlockStart('text');
        if (startEvent) events.push(startEvent);
      }

      // Add text delta
      this.accumulatedText += block.text;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'text_delta',
            text: block.text
          }
        }
      });

      return events;
    }

    return null;
  }

  /**
   * Extract content blocks from final message
   */
  _extractFinalContent(content) {
    for (const block of content) {
      if (block.type === 'thinking') {
        this.contentBlocks.push({
          type: 'thinking',
          thinking: block.thinking || this.accumulatedThinking,
          signature: block.signature || this.thinkingSignature
        });
      } else if (block.type === 'text') {
        this.contentBlocks.push({
          type: 'text',
          text: block.text || ''
        });
      }
    }
  }

  _createMessageStart() {
    if (this.hasStarted) {
      return null;
    }
    this.hasStarted = true;

    // Just emit message_start, blocks will be started as content arrives
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
      }
    ];
  }

  /**
   * Create a content block start event
   */
  _createBlockStart(blockType) {
    this.currentBlockIndex++;
    this.currentBlockType = blockType;
    this.blockStarted = true;

    // Ensure message has started
    const events = [];
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) events.push(...startEvents);
    }

    if (blockType === 'thinking') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'thinking',
            thinking: ''
          }
        }
      });
    } else {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'text',
            text: ''
          }
        }
      });
    }

    return events.length === 1 ? events[0] : events;
  }

  /**
   * Create a content block stop event
   */
  _createBlockStop() {
    const event = {
      event: 'content_block_stop',
      data: {
        type: 'content_block_stop',
        index: this.currentBlockIndex
      }
    };
    this.blockStarted = false;
    return event;
  }

  _createContentDelta(text) {
    // Legacy method for backward compatibility
    const events = [];

    // Ensure message and text block have started
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) events.push(...startEvents);
    }

    if (!this.blockStarted || this.currentBlockType !== 'text') {
      const startEvent = this._createBlockStart('text');
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    this.accumulatedText += text;
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: {
          type: 'text_delta',
          text
        }
      }
    });

    return events;
  }

  _createMessageStop() {
    const events = [];

    // Close any open content block
    if (this.blockStarted) {
      events.push(this._createBlockStop());
    }

    // Add message_delta with stop reason
    events.push({
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
    });

    // Add message_stop
    events.push({
      event: 'message_stop',
      data: {
        type: 'message_stop'
      }
    });

    return events;
  }

  /**
   * Build a complete non-streaming response from accumulated data
   * @returns {object} Anthropic Messages API response
   */
  buildNonStreamingResponse() {
    // Build content array, preferring extracted blocks or falling back to accumulated
    let content = [];

    if (this.contentBlocks.length > 0) {
      // Use extracted content blocks from final message
      content = this.contentBlocks;
    } else {
      // Fall back to accumulated content
      if (this.accumulatedThinking) {
        const thinkingBlock = {
          type: 'thinking',
          thinking: this.accumulatedThinking
        };
        if (this.thinkingSignature) {
          thinkingBlock.signature = this.thinkingSignature;
        }
        content.push(thinkingBlock);
      }

      if (this.accumulatedText) {
        content.push({
          type: 'text',
          text: this.accumulatedText
        });
      }

      // If no content at all, add empty text block
      if (content.length === 0) {
        content.push({
          type: 'text',
          text: ''
        });
      }
    }

    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content,
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
