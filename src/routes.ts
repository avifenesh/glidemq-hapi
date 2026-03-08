import type { Plugin, Server, Request, ResponseToolkit } from '@hapi/hapi';
import type { GlideMQRoutesOptions, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import { buildSchemas, hasZod } from './schemas';
import { createEventsHandler } from './events';

const VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_JOB_TYPES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
const VALID_CLEAN_TYPES = ['completed', 'failed'] as const;
const VALID_METRICS_TYPES = ['completed', 'failed'] as const;
const VALID_SCHEDULER_NAME = /^[a-zA-Z0-9_:.-]{1,256}$/;

const ALLOWED_OPTS = [
  'delay', 'priority', 'attempts', 'timeout', 'removeOnComplete', 'removeOnFail',
  'jobId', 'lifo', 'deduplication', 'ordering', 'cost', 'backoff', 'parent', 'ttl',
];

const PRODUCER_ALLOWED_OPTS = [
  'delay', 'priority', 'attempts', 'timeout', 'removeOnComplete', 'removeOnFail',
];

function pickOpts(rawOpts: Record<string, unknown>): Record<string, unknown> {
  const safeOpts: Record<string, unknown> = {};
  for (const key of ALLOWED_OPTS) {
    if (key in rawOpts) safeOpts[key] = rawOpts[key];
  }
  return safeOpts;
}

export const glideMQRoutes: Plugin<GlideMQRoutesOptions> = {
  name: '@glidemq/hapi-routes',
  version: '0.1.0',
  dependencies: ['@glidemq/hapi'],
  register: async (server: Server, options: GlideMQRoutesOptions) => {
    const allowedQueues = options?.queues;
    const allowedProducers = options?.producers;
    const pfx = options?.prefix ?? '';
    const schemas = hasZod() ? buildSchemas() : null;

    function getRegistry(request: Request): QueueRegistry {
      return request.server.glidemq;
    }

    // Builds the set of route paths registered by this plugin for scoping extensions
    const glidemqPaths = new Set<string>();

    function isGlideMQRoute(request: Request): boolean {
      return glidemqPaths.has(request.route.path);
    }

    // Queue name validation + access control (scoped to glidemq routes only)
    server.ext('onPreHandler', async (request, h) => {
      if (!isGlideMQRoute(request)) return h.continue;

      const name = (request.params as any)?.name;
      if (!name) return h.continue;

      if (!VALID_QUEUE_NAME.test(name)) {
        return h.response({ error: 'Invalid queue name' }).code(400).takeover();
      }

      // Allow produce endpoint to pass through for producer-only names
      if (request.route.path === `${pfx}/{name}/produce`) {
        const registry = getRegistry(request);
        if ((allowedProducers && !allowedProducers.includes(name)) || !registry.hasProducer(name)) {
          return h.response({ error: 'Producer not found or not accessible' }).code(404).takeover();
        }
        return h.continue;
      }

      const registry = getRegistry(request);
      if ((allowedQueues && !allowedQueues.includes(name)) || !registry.has(name)) {
        return h.response({ error: 'Queue not found or not accessible' }).code(404).takeover();
      }

      return h.continue;
    });

    // Error handler (scoped to glidemq routes only)
    server.ext('onPreResponse', (request, h) => {
      if (!isGlideMQRoute(request)) return h.continue;

      const response = request.response;
      if (response instanceof Error && !('isBoom' in response && (response as any).isBoom)) {
        server.log(['error'], response);
        return h.response({ error: 'Internal server error' }).code(500).takeover();
      }
      return h.continue;
    });

    function registerRoute(config: Parameters<Server['route']>[0]) {
      const cfg = config as { path: string };
      glidemqPaths.add(cfg.path);
      server.route(config);
    }

    // POST /{name}/jobs - Add a job
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/jobs`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.addJobSchema.safeParse(request.payload);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { name: jobName, data, opts } = result.data;
          const job = await queue.add(jobName, data, opts as any);
          if (!job) return h.response({ error: 'Job deduplicated' }).code(409);
          return h.response(serializeJob(job)).code(201);
        }

        const body = request.payload as any;
        if (!body?.name || typeof body.name !== 'string') {
          return h.response({ error: 'Validation failed', details: ['name: Required'] }).code(400);
        }

        const rawOpts = body.opts ?? {};
        const safeOpts = pickOpts(rawOpts);
        const job = await queue.add(body.name, body.data ?? {}, safeOpts as any);
        if (!job) return h.response({ error: 'Job deduplicated' }).code(409);
        return h.response(serializeJob(job)).code(201);
      },
    });

    // POST /{name}/jobs/wait - Add a job and wait for result
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/jobs/wait`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.addAndWaitBodySchema.safeParse(request.payload);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { name: jobName, data, opts, waitTimeout } = result.data;
          const returnvalue = await (queue as any).addAndWait(jobName, data, opts as any, waitTimeout);
          return h.response({ returnvalue });
        }

        const body = request.payload as any;
        if (!body?.name || typeof body.name !== 'string') {
          return h.response({ error: 'Validation failed', details: ['name: Required'] }).code(400);
        }

        const waitTimeout = body.waitTimeout;
        if (waitTimeout !== undefined && (typeof waitTimeout !== 'number' || waitTimeout <= 0)) {
          return h.response({ error: 'Validation failed', details: ['waitTimeout must be a positive number'] }).code(400);
        }

        const rawOpts = body.opts ?? {};
        const safeOpts = pickOpts(rawOpts);
        const returnvalue = await (queue as any).addAndWait(body.name, body.data ?? {}, safeOpts as any, waitTimeout);
        return h.response({ returnvalue });
      },
    });

    // GET /{name}/jobs - List jobs
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/jobs`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.getJobsQuerySchema.safeParse(request.query);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { type, start, end, excludeData } = result.data;
          const jobs = excludeData
            ? await (queue as any).getJobs(type, start, end, { excludeData: true })
            : await queue.getJobs(type as any, start, end);
          return h.response(serializeJobs(jobs));
        }

        const query = request.query as Record<string, string>;
        const typeParam = (query.type ?? 'waiting') as string;
        if (!VALID_JOB_TYPES.includes(typeParam as any)) {
          return h
            .response({ error: 'Validation failed', details: [`type: must be one of ${VALID_JOB_TYPES.join(', ')}`] })
            .code(400);
        }

        const start = parseInt(query.start ?? '0', 10);
        const end = parseInt(query.end ?? '-1', 10);

        if (isNaN(start) || isNaN(end)) {
          return h.response({ error: 'Validation failed', details: ['start and end must be numbers'] }).code(400);
        }

        const excludeData = query.excludeData === 'true' || query.excludeData === '1';
        const jobs = excludeData
          ? await (queue as any).getJobs(typeParam, start, end, { excludeData: true })
          : await queue.getJobs(typeParam as any, start, end);
        return h.response(serializeJobs(jobs));
      },
    });

    // GET /{name}/jobs/{id} - Get a single job
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/jobs/{id}`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, id } = request.params as { name: string; id: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const job = await queue.getJob(id);
        if (!job) {
          return h.response({ error: 'Job not found' }).code(404);
        }
        return h.response(serializeJob(job));
      },
    });

    // POST /{name}/jobs/{id}/priority - Change job priority
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/jobs/{id}/priority`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, id } = request.params as { name: string; id: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const job = await queue.getJob(id);
        if (!job) {
          return h.response({ error: 'Job not found' }).code(404);
        }

        if (schemas) {
          const result = schemas.changePriorityBodySchema.safeParse(request.payload);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          await (job as any).changePriority(result.data.priority);
          return h.response({ ok: true });
        }

        const body = request.payload as any;
        const priority = body?.priority;
        if (priority === undefined || typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 2048) {
          return h.response({ error: 'Validation failed', details: ['priority must be an integer between 0 and 2048'] }).code(400);
        }

        await (job as any).changePriority(priority);
        return h.response({ ok: true });
      },
    });

    // POST /{name}/jobs/{id}/delay - Change job delay
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/jobs/{id}/delay`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, id } = request.params as { name: string; id: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const job = await queue.getJob(id);
        if (!job) {
          return h.response({ error: 'Job not found' }).code(404);
        }

        if (schemas) {
          const result = schemas.changeDelayBodySchema.safeParse(request.payload);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          await (job as any).changeDelay(result.data.delay);
          return h.response({ ok: true });
        }

        const body = request.payload as any;
        const delay = body?.delay;
        if (delay === undefined || typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
          return h.response({ error: 'Validation failed', details: ['delay must be a non-negative integer'] }).code(400);
        }

        await (job as any).changeDelay(delay);
        return h.response({ ok: true });
      },
    });

    // POST /{name}/jobs/{id}/promote - Promote a delayed job
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/jobs/{id}/promote`,
      options: {
        payload: { failAction: 'ignore' as const },
      },
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, id } = request.params as { name: string; id: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const job = await queue.getJob(id);
        if (!job) {
          return h.response({ error: 'Job not found' }).code(404);
        }

        await (job as any).promote();
        return h.response({ ok: true });
      },
    });

    // GET /{name}/counts - Get job counts
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/counts`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const counts = await queue.getJobCounts();
        return h.response(counts);
      },
    });

    // GET /{name}/metrics - Get queue metrics
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/metrics`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.metricsQuerySchema.safeParse(request.query);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { type, start, end } = result.data;
          const metrics = await (queue as any).getMetrics(type, { start, end });
          return h.response(metrics);
        }

        const query = request.query as Record<string, string>;
        const typeParam = query.type as string | undefined;
        if (!typeParam) {
          return h.response({ error: 'Validation failed', details: ['type: required (completed or failed)'] }).code(400);
        }
        if (!VALID_METRICS_TYPES.includes(typeParam as any)) {
          return h
            .response({ error: 'Validation failed', details: [`type: must be one of ${VALID_METRICS_TYPES.join(', ')}`] })
            .code(400);
        }

        const start = parseInt(query.start ?? '0', 10);
        const end = parseInt(query.end ?? '-1', 10);

        if (isNaN(start) || isNaN(end)) {
          return h.response({ error: 'Validation failed', details: ['start and end must be numbers'] }).code(400);
        }

        const metrics = await (queue as any).getMetrics(typeParam, { start, end });
        return h.response(metrics);
      },
    });

    // POST /{name}/pause - Pause queue
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/pause`,
      options: {
        payload: { failAction: 'ignore' as const },
      },
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        await queue.pause();
        return h.response().code(204);
      },
    });

    // POST /{name}/resume - Resume queue
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/resume`,
      options: {
        payload: { failAction: 'ignore' as const },
      },
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        await queue.resume();
        return h.response().code(204);
      },
    });

    // POST /{name}/drain - Drain queue
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/drain`,
      options: {
        payload: { failAction: 'ignore' as const },
      },
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        await queue.drain();
        return h.response().code(204);
      },
    });

    // POST /{name}/retry - Retry failed jobs
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/retry`,
      options: {
        payload: { failAction: 'ignore' as const },
      },
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.retryBodySchema.safeParse(request.payload ?? {});
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { count } = result.data;
          const retried = await queue.retryJobs(count != null ? { count } : undefined);
          return h.response({ retried });
        }

        let count: number | undefined;
        try {
          const body = request.payload as any;
          count = body?.count;
        } catch {
          // No body or invalid - retry all
        }

        if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
          return h.response({ error: 'Validation failed', details: ['count must be a positive integer'] }).code(400);
        }

        const retried = await queue.retryJobs(count != null ? { count } : undefined);
        return h.response({ retried });
      },
    });

    // DELETE /{name}/clean - Clean old jobs
    registerRoute({
      method: 'DELETE',
      path: `${pfx}/{name}/clean`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.cleanQuerySchema.safeParse(request.query);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { grace, limit, type } = result.data;
          const removed = await queue.clean(grace, limit, type as any);
          return h.response({ removed: removed.length });
        }

        const query = request.query as Record<string, string>;
        const typeParam = (query.type ?? 'completed') as string;
        if (!VALID_CLEAN_TYPES.includes(typeParam as any)) {
          return h
            .response({ error: 'Validation failed', details: [`type: must be one of ${VALID_CLEAN_TYPES.join(', ')}`] })
            .code(400);
        }

        const grace = parseInt(query.grace ?? '0', 10);
        const limit = parseInt(query.limit ?? '100', 10);

        if (isNaN(grace) || isNaN(limit) || grace < 0 || limit < 1) {
          return h.response({ error: 'Validation failed', details: ['grace must be >= 0 and limit must be >= 1'] }).code(400);
        }

        const removed = await queue.clean(grace, limit, typeParam as any);
        return h.response({ removed: removed.length });
      },
    });

    // GET /{name}/workers - List workers
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/workers`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const workers = await queue.getWorkers();
        return h.response(workers);
      },
    });

    // POST /{name}/produce - Add a job via Producer (lightweight, serverless)
    registerRoute({
      method: 'POST',
      path: `${pfx}/{name}/produce`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const producer = registry.getProducer(name);

        if (schemas) {
          const result = schemas.addJobSchema.safeParse(request.payload);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { name: jobName, data, opts } = result.data;
          const id = await producer.add(jobName, data, opts as any);
          if (!id) return h.response({ error: 'Job deduplicated' }).code(409);
          return h.response({ id }).code(201);
        }

        const body = request.payload as any;
        if (!body?.name || typeof body.name !== 'string') {
          return h.response({ error: 'Validation failed', details: ['name: Required'] }).code(400);
        }

        const rawOpts = body.opts ?? {};
        const safeOpts: Record<string, unknown> = {};
        for (const key of PRODUCER_ALLOWED_OPTS) {
          if (key in rawOpts) safeOpts[key] = rawOpts[key];
        }
        const id = await producer.add(body.name, body.data ?? {}, safeOpts as any);
        if (!id) return h.response({ error: 'Job deduplicated' }).code(409);
        return h.response({ id }).code(201);
      },
    });

    // --- Scheduler endpoints ---

    // GET /{name}/schedulers - List all schedulers
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/schedulers`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name } = request.params as { name: string };
        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const schedulers = await (queue as any).getRepeatableJobs();
        return h.response(schedulers);
      },
    });

    // GET /{name}/schedulers/{schedulerName} - Get one scheduler
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/schedulers/{schedulerName}`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, schedulerName } = request.params as { name: string; schedulerName: string };

        if (!VALID_SCHEDULER_NAME.test(schedulerName)) {
          return h.response({ error: 'Invalid scheduler name' }).code(400);
        }

        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        const scheduler = await (queue as any).getJobScheduler(schedulerName);
        if (!scheduler) {
          return h.response({ error: 'Scheduler not found' }).code(404);
        }
        return h.response(scheduler);
      },
    });

    // PUT /{name}/schedulers/{schedulerName} - Upsert a scheduler
    registerRoute({
      method: 'PUT',
      path: `${pfx}/{name}/schedulers/{schedulerName}`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, schedulerName } = request.params as { name: string; schedulerName: string };

        if (!VALID_SCHEDULER_NAME.test(schedulerName)) {
          return h.response({ error: 'Invalid scheduler name' }).code(400);
        }

        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        if (schemas) {
          const result = schemas.upsertSchedulerBodySchema.safeParse(request.payload);
          if (!result.success) {
            const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            return h.response({ error: 'Validation failed', details: issues }).code(400);
          }
          const { schedule, template } = result.data;
          const job = await (queue as any).upsertJobScheduler(schedulerName, schedule, template);
          return h.response(job ? serializeJob(job) : { ok: true });
        }

        const body = request.payload as any;
        if (!body?.schedule || typeof body.schedule !== 'object') {
          return h.response({ error: 'Validation failed', details: ['schedule: Required'] }).code(400);
        }

        const job = await (queue as any).upsertJobScheduler(schedulerName, body.schedule, body.template);
        return h.response(job ? serializeJob(job) : { ok: true });
      },
    });

    // DELETE /{name}/schedulers/{schedulerName} - Remove a scheduler
    registerRoute({
      method: 'DELETE',
      path: `${pfx}/{name}/schedulers/{schedulerName}`,
      handler: async (request: Request, h: ResponseToolkit) => {
        const { name, schedulerName } = request.params as { name: string; schedulerName: string };

        if (!VALID_SCHEDULER_NAME.test(schedulerName)) {
          return h.response({ error: 'Invalid scheduler name' }).code(400);
        }

        const registry = getRegistry(request);
        const { queue } = registry.get(name);

        await (queue as any).removeJobScheduler(schedulerName);
        return h.response().code(204);
      },
    });

    // GET /{name}/events - SSE stream
    const eventsHandler = createEventsHandler(server);
    registerRoute({
      method: 'GET',
      path: `${pfx}/{name}/events`,
      options: {
        timeout: { server: false, socket: false },
      },
      handler: eventsHandler,
    });
  },
};
