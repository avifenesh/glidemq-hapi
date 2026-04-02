import { PassThrough } from 'stream';
import type { Server, Request, ResponseToolkit } from '@hapi/hapi';
import Boom from '@hapi/boom';
import Joi from 'joi';
import type { GlideMQRoutesOptions, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import {
  queueNameParamSchema,
  jobIdParamSchema,
  schedulerParamSchema,
  flowIdParamSchema,
  jobStreamParamSchema,
  addJobSchema,
  addAndWaitBodySchema as addAndWaitSchema,
  getJobsQuerySchema,
  cleanQuerySchema,
  metricsQuerySchema,
  retryBodySchema,
  changePriorityBodySchema as changePrioritySchema,
  changeDelayBodySchema as changeDelaySchema,
  upsertSchedulerBodySchema as upsertSchedulerSchema,
} from './schemas';
import { createEventsHandler } from './events';

const failAction = (_request: Request, _h: ResponseToolkit, err?: Error) => {
  throw err;
};

const SSE_BLOCK_MS = 5_000;
const SSE_HEARTBEAT_MS = 15_000;

type BroadcastClient = {
  matcher: ((subject: string) => boolean) | null;
  stream: PassThrough;
};

type SharedBroadcastStream = {
  clients: Set<BroadcastClient>;
  closing: boolean;
  ready: Promise<void>;
  worker: { close: () => Promise<void> };
  close: () => Promise<void>;
};

type FlowKind = 'tree' | 'dag';

type FlowDefinition = {
  name: string;
  queueName: string;
  data: unknown;
  opts?: Record<string, unknown>;
  children?: FlowDefinition[];
};

type DagDefinition = {
  nodes: Array<{
    name: string;
    queueName: string;
    data: unknown;
    opts?: Record<string, unknown>;
    deps?: string[];
  }>;
};

type FlowJobRef = {
  jobId: string;
  queueName: string;
};

type FlowNodeSummary = ReturnType<typeof serializeJob> & {
  flowId: string;
  queueName: string;
  state: string;
  parentIds?: string[];
  parentQueues?: string[];
};

type FlowTreeNode = FlowNodeSummary & {
  children: FlowTreeNode[];
};

function parseCsvQuery(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseIntegerQuery(raw: string | undefined, name: string, opts?: { min?: number }): number | undefined {
  if (raw == null) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw Boom.badRequest(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw Boom.badRequest(`${name} must be an integer`);
  }
  if (opts?.min != null && value < opts.min) {
    throw Boom.badRequest(`${name} must be >= ${opts.min}`);
  }
  return value;
}

function writeSSEChunk(stream: PassThrough, event: string, data: string, id?: string): boolean {
  try {
    if (stream.destroyed || stream.writableEnded) return false;
    if (id != null) stream.write(`id: ${id}\n`);
    stream.write(`event: ${event}\n`);
    stream.write(`data: ${data}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function flowMetaKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:meta`;
}

function flowJobsKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:jobs`;
}

function flowRootsKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:roots`;
}

function encodeFlowJobRef(ref: FlowJobRef): string {
  return `${ref.queueName}:${ref.jobId}`;
}

function decodeFlowJobRef(raw: string): FlowJobRef | null {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { queueName: raw.slice(0, separator), jobId: raw.slice(separator + 1) };
}

function hashEntriesToRecord(hashData: any): Record<string, string> | null {
  if (!Array.isArray(hashData) || hashData.length === 0) return null;
  const record: Record<string, string> = Object.create(null);
  for (const entry of hashData) {
    const key = entry?.field ?? entry?.key;
    if (key == null) continue;
    record[String(key)] = String(entry.value);
  }
  return Object.keys(record).length > 0 ? record : null;
}

function collectFlowQueueNames(flow: FlowDefinition, acc: Set<string> = new Set()): Set<string> {
  acc.add(flow.queueName);
  for (const child of flow.children ?? []) {
    collectFlowQueueNames(child, acc);
  }
  return acc;
}

function collectDagQueueNames(dag: DagDefinition): Set<string> {
  const names = new Set<string>();
  for (const node of dag.nodes) {
    names.add(node.queueName);
  }
  return names;
}

function buildFlowTreeNodes(flowId: string, roots: FlowJobRef[], nodes: FlowNodeSummary[]): FlowTreeNode[] {
  const nodeMap = new Map<string, FlowNodeSummary>();
  const childrenByParent = new Map<string, FlowNodeSummary[]>();

  for (const node of nodes) {
    nodeMap.set(encodeFlowJobRef({ jobId: node.id, queueName: node.queueName }), node);

    const parentRefs: FlowJobRef[] = [];
    if (node.parentIds && node.parentQueues && node.parentIds.length === node.parentQueues.length) {
      for (let i = 0; i < node.parentIds.length; i++) {
        parentRefs.push({ jobId: node.parentIds[i], queueName: node.parentQueues[i] });
      }
    } else if (node.parentId) {
      parentRefs.push({ jobId: node.parentId, queueName: node.queueName });
    }

    for (const parentRef of parentRefs) {
      const key = encodeFlowJobRef(parentRef);
      const siblings = childrenByParent.get(key);
      if (siblings) siblings.push(node);
      else childrenByParent.set(key, [node]);
    }
  }

  function visit(ref: FlowJobRef, path: Set<string>): FlowTreeNode {
    const key = encodeFlowJobRef(ref);
    const node = nodeMap.get(key);
    if (!node) {
      return {
        attemptsMade: 0,
        children: [],
        data: null,
        failedReason: undefined,
        finishedOn: undefined,
        flowId,
        id: ref.jobId,
        name: '',
        opts: {},
        parentId: undefined,
        parentIds: undefined,
        parentQueue: undefined,
        parentQueues: undefined,
        processedOn: undefined,
        progress: 0,
        queueName: ref.queueName,
        returnvalue: undefined,
        state: 'missing',
        timestamp: 0,
      };
    }

    const children = (childrenByParent.get(key) ?? [])
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp || a.queueName.localeCompare(b.queueName) || a.id.localeCompare(b.id))
      .map((child) => {
        const childKey = encodeFlowJobRef({ jobId: child.id, queueName: child.queueName });
        if (path.has(childKey)) {
          return { ...child, children: [] };
        }
        const nextPath = new Set(path);
        nextPath.add(childKey);
        return visit({ jobId: child.id, queueName: child.queueName }, nextPath);
      });

    return { ...node, children };
  }

  return roots
    .slice()
    .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
    .map((root) => visit(root, new Set([encodeFlowJobRef(root)])));
}

export function registerRoutes(server: Server, _registry: QueueRegistry, opts: GlideMQRoutesOptions): void {
  const allowedQueues = opts?.queues;
  const allowedProducers = opts?.producers;
  const broadcastStreams = new Map<string, SharedBroadcastStream>();

  function requireQueue(request: Request): { name: string; registry: QueueRegistry } {
    const { name } = request.params as { name: string };
    const registry = request.glidemq;
    if (allowedQueues && !allowedQueues.includes(name)) throw Boom.notFound('Queue not found');
    if (!registry.has(name)) throw Boom.notFound('Queue not found');
    return { name, registry };
  }

  function requireProducer(request: Request): { name: string; registry: QueueRegistry } {
    const { name } = request.params as { name: string };
    const registry = request.glidemq;
    if (allowedProducers && !allowedProducers.includes(name)) throw Boom.notFound('Producer not found');
    if (!registry.hasProducer(name)) throw Boom.notFound('Producer not found');
    return { name, registry };
  }

  function requireBroadcast(request: Request): { name: string; registry: QueueRegistry } {
    const { name } = request.params as { name: string };
    const registry = request.glidemq;
    if (allowedQueues && !allowedQueues.includes(name)) throw Boom.notFound('Queue not found');
    return { name, registry };
  }

  function getLiveConnection(registry: QueueRegistry, feature: string) {
    const connection = registry.getConnection();
    if (!connection) {
      throw Boom.badImplementation(`Connection config required for ${feature}`);
    }
    return connection;
  }

  function getFlowClientQueueNames(registry: QueueRegistry): string[] {
    const names = allowedQueues ?? registry.names();
    return names.filter((name) => registry.has(name));
  }

  async function getFlowClient(registry: QueueRegistry): Promise<any> {
    const queueNames = getFlowClientQueueNames(registry);
    if (queueNames.length === 0) {
      throw Boom.badImplementation('Flow HTTP endpoints require at least one configured queue');
    }
    const { queue } = registry.get(queueNames[0]);
    const client = await (queue as any).getClient?.();
    if (!client) {
      throw Boom.badImplementation('Connection config required for flow HTTP endpoints');
    }
    return client;
  }

  function assertAllowedFlowQueues(registry: QueueRegistry, queueNames: Iterable<string>): void {
    for (const queueName of queueNames) {
      if (queueNameParamSchema.validate(queueName).error) {
        throw Boom.badRequest('Invalid queue name');
      }
      if ((allowedQueues && !allowedQueues.includes(queueName)) || !registry.has(queueName)) {
        throw Boom.notFound('Queue not found');
      }
    }
  }

  async function registerFlowRecord(
    registry: QueueRegistry,
    flowId: string,
    kind: FlowKind,
    roots: FlowJobRef[],
    jobs: FlowJobRef[],
  ): Promise<void> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    await client.hset(flowMetaKey(flowId, prefix), { createdAt: Date.now().toString(), kind });
    await client.del([flowJobsKey(flowId, prefix), flowRootsKey(flowId, prefix)]);

    if (jobs.length > 0) {
      await client.sadd(
        flowJobsKey(flowId, prefix),
        jobs
          .slice()
          .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
          .map(encodeFlowJobRef),
      );
      for (const ref of jobs) {
        const { queue } = registry.get(ref.queueName);
        await client.hset((queue as any).keys.job(ref.jobId), { flowId });
      }
    }

    if (roots.length > 0) {
      await client.sadd(
        flowRootsKey(flowId, prefix),
        roots
          .slice()
          .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
          .map(encodeFlowJobRef),
      );
    }
  }

  async function loadFlowRecord(
    registry: QueueRegistry,
    flowId: string,
  ): Promise<{ createdAt: number; kind: FlowKind; jobs: FlowJobRef[]; roots: FlowJobRef[] } | null> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    const meta = hashEntriesToRecord(await client.hgetall(flowMetaKey(flowId, prefix)));
    if (!meta?.kind) return null;

    const jobs = Array.from((await client.smembers(flowJobsKey(flowId, prefix))) ?? [])
      .map((entry) => decodeFlowJobRef(String(entry)))
      .filter((entry): entry is FlowJobRef => entry !== null);
    const roots = Array.from((await client.smembers(flowRootsKey(flowId, prefix))) ?? [])
      .map((entry) => decodeFlowJobRef(String(entry)))
      .filter((entry): entry is FlowJobRef => entry !== null);

    return {
      createdAt: Number(meta.createdAt || '0'),
      kind: meta.kind === 'dag' ? 'dag' : 'tree',
      jobs,
      roots,
    };
  }

  async function deleteFlowRecord(registry: QueueRegistry, flowId: string): Promise<void> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    await client.del([flowMetaKey(flowId, prefix), flowJobsKey(flowId, prefix), flowRootsKey(flowId, prefix)]);
  }

  async function buildFlowSnapshot(registry: QueueRegistry, flowId: string) {
    const record = await loadFlowRecord(registry, flowId);
    if (!record) return null;
    assertAllowedFlowQueues(registry, record.jobs.map((job) => job.queueName));

    const nodes: FlowNodeSummary[] = [];
    const counts: Record<string, number> = Object.create(null);
    for (const ref of record.jobs) {
      const { queue } = registry.get(ref.queueName);
      const job = await queue.getJob(ref.jobId);
      if (!job) continue;
      const state = await (job as any).getState();
      counts[state] = (counts[state] || 0) + 1;
      nodes.push({
        ...serializeJob(job),
        flowId,
        parentIds: (job as any).parentIds,
        parentQueues: (job as any).parentQueues,
        queueName: ref.queueName,
        state,
      });
    }

    let usage: unknown = null;
    let budget: unknown = null;
    if (record.roots.length === 1) {
      const root = record.roots[0];
      const { queue } = registry.get(root.queueName);
      try {
        usage = await (queue as any).getFlowUsage(root.jobId);
      } catch {
        usage = null;
      }
      try {
        budget = await (queue as any).getFlowBudget(root.jobId);
      } catch {
        budget = null;
      }
    }

    return {
      budget,
      counts,
      createdAt: record.createdAt,
      flowId,
      kind: record.kind,
      nodes: nodes.sort((a, b) => a.timestamp - b.timestamp || a.queueName.localeCompare(b.queueName) || a.id.localeCompare(b.id)),
      roots: record.roots.slice().sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId)),
      tree: buildFlowTreeNodes(flowId, record.roots, nodes),
      usage,
    };
  }

  function removeBroadcastClient(shared: SharedBroadcastStream, client: BroadcastClient): void {
    if (!shared.clients.delete(client)) return;
    try {
      if (!client.stream.writableEnded) {
        client.stream.end();
      }
    } catch {
      // ignore
    }
    if (shared.clients.size === 0) {
      void shared.close();
    }
  }

  async function getSharedBroadcastStream(name: string, subscription: string, registry: QueueRegistry): Promise<SharedBroadcastStream> {
    const prefix = registry.getPrefix();
    const cacheKey = `${prefix ?? ''}\u0000${name}\u0000${subscription}`;
    const cached = broadcastStreams.get(cacheKey);
    if (cached) {
      await cached.ready;
      return cached;
    }

    const connection = getLiveConnection(registry, 'broadcast SSE');
    const { BroadcastWorker } = require('glide-mq') as typeof import('glide-mq');
    const clients = new Set<BroadcastClient>();

    const shared: SharedBroadcastStream = {
      clients,
      closing: false,
      ready: Promise.resolve(),
      worker: null as unknown as { close: () => Promise<void> },
      close: async () => {
        if (shared.closing) return;
        shared.closing = true;
        broadcastStreams.delete(cacheKey);
        for (const client of Array.from(clients)) {
          try {
            if (!client.stream.writableEnded) {
              client.stream.end();
            }
          } catch {
            // ignore
          }
        }
        clients.clear();
        await shared.worker.close();
      },
    };

    const worker = new BroadcastWorker(
      name,
      async (job: any) => {
        const payload = JSON.stringify({
          data: job.data,
          id: job.id,
          subject: job.name,
          timestamp: job.timestamp,
        });
        for (const client of Array.from(shared.clients)) {
          if (client.matcher && !client.matcher(job.name)) continue;
          if (!writeSSEChunk(client.stream, 'message', payload, job.id)) {
            removeBroadcastClient(shared, client);
          }
        }
      },
      {
        blockTimeout: SSE_BLOCK_MS,
        connection,
        prefix,
        subscription,
      },
    );

    shared.worker = worker;
    shared.ready = worker.waitUntilReady();
    broadcastStreams.set(cacheKey, shared);

    try {
      await shared.ready;
      return shared;
    } catch (error) {
      broadcastStreams.delete(cacheKey);
      await worker.close().catch(() => undefined);
      throw error;
    }
  }

  server.ext({
    type: 'onPostStop',
    method: async () => {
      for (const shared of Array.from(broadcastStreams.values())) {
        await shared.close().catch(() => undefined);
      }
      broadcastStreams.clear();
    },
  });

  server.route({
    method: 'GET',
    path: '/usage/summary',
    handler: async (request: Request, h: ResponseToolkit) => {
      const registry = request.glidemq;
      const query = request.query as {
        queues?: string;
        start?: string;
        end?: string;
        window?: string;
        windowMs?: string;
      };

      const requestedQueues = parseCsvQuery(query.queues);
      if (requestedQueues) {
        for (const queueName of requestedQueues) {
          const { error } = queueNameParamSchema.validate({ name: queueName });
          if (error) throw Boom.badRequest('Invalid queue name');
          if (allowedQueues && !allowedQueues.includes(queueName)) throw Boom.notFound('Queue not found');
        }
      }

      if (query.window && query.windowMs && query.window !== query.windowMs) {
        throw Boom.badRequest('window and windowMs must match when both are provided');
      }

      const { Queue } = require('glide-mq') as typeof import('glide-mq');
      const summary = await (Queue as any).getUsageSummary({
        connection: getLiveConnection(registry, 'usage summary'),
        endTime: parseIntegerQuery(query.end, 'end', { min: 0 }),
        prefix: registry.getPrefix(),
        queues: requestedQueues ?? allowedQueues,
        startTime: parseIntegerQuery(query.start, 'start', { min: 0 }),
        windowMs: parseIntegerQuery(query.windowMs ?? query.window, query.windowMs ? 'windowMs' : 'window', { min: 1 }),
      });

      return h.response(summary);
    },
  });

  // POST /{name}/jobs - Add a job
  server.route({
    method: 'POST',
    path: '/{name}/jobs',
    options: {
      validate: {
        params: queueNameParamSchema,
        payload: addJobSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { name: jobName, data, opts: jobOpts } = request.payload as {
        name: string;
        data: unknown;
        opts: Record<string, unknown>;
      };

      const job = await queue.add(jobName, data, jobOpts as any);
      if (!job) throw Boom.conflict('Job deduplicated');
      return h.response(serializeJob(job)).code(201);
    },
  });

  // POST /{name}/jobs/wait - Add a job and wait for result
  server.route({
    method: 'POST',
    path: '/{name}/jobs/wait',
    options: {
      validate: {
        params: queueNameParamSchema,
        payload: addAndWaitSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { name: jobName, data, opts: jobOpts, waitTimeout } = request.payload as {
        name: string;
        data: unknown;
        opts: Record<string, unknown>;
        waitTimeout?: number;
      };

      const returnvalue = await (queue as any).addAndWait(jobName, data, jobOpts as any, waitTimeout);
      return h.response({ returnvalue });
    },
  });

  // GET /{name}/jobs - List jobs
  server.route({
    method: 'GET',
    path: '/{name}/jobs',
    options: {
      validate: {
        params: queueNameParamSchema,
        query: getJobsQuerySchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { type, start, end, excludeData } = request.query as unknown as {
        type: string;
        start: number;
        end: number;
        excludeData: boolean;
      };

      const jobs = excludeData
        ? await (queue as any).getJobs(type, start, end, { excludeData: true })
        : await queue.getJobs(type as any, start, end);
      return h.response(serializeJobs(jobs));
    },
  });

  // GET /{name}/jobs/{id} - Get a single job
  server.route({
    method: 'GET',
    path: '/{name}/jobs/{id}',
    options: {
      validate: {
        params: jobIdParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const job = await queue.getJob(id);
      if (!job) throw Boom.notFound('Job not found');
      return h.response(serializeJob(job));
    },
  });

  // POST /{name}/jobs/{id}/priority - Change job priority
  server.route({
    method: 'POST',
    path: '/{name}/jobs/{id}/priority',
    options: {
      validate: {
        params: jobIdParamSchema,
        payload: changePrioritySchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const job = await queue.getJob(id);
      if (!job) throw Boom.notFound('Job not found');

      const { priority } = request.payload as { priority: number };
      await (job as any).changePriority(priority);
      return h.response({ ok: true });
    },
  });

  // POST /{name}/jobs/{id}/delay - Change job delay
  server.route({
    method: 'POST',
    path: '/{name}/jobs/{id}/delay',
    options: {
      validate: {
        params: jobIdParamSchema,
        payload: changeDelaySchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const job = await queue.getJob(id);
      if (!job) throw Boom.notFound('Job not found');

      const { delay } = request.payload as { delay: number };
      await (job as any).changeDelay(delay);
      return h.response({ ok: true });
    },
  });

  // POST /{name}/jobs/{id}/promote - Promote a delayed job
  server.route({
    method: 'POST',
    path: '/{name}/jobs/{id}/promote',
    options: {
      validate: {
        params: jobIdParamSchema,
        failAction,
      },
      payload: { failAction: 'ignore' as const },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const job = await queue.getJob(id);
      if (!job) throw Boom.notFound('Job not found');

      await (job as any).promote();
      return h.response({ ok: true });
    },
  });

  // GET /{name}/counts - Get job counts
  server.route({
    method: 'GET',
    path: '/{name}/counts',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);

      const counts = await queue.getJobCounts();
      return h.response(counts);
    },
  });

  // GET /{name}/metrics - Get queue metrics
  server.route({
    method: 'GET',
    path: '/{name}/metrics',
    options: {
      validate: {
        params: queueNameParamSchema,
        query: metricsQuerySchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { type, start, end } = request.query as unknown as { type: string; start: number; end: number };

      const metrics = await (queue as any).getMetrics(type, { start, end });
      return h.response(metrics);
    },
  });

  // POST /{name}/pause - Pause queue
  server.route({
    method: 'POST',
    path: '/{name}/pause',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
      payload: { failAction: 'ignore' as const },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);

      await queue.pause();
      return h.response().code(204);
    },
  });

  // POST /{name}/resume - Resume queue
  server.route({
    method: 'POST',
    path: '/{name}/resume',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
      payload: { failAction: 'ignore' as const },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);

      await queue.resume();
      return h.response().code(204);
    },
  });

  // POST /{name}/drain - Drain queue
  server.route({
    method: 'POST',
    path: '/{name}/drain',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
      payload: { failAction: 'ignore' as const },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);

      await queue.drain();
      return h.response().code(204);
    },
  });

  // POST /{name}/retry - Retry failed jobs
  server.route({
    method: 'POST',
    path: '/{name}/retry',
    options: {
      validate: {
        params: queueNameParamSchema,
        payload: Joi.alternatives().try(retryBodySchema, Joi.any().valid(null)),
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { count } = (request.payload ?? {}) as { count?: number };

      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return h.response({ retried });
    },
  });

  // DELETE /{name}/clean - Clean old jobs
  server.route({
    method: 'DELETE',
    path: '/{name}/clean',
    options: {
      validate: {
        params: queueNameParamSchema,
        query: cleanQuerySchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { grace, limit, type } = request.query as unknown as { grace: number; limit: number; type: string };

      const removed = await queue.clean(grace, limit, type as any);
      return h.response({ removed: removed.length });
    },
  });

  // GET /{name}/workers - List workers
  server.route({
    method: 'GET',
    path: '/{name}/workers',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);

      const workers = await queue.getWorkers();
      return h.response(workers);
    },
  });

  // POST /{name}/produce - Add a job via Producer (lightweight, serverless)
  server.route({
    method: 'POST',
    path: '/{name}/produce',
    options: {
      validate: {
        params: queueNameParamSchema,
        payload: addJobSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireProducer(request);
      const producer = registry.getProducer(name);
      const { name: jobName, data, opts: jobOpts } = request.payload as {
        name: string;
        data: unknown;
        opts: Record<string, unknown>;
      };

      const id = await producer.add(jobName, data, jobOpts as any);
      if (!id) throw Boom.conflict('Job deduplicated');
      return h.response({ id }).code(201);
    },
  });

  // --- Scheduler endpoints ---

  // GET /{name}/schedulers - List all schedulers
  server.route({
    method: 'GET',
    path: '/{name}/schedulers',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);

      const schedulers = await (queue as any).getRepeatableJobs();
      return h.response(schedulers);
    },
  });

  // GET /{name}/schedulers/{schedulerName} - Get one scheduler
  server.route({
    method: 'GET',
    path: '/{name}/schedulers/{schedulerName}',
    options: {
      validate: {
        params: schedulerParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { schedulerName } = request.params as { name: string; schedulerName: string };

      const scheduler = await (queue as any).getJobScheduler(schedulerName);
      if (!scheduler) throw Boom.notFound('Scheduler not found');
      return h.response(scheduler);
    },
  });

  // PUT /{name}/schedulers/{schedulerName} - Upsert a scheduler
  server.route({
    method: 'PUT',
    path: '/{name}/schedulers/{schedulerName}',
    options: {
      validate: {
        params: schedulerParamSchema,
        payload: upsertSchedulerSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { schedulerName } = request.params as { name: string; schedulerName: string };
      const { schedule, template } = request.payload as {
        schedule: Record<string, unknown>;
        template?: Record<string, unknown>;
      };

      const job = await (queue as any).upsertJobScheduler(schedulerName, schedule, template);
      return h.response(job ? serializeJob(job) : { ok: true });
    },
  });

  // DELETE /{name}/schedulers/{schedulerName} - Remove a scheduler
  server.route({
    method: 'DELETE',
    path: '/{name}/schedulers/{schedulerName}',
    options: {
      validate: {
        params: schedulerParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { schedulerName } = request.params as { name: string; schedulerName: string };

      await (queue as any).removeJobScheduler(schedulerName);
      return h.response().code(204);
    },
  });

  // --- AI-native endpoints ---

  server.route({
    method: 'POST',
    path: '/flows',
    handler: async (request: Request, h: ResponseToolkit) => {
      const registry = request.glidemq;
      const body = (request.payload ?? {}) as { budget?: Record<string, unknown>; dag?: DagDefinition; flow?: FlowDefinition };

      if ((!!body.flow && !!body.dag) || (!body.flow && !body.dag)) {
        return h.response({ error: 'Body must include exactly one of: flow, dag' }).code(400);
      }

      const connection = getLiveConnection(registry, 'flow HTTP endpoints');

      const { FlowProducer } = require('glide-mq') as typeof import('glide-mq');
      const producer = new FlowProducer({ connection, prefix: registry.getPrefix() });

      try {
        if (body.flow) {
          const queueNames = collectFlowQueueNames(body.flow);
          assertAllowedFlowQueues(registry, queueNames);
          const node = await (producer as any).add(body.flow as any, body.budget ? { budget: body.budget as any } : undefined);
          const refs: FlowJobRef[] = [];

          const collectRefs = (flowDef: FlowDefinition, jobNode: any) => {
            refs.push({ jobId: jobNode.job.id, queueName: flowDef.queueName });
            if (!flowDef.children || !jobNode.children) return;
            for (let i = 0; i < flowDef.children.length && i < jobNode.children.length; i++) {
              collectRefs(flowDef.children[i], jobNode.children[i]);
            }
          };

          collectRefs(body.flow, node);
          const root = { jobId: node.job.id, queueName: body.flow.queueName };
          await registerFlowRecord(registry, node.job.id, 'tree', [root], refs);
          return h.response({ flowId: node.job.id, kind: 'tree', nodeCount: refs.length, root, roots: [root] }).code(201);
        }

        if (body.budget) {
          return h.response({ error: 'budget is currently supported only for tree flows' }).code(400);
        }

        const dag = body.dag!;
        const queueNames = collectDagQueueNames(dag);
        assertAllowedFlowQueues(registry, queueNames);
        const jobs = await producer.addDAG(dag as any);
        const flowId = `dag-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const refs = dag.nodes.map((dagNode) => {
          const job = jobs.get(dagNode.name);
          if (!job) throw Boom.badImplementation(`Missing DAG job for node ${dagNode.name}`);
          return { jobId: job.id, queueName: dagNode.queueName };
        });
        const roots = dag.nodes
          .filter((dagNode) => !dagNode.deps || dagNode.deps.length === 0)
          .map((dagNode) => ({ jobId: jobs.get(dagNode.name)!.id, queueName: dagNode.queueName }));
        await registerFlowRecord(registry, flowId, 'dag', roots, refs);
        return h
          .response({
            flowId,
            jobs: dag.nodes.map((dagNode) => ({
              id: jobs.get(dagNode.name)!.id,
              name: dagNode.name,
              queueName: dagNode.queueName,
            })),
            kind: 'dag',
            nodeCount: refs.length,
            roots,
          })
          .code(201);
      } finally {
        await producer.close().catch(() => undefined);
      }
    },
  });

  server.route({
    method: 'GET',
    path: '/flows/{id}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const snapshot = await buildFlowSnapshot(request.glidemq, (request.params as { id: string }).id);
      if (!snapshot) throw Boom.notFound('Flow not found');
      return h.response(snapshot);
    },
  });

  server.route({
    method: 'GET',
    path: '/flows/{id}/tree',
    handler: async (request: Request, h: ResponseToolkit) => {
      const snapshot = await buildFlowSnapshot(request.glidemq, (request.params as { id: string }).id);
      if (!snapshot) throw Boom.notFound('Flow not found');
      return h.response({
        budget: snapshot.budget,
        counts: snapshot.counts,
        createdAt: snapshot.createdAt,
        flowId: snapshot.flowId,
        kind: snapshot.kind,
        roots: snapshot.roots,
        tree: snapshot.tree,
        usage: snapshot.usage,
      });
    },
  });

  server.route({
    method: 'DELETE',
    path: '/flows/{id}',
    handler: async (request: Request, h: ResponseToolkit) => {
      const registry = request.glidemq;
      const flowId = (request.params as { id: string }).id;
      const record = await loadFlowRecord(registry, flowId);
      if (!record) throw Boom.notFound('Flow not found');
      assertAllowedFlowQueues(registry, record.jobs.map((job) => job.queueName));

      let revoked = 0;
      let flagged = 0;
      let skipped = 0;
      const jobs: Array<{ id: string; queueName: string; state?: string; status: string }> = [];

      for (const ref of record.jobs) {
        const { queue } = registry.get(ref.queueName);
        const job = await queue.getJob(ref.jobId);
        if (!job) {
          skipped += 1;
          jobs.push({ id: ref.jobId, queueName: ref.queueName, status: 'missing' });
          continue;
        }
        const state = await (job as any).getState();
        if (state === 'completed' || state === 'failed') {
          skipped += 1;
          jobs.push({ id: ref.jobId, queueName: ref.queueName, state, status: 'skipped' });
          continue;
        }
        const status = await (queue as any).revoke(ref.jobId);
        if (status === 'revoked') revoked += 1;
        else if (status === 'flagged') flagged += 1;
        else skipped += 1;
        jobs.push({ id: ref.jobId, queueName: ref.queueName, state, status });
      }

      await deleteFlowRecord(registry, flowId);
      return h.response({ flagged, flowId, jobs, revoked, skipped });
    },
  });

  // GET /{name}/flows/{id}/usage - Get aggregated token/cost usage for a flow
  server.route({
    method: 'GET',
    path: '/{name}/flows/{id}/usage',
    options: {
      validate: {
        params: flowIdParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const usage = await (queue as any).getFlowUsage(id);
      if (!usage) throw Boom.notFound('Flow not found');
      return h.response(usage);
    },
  });

  // GET /{name}/flows/{id}/budget - Get budget status for a flow
  server.route({
    method: 'GET',
    path: '/{name}/flows/{id}/budget',
    options: {
      validate: {
        params: flowIdParamSchema,
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const budget = await (queue as any).getFlowBudget(id);
      if (!budget) throw Boom.notFound('Flow not found');
      return h.response(budget);
    },
  });

  // GET /{name}/jobs/{id}/stream - SSE stream for a single job's output chunks
  server.route({
    method: 'GET',
    path: '/{name}/jobs/{id}/stream',
    options: {
      validate: {
        params: jobStreamParamSchema,
        failAction,
      },
      timeout: { server: false, socket: false },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireQueue(request);
      const { queue } = registry.get(name);
      const { id } = request.params as { name: string; id: string };

      const stream = new PassThrough();
      const response = h
        .response(stream)
        .type('text/event-stream')
        .header('Cache-Control', 'no-cache');

      stream.write(':ok\n\n');

      let lastId = (request.headers['last-event-id'] as string)
        || (request.query as any).lastId as string
        || undefined;
      let running = true;

      request.raw.req.on('close', () => {
        running = false;
      });

      (async () => {
        try {
          while (running) {
            const entries = await (queue as any).readStream(id, { lastId, count: 100 });
            for (const entry of entries) {
              stream.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.fields)}\n\n`);
              lastId = entry.id;
            }

            const job = await queue.getJob(id);
            if (!job) break;
            const state = await (job as any).getState();
            if (state === 'completed' || state === 'failed') {
              const trailing = await (queue as any).readStream(id, { lastId, count: 100 });
              for (const entry of trailing) {
                stream.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.fields)}\n\n`);
              }
              break;
            }

            await new Promise<void>((r) => setTimeout(r, 500));
          }
        } catch {
          // Connection lost or queue error - end gracefully
        } finally {
          if (!stream.writableEnded) {
            stream.end();
          }
        }
      })();

      return response;
    },
  });

  // GET /{name}/events - SSE stream
  const eventsHandler = createEventsHandler(server);
  server.route({
    method: 'GET',
    path: '/{name}/events',
    options: {
      validate: {
        params: queueNameParamSchema,
        failAction,
      },
      timeout: { server: false, socket: false },
    },
    handler: eventsHandler,
  });

  server.route({
    method: 'POST',
    path: '/broadcast/{name}',
    options: {
      validate: {
        params: queueNameParamSchema,
        payload: Joi.object({
          subject: Joi.string().trim().min(1).required(),
          data: Joi.any(),
          opts: Joi.object().unknown(true),
        }),
        failAction,
      },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireBroadcast(request);
      const { Broadcast } = require('glide-mq') as typeof import('glide-mq');
      const { subject, data, opts: jobOpts } = request.payload as {
        subject: string;
        data?: unknown;
        opts?: Record<string, unknown>;
      };

      const broadcast = new Broadcast(name, {
        connection: getLiveConnection(registry, 'broadcast publish'),
        prefix: registry.getPrefix(),
      });

      try {
        const id = await broadcast.publish(subject, data ?? null, jobOpts as any);
        return h.response(id ? { id, subject } : { skipped: true }).code(id ? 201 : 200);
      } finally {
        await broadcast.close().catch(() => undefined);
      }
    },
  });

  server.route({
    method: 'GET',
    path: '/broadcast/{name}/events',
    options: {
      validate: {
        params: queueNameParamSchema,
        query: Joi.object({
          subscription: Joi.string().trim().min(1).required(),
          subjects: Joi.string().optional(),
        }),
        failAction,
      },
      timeout: { server: false, socket: false },
    },
    handler: async (request: Request, h: ResponseToolkit) => {
      const { name, registry } = requireBroadcast(request);
      const { subscription, subjects } = request.query as { subscription: string; subjects?: string };
      const { compileSubjectMatcher } = require('glide-mq') as typeof import('glide-mq');
      const shared = await getSharedBroadcastStream(name, subscription, registry);
      const stream = new PassThrough();
      const client: BroadcastClient = {
        matcher: compileSubjectMatcher(parseCsvQuery(subjects)),
        stream,
      };

      const response = h
        .response(stream)
        .type('text/event-stream')
        .header('Cache-Control', 'no-cache');

      stream.write(':ok\n\n');
      shared.clients.add(client);

      request.raw.req.on('close', () => {
        removeBroadcastClient(shared, client);
      });

      (async () => {
        try {
          while (!stream.writableEnded) {
            if (!writeSSEChunk(stream, 'heartbeat', JSON.stringify({ time: Date.now() }))) {
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, SSE_HEARTBEAT_MS));
          }
        } finally {
          removeBroadcastClient(shared, client);
        }
      })().catch(() => {
        removeBroadcastClient(shared, client);
      });

      return response;
    },
  });
}
