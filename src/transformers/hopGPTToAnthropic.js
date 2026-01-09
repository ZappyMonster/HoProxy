import { v4 as uuidv4 } from 'uuid';

const MCP_TOOL_CALL_BLOCK_RE = /<mcp_tool_call>[\s\S]*?<\/mcp_tool_call>/gi;
const MCP_TOOL_CALL_START_TAG = '<mcp_tool_call>';

function extractXmlTagValue(source, tagName) {
  if (!source) {
    return null;
  }
  const matcher = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = source.match(matcher);
  return match ? match[1].trim() : null;
}

function parseMcpToolCallBlock(block) {
  const serverName = extractXmlTagValue(block, 'server_name');
  const toolName = extractXmlTagValue(block, 'tool_name');
  const argsText = extractXmlTagValue(block, 'arguments');

  if (!toolName || !argsText) {
    return null;
  }

  let parsedArgs = {};
  try {
    parsedArgs = JSON.parse(argsText.trim());
  } catch (error) {
    console.warn('Failed to parse MCP tool call arguments:', error);
    return null;
  }

  return {
    serverName,
    toolName,
    arguments: parsedArgs
  };
}

function splitMcpToolCalls(text) {
  if (!text) {
    return [];
  }

  const segments = [];
  let lastIndex = 0;

  MCP_TOOL_CALL_BLOCK_RE.lastIndex = 0;
  let match = null;
  while ((match = MCP_TOOL_CALL_BLOCK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const toolCall = parseMcpToolCallBlock(match[0]);
    if (toolCall) {
      segments.push({ type: 'tool_call', toolCall });
    }
    lastIndex = MCP_TOOL_CALL_BLOCK_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function splitStreamTextForMcpToolCalls(text) {
  const segments = [];
  let lastIndex = 0;

  MCP_TOOL_CALL_BLOCK_RE.lastIndex = 0;
  let match = null;
  while ((match = MCP_TOOL_CALL_BLOCK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const toolCall = parseMcpToolCallBlock(match[0]);
    if (toolCall) {
      segments.push({ type: 'tool_call', toolCall });
    }
    lastIndex = MCP_TOOL_CALL_BLOCK_RE.lastIndex;
  }

  const trailing = text.slice(lastIndex);
  if (!trailing) {
    return { segments, remainder: '' };
  }

  const startIndex = trailing.indexOf(MCP_TOOL_CALL_START_TAG);
  if (startIndex !== -1) {
    if (startIndex > 0) {
      segments.push({ type: 'text', text: trailing.slice(0, startIndex) });
    }
    return { segments, remainder: trailing.slice(startIndex) };
  }

  const lastLt = trailing.lastIndexOf('<');
  if (lastLt !== -1) {
    const possibleTag = trailing.slice(lastLt);
    if (MCP_TOOL_CALL_START_TAG.startsWith(possibleTag)) {
      if (lastLt > 0) {
        segments.push({ type: 'text', text: trailing.slice(0, lastLt) });
      }
      return { segments, remainder: possibleTag };
    }
  }

  segments.push({ type: 'text', text: trailing });
  return { segments, remainder: '' };
}

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
 * Generate a unique tool use ID in Anthropic format
 * @returns {string} Tool use ID like toolu_01XFDUDYJgAACzvnptvVoYEL
 */
function generateToolUseId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'toolu_01';
  for (let i = 0; i < 22; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function normalizeMaxTokens(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const intValue = Math.floor(value);
  return intValue > 0 ? intValue : null;
}

function normalizeStopSequences(value) {
  if (Array.isArray(value)) {
    return value.filter(seq => typeof seq === 'string' && seq.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}

function mapStopReason(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'stop_sequence' || normalized === 'stop-sequence' || normalized === 'stopsequence') {
    return 'stop_sequence';
  }
  if (normalized === 'max_tokens' || normalized === 'max-tokens' || normalized === 'length' || normalized === 'max_tokens_exceeded') {
    return 'max_tokens';
  }
  if (normalized === 'tool_use' || normalized === 'tool-use' || normalized === 'tool' || normalized === 'function_call') {
    return 'tool_use';
  }
  if (normalized === 'end_turn' || normalized === 'end-turn' || normalized === 'stop' || normalized === 'eos') {
    return 'end_turn';
  }
  return null;
}

/**
 * Transformer class to convert HopGPT SSE events to Anthropic SSE format
 * Supports extended thinking and tool use for compatible models
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
    this.systemPrompt = options.systemPrompt ?? null;

    // Thinking support
    this.thinkingEnabled = options.thinkingEnabled ?? isThinkingModel(model);
    this.currentBlockIndex = -1;  // Will be incremented when blocks start
    this.currentBlockType = null; // 'thinking', 'text', or 'tool_use'
    this.blockStarted = false;    // Track if current block has started

    // Accumulated content for non-streaming responses
    this.contentBlocks = [];      // Array of {type, content, signature?}
    this.accumulatedText = '';    // For backward compatibility
    this.accumulatedThinking = '';
    this.thinkingSignature = null;
    this.mcpToolCallBuffer = '';

    // Tool use support
    this.currentToolUse = null;   // Current tool use being streamed {id, name, inputJson}
    this.accumulatedToolUses = []; // All completed tool uses
    this.hasToolUse = false;      // Track if response contains tool use

    // MCP tool call passthrough mode - when enabled, <mcp_tool_call> blocks are
    // passed through as text instead of being converted to tool_use blocks.
    // This is needed for clients like OpenCode that parse and execute tool calls
    // directly from the text stream.
    this.mcpPassthrough = options.mcpPassthrough ?? false;

    this.maxTokens = normalizeMaxTokens(options.maxTokens);
    this.stopSequences = normalizeStopSequences(options.stopSequences);
    this.hopGPTStopReason = null;
    this.hopGPTStopSequence = null;
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
      this.hopGPTStopReason = data.responseMessage?.stopReason ??
        data.responseMessage?.stop_reason ??
        data.responseMessage?.finishReason ??
        data.responseMessage?.finish_reason ??
        null;
      this.hopGPTStopSequence = data.responseMessage?.stopSequence ??
        data.responseMessage?.stop_sequence ??
        null;

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
      // In passthrough mode, don't parse MCP tool calls - just emit text as-is
      if (this.mcpPassthrough) {
        events.push(...this._emitTextDelta(block.text));
        return events.length > 0 ? events : null;
      }

      const combined = `${this.mcpToolCallBuffer}${block.text}`;
      const { segments, remainder } = splitStreamTextForMcpToolCalls(combined);
      this.mcpToolCallBuffer = remainder;

      for (const segment of segments) {
        if (segment.type === 'text') {
          events.push(...this._emitTextDelta(segment.text));
          continue;
        }
        if (segment.type === 'tool_call') {
          const toolBlock = {
            type: 'tool_use',
            id: generateToolUseId(),
            name: segment.toolCall.toolName,
            input: segment.toolCall.arguments
          };
          events.push(...this._processToolUseBlock(toolBlock));
        }
      }

      return events.length > 0 ? events : null;
    }

    // Handle tool_use blocks
    if (block.type === 'tool_use') {
      return this._processToolUseBlock(block);
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
        // In passthrough mode, don't parse MCP tool calls - preserve text as-is
        if (this.mcpPassthrough) {
          if (block.text) {
            this.contentBlocks.push({
              type: 'text',
              text: block.text
            });
            this.accumulatedText += block.text;
          }
          continue;
        }

        const segments = splitMcpToolCalls(block.text || '');
        for (const segment of segments) {
          if (segment.type === 'text') {
            if (!segment.text) continue;
            this.contentBlocks.push({
              type: 'text',
              text: segment.text
            });
            this.accumulatedText += segment.text;
            continue;
          }
          if (segment.type === 'tool_call') {
            this.hasToolUse = true;
            this.contentBlocks.push({
              type: 'tool_use',
              id: generateToolUseId(),
              name: segment.toolCall.toolName,
              input: segment.toolCall.arguments || {}
            });
          }
        }
      } else if (block.type === 'tool_use') {
        this.hasToolUse = true;
        let input = block.input;

        // Parse input if it's a string
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch (e) {
            input = {};
          }
        }

        this.contentBlocks.push({
          type: 'tool_use',
          id: block.id || generateToolUseId(),
          name: block.name || '',
          input: input || {}
        });
      }
    }
  }

  _emitTextDelta(text) {
    if (!text) {
      return [];
    }

    const events = [];

    if (this.blockStarted && this.currentBlockType !== 'text') {
      // Save tool use before switching away from tool_use block
      if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
        this.accumulatedToolUses.push({...this.currentToolUse});
        this.currentToolUse = null;
      }
      events.push(this._createBlockStop());
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

  _processToolUseBlock(block) {
    const events = [];
    this.hasToolUse = true;

    const toolId = block.id || (this.currentToolUse?.id);
    const toolName = block.name || (this.currentToolUse?.name);

    if (this.blockStarted && (this.currentBlockType !== 'tool_use' ||
        (this.currentToolUse && this.currentToolUse.id !== toolId))) {
      if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
        this.accumulatedToolUses.push({...this.currentToolUse});
      }
      events.push(this._createBlockStop());
    }

    if (!this.blockStarted || this.currentBlockType !== 'tool_use' ||
        (this.currentToolUse && this.currentToolUse.id !== toolId)) {
      this.currentToolUse = {
        id: toolId || generateToolUseId(),
        name: toolName || '',
        inputJson: ''
      };
      const startEvent = this._createBlockStart('tool_use', this.currentToolUse);
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    if (block.name && !this.currentToolUse.name) {
      this.currentToolUse.name = block.name;
    }

    if (block.input !== undefined) {
      let inputDelta = '';
      if (typeof block.input === 'string') {
        inputDelta = block.input;
        this.currentToolUse.inputJson += inputDelta;
      } else if (typeof block.input === 'object') {
        inputDelta = JSON.stringify(block.input);
        this.currentToolUse.inputJson = inputDelta;
      }

      if (inputDelta) {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: inputDelta
            }
          }
        });
      }
    }

    if (block.input_json !== undefined) {
      this.currentToolUse.inputJson += block.input_json;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: block.input_json
          }
        }
      });
    }

    return events;
  }

  _getGeneratedText() {
    if (this.contentBlocks.length > 0) {
      return this.contentBlocks
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('');
    }

    return this.accumulatedText || '';
  }

  _detectStopSequence() {
    if (!this.stopSequences || this.stopSequences.length === 0) {
      return null;
    }

    const text = this._getGeneratedText();
    if (!text) {
      return null;
    }

    for (const sequence of this.stopSequences) {
      if (sequence && text.endsWith(sequence)) {
        return sequence;
      }
    }

    return null;
  }

  _determineStopInfo() {
    if (this.hasToolUse) {
      return { stopReason: 'tool_use', stopSequence: null };
    }

    const mappedReason = mapStopReason(this.hopGPTStopReason);
    if (mappedReason) {
      if (mappedReason === 'stop_sequence') {
        const sequence = typeof this.hopGPTStopSequence === 'string' && this.hopGPTStopSequence.length > 0
          ? this.hopGPTStopSequence
          : this._detectStopSequence();
        return { stopReason: 'stop_sequence', stopSequence: sequence || null };
      }
      return { stopReason: mappedReason, stopSequence: null };
    }

    const detectedSequence = this._detectStopSequence();
    if (detectedSequence) {
      return { stopReason: 'stop_sequence', stopSequence: detectedSequence };
    }

    if (this.maxTokens !== null && this.outputTokens >= this.maxTokens) {
      return { stopReason: 'max_tokens', stopSequence: null };
    }

    return { stopReason: 'end_turn', stopSequence: null };
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
  _createBlockStart(blockType, toolUseInfo = null) {
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
    } else if (blockType === 'tool_use') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseInfo?.id || generateToolUseId(),
            name: toolUseInfo?.name || '',
            input: {}
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

    // Save current tool use if still in progress
    if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
      this.accumulatedToolUses.push({...this.currentToolUse});
    }

    // Close any open content block
    if (this.blockStarted) {
      events.push(this._createBlockStop());
    }

    const { stopReason, stopSequence } = this._determineStopInfo();

    // Add message_delta with stop reason
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: stopSequence
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

      // Add accumulated tool uses
      for (const toolUse of this.accumulatedToolUses) {
        let input = {};
        if (toolUse.inputJson) {
          try {
            input = JSON.parse(toolUse.inputJson);
          } catch (e) {
            // If parsing fails, keep empty object
          }
        }
        content.push({
          type: 'tool_use',
          id: toolUse.id,
          name: toolUse.name,
          input
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

    const { stopReason, stopSequence } = this._determineStopInfo();

    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content,
      model: this.model,
      stop_reason: stopReason,
      stop_sequence: stopSequence,
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
      lastAssistantMessageId: this.responseMessageId,
      systemPrompt: this.systemPrompt
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
