import { PassThrough } from 'stream';
import type { Request, ResponseToolkit, Server } from '@hapi/hapi';
import type { QueueRegistry } from './types';

interface EventSubscription {
  queueEvents: any;
  refCount: number;
}

const QueueEventsClass: { new (name: string, opts: any): any } | null = (() => {
  try {
    return (require('glide-mq') as any).QueueEvents;
  } catch {
    return null;
  }
})();

function writeSSE(stream: PassThrough, event: string, data: string, id: string): boolean {
  try {
    if (stream.destroyed || stream.writableEnded) return false;
    return stream.write(`event: ${event}\ndata: ${data}\nid: ${id}\n\n`);
  } catch {
    return false;
  }
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getSubscriptions(server: Server): Map<string, EventSubscription> {
  if (!(server.app as any).__glidemq_subscriptions) {
    (server.app as any).__glidemq_subscriptions = new Map<string, EventSubscription>();
  }
  return (server.app as any).__glidemq_subscriptions;
}

function acquireQueueEvents(
  subscriptions: Map<string, EventSubscription>,
  name: string,
  connectionOpts: any,
  prefix?: string,
): any {
  const existing = subscriptions.get(name);
  if (existing) {
    existing.refCount++;
    return existing.queueEvents;
  }

  if (!QueueEventsClass) {
    throw new Error('glide-mq is required for live SSE events');
  }

  const queueEvents = new QueueEventsClass(name, {
    connection: connectionOpts,
    prefix,
  });

  subscriptions.set(name, { queueEvents, refCount: 1 });
  return queueEvents;
}

function releaseQueueEvents(subscriptions: Map<string, EventSubscription>, name: string): void {
  const sub = subscriptions.get(name);
  if (!sub) return;
  sub.refCount--;
  if (sub.refCount <= 0) {
    sub.queueEvents.close().catch(() => {});
    subscriptions.delete(name);
  }
}

function closeAllSubscriptions(subscriptions: Map<string, EventSubscription>): Promise<void> {
  const closes: Promise<void>[] = [];
  for (const sub of subscriptions.values()) {
    closes.push(sub.queueEvents.close().catch(() => {}));
  }
  subscriptions.clear();
  return Promise.allSettled(closes).then(() => {});
}

export function createEventsHandler(server: Server) {
  // Clean up all subscriptions on server stop
  server.ext({
    type: 'onPostStop',
    method: async () => {
      await closeAllSubscriptions(getSubscriptions(server));
    },
  });

  return async (request: Request, h: ResponseToolkit) => {
    const { name } = request.params as { name: string };
    const registry: QueueRegistry = request.server.glidemq;

    const stream = new PassThrough();

    const response = h
      .response(stream)
      .type('text/event-stream')
      .header('Cache-Control', 'no-cache');

    stream.write(':ok\n\n');

    const handler = registry.testing
      ? handleTestingSSE(request, stream, registry, name)
      : handleLiveSSE(request, stream, request.server, registry, name);

    handler.catch(() => {
      if (!stream.writableEnded) {
        stream.end();
      }
    });

    return response;
  };
}

async function handleLiveSSE(
  request: Request,
  stream: PassThrough,
  server: Server,
  registry: QueueRegistry,
  name: string,
): Promise<void> {
  const connection = registry.getConnection();
  const prefix = registry.getPrefix();

  if (!connection) {
    writeSSE(stream, 'error', JSON.stringify({ message: 'No connection configured' }), '0');
    stream.end();
    return;
  }

  const subscriptions = getSubscriptions(server);
  const queueEvents = acquireQueueEvents(subscriptions, name, connection, prefix);
  let eventId = 0;
  let running = true;
  const ac = new AbortController();

  const eventTypes = ['completed', 'failed', 'progress', 'stalled', 'active', 'waiting'];
  const listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  for (const eventType of eventTypes) {
    const handler = (args: any) => {
      if (!running) return;
      writeSSE(stream, eventType, JSON.stringify({ ...args, queue: name }), String(eventId++));
    };
    queueEvents.on(eventType, handler);
    listeners.push({ event: eventType, handler });
  }

  request.raw.req.on('close', () => {
    running = false;
    ac.abort();
  });

  try {
    while (running) {
      if (!writeSSE(stream, 'heartbeat', JSON.stringify({ time: Date.now() }), String(eventId++))) {
        break;
      }
      await cancellableSleep(15_000, ac.signal);
    }
  } finally {
    for (const { event, handler } of listeners) {
      queueEvents.removeListener(event, handler);
    }
    releaseQueueEvents(subscriptions, name);
    if (!stream.writableEnded) {
      stream.end();
    }
  }
}

async function handleTestingSSE(
  request: Request,
  stream: PassThrough,
  registry: QueueRegistry,
  name: string,
): Promise<void> {
  let eventId = 0;
  const { queue } = registry.get(name);
  let lastCounts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  let running = true;
  const ac = new AbortController();

  request.raw.req.on('close', () => {
    running = false;
    ac.abort();
  });

  while (running) {
    try {
      const counts = await queue.getJobCounts();
      if (!running) break;

      for (const [state, count] of Object.entries(counts) as [string, number][]) {
        const prev = (lastCounts as any)[state] ?? 0;
        if (count !== prev) {
          writeSSE(stream, 'counts', JSON.stringify({ queue: name, state, count, prev }), String(eventId++));
        }
      }
      lastCounts = counts;
    } catch {
      break;
    }
    await cancellableSleep(1_000, ac.signal);
  }

  if (!stream.writableEnded) {
    stream.end();
  }
}
