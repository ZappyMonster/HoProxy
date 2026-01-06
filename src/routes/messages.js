import { Router } from 'express';
import { transformAnthropicToHopGPT, extractThinkingConfig } from '../transformers/anthropicToHopGPT.js';
import { HopGPTToAnthropicTransformer, formatSSEEvent } from '../transformers/hopGPTToAnthropic.js';
import { getDefaultClient, HopGPTError } from '../services/hopgptClient.js';
import { pipeSSEStream, parseSSEStream } from '../utils/sseParser.js';

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

    // Transform request
    const hopGPTRequest = transformAnthropicToHopGPT(anthropicRequest);

    // Extract thinking configuration for response transformer
    const thinkingConfig = extractThinkingConfig(anthropicRequest);

    // Determine if streaming
    const isStreaming = anthropicRequest.stream === true;

    if (isStreaming) {
      await handleStreamingRequest(client, hopGPTRequest, anthropicRequest.model, thinkingConfig, res);
    } else {
      await handleNonStreamingRequest(client, hopGPTRequest, anthropicRequest.model, thinkingConfig, res);
    }
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Handle streaming response
 */
async function handleStreamingRequest(client, hopGPTRequest, model, thinkingConfig, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Prevent request timeout
  res.flushHeaders();

  const transformer = new HopGPTToAnthropicTransformer(model, {
    thinkingEnabled: thinkingConfig.enabled
  });

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
async function handleNonStreamingRequest(client, hopGPTRequest, model, thinkingConfig, res) {
  const transformer = new HopGPTToAnthropicTransformer(model, {
    thinkingEnabled: thinkingConfig.enabled
  });

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
