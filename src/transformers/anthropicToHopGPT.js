import { v4 as uuidv4 } from 'uuid';
import { isThinkingModel } from './hopGPTToAnthropic.js';

/**
 * Extract thinking configuration from Anthropic request
 * @param {object} anthropicRequest - Anthropic API request body
 * @returns {object} Thinking configuration {enabled, budgetTokens}
 */
export function extractThinkingConfig(anthropicRequest) {
  const { model, thinking } = anthropicRequest;

  // Check explicit thinking parameter
  if (thinking) {
    return {
      enabled: thinking.type === 'enabled',
      budgetTokens: thinking.budget_tokens || null
    };
  }

  // Auto-detect from model name
  return {
    enabled: isThinkingModel(model),
    budgetTokens: null
  };
}

/**
 * Transform Anthropic Messages API request to HopGPT format
 * @param {object} anthropicRequest - Anthropic API request body
 * @param {object} conversationState - Optional conversation state for multi-turn
 * @returns {object} HopGPT request body
 */
export function transformAnthropicToHopGPT(anthropicRequest, conversationState = null) {
  const { model, messages, system } = anthropicRequest;

  // Get thinking configuration
  const thinkingConfig = extractThinkingConfig(anthropicRequest);

  // Get the latest user message
  const latestMessage = messages[messages.length - 1];

  // Build text content - handle both string and array content formats
  let text = '';
  if (typeof latestMessage.content === 'string') {
    text = latestMessage.content;
  } else if (Array.isArray(latestMessage.content)) {
    // Extract text from content blocks (skip thinking blocks in user messages)
    text = latestMessage.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  // Prepend system message if provided and this is the first message
  if (system && messages.length === 1) {
    text = `${system}\n\n${text}`;
  }

  // Get parent message ID for conversation threading
  const parentMessageId = conversationState?.lastAssistantMessageId ||
    '00000000-0000-0000-0000-000000000000';

  // Generate timestamp in HopGPT format
  const clientTimestamp = new Date().toISOString().slice(0, 19);

  // Build base request
  const hopGPTRequest = {
    text,
    sender: 'User',
    clientTimestamp,
    isCreatedByUser: true,
    parentMessageId,
    messageId: uuidv4(),
    error: false,
    endpoint: 'AnthropicClaude',
    endpointType: 'custom',
    model: model || 'claude-sonnet-4-20250514',
    resendFiles: false,
    imageDetail: 'high',
    key: 'never',
    modelDisplayLabel: 'Claude',
    isTemporary: false,
    isRegenerate: false,
    isContinued: false,
    ephemeralAgent: {
      execute_code: false,
      web_search: false,
      file_search: false,
      artifacts: false,
      mcp: []
    }
  };

  // Add reasoning/thinking parameters based on thinking config
  if (thinkingConfig.enabled) {
    hopGPTRequest.reasoning_effort = 'high';
    hopGPTRequest.reasoning_summary = 'detailed';
  }

  return hopGPTRequest;
}

/**
 * Build conversation history text for multi-turn conversations
 * HopGPT handles conversation state server-side via parentMessageId,
 * but for context we can include previous messages in the text if needed
 *
 * Note: Thinking blocks from previous assistant messages are excluded
 * as they are internal model reasoning and should not be in conversation text
 */
export function buildConversationText(messages, system = null) {
  let parts = [];

  if (system) {
    parts.push(`System: ${system}`);
  }

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    let content;

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Filter out thinking blocks - only include text content
      content = msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    } else {
      content = '';
    }

    if (content) {
      parts.push(`${role}: ${content}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Check if a message contains thinking blocks
 * @param {object} message - Anthropic message object
 * @returns {boolean} True if message contains thinking content
 */
export function hasThinkingContent(message) {
  if (!message || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(block => block.type === 'thinking');
}

/**
 * Extract thinking signature from a message
 * Used for interleaved thinking in multi-turn conversations
 * @param {object} message - Anthropic message object
 * @returns {string|null} The thinking signature if present
 */
export function extractThinkingSignature(message) {
  if (!message || !Array.isArray(message.content)) {
    return null;
  }

  for (const block of message.content) {
    if (block.type === 'thinking' && block.signature) {
      return block.signature;
    }
  }

  return null;
}
