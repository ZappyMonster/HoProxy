import { v4 as uuidv4 } from 'uuid';
import { cacheThinkingSignature, cacheToolSignature } from './signatureCache.js';
import { normalizeMaxTokens, normalizeStopSequences } from './anthropicToHopGPT.js';
import { loggers } from '../utils/logger.js';

const log = loggers.transform;

// Pattern for <mcp_tool_call> blocks
const MCP_TOOL_CALL_BLOCK_RE = /<mcp_tool_call\b[\s\S]*?<\/mcp_tool_call>/gi;
const MCP_TOOL_CALL_START_TAG = '<mcp_tool_call';

// Pattern for <function_calls> blocks (used by OpenCode)
// Also matches <function_calls> used by Claude Code
const FUNCTION_CALLS_BLOCK_RE = /<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>/gi;
const FUNCTION_CALLS_START_TAG = '<function_calls';
const ANTML_FUNCTION_CALLS_START_TAG = '<antml:function_calls';

// Pattern for <tool_call> blocks with JSON (another OpenCode format)
const TOOL_CALL_JSON_BLOCK_RE = /<tool_call\b[\s\S]*?<\/tool_call>/gi;
const TOOL_CALL_JSON_START_TAG = '<tool_call';

// Pattern for <tool_use> blocks with JSON-like content (Anthropic style in text)
const TOOL_USE_START_TAG = '<tool_use';

// Pattern for standalone <invoke> blocks
// Also matches <invoke> used by Claude Code
const INVOKE_BLOCK_RE = /<(?:antml:)?invoke\b[\s\S]*?<\/(?:antml:)?invoke>/gi;
const INVOKE_START_TAG = '<invoke';
const ANTML_INVOKE_START_TAG = '<antml:invoke';

// Combined pattern for any tool call format
// Includes antml: namespace variants used by Claude Code
const ANY_TOOL_CALL_BLOCK_RE = /(?:<mcp_tool_call\b[\s\S]*?<\/mcp_tool_call>|<(?:antml:)?function_calls\b[\s\S]*?<\/(?:antml:)?function_calls>|<tool_call\b[\s\S]*?<\/tool_call>|<tool_call\b[\s\S]*?<\/tool_use>|<tool_use\b[\s\S]*?<\/tool_use>|<tool_use\b[\s\S]*?<\/tool_call>|<(?:antml:)?invoke\b[\s\S]*?<\/(?:antml:)?invoke>)/gi;

const FUNCTION_CALLS_TAGS = [FUNCTION_CALLS_START_TAG, ANTML_FUNCTION_CALLS_START_TAG];
const INVOKE_TAGS = [INVOKE_START_TAG, ANTML_INVOKE_START_TAG];

function includesAny(haystack, needles) {
  return needles.some(tag => haystack.includes(tag));
}

function extractXmlTagValue(source, tagName) {
  if (!source) {
    return null;
  }
  const matcher = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = source.match(matcher);
  return match ? match[1].trim() : null;
}

