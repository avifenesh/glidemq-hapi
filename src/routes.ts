import type { Server, Request, ResponseToolkit } from '@hapi/hapi';
import Boom from '@hapi/boom';
import Joi from 'joi';
import type { GlideMQRoutesOptions, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import {
  queueNameParamSchema,
  jobIdParamSchema,
  schedulerParamSchema,
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

export function registerRoutes(server: Server, _registry: QueueRegistry, opts: GlideMQRoutesOptions): void {
  const allowedQueues = opts?.queues;
  const allowedProducers = opts?.producers;
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
}
