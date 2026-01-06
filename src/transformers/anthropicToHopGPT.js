import { v4 as uuidv4 } from 'uuid';
import { isThinkingModel } from './hopGPTToAnthropic.js';

/**
 * Transform Anthropic tool definitions to HopGPT format
 * @param {Array} tools - Anthropic tools array
 * @returns {Array} HopGPT tools array
 */
export function transformTools(tools) {
  if (!tools || !Array.isArray(tools)) {
    return null;
  }

  return tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object', properties: {} }
  }));
}

/**
 * Transform Anthropic tool_choice to HopGPT format
 * @param {object|string} toolChoice - Anthropic tool_choice
 * @returns {object|null} HopGPT tool choice config
 */
export function transformToolChoice(toolChoice) {
  if (!toolChoice) {
    return null;
  }

  // Handle string shortcuts
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto') {
      return { type: 'auto' };
    }
    if (toolChoice === 'any') {
      return { type: 'required' };
    }
    if (toolChoice === 'none') {
      return { type: 'none' };
    }
  }

  // Handle object format
  if (typeof toolChoice === 'object') {
    if (toolChoice.type === 'auto') {
      return { type: 'auto' };
    }
    if (toolChoice.type === 'any') {
      return { type: 'required' };
    }
    if (toolChoice.type === 'tool') {
      return { type: 'function', function: { name: toolChoice.name } };
    }
  }

  return null;
}

/**
 * Format a tool_use block for conversation context
 * @param {object} block - tool_use content block
 * @returns {string} Formatted string representation
 */
function formatToolUseBlock(block) {
  const inputStr = typeof block.input === 'string'
    ? block.input
    : JSON.stringify(block.input, null, 2);
  return `<tool_use id="${block.id}" name="${block.name}">\n${inputStr}\n</tool_use>`;
}

/**
 * Format a tool_result block for conversation context
 * @param {object} block - tool_result content block
 * @returns {string} Formatted string representation
 */
function formatToolResultBlock(block) {
  let content = '';
  if (typeof block.content === 'string') {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    // Handle array content (e.g., with text blocks)
    content = block.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }

  const errorAttr = block.is_error ? ' is_error="true"' : '';
  return `<tool_result tool_use_id="${block.tool_use_id}"${errorAttr}>\n${content}\n</tool_result>`;
}

/**
 * Extract content from a message, handling all content block types
 * @param {object} message - Anthropic message
 * @returns {string} Extracted text content
 */
function extractMessageContent(message) {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const parts = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(formatToolUseBlock(block));
    } else if (block.type === 'tool_result') {
      parts.push(formatToolResultBlock(block));
    }
    // Skip thinking blocks - they are internal model reasoning
  }

  return parts.join('\n\n');
}

export function normalizeSystemPrompt(system) {
  if (!system) {
    return null;
  }

  if (typeof system === 'string') {
    return system.trim().length > 0 ? system : null;
  }

  if (Array.isArray(system)) {
    const parts = [];
    for (const block of system) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    const combined = parts.join('\n');
    return combined.trim().length > 0 ? combined : null;
  }

  return null;
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

function extractTextAndImages(content, imageDetail) {
  if (typeof content === 'string') {
    return { text: content, images: [] };
  }

  if (!Array.isArray(content)) {
    return { text: '', images: [] };
  }

  const textParts = [];
  const images = [];

  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'tool_use') {
      textParts.push(formatToolUseBlock(block));
      continue;
    }

    if (block.type === 'tool_result') {
      textParts.push(formatToolResultBlock(block));
      continue;
    }

    if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data && block.source.media_type) {
        images.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
            detail: imageDetail
          }
        });
      } else if (block.source.type === 'url' && block.source.url) {
        images.push({
          type: 'image_url',
          image_url: {
            url: block.source.url,
            detail: imageDetail
          }
        });
      }
    }
  }

  return { text: textParts.join('\n'), images };
}

/**
 * Transform Anthropic Messages API request to HopGPT format
 * @param {object} anthropicRequest - Anthropic API request body
 * @param {object} conversationState - Optional conversation state for multi-turn
 * @returns {object} HopGPT request body
 */
export function transformAnthropicToHopGPT(anthropicRequest, conversationState = null) {
  const { model, messages, system, tools, tool_choice, max_tokens, stop_sequences } = anthropicRequest;
  const imageDetail = 'high';

  // Get thinking configuration
  const thinkingConfig = extractThinkingConfig(anthropicRequest);
  const normalizedSystem = normalizeSystemPrompt(system);
  const stateSystem = normalizeSystemPrompt(conversationState?.systemPrompt ?? conversationState?.system);
  const systemText = normalizedSystem ?? stateSystem;
  const systemChanged = normalizedSystem && stateSystem && normalizedSystem !== stateSystem;
  const isNewConversation = !conversationState?.lastAssistantMessageId;

  // Get the latest user message
  const latestMessage = messages[messages.length - 1];

  // Build text content - handle all content block types including tool_result
  let text = '';
  let images = [];
  if (typeof latestMessage.content === 'string') {
    text = latestMessage.content;
  } else if (Array.isArray(latestMessage.content)) {
    // Extract text from content blocks (skip thinking blocks in user messages)
    const extracted = extractTextAndImages(latestMessage.content, imageDetail);
    text = extracted.text;
    images = extracted.images;
  }

  const shouldIncludeHistory = isNewConversation && messages.length > 1;
  if (shouldIncludeHistory) {
    text = buildConversationText(messages, systemText);
  } else if (systemText && (isNewConversation || systemChanged || !stateSystem)) {
    text = text ? `${systemText}\n\n${text}` : systemText;
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
    imageDetail,
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

  if (images.length > 0) {
    hopGPTRequest.image_urls = images;
  }

  const maxTokens = normalizeMaxTokens(max_tokens);
  const stopSequences = normalizeStopSequences(stop_sequences);
  if (maxTokens !== null) {
    hopGPTRequest.max_tokens = maxTokens;
  }
  if (stopSequences.length > 0) {
    hopGPTRequest.stop_sequences = stopSequences;
  }

  // Add tools if provided
  const transformedTools = transformTools(tools);
  if (transformedTools) {
    hopGPTRequest.tools = transformedTools;
  }

  // Add tool_choice if provided
  const transformedToolChoice = transformToolChoice(tool_choice);
  if (transformedToolChoice) {
    hopGPTRequest.tool_choice = transformedToolChoice;
  }

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
  const systemText = normalizeSystemPrompt(system);

  if (systemText) {
    parts.push(`System: ${systemText}`);
  }

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const content = extractMessageContent(msg);

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