function extractXmlTagValueFlexible(source, tagName, fallbackTagName) {
  const value = extractXmlTagValue(source, tagName);
  if (value !== null) {
    return value;
  }
  if (!source || !fallbackTagName) {
    return null;
  }
  const matcher = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${fallbackTagName}>`, 'i');
  const match = source.match(matcher);
  return match ? match[1].trim() : null;
}

function extractXmlAttribute(source, tagName, attrName) {
  if (!source) {
    return null;
  }
  const matcher = new RegExp(`<${tagName}[^>]*\\s${attrName}=["']([^"']*)["']`, 'i');
  const match = source.match(matcher);
  return match ? match[1] : null;
}

function stripCdata(source) {
  if (!source) {
    return source;
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('<![CDATA[') && trimmed.endsWith(']]>')) {
    return trimmed.slice(9, -3);
  }
  return source;
}

function escapeUnescapedControlChars(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return jsonStr;
  }

  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
        continue;
      }
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        result += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
    result += ch;
  }

  return result;
}

function parseEmbeddedJson(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return value;
    }
  }
  return value;
}

function parseJsonWithRepair(jsonText) {
  if (!jsonText || typeof jsonText !== 'string') {
    return null;
  }
  const cleaned = stripCdata(jsonText).trim();
  if (!cleaned) {
    return null;
  }
  const escaped = escapeUnescapedControlChars(cleaned);
  const attempts = [cleaned, escaped, repairMalformedArrayJson(cleaned), repairMalformedArrayJson(escaped)]
    .filter((value, index, self) => typeof value === 'string' && self.indexOf(value) === index);

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch (error) {
      continue;
    }
  }

  return null;
}

function parseToolCallJsonContent(jsonContent) {
  const parsed = parseJsonWithRepair(jsonContent);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const toolName = parsed.name;
  if (!toolName) {
    return null;
  }
  const args = parsed.parameters || parsed.arguments || parsed.input || {};
  return {
    toolName,
    arguments: parseEmbeddedJson(args),
    toolUseId: parsed.id || parsed.toolUseId || null
  };
}

function getLeadingTagName(block) {
  if (!block) {
    return null;
  }
  const match = block.trim().match(/^<\s*([a-zA-Z0-9:]+)/);
  return match ? match[1].toLowerCase() : null;
}

function findMatchingBrace(source, startIndex) {
  if (!source || startIndex < 0 || startIndex >= source.length || source[startIndex] !== '{') {
    return -1;
  }
  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      braceCount++;
    } else if (ch === '}') {
      braceCount--;
      if (braceCount === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Repair malformed JSON where array brackets are missing.
 * Fixes patterns like: {"key": {"id": "1"}, {"id": "2"}}
 * To become: {"key": [{"id": "1"}, {"id": "2"}]}
 *
 * This commonly happens when models output tool calls with array parameters
 * but omit the array brackets.
 */
function repairMalformedArrayJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') {
    return jsonStr;
  }

  // Pattern: a key followed by an object, then comma and another object without array brackets
  // e.g., "key": {"a": 1}, {"b": 2} should become "key": [{"a": 1}, {"b": 2}]
  //
  // Strategy: Find patterns where we have }: followed by whitespace and {
  // which indicates adjacent objects that should be in an array

  let result = jsonStr;
  const modifications = [];
  const valueStarts = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let keyEscaped = false;
      for (; j < jsonStr.length; j++) {
        const next = jsonStr[j];
        if (keyEscaped) {
          keyEscaped = false;
          continue;
        }
        if (next === '\\') {
          keyEscaped = true;
          continue;
        }
        if (next === '"') {
          break;
        }
      }

      if (j >= jsonStr.length) {
        break;
      }

      let k = j + 1;
      while (k < jsonStr.length && /\s/.test(jsonStr[k])) {
        k++;
      }
      if (jsonStr[k] !== ':') {
        i = j;
        continue;
      }
      k++;
      while (k < jsonStr.length && /\s/.test(jsonStr[k])) {
        k++;
      }
      if (jsonStr[k] === '{') {
        valueStarts.push(k);
      }
      i = j;
      continue;
    }
  }

  for (const startOfValue of valueStarts) {
    const firstObjEnd = findMatchingBrace(jsonStr, startOfValue);
    if (firstObjEnd === -1) {
      continue;
    }

    let pos = firstObjEnd + 1;
    while (pos < jsonStr.length && /\s/.test(jsonStr[pos])) {
      pos++;
    }
    if (jsonStr[pos] !== ',') {
      continue;
    }
    pos++;
    while (pos < jsonStr.length && /\s/.test(jsonStr[pos])) {
      pos++;
    }
    if (jsonStr[pos] !== '{') {
      continue;
    }

    let arrayEnd = firstObjEnd;
    let nextObjStart = pos;
    while (nextObjStart < jsonStr.length && jsonStr[nextObjStart] === '{') {
      const nextObjEnd = findMatchingBrace(jsonStr, nextObjStart);
      if (nextObjEnd === -1) {
        break;
      }
      arrayEnd = nextObjEnd;
      let afterObj = nextObjEnd + 1;
      while (afterObj < jsonStr.length && /\s/.test(jsonStr[afterObj])) {
        afterObj++;
      }
      if (jsonStr[afterObj] !== ',') {
        break;
      }
      afterObj++;
      while (afterObj < jsonStr.length && /\s/.test(jsonStr[afterObj])) {
        afterObj++;
      }
      if (jsonStr[afterObj] !== '{') {
        break;
      }
      nextObjStart = afterObj;
    }

    modifications.push({
      insertOpenBracket: startOfValue,
      insertCloseBracket: arrayEnd + 1
    });
  }

  // Apply modifications in reverse order to preserve positions
  modifications.sort((a, b) => b.insertCloseBracket - a.insertCloseBracket);
  for (const mod of modifications) {
    result = result.slice(0, mod.insertCloseBracket) + ']' + result.slice(mod.insertCloseBracket);
    result = result.slice(0, mod.insertOpenBracket) + '[' + result.slice(mod.insertOpenBracket);
  }

  return result;
}

function parseMcpToolCallBlock(block) {
  const serverName = extractXmlTagValue(block, 'server_name');
  const toolName = extractXmlTagValue(block, 'tool_name');
  const argsText = extractXmlTagValue(block, 'arguments');

  if (!toolName) {
    return null;
  }

  let parsedArgs = {};
  if (argsText && argsText.trim().length > 0) {
    const trimmedArgs = argsText.trim();
    const repairedArgs = parseJsonWithRepair(trimmedArgs);
    if (repairedArgs !== null) {
      parsedArgs = repairedArgs;
    } else {
      log.warn('Failed to parse MCP tool call arguments');
      parsedArgs = { _raw: trimmedArgs };
    }
  }

  return {
    serverName,
    toolName,
    arguments: parsedArgs
  };
}

/**
 * Parse a single <invoke> block from <function_calls> format
 * Also handles antml: namespace variants used by Claude Code
 * Format: <invoke name="ToolName"><parameter name="paramName">value</parameter>...</invoke>
 * Or: <invoke name="ToolName"><parameter name="paramName">value</parameter>...</invoke>
 */
function parseInvokeBlock(invokeBlock) {
  // Try both invoke and antml:invoke tag names
  let toolName = extractXmlAttribute(invokeBlock, 'invoke', 'name');
  if (!toolName) {
    toolName = extractXmlAttribute(invokeBlock, 'antml:invoke', 'name');
  }
  if (!toolName) {
    return null;
  }

  // Extract all parameters - handle both antml:parameter and parameter tags
  const parameterRe = /<(?:antml:)?parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:antml:)?parameter>/gi;
  const args = {};
  let paramMatch;
  while ((paramMatch = parameterRe.exec(invokeBlock)) !== null) {
    const paramName = paramMatch[1];
    const paramValue = paramMatch[2].trim();
    args[paramName] = paramValue;
  }

  return {
    serverName: null,
    toolName,
    arguments: args
  };
}

/**
 * Parse <function_calls> block containing one or more <invoke> blocks
 * Also handles antml: namespace variants used by Claude Code
 */
function parseFunctionCallsBlock(block) {
  const invokeRe = /<(?:antml:)?invoke[^>]*>[\s\S]*?<\/(?:antml:)?invoke>/gi;
  const toolCalls = [];
  let invokeMatch;
  while ((invokeMatch = invokeRe.exec(block)) !== null) {
    const toolCall = parseInvokeBlock(invokeMatch[0]);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
  }
  return toolCalls;
}

/**
 * Parse <tool_call> block with JSON content
 * Format: <tool_call>{"name": "ToolName", "parameters": {...}}</tool_call>
 */
function parseToolCallJsonBlock(block) {
  const jsonContent = extractXmlTagValueFlexible(block, 'tool_call', 'tool_use');
  if (!jsonContent) {
    return null;
  }

  try {
    const toolCall = parseToolCallJsonContent(jsonContent);
    if (!toolCall) {
      return null;
    }
    return {
      serverName: null,
      toolName: toolCall.toolName,
      toolUseId: toolCall.toolUseId,
      arguments: toolCall.arguments
    };
  } catch (error) {
    log.warn('Failed to parse tool_call JSON', { error: error.message });
  }
}

/**
 * Parse <tool_use> block with JSON content
 * Format: <tool_use id="toolu_x" name="ToolName">{...}</tool_use>
 */
function parseToolUseBlock(block) {
  const toolUseId = extractXmlAttribute(block, 'tool_use', 'id');
  const toolName = extractXmlAttribute(block, 'tool_use', 'name');
  if (!toolName) {
    const inputText = extractXmlTagValueFlexible(block, 'tool_use', 'tool_call');
    if (!inputText) {
      return null;
    }
    const toolCall = parseToolCallJsonContent(inputText);
    if (!toolCall) {
      return null;
    }
    return {
      serverName: null,
      toolName: toolCall.toolName,
      toolUseId: toolUseId || toolCall.toolUseId,
      arguments: toolCall.arguments
    };
  }

  const inputText = stripCdata(extractXmlTagValueFlexible(block, 'tool_use', 'tool_call'));
  let parsedArgs = {};

  if (inputText && inputText.length > 0) {
    const trimmedInput = inputText.trim();
    const repairedInput = parseJsonWithRepair(trimmedInput);
    parsedArgs = repairedInput !== null ? repairedInput : trimmedInput;
  }

  return {
    serverName: null,
    toolName,
    toolUseId,
    arguments: parsedArgs
  };
}

/**
 * Parse any tool call block format and return array of tool calls
 */
function parseAnyToolCallBlock(block) {
  const leadingTag = getLeadingTagName(block);
  if (leadingTag === 'mcp_tool_call') {
    const toolCall = parseMcpToolCallBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (leadingTag === 'function_calls' || leadingTag === 'antml:function_calls') {
    return parseFunctionCallsBlock(block);
  }
  if (leadingTag === 'invoke' || leadingTag === 'antml:invoke') {
    const toolCall = parseInvokeBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (leadingTag === 'tool_call') {
    const toolCall = parseToolCallJsonBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (leadingTag === 'tool_use') {
    const toolCall = parseToolUseBlock(block);
    return toolCall ? [toolCall] : [];
  }
  const blockLower = block.toLowerCase();
  if (blockLower.includes(MCP_TOOL_CALL_START_TAG)) {
    const toolCall = parseMcpToolCallBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (includesAny(blockLower, FUNCTION_CALLS_TAGS)) {
    return parseFunctionCallsBlock(block);
  }
  if (includesAny(blockLower, INVOKE_TAGS)) {
    const toolCall = parseInvokeBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (blockLower.includes('<tool_call')) {
    const toolCall = parseToolCallJsonBlock(block);
    return toolCall ? [toolCall] : [];
  }
  if (blockLower.includes('<tool_use')) {
    const toolCall = parseToolUseBlock(block);
    return toolCall ? [toolCall] : [];
  }
  return [];
}

function splitMcpToolCalls(text) {
  if (!text) {
    return [];
  }

  const segments = [];
  let lastIndex = 0;

  // Use combined pattern to match both formats
  ANY_TOOL_CALL_BLOCK_RE.lastIndex = 0;
  let match = null;
  while ((match = ANY_TOOL_CALL_BLOCK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const toolCalls = parseAnyToolCallBlock(match[0]);
    if (toolCalls.length === 0) {
      // Fallback: emit the original text if parsing failed
      segments.push({ type: 'text', text: match[0] });
    } else {
      for (const toolCall of toolCalls) {
        segments.push({ type: 'tool_call', toolCall });
      }
    }
    lastIndex = ANY_TOOL_CALL_BLOCK_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}

function splitStreamTextForMcpToolCalls(text) {
  const segments = [];
  let lastIndex = 0;

  // Maximum buffer size before we give up waiting for a closing tag
  // This prevents infinite buffering when text contains partial tag-like content
  const MAX_BUFFER_SIZE = 8000;

  // Use combined pattern to match both formats
  ANY_TOOL_CALL_BLOCK_RE.lastIndex = 0;
  let match = null;
  while ((match = ANY_TOOL_CALL_BLOCK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const toolCalls = parseAnyToolCallBlock(match[0]);
    if (toolCalls.length === 0) {
      // Fallback: emit the original text if parsing failed
      segments.push({ type: 'text', text: match[0] });
    } else {
      for (const toolCall of toolCalls) {
        segments.push({ type: 'tool_call', toolCall });
      }
    }
    lastIndex = ANY_TOOL_CALL_BLOCK_RE.lastIndex;
  }

  const trailing = text.slice(lastIndex);
  if (!trailing) {
    return { segments, remainder: '' };
  }

  // Check for partial <mcp_tool_call>, <function_calls>, or <tool_call> tags
  // Also check for antml: namespace variants
  const mcpStartIndex = trailing.indexOf(MCP_TOOL_CALL_START_TAG);
  const funcStartIndex = trailing.indexOf(FUNCTION_CALLS_START_TAG);
  const antmlFuncStartIndex = trailing.indexOf(ANTML_FUNCTION_CALLS_START_TAG);
  const toolCallStartIndex = trailing.indexOf(TOOL_CALL_JSON_START_TAG);
  const toolUseStartIndex = trailing.indexOf(TOOL_USE_START_TAG);
  const invokeStartIndex = trailing.indexOf(INVOKE_START_TAG);
  const antmlInvokeStartIndex = trailing.indexOf(ANTML_INVOKE_START_TAG);

  // Find the earliest partial tag
  let startIndex = -1;
  const indices = [mcpStartIndex, funcStartIndex, antmlFuncStartIndex, toolCallStartIndex, toolUseStartIndex, invokeStartIndex, antmlInvokeStartIndex]
    .filter(i => i !== -1);
  if (indices.length > 0) {
    startIndex = Math.min(...indices);
  }

  if (startIndex !== -1) {
    // Check if the potential partial tag is actually inside quotes or backticks
    // This helps avoid buffering documentation text like `<tool_use>` or "<invoke>"
    const beforeTag = trailing.slice(Math.max(0, startIndex - 1), startIndex);
    const isQuotedBefore = beforeTag === '`' || beforeTag === '"' || beforeTag === "'";

    // Also check what comes after the tag start - if it's a quote, it's likely
    // a string literal in source code (e.g., const TAG = '<function_calls';)
    // Find the end of the tag name to check the next character
    const tagNames = [
      MCP_TOOL_CALL_START_TAG,
      FUNCTION_CALLS_START_TAG,
      ANTML_FUNCTION_CALLS_START_TAG,
      TOOL_CALL_JSON_START_TAG,
      TOOL_USE_START_TAG,
      INVOKE_START_TAG,
      ANTML_INVOKE_START_TAG
    ];
    let matchedTag = null;
    for (const tag of tagNames) {
      if (trailing.slice(startIndex).startsWith(tag)) {
        matchedTag = tag;
        break;
      }
    }
    const afterTagIndex = matchedTag ? startIndex + matchedTag.length : startIndex + 1;
    const afterTag = trailing.slice(afterTagIndex, afterTagIndex + 1);
    const isQuotedAfter = afterTag === "'" || afterTag === '"';

    // Also check if buffer would be too large - if so, it's probably not a real tool call
    const potentialRemainder = trailing.slice(startIndex);
    if (isQuotedBefore || isQuotedAfter || potentialRemainder.length > MAX_BUFFER_SIZE) {
      // Don't buffer - emit as text instead
      segments.push({ type: 'text', text: trailing });
      return { segments, remainder: '' };
    }

    if (startIndex > 0) {
      segments.push({ type: 'text', text: trailing.slice(0, startIndex) });
    }
    return { segments, remainder: trailing.slice(startIndex) };
  }

  // Check for partial tag at end (e.g., "<mcp_tool" or "<function" or "<tool_c" or "<")
  const lastLt = trailing.lastIndexOf('<');
  if (lastLt !== -1) {
    const possibleTag = trailing.slice(lastLt);
    if (MCP_TOOL_CALL_START_TAG.startsWith(possibleTag) ||
        FUNCTION_CALLS_START_TAG.startsWith(possibleTag) ||
        ANTML_FUNCTION_CALLS_START_TAG.startsWith(possibleTag) ||
        TOOL_CALL_JSON_START_TAG.startsWith(possibleTag) ||
        TOOL_USE_START_TAG.startsWith(possibleTag) ||
        INVOKE_START_TAG.startsWith(possibleTag) ||
        ANTML_INVOKE_START_TAG.startsWith(possibleTag)) {
      if (lastLt > 0) {
        segments.push({ type: 'text', text: trailing.slice(0, lastLt) });
      }
      return { segments, remainder: possibleTag };
    }
  }

  segments.push({ type: 'text', text: trailing });
  return { segments, remainder: '' };
}

