import { Router } from 'express';
import { loggers } from '../utils/logger.js';
import { MODEL_MAPPINGS, resolveModelMapping } from '../utils/modelMapping.js';

const log = loggers.model;
const router = Router();

/**
 * Available models in HopGPT
 * Format compatible with Anthropic's model list API
 */
const CANONICAL_MODELS = [
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

const MODEL_BY_ID = new Map(CANONICAL_MODELS.map(model => [model.id, model]));

function buildAliasModels() {
  const aliasModels = [];
  const seen = new Set(MODEL_BY_ID.keys());

  for (const mapping of MODEL_MAPPINGS) {
    const canonicalModel = MODEL_BY_ID.get(mapping.canonical);
    if (!canonicalModel) continue;

    for (const alias of mapping.aliases) {
      if (seen.has(alias)) continue;
      aliasModels.push({
        ...canonicalModel,
        id: alias
      });
      seen.add(alias);
    }
  }

  return aliasModels;
}

const AVAILABLE_MODELS = [
  ...CANONICAL_MODELS,
  ...buildAliasModels()
];

/**
 * GET /v1/models
 * Returns list of available models
 */
router.get('/models', (req, res) => {
  log.debug('Listing models', { count: AVAILABLE_MODELS.length });
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
  const requestedId = req.params.model_id;
  let model = AVAILABLE_MODELS.find(m => m.id === requestedId);

  if (!model) {
    const mapping = resolveModelMapping(requestedId);
    if (mapping.mapped) {
      const canonicalModel = MODEL_BY_ID.get(mapping.responseModel);
      if (canonicalModel) {
        model = {
          ...canonicalModel,
          id: requestedId
        };
      }
    }
  }

  if (!model) {
    log.debug('Model not found', { modelId: req.params.model_id });
    return res.status(404).json({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: `Model not found: ${req.params.model_id}`
      }
    });
  }

  log.debug('Model retrieved', { modelId: model.id });
  res.json(model);
});

export default router;
