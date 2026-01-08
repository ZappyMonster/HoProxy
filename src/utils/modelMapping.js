const MODEL_MAPPINGS = Object.freeze([
  {
    canonical: 'claude-opus-4-5-thinking',
    hopgpt: 'claude-opus-4.5',
    aliases: [
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4.5-thinking'
    ]
  },
  {
    canonical: 'claude-sonnet-4-5-thinking',
    hopgpt: 'claude-sonnet-4.5',
    aliases: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4.5-thinking'
    ]
  },
  {
    canonical: 'claude-haiku-4-5-thinking',
    hopgpt: 'claude-haiku-4.5',
    aliases: [
      'claude-haiku-4-5',
      'claude-haiku-4.5',
      'claude-haiku-4.5-thinking'
    ]
  }
]);

const VERSION_SUFFIX_REGEX = /-(\d{8}|\d{4}-\d{2}-\d{2}|latest|stable)$/;

function normalizeModelName(value) {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function addModelVariants(variants, name) {
  if (!name) return;
  variants.add(name);

  if (name.includes('4.5')) {
    variants.add(name.replace('4.5', '4-5'));
  }
  if (name.includes('4-5')) {
    variants.add(name.replace('4-5', '4.5'));
  }

  if (name.endsWith('-thinking')) {
    variants.add(name.replace(/-thinking$/, ''));
  } else if (name.startsWith('claude-')) {
    variants.add(`${name}-thinking`);
  }
}

function buildCandidateSet(modelName) {
  const normalized = normalizeModelName(modelName);
  const stripped = normalized.replace(VERSION_SUFFIX_REGEX, '');
  const candidates = new Set();

  addModelVariants(candidates, normalized);
  if (stripped !== normalized) {
    addModelVariants(candidates, stripped);
  }

  return candidates;
}

const MODEL_ALIAS_MAP = new Map();
for (const mapping of MODEL_MAPPINGS) {
  const aliasSources = [mapping.canonical, ...mapping.aliases];
  for (const alias of aliasSources) {
    const candidates = buildCandidateSet(alias);
    for (const candidate of candidates) {
      MODEL_ALIAS_MAP.set(candidate, mapping);
    }
  }
}

export function resolveModelMapping(modelName) {
  if (typeof modelName !== 'string' || modelName.trim() === '') {
    return {
      hopgptModel: modelName,
      responseModel: modelName,
      mapped: false
    };
  }

  const candidates = buildCandidateSet(modelName);
  for (const candidate of candidates) {
    const mapping = MODEL_ALIAS_MAP.get(candidate);
    if (mapping) {
      return {
        hopgptModel: mapping.hopgpt,
        responseModel: mapping.canonical,
        mapped: true
      };
    }
  }

  return {
    hopgptModel: modelName,
    responseModel: modelName,
    mapped: false
  };
}

export { MODEL_MAPPINGS };