/**
 * Check if a model supports extended thinking
 * @param {string} model - Model name
 * @returns {boolean} True if model supports thinking
 */
export function isThinkingModel(model) {
  if (!model) return false;
  const modelLower = model.toLowerCase();
  // Models with "-thinking" suffix or explicit thinking models
  return modelLower.includes('-thinking') ||
         modelLower.includes('thinking') ||
         // Claude Opus 4.5 models may support thinking with explicit parameter
         modelLower.includes('opus-4.5') ||
         modelLower.includes('opus-4-5');
}

/**
 * Generate a unique tool use ID in Anthropic format
 * @returns {string} Tool use ID like toolu_01XFDUDYJgAACzvnptvVoYEL
 */
function generateToolUseId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'toolu_01';
  for (let i = 0; i < 22; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function mapStopReason(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'stop_sequence' || normalized === 'stop-sequence' || normalized === 'stopsequence') {
    return 'stop_sequence';
  }
  if (normalized === 'max_tokens' || normalized === 'max-tokens' || normalized === 'length' || normalized === 'max_tokens_exceeded') {
    return 'max_tokens';
  }
  if (normalized === 'tool_use' || normalized === 'tool-use' || normalized === 'tool' || normalized === 'function_call') {
    return 'tool_use';
  }
  if (normalized === 'end_turn' || normalized === 'end-turn' || normalized === 'stop' || normalized === 'eos') {
    return 'end_turn';
  }
  return null;
}

