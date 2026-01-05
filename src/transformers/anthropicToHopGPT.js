import { v4 as uuidv4 } from 'uuid';

/**
 * Transform Anthropic Messages API request to HopGPT format
 * @param {object} anthropicRequest - Anthropic API request body
 * @param {object} conversationState - Optional conversation state for multi-turn
 * @returns {object} HopGPT request body
 */
export function transformAnthropicToHopGPT(anthropicRequest, conversationState = null) {
  const { model, messages, system } = anthropicRequest;

  // Get the latest user message
  const latestMessage = messages[messages.length - 1];

  // Build text content - handle both string and array content formats
  let text = '';
  if (typeof latestMessage.content === 'string') {
    text = latestMessage.content;
  } else if (Array.isArray(latestMessage.content)) {
    // Extract text from content blocks
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

  return {
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
    reasoning_effort: 'high',
    reasoning_summary: 'detailed',
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
}

/**
 * Build conversation history text for multi-turn conversations
 * HopGPT handles conversation state server-side via parentMessageId,
 * but for context we can include previous messages in the text if needed
 */
export function buildConversationText(messages, system = null) {
  let parts = [];

  if (system) {
    parts.push(`System: ${system}`);
  }

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    parts.push(`${role}: ${content}`);
  }

  return parts.join('\n\n');
}
