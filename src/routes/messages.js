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
 * POST /v1/messages/count_tokens
 * Anthropic Messages API token count endpoint (not implemented)
 */
router.post('/messages/count_tokens', (req, res) => {
  res.status(501).json({
    type: 'error',
    error: {
      type: 'not_implemented',
      message: 'Token counting is not implemented. Use /v1/messages and configure your client to skip token counting.'
    }
  });
});

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

    // Debug logging for transformed request
    if (process.env.HOPGPT_DEBUG === 'true') {
      console.log('[Messages] Transformed model:', hopGPTRequest.model);
      if (hopGPTRequest.tools) {
        console.log('[Messages] Transformed tools count:', hopGPTRequest.tools.length);
        console.log('[Messages] First tool sample:', JSON.stringify(hopGPTRequest.tools[0], null, 2));
      }
    }

    // Extract thinking configuration for response transformer
    const thinkingConfig = extractThinkingConfig(anthropicRequest);

    const systemPrompt = normalizeSystemPrompt(anthropicRequest.system) ??
      normalizeSystemPrompt(conversationState?.systemPrompt ?? conversationState?.system);

    // Check for MCP passthrough mode via header or request metadata
    // This preserves <mcp_tool_call> blocks in text for clients like OpenCode
    // that parse and execute tool calls directly from the text stream
    const mcpPassthrough = req.headers['x-mcp-passthrough'] === 'true' ||
      anthropicRequest.metadata?.mcp_passthrough === true ||
      anthropicRequest.metadata?.mcpPassthrough === true;

    // Debug logging
    if (process.env.HOPGPT_DEBUG === 'true') {
      console.log('[Messages] mcpPassthrough:', mcpPassthrough);
      console.log('[Messages] streaming:', anthropicRequest.stream === true);
      console.log('[Messages] tools count:', anthropicRequest.tools?.length || 0);
      if (anthropicRequest.tools?.length > 0) {
        console.log('[Messages] Tools injected into prompt for model to use');
      }
    }

    const transformerOptions = {
      thinkingEnabled: thinkingConfig.enabled,
      maxTokens: hopGPTRequest.max_tokens,
      stopSequences: hopGPTRequest.stop_sequences,
      systemPrompt,
      mcpPassthrough
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
    const hopGPTResponse = await client.sendMessage(hopGPTRequest, { stream: true });

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
    const hopGPTResponse = await client.sendMessage(hopGPTRequest, { stream: false });

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
    const responseBody = typeof error.responseBody === 'string' ? error.responseBody : '';
    const resolved = mapErrorResponse({
      statusCode,
      message: error.message,
      responseBody,
      fallbackType: error.toAnthropicError().error?.type || 'api_error',
      retryAfterMs: error.retryAfterMs
    });

    if (resolved.retryAfterSeconds) {
      res.setHeader('Retry-After', resolved.retryAfterSeconds);
    }
    return res.status(resolved.statusCode).json(resolved.payload);
  }

  const fallback = mapErrorResponse({
    statusCode: 500,
    message: error?.message,
    responseBody: '',
    fallbackType: 'api_error',
    retryAfterMs: null
  });
  if (fallback.retryAfterSeconds) {
    res.setHeader('Retry-After', fallback.retryAfterSeconds);
  }
  res.status(fallback.statusCode).json(fallback.payload);
}

export default router;

function mapErrorResponse({ statusCode, message, responseBody, fallbackType, retryAfterMs }) {
  const errorText = extractErrorText(message, responseBody);
  const errorTextLower = errorText.toLowerCase();
  const retryAfterSeconds = retryAfterMs
    ? Math.ceil(retryAfterMs / 1000)
    : parseRetryAfterSeconds(errorText);

  if (statusCode === 401 || errorTextLower.includes('unauthorized') || errorTextLower.includes('unauthenticated')) {
    return buildErrorResponse(401, 'authentication_error', errorText, retryAfterSeconds);
  }

  if (statusCode === 403 || errorTextLower.includes('forbidden') || errorTextLower.includes('permission')) {
    return buildErrorResponse(403, 'permission_error', errorText, retryAfterSeconds);
  }

  if (statusCode === 429 || isRateLimitMessage(errorTextLower)) {
    return buildErrorResponse(429, 'rate_limit_error', errorText, retryAfterSeconds);
  }

  if (statusCode === 400 || isInvalidRequestMessage(errorTextLower)) {
    return buildErrorResponse(400, 'invalid_request_error', errorText, retryAfterSeconds);
  }

  const resolvedStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 502;
  const resolvedType = fallbackType || (resolvedStatus >= 500 ? 'api_error' : 'invalid_request_error');
  return buildErrorResponse(resolvedStatus, resolvedType, errorText, retryAfterSeconds);
}

function buildErrorResponse(statusCode, errorType, message, retryAfterSeconds) {
  const payload = {
    type: 'error',
    error: {
      type: errorType,
      message: message || 'Internal server error'
    }
  };

  if (retryAfterSeconds) {
    payload.error.retry_after_seconds = retryAfterSeconds;
  }

  return {
    statusCode,
    payload,
    retryAfterSeconds
  };
}

function extractErrorText(message, responseBody) {
  if (typeof responseBody === 'string' && responseBody.trim()) {
    const parsed = parseErrorMessageFromBody(responseBody);
    if (parsed) {
      return parsed;
    }
  }

  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  return 'Internal server error';
}

function parseErrorMessageFromBody(body) {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.error?.message === 'string') {
      return parsed.error.message;
    }
    if (typeof parsed?.message === 'string') {
      return parsed.message;
    }
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch (error) {
    return trimmed;
  }

  return null;
}

function isRateLimitMessage(text) {
  return text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('retry after');
}

function isInvalidRequestMessage(text) {
  return text.includes('invalid request') ||
    text.includes('invalid_argument') ||
    text.includes('invalid input') ||
    text.includes('bad request');
}

function parseRetryAfterSeconds(text) {
  if (!text) {
    return null;
  }

  const retryMatch = text.match(/retry\s*after\s*([\d.]+)\s*(ms|s|sec|secs|seconds|m|minutes|h|hours)?/i);
  if (retryMatch) {
    const value = Number.parseFloat(retryMatch[1]);
    const unit = (retryMatch[2] || 's').toLowerCase();
    if (Number.isFinite(value)) {
      if (unit.startsWith('ms')) return Math.ceil(value / 1000);
      if (unit.startsWith('m')) return Math.ceil(value * 60);
      if (unit.startsWith('h')) return Math.ceil(value * 3600);
      return Math.ceil(value);
    }
  }

  const durationMatch = text.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i);
  if (durationMatch) {
    if (durationMatch[1]) {
      const hours = Number.parseInt(durationMatch[1], 10);
      const minutes = Number.parseInt(durationMatch[2], 10);
      const seconds = Number.parseInt(durationMatch[3], 10);
      return hours * 3600 + minutes * 60 + seconds;
    }
    if (durationMatch[4]) {
      const minutes = Number.parseInt(durationMatch[4], 10);
      const seconds = Number.parseInt(durationMatch[5], 10);
      return minutes * 60 + seconds;
    }
    if (durationMatch[6]) {
      return Number.parseInt(durationMatch[6], 10);
    }
  }

  return null;
}