/**
 * Transformer class to convert HopGPT SSE events to Anthropic SSE format
 * Supports extended thinking and tool use for compatible models
 */
export class HopGPTToAnthropicTransformer {
  constructor(model = 'claude-sonnet-4-20250514', options = {}) {
    this.messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    this.model = model;
    this.hasStarted = false;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.conversationId = null;
    this.responseMessageId = null;
    this.systemPrompt = options.systemPrompt ?? null;

    // Thinking support
    this.thinkingEnabled = options.thinkingEnabled ?? isThinkingModel(model);
    this.currentBlockIndex = -1;  // Will be incremented when blocks start
    this.currentBlockType = null; // 'thinking', 'text', or 'tool_use'
    this.blockStarted = false;    // Track if current block has started

    // Accumulated content for non-streaming responses
    this.contentBlocks = [];      // Array of {type, content, signature?}
    this.accumulatedText = '';    // For backward compatibility
    this.accumulatedThinking = '';
    this.thinkingSignature = null;
    this.mcpToolCallBuffer = '';

    // Tool use support
    this.currentToolUse = null;   // Current tool use being streamed {id, name, inputJson}
    this.accumulatedToolUses = []; // All completed tool uses
    this.hasToolUse = false;      // Track if response contains tool use

    // MCP tool call passthrough mode - when enabled, <mcp_tool_call> blocks are
    // passed through as text instead of being converted to tool_use blocks.
    // This is needed for clients like OpenCode that parse and execute tool calls
    // directly from the text stream.
    this.mcpPassthrough = options.mcpPassthrough ?? false;

    this.maxTokens = normalizeMaxTokens(options.maxTokens);
    this.stopSequences = normalizeStopSequences(options.stopSequences);
    this.hopGPTStopReason = null;
    this.hopGPTStopSequence = null;
  }

