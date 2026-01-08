import { Router } from 'express';

const router = Router();

/**
 * Available models in HopGPT
 * Format compatible with Anthropic's model list API
 */
const AVAILABLE_MODELS = [
  {
    id: 'claude-opus-4-5-thinking',
    object: 'model',
    created: 1735689600, // 2025-01-01
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.5 (Thinking)',
    max_tokens: 32768,
  },
  {
    id: 'claude-sonnet-4-5-thinking',
    object: 'model',
    created: 1735689600, // 2025-01-01
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 4.5 (Thinking)',
    max_tokens: 16384,
  },
  {
    id: 'claude-haiku-4-5-thinking',
    object: 'model',
    created: 1735689600, // 2025-01-01
    owned_by: 'anthropic',
    display_name: 'Claude Haiku 4.5 (Thinking)',
    max_tokens: 8192,
  },
];

/**
 * GET /v1/models
 * Returns list of available models
 */
router.get('/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

/**
 * GET /v1/models/:model_id
 * Returns a specific model by ID
 */
router.get('/models/:model_id', (req, res) => {
  const model = AVAILABLE_MODELS.find(m => m.id === req.params.model_id);

  if (!model) {
    return res.status(404).json({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: `Model not found: ${req.params.model_id}`
      }
    });
  }

  res.json(model);
});

export default router;
