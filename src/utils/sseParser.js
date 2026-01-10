import { createParser } from 'eventsource-parser';

/**
 * Parse an SSE stream from a fetch response
 * @param {Response} response - Fetch response with SSE body
 * @param {function} onEvent - Callback for each parsed event
 * @returns {Promise<void>}
 */
export async function parseSSEStream(response, onEvent) {
  const parser = createParser((event) => {
    if (event.type === 'event') {
      onEvent({
        event: event.event || 'message',
        data: event.data
      });
    }
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse SSE stream and pipe transformed events to response
 * @param {Response} fetchResponse - Fetch response with SSE body
 * @param {object} res - Express response object
 * @param {function} transformEvent - Function to transform each event
 * @returns {Promise<object>} Final transformer state
 */
export async function pipeSSEStream(fetchResponse, res, transformEvent) {
  const parser = createParser((event) => {
    if (event.type === 'event') {
      const parsedEvent = {
        event: event.event || 'message',
        data: event.data
      };

      const transformedEvents = transformEvent(parsedEvent);

      if (transformedEvents) {
        const events = Array.isArray(transformedEvents) ? transformedEvents : [transformedEvents];

        for (const evt of events) {
          res.write(`event: ${evt.event}\n`);
          res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
          if (typeof res.flush === 'function') {
            res.flush();
          }
        }
      }
    }
  });

  const reader = fetchResponse.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Collect all events from an SSE stream
 * @param {Response} response - Fetch response with SSE body
 * @returns {Promise<Array>} Array of parsed events
 */
export async function collectSSEEvents(response) {
  const events = [];

  await parseSSEStream(response, (event) => {
    events.push(event);
  });

  return events;
}