  /**
   * Transform a HopGPT SSE event to Anthropic SSE event(s)
   * @param {object} event - Parsed SSE event with 'event' and 'data' fields
   * @returns {Array|null} Array of Anthropic SSE events or null if event should be skipped
   */
  transformEvent(event) {
    try {
      const data = JSON.parse(event.data);
      return this._transformData(data);
    } catch (error) {
      log.error('Failed to parse SSE event', { error: error.message });
      return null;
    }
  }

  _transformData(data) {
    // Debug logging to trace what HopGPT sends
    log.debug('Processing HopGPT event', { eventType: data.event || (data.created ? 'created' : data.final ? 'final' : 'unknown') });

    // Event type 1: Initial message created
    if (data.created && data.message) {
      return this._createMessageStart();
    }

    // Event type 2: on_run_step - skip (internal HopGPT event)
    if (data.event === 'on_run_step') {
      return null;
    }

    // Event type 3: on_message_delta - content chunks (text or thinking)
    if (data.event === 'on_message_delta') {
      const deltaContent = data.data?.delta?.content;
      if (deltaContent && deltaContent.length > 0) {
        const events = [];

        // Process all content blocks (may include thinking and text)
        for (const block of deltaContent) {
          const blockEvents = this._processContentBlock(block);
          if (blockEvents) {
            events.push(...blockEvents);
          }
        }

        // Also check for thoughtSignature in the delta
        if (data.data?.delta?.thoughtSignature) {
          this.thinkingSignature = data.data.delta.thoughtSignature;
          cacheThinkingSignature(this.thinkingSignature, 'claude');
        }

        return events.length > 0 ? events : null;
      }
      return null;
    }

    // Event type 4: final - end of stream
    if (data.final) {
      this.conversationId = data.conversation?.conversationId;
      this.responseMessageId = data.responseMessage?.messageId;
      this.inputTokens = data.responseMessage?.promptTokens || 0;
      this.outputTokens = data.responseMessage?.tokenCount || 0;
      this.hopGPTStopReason = data.responseMessage?.stopReason ??
        data.responseMessage?.stop_reason ??
        data.responseMessage?.finishReason ??
        data.responseMessage?.finish_reason ??
        null;
      this.hopGPTStopSequence = data.responseMessage?.stopSequence ??
        data.responseMessage?.stop_sequence ??
        null;

      // Check for thoughtSignature in final response
      if (data.responseMessage?.thoughtSignature) {
        this.thinkingSignature = data.responseMessage.thoughtSignature;
        cacheThinkingSignature(this.thinkingSignature, 'claude');
      }

      // Extract content blocks from final message for non-streaming
      if (data.responseMessage?.content) {
        this._extractFinalContent(data.responseMessage.content);
      }

      return this._createMessageStop();
    }

    return null;
  }

