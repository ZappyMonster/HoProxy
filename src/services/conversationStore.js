import { v4 as uuidv4 } from 'uuid';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

const sessionStore = new Map();

function normalizeId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getTtlMs() {
  const configured = Number.parseInt(process.env.CONVERSATION_TTL_MS, 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_TTL_MS;
}

function cleanupExpiredSessions(now = Date.now()) {
  const ttlMs = getTtlMs();
  for (const [sessionId, entry] of sessionStore.entries()) {
    if (now - entry.lastTouchedAt > ttlMs) {
      sessionStore.delete(sessionId);
    }
  }
}

function extractSessionIdFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  return normalizeId(metadata.session_id) ||
    normalizeId(metadata.sessionId) ||
    normalizeId(metadata.conversation_id) ||
    normalizeId(metadata.conversationId);
}

export function resolveSessionId(req, requestBody) {
  const headerSessionId = normalizeId(req.get('x-session-id')) ||
    normalizeId(req.get('x-sessionid'));
  const metadataSessionId = extractSessionIdFromMetadata(requestBody?.metadata);
  const sessionId = headerSessionId || metadataSessionId;

  if (sessionId) {
    return { sessionId, isGenerated: false };
  }

  return { sessionId: uuidv4(), isGenerated: true };
}

export function shouldResetConversation(req, requestBody) {
  const headerReset = normalizeId(req.get('x-conversation-reset'));
  if (headerReset && headerReset.toLowerCase() === 'true') {
    return true;
  }

  const metadata = requestBody?.metadata;
  return metadata?.conversation_reset === true ||
    metadata?.reset === true ||
    metadata?.new_conversation === true;
}

export function getConversationState(sessionId) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  cleanupExpiredSessions();

  const entry = sessionStore.get(normalizedSessionId);
  if (!entry) {
    return null;
  }

  entry.lastTouchedAt = Date.now();
  return {
    conversationId: entry.conversationId || null,
    lastAssistantMessageId: entry.lastAssistantMessageId || null,
    systemPrompt: entry.systemPrompt || null
  };
}

export function updateConversationState(sessionId, state) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId || !state) {
    return;
  }

  cleanupExpiredSessions();

  const now = Date.now();
  const entry = sessionStore.get(normalizedSessionId) || { createdAt: now };
  const conversationId = normalizeId(state.conversationId);
  const lastAssistantMessageId = normalizeId(state.lastAssistantMessageId);
  const systemPrompt = normalizeId(state.systemPrompt);

  if (conversationId) {
    entry.conversationId = conversationId;
  }
  if (lastAssistantMessageId) {
    entry.lastAssistantMessageId = lastAssistantMessageId;
  }
  if (systemPrompt) {
    entry.systemPrompt = systemPrompt;
  }

  entry.lastTouchedAt = now;
  sessionStore.set(normalizedSessionId, entry);
}

export function resetConversationState(sessionId) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId) {
    return;
  }
  sessionStore.delete(normalizedSessionId);
}
