import { Router } from 'express';
import { transformAnthropicToHopGPT, extractThinkingConfig, normalizeSystemPrompt } from '../transformers/anthropicToHopGPT.js';
import { HopGPTToAnthropicTransformer, formatSSEEvent } from '../transformers/hopGPTToAnthropic.js';
import { getDefaultClient, HopGPTError } from '../services/hopgptClient.js';
import {
  resolveSessionId,
  shouldResetConversation,
  getConversationState,
  updateConversationState,
  resetConversationState
} from '../services/conversationStore.js';
import { pipeSSEStream, parseSSEStream } from '../utils/sseParser.js';
import { resolveModelMapping } from '../utils/modelMapping.js';

const router = Router();

/**
 * POST /v1/messages
 * Anthropic Messages API compatible endpoint
 */
router.post('/messages', async (req, res) => {
  try {
    const anthropicRequest = req.body;

    // Validate request
    const validationError = validateRequest(anthropicRequest);
    if (validationError) {
      return res.status(400).json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: validationError
        }
      });
    }

    // Get HopGPT client
    const client = getDefaultClient();

    // Validate authentication
    const authValidation = client.validateAuth();
    if (!authValidation.valid) {
      return res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `Missing authentication configuration: ${authValidation.missing.join(', ')}`
        }
      });
    }

    // Log any warnings
    if (authValidation.warnings?.length > 0) {
      authValidation.warnings.forEach(warning => console.log(`[Auth Warning] ${warning}`));
    }

    // Resolve model mapping for HopGPT and response model names
    const modelMapping = resolveModelMapping(anthropicRequest.model);
    if (!modelMapping.mapped && anthropicRequest.model) {
      console.warn(`[Model Warning] Unmapped model "${anthropicRequest.model}", using as-is`);
    }

    const { sessionId } = resolveSessionId(req, anthropicRequest);
    res.setHeader('X-Session-Id', sessionId);

    const resetRequested = shouldResetConversation(req, anthropicRequest);
    if (resetRequested) {
      resetConversationState(sessionId);
    }

    const storedConversationState = resetRequested ? null : getConversationState(sessionId);
    const requestConversationState = normalizeConversationState(
      anthropicRequest.conversation_state || anthropicRequest.conversationState
    );
    const conversationState = mergeConversationStates(storedConversationState, requestConversationState);

    // Transform request
    const hopGPTRequest = transformAnthropicToHopGPT(anthropicRequest, conversationState);
    hopGPTRequest.model = modelMapping.hopgptModel || hopGPTRequest.model;

    // Extract thinking configuration for response transformer
    const thinkingConfig = extractThinkingConfig(anthropicRequest);

    const systemPrompt = normalizeSystemPrompt(anthropicRequest.system) ??
      normalizeSystemPrompt(conversationState?.systemPrompt ?? conversationState?.system);

    const transformerOptions = {
      thinkingEnabled: thinkingConfig.enabled,
      maxTokens: hopGPTRequest.max_tokens,
      stopSequences: hopGPTRequest.stop_sequences,
      systemPrompt
    };

    // Determine if streaming
    const isStreaming = anthropicRequest.stream === true;

    const responseModel = modelMapping.responseModel || anthropicRequest.model;

    const transformer = new HopGPTToAnthropicTransformer(responseModel, transformerOptions);

    if (isStreaming) {
      await handleStreamingRequest(client, hopGPTRequest, transformer, res);
    } else {
      await handleNonStreamingRequest(client, hopGPTRequest, transformer, res);
    }

    const nextState = transformer.getConversationState();
    if (nextState?.lastAssistantMessageId || nextState?.conversationId || nextState?.systemPrompt) {
      updateConversationState(sessionId, nextState);
    }
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Handle streaming response
 */
async function handleStreamingRequest(client, hopGPTRequest, transformer, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Prevent request timeout
  res.flushHeaders();

  try {
    const hopGPTResponse = await client.sendMessage(hopGPTRequest);

    await pipeSSEStream(hopGPTResponse, res, (event) => {
      return transformer.transformEvent(event);
    });

    res.end();
  } catch (error) {
    // Send error as SSE event
    const errorEvent = {
      event: 'error',
      data: {
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message
        }
      }
    };
    res.write(formatSSEEvent(errorEvent));
    res.end();
  }
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingRequest(client, hopGPTRequest, transformer, res) {
  try {
    const hopGPTResponse = await client.sendMessage(hopGPTRequest);

    // Process all events to accumulate the full response
    await parseSSEStream(hopGPTResponse, (event) => {
      transformer.transformEvent(event);
    });

    // Build and send the complete response
    const response = transformer.buildNonStreamingResponse();
    res.json(response);
  } catch (error) {
    throw error;
  }
}

/**
 * Validate Anthropic request format
 */
function validateRequest(request) {
  if (!request.model) {
    return 'model is required';
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    return 'messages array is required';
  }

  if (request.messages.length === 0) {
    return 'messages array cannot be empty';
  }

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];

    if (!msg.role) {
      return `messages[${i}].role is required`;
    }

    if (!['user', 'assistant'].includes(msg.role)) {
      return `messages[${i}].role must be 'user' or 'assistant'`;
    }

    if (msg.content === undefined || msg.content === null) {
      return `messages[${i}].content is required`;
    }
  }

  return null;
}

function normalizeConversationState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  return {
    conversationId: state.conversationId || state.conversation_id || null,
    lastAssistantMessageId: state.lastAssistantMessageId || state.last_assistant_message_id || null,
    systemPrompt: state.systemPrompt || state.system_prompt || state.system || null
  };
}

function mergeConversationStates(storedState, requestState) {
  if (!storedState && !requestState) {
    return null;
  }

  if (!storedState) {
    return requestState;
  }

  if (!requestState) {
    return storedState;
  }

  return {
    conversationId: requestState.conversationId ?? storedState.conversationId,
    lastAssistantMessageId: requestState.lastAssistantMessageId ?? storedState.lastAssistantMessageId,
    systemPrompt: requestState.systemPrompt ?? storedState.systemPrompt
  };
}

/**
 * Handle errors and send appropriate response
 */
function handleError(error, res) {
  console.error('Request error:', error);

  if (error instanceof HopGPTError) {
    const statusCode = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
    return res.status(statusCode).json(error.toAnthropicError());
  }

  // Generic error
  res.status(500).json({
    type: 'error',
    error: {
      type: 'api_error',
      message: error.message || 'Internal server error'
    }
  });
}

export default router;