  /**
   * Process a single content block from delta
   */
  _processContentBlock(block) {
    const events = [];

    // Handle thinking blocks
    if (block.type === 'thinking' && block.thinking) {
      // If we were in a different block type, close it first
      if (this.blockStarted && this.currentBlockType !== 'thinking') {
        events.push(this._createBlockStop());
      }

      // Start thinking block if needed
      if (!this.blockStarted || this.currentBlockType !== 'thinking') {
        const startEvent = this._createBlockStart('thinking');
        if (startEvent) events.push(startEvent);
      }

      // Add thinking delta
      this.accumulatedThinking += block.thinking;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: block.thinking
          }
        }
      });

      // Capture signature if present
      if (block.signature) {
        this.thinkingSignature = block.signature;
        cacheThinkingSignature(this.thinkingSignature, 'claude');
      }

      return events;
    }

    // Handle text blocks
    if (block.type === 'text' && block.text) {
      // In passthrough mode, don't parse MCP tool calls - just emit text as-is
      if (this.mcpPassthrough) {
        events.push(...this._emitTextDelta(block.text));
        return events.length > 0 ? events : null;
      }

      // Debug: Log incoming text for tool call detection
      if (process.env.HOPGPT_DEBUG === 'true') {
        const hasToolCallTag = block.text.includes('<tool_call') ||
                               includesAny(block.text, FUNCTION_CALLS_TAGS) ||
                               block.text.includes(MCP_TOOL_CALL_START_TAG) ||
                               block.text.includes(TOOL_USE_START_TAG) ||
                               includesAny(block.text, INVOKE_TAGS);
        if (hasToolCallTag) {
          console.log('[Transform] Text contains tool call XML:', block.text.slice(0, 200));
        }
      }

      const combined = `${this.mcpToolCallBuffer}${block.text}`;
      const { segments, remainder } = splitStreamTextForMcpToolCalls(combined);
      this.mcpToolCallBuffer = remainder;

      // Debug: Log buffer state when it grows large (potential infinite buffering issue)
      if (process.env.HOPGPT_DEBUG === 'true') {
        if (remainder && remainder.length > 500) {
          console.log('[Transform] WARNING: Large buffer detected:', remainder.length, 'chars. First 200:', remainder.slice(0, 200));
        }
        const toolCalls = segments.filter(s => s.type === 'tool_call');
        if (toolCalls.length > 0) {
          console.log(`[Transform] Parsed ${toolCalls.length} tool calls from text`);
          for (const tc of toolCalls) {
            console.log('[Transform] Tool call:', tc.toolCall?.toolName);
          }
        }
      }

      for (const segment of segments) {
        if (segment.type === 'text') {
          events.push(...this._emitTextDelta(segment.text));
          continue;
        }
        if (segment.type === 'tool_call') {
          const toolBlock = {
            type: 'tool_use',
            id: segment.toolCall.toolUseId || generateToolUseId(),
            name: segment.toolCall.toolName,
            input: segment.toolCall.arguments
          };
          events.push(...this._processToolUseBlock(toolBlock));
        }
      }

      return events.length > 0 ? events : null;
    }

    // Handle tool_use blocks
    if (block.type === 'tool_use') {
      if (block.thoughtSignature && block.id) {
        cacheToolSignature(block.id, block.thoughtSignature);
      }
      return this._processToolUseBlock(block);
    }

    return null;
  }

  /**
   * Extract content blocks from final message
   */
  _extractFinalContent(content) {
    for (const block of content) {
      if (block.type === 'thinking') {
        if (block.signature) {
          cacheThinkingSignature(block.signature, 'claude');
        }
        this.contentBlocks.push({
          type: 'thinking',
          thinking: block.thinking || this.accumulatedThinking,
          signature: block.signature || this.thinkingSignature
        });
      } else if (block.type === 'text') {
        // In passthrough mode, don't parse MCP tool calls - preserve text as-is
        if (this.mcpPassthrough) {
          if (block.text) {
            this.contentBlocks.push({
              type: 'text',
              text: block.text
            });
            this.accumulatedText += block.text;
          }
          continue;
        }

        const segments = splitMcpToolCalls(block.text || '');
        for (const segment of segments) {
          if (segment.type === 'text') {
            if (!segment.text) continue;
            this.contentBlocks.push({
              type: 'text',
              text: segment.text
            });
            this.accumulatedText += segment.text;
            continue;
          }
          if (segment.type === 'tool_call') {
            this.hasToolUse = true;
            this.contentBlocks.push({
              type: 'tool_use',
              id: segment.toolCall.toolUseId || generateToolUseId(),
              name: segment.toolCall.toolName,
              input: segment.toolCall.arguments || {}
            });
          }
        }
      } else if (block.type === 'tool_use') {
        this.hasToolUse = true;
        let input = block.input;

        // Parse input if it's a string
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch (e) {
            input = {};
          }
        }

        this.contentBlocks.push({
          type: 'tool_use',
          id: block.id || generateToolUseId(),
          name: block.name || '',
          input: input || {}
        });
      }
    }
  }

  _emitTextDelta(text) {
    if (!text) {
      return [];
    }

    const events = [];

    if (this.blockStarted && this.currentBlockType !== 'text') {
      // Save tool use before switching away from tool_use block
      if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
        this.accumulatedToolUses.push({...this.currentToolUse});
        this.currentToolUse = null;
      }
      events.push(this._createBlockStop());
    }

    if (!this.blockStarted || this.currentBlockType !== 'text') {
      const startEvent = this._createBlockStart('text');
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    this.accumulatedText += text;
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: {
          type: 'text_delta',
          text
        }
      }
    });

    return events;
  }

  _processToolUseBlock(block) {
    const events = [];
    this.hasToolUse = true;

    const toolId = block.id || (this.currentToolUse?.id);
    const toolName = block.name || (this.currentToolUse?.name);

    if (this.blockStarted && (this.currentBlockType !== 'tool_use' ||
        (this.currentToolUse && this.currentToolUse.id !== toolId))) {
      if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
        this.accumulatedToolUses.push({...this.currentToolUse});
      }
      events.push(this._createBlockStop());
    }

    if (!this.blockStarted || this.currentBlockType !== 'tool_use' ||
        (this.currentToolUse && this.currentToolUse.id !== toolId)) {
      this.currentToolUse = {
        id: toolId || generateToolUseId(),
        name: toolName || '',
        inputJson: ''
      };
      const startEvent = this._createBlockStart('tool_use', this.currentToolUse);
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    if (block.name && !this.currentToolUse.name) {
      this.currentToolUse.name = block.name;
    }

    if (block.input !== undefined) {
      let inputDelta = '';
      if (typeof block.input === 'string') {
        inputDelta = block.input;
        this.currentToolUse.inputJson += inputDelta;
      } else if (typeof block.input === 'object') {
        inputDelta = JSON.stringify(block.input);
        this.currentToolUse.inputJson = inputDelta;
      }

      if (inputDelta) {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: inputDelta
            }
          }
        });
      }
    }

    if (block.input_json !== undefined) {
      this.currentToolUse.inputJson += block.input_json;
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: block.input_json
          }
        }
      });
    }

    return events;
  }

  _getGeneratedText() {
    if (this.contentBlocks.length > 0) {
      return this.contentBlocks
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('');
    }

    return this.accumulatedText || '';
  }

  _detectStopSequence() {
    if (!this.stopSequences || this.stopSequences.length === 0) {
      return null;
    }

    const text = this._getGeneratedText();
    if (!text) {
      return null;
    }

    for (const sequence of this.stopSequences) {
      if (sequence && text.endsWith(sequence)) {
        return sequence;
      }
    }

    return null;
  }

  _determineStopInfo() {
    if (this.hasToolUse) {
      return { stopReason: 'tool_use', stopSequence: null };
    }

    const mappedReason = mapStopReason(this.hopGPTStopReason);
    if (mappedReason) {
      if (mappedReason === 'stop_sequence') {
        const sequence = typeof this.hopGPTStopSequence === 'string' && this.hopGPTStopSequence.length > 0
          ? this.hopGPTStopSequence
          : this._detectStopSequence();
        return { stopReason: 'stop_sequence', stopSequence: sequence || null };
      }
      return { stopReason: mappedReason, stopSequence: null };
    }

    const detectedSequence = this._detectStopSequence();
    if (detectedSequence) {
      return { stopReason: 'stop_sequence', stopSequence: detectedSequence };
    }

    if (this.maxTokens !== null && this.outputTokens >= this.maxTokens) {
      return { stopReason: 'max_tokens', stopSequence: null };
    }

    return { stopReason: 'end_turn', stopSequence: null };
  }

  _createMessageStart() {
    if (this.hasStarted) {
      return null;
    }
    this.hasStarted = true;

    // Just emit message_start, blocks will be started as content arrives
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: this.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0
            }
          }
        }
      }
    ];
  }

  /**
   * Create a content block start event
   */
  _createBlockStart(blockType, toolUseInfo = null) {
    this.currentBlockIndex++;
    this.currentBlockType = blockType;
    this.blockStarted = true;

    // Ensure message has started
    const events = [];
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) events.push(...startEvents);
    }

    if (blockType === 'thinking') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'thinking',
            thinking: ''
          }
        }
      });
    } else if (blockType === 'tool_use') {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseInfo?.id || generateToolUseId(),
            name: toolUseInfo?.name || ''
          }
        }
      });
    } else {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: {
            type: 'text',
            text: ''
          }
        }
      });
    }

    return events.length === 1 ? events[0] : events;
  }

  /**
   * Create a content block stop event
   */
  _createBlockStop() {
    const event = {
      event: 'content_block_stop',
      data: {
        type: 'content_block_stop',
        index: this.currentBlockIndex
      }
    };
    this.blockStarted = false;
    return event;
  }

  _createContentDelta(text) {
    // Legacy method for backward compatibility
    const events = [];

    // Ensure message and text block have started
    if (!this.hasStarted) {
      const startEvents = this._createMessageStart();
      if (startEvents) events.push(...startEvents);
    }

    if (!this.blockStarted || this.currentBlockType !== 'text') {
      const startEvent = this._createBlockStart('text');
      if (Array.isArray(startEvent)) {
        events.push(...startEvent);
      } else if (startEvent) {
        events.push(startEvent);
      }
    }

    this.accumulatedText += text;
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: {
          type: 'text_delta',
          text
        }
      }
    });

    return events;
  }

  _createMessageStop() {
    const events = [];

    // Mark that we're emitting message_stop
    this._hasEmittedMessageStop = true;

    // Flush any remaining buffered MCP tool calls
    if (this.mcpToolCallBuffer && !this.mcpPassthrough) {
      const segments = splitMcpToolCalls(this.mcpToolCallBuffer);
      for (const segment of segments) {
        if (segment.type === 'text' && segment.text) {
          events.push(...this._emitTextDelta(segment.text));
        } else if (segment.type === 'tool_call') {
          const toolBlock = {
            type: 'tool_use',
            id: segment.toolCall.toolUseId || generateToolUseId(),
            name: segment.toolCall.toolName,
            input: segment.toolCall.arguments
          };
          events.push(...this._processToolUseBlock(toolBlock));
        }
      }
      this.mcpToolCallBuffer = '';
    }

    // Save current tool use if still in progress
    if (this.currentBlockType === 'tool_use' && this.currentToolUse) {
      this.accumulatedToolUses.push({...this.currentToolUse});
    }

    // Close any open content block
    if (this.blockStarted) {
      events.push(this._createBlockStop());
    }

    const { stopReason, stopSequence } = this._determineStopInfo();

    // Add message_delta with stop reason
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: stopSequence
        },
        usage: {
          output_tokens: this.outputTokens
        }
      }
    });

    // Add message_stop
    events.push({
      event: 'message_stop',
      data: {
        type: 'message_stop'
      }
    });

    return events;
  }

  /**
   * Build a complete non-streaming response from accumulated data
   * @returns {object} Anthropic Messages API response
   */
  buildNonStreamingResponse() {
    // Build content array, preferring extracted blocks or falling back to accumulated
    let content = [];

    if (this.contentBlocks.length > 0) {
      // Use extracted content blocks from final message
      content = this.contentBlocks;
    } else {
      // Fall back to accumulated content
      if (this.accumulatedThinking) {
        const thinkingBlock = {
          type: 'thinking',
          thinking: this.accumulatedThinking
        };
        if (this.thinkingSignature) {
          thinkingBlock.signature = this.thinkingSignature;
        }
        content.push(thinkingBlock);
      }

      if (this.accumulatedText) {
        content.push({
          type: 'text',
          text: this.accumulatedText
        });
      }

      // Add accumulated tool uses
      for (const toolUse of this.accumulatedToolUses) {
        let input = {};
        if (toolUse.inputJson) {
          try {
            input = JSON.parse(toolUse.inputJson);
          } catch (e) {
            // If parsing fails, keep empty object
          }
        }
        content.push({
          type: 'tool_use',
          id: toolUse.id,
          name: toolUse.name,
          input
        });
      }

      // If no content at all, add empty text block
      if (content.length === 0) {
        content.push({
          type: 'text',
          text: ''
        });
      }
    }

    const { stopReason, stopSequence } = this._determineStopInfo();

    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content,
      model: this.model,
      stop_reason: stopReason,
      stop_sequence: stopSequence,
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens
      }
    };
  }

  /**
   * Get conversation state for multi-turn conversations
   * @returns {object} Conversation state
   */
  getConversationState() {
    return {
      conversationId: this.conversationId,
      lastAssistantMessageId: this.responseMessageId,
      systemPrompt: this.systemPrompt
    };
  }

  /**
   * Check if the stream has been properly terminated with message_stop
   * @returns {boolean} True if message_stop has been emitted
   */
  hasEnded() {
    return this._hasEmittedMessageStop === true;
  }

  /**
   * Force cleanup and emit message_stop if the stream ends without a final event
   * This ensures clients always receive a proper termination signal
   * @returns {Array} Array of cleanup SSE events to emit
   */
  forceEnd() {
    // If we've already emitted message_stop, don't do it again
    if (this._hasEmittedMessageStop) {
      return [];
    }

    log.debug('Forcing stream end - no final event received from HopGPT');

    // Use _createMessageStop to properly flush buffer, close blocks, and emit events
    const events = this._createMessageStop();
    this._hasEmittedMessageStop = true;
    return events;
  }
}

/**
 * Format SSE event for writing to response
 * @param {object} event - Event with 'event' and 'data' fields
 * @returns {string} Formatted SSE string
 */
export function formatSSEEvent(event) {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
