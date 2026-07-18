// Shared Seam-1 helpers: read real SSE bytes off a streaming Response and wait
// for a named event, with a safety timeout so a broken stream fails fast instead
// of hanging the suite. Used by the events / issues route specs.
export interface SseEvent {
  event: string;
  data: unknown;
}

const parseFrame = (frame: string): SseEvent | null => {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  const data: unknown = JSON.parse(dataLines.join('\n'));
  return { event, data };
};

export async function* readEvents(res: Response): AsyncGenerator<SseEvent> {
  const body = res.body;
  if (!body) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = parseFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (frame) {
        yield frame;
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

// Read events until one of `type` arrives (or the budget elapses).
export async function nextEventOfType(
  events: AsyncGenerator<SseEvent>,
  type: string,
  budgetMs = 2000,
): Promise<SseEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      budgetMs,
    );
  });
  try {
    for (;;) {
      const result = await Promise.race([events.next(), timeout]);
      if (result.done) {
        throw new Error('stream ended before event');
      }
      if (result.value.event === type) {
        return result.value;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
