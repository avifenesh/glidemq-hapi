import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp } from './helpers/test-app';

describe('glideMQRoutes', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function setup(queues?: Record<string, any>) {
    const { server, registry } = await buildTestApp(
      queues ?? {
        emails: {
          processor: async (job: any) => ({ sent: true, to: job.data.to }),
        },
        reports: {},
      },
    );
    cleanup = () => server.stop();
    return { server, registry };
  }

  describe('POST /{name}/jobs', () => {
    it('adds a job and returns 201', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'welcome', data: { to: 'user@test.com' } },
      });

      expect(res.statusCode).toBe(201);
      const job = JSON.parse(res.payload);
      expect(job.name).toBe('welcome');
      expect(job.data).toEqual({ to: 'user@test.com' });
      expect(job.id).toBeDefined();
    });

    it('returns 400 with error details if name is missing', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { data: { to: 'user@test.com' } },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe('Bad Request');
      expect(body.message).toBeDefined();
    });

    it('returns 404 for unconfigured queue', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/unknown/jobs',
        payload: { name: 'test', data: {} },
      });

      expect(res.statusCode).toBe(404);
    });

    it('defaults data to empty object when omitted', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'minimal' },
      });
      expect(res.statusCode).toBe(201);
      const job = JSON.parse(res.payload);
      expect(job.name).toBe('minimal');
    });

    it('accepts allowed opts keys', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {}, opts: { delay: 1000, priority: 5 } },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /{name}/jobs/wait', () => {
    it('returns 400 when name is missing', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs/wait',
        payload: { data: {} },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid waitTimeout', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs/wait',
        payload: { name: 'test', data: {}, waitTimeout: -1 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /{name}/jobs', () => {
    it('lists jobs', async () => {
      const { server } = await setup();
      await server.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test', data: {} } });

      const res = await server.inject({ method: 'GET', url: '/emails/jobs?type=waiting' });
      expect(res.statusCode).toBe(200);
      const jobs = JSON.parse(res.payload);
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('defaults to waiting when no type param', async () => {
      const { server } = await setup();
      await server.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test', data: {} } });

      const res = await server.inject({ method: 'GET', url: '/emails/jobs' });
      expect(res.statusCode).toBe(200);
      const jobs = JSON.parse(res.payload);
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('returns empty array for type with no jobs', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/jobs?type=failed' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });

    it('returns 400 for invalid type param', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/jobs?type=bogus' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Bad Request');
    });

    it('supports excludeData query parameter', async () => {
      const { server } = await setup();
      await server.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test', data: { big: 'payload' } } });

      const res = await server.inject({ method: 'GET', url: '/emails/jobs?type=waiting&excludeData=true' });
      expect(res.statusCode).toBe(200);
      const jobs = JSON.parse(res.payload);
      expect(Array.isArray(jobs)).toBe(true);
    });
  });

  describe('GET /{name}/jobs/{id}', () => {
    it('returns a job by id', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: { x: 1 } },
      });
      const added = JSON.parse(addRes.payload);

      const res = await server.inject({ method: 'GET', url: `/emails/jobs/${added.id}` });
      expect(res.statusCode).toBe(200);
      const job = JSON.parse(res.payload);
      expect(job.id).toBe(added.id);
      expect(job.data).toEqual({ x: 1 });
    });

    it('returns 404 for missing job', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/jobs/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /{name}/jobs/{id}/priority', () => {
    it('changes job priority', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {} },
      });
      const { id } = JSON.parse(addRes.payload);

      const res = await server.inject({
        method: 'POST',
        url: `/emails/jobs/${id}/priority`,
        payload: { priority: 10 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });

    it('returns 404 for non-existent job', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs/nonexistent/priority',
        payload: { priority: 5 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid priority', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {} },
      });
      const { id } = JSON.parse(addRes.payload);

      const res = await server.inject({
        method: 'POST',
        url: `/emails/jobs/${id}/priority`,
        payload: { priority: -1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for priority above 2048', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {} },
      });
      const { id } = JSON.parse(addRes.payload);

      const res = await server.inject({
        method: 'POST',
        url: `/emails/jobs/${id}/priority`,
        payload: { priority: 3000 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /{name}/jobs/{id}/delay', () => {
    it('changes job delay', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {} },
      });
      const { id } = JSON.parse(addRes.payload);

      const res = await server.inject({
        method: 'POST',
        url: `/emails/jobs/${id}/delay`,
        payload: { delay: 5000 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });

    it('returns 404 for non-existent job', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'POST',
        url: '/emails/jobs/nonexistent/delay',
        payload: { delay: 1000 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for negative delay', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {} },
      });
      const { id } = JSON.parse(addRes.payload);

      const res = await server.inject({
        method: 'POST',
        url: `/emails/jobs/${id}/delay`,
        payload: { delay: -1 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /{name}/jobs/{id}/promote', () => {
    it('promotes a job', async () => {
      const { server } = await setup();
      const addRes = await server.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {}, opts: { delay: 60000 } },
      });
      const { id } = JSON.parse(addRes.payload);

      const res = await server.inject({ method: 'POST', url: `/emails/jobs/${id}/promote` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });

    it('returns 404 for non-existent job', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/jobs/nonexistent/promote' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /{name}/counts', () => {
    it('returns job counts', async () => {
      const { server } = await setup();
      await server.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test1', data: {} } });
      await server.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test2', data: {} } });

      const res = await server.inject({ method: 'GET', url: '/emails/counts' });
      expect(res.statusCode).toBe(200);
      const counts = JSON.parse(res.payload);
      expect(counts).toHaveProperty('waiting');
      expect(counts).toHaveProperty('active');
      expect(counts).toHaveProperty('completed');
      expect(counts).toHaveProperty('failed');
    });
  });

  describe('GET /{name}/metrics', () => {
    it('returns metrics for completed type', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/metrics?type=completed' });
      expect(res.statusCode).toBe(200);
    });

    it('returns 400 when type is missing', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/metrics' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Bad Request');
    });

    it('returns 400 for invalid type', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/metrics?type=bogus' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /{name}/pause', () => {
    it('pauses the queue', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/pause' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /{name}/resume', () => {
    it('resumes the queue', async () => {
      const { server } = await setup();
      await server.inject({ method: 'POST', url: '/emails/pause' });
      const res = await server.inject({ method: 'POST', url: '/emails/resume' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /{name}/drain', () => {
    it('drains the queue', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/drain' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /{name}/retry', () => {
    it('retries failed jobs', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/retry', payload: {} });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveProperty('retried');
    });

    it('handles retry with no body at all', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/retry' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveProperty('retried');
    });

    it('rejects count of 0', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/retry', payload: { count: 0 } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative count', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'POST', url: '/emails/retry', payload: { count: -5 } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /{name}/clean', () => {
    it('cleans old jobs', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/clean?type=completed&grace=0&limit=100' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveProperty('removed');
    });

    it('cleans with type=failed', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/clean?type=failed' });
      expect(res.statusCode).toBe(200);
      expect(typeof JSON.parse(res.payload).removed).toBe('number');
    });

    it('defaults all params when none provided', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/clean' });
      expect(res.statusCode).toBe(200);
    });

    it('returns 400 for invalid type', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/clean?type=bogus' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative grace', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/clean?grace=-1' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects zero limit', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/clean?limit=0' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /{name}/workers', () => {
    it('returns worker list', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/workers' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
    });
  });

  describe('GET /{name}/schedulers', () => {
    it('lists schedulers', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/schedulers' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(res.payload))).toBe(true);
    });
  });

  describe('GET /{name}/schedulers/{schedulerName}', () => {
    it('returns 404 for non-existent scheduler', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/schedulers/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for invalid scheduler name', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/emails/schedulers/bad name!' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /{name}/schedulers/{schedulerName}', () => {
    it('upserts a scheduler with cron pattern', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'PUT',
        url: '/emails/schedulers/daily-report',
        payload: {
          schedule: { pattern: '0 9 * * *' },
          template: { name: 'report', data: { type: 'daily' } },
        },
      });
      // upsertJobScheduler may return a job or null depending on TestQueue support
      expect([200, 201]).toContain(res.statusCode);
    });

    it('returns 400 when schedule is missing', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'PUT',
        url: '/emails/schedulers/test',
        payload: { template: { name: 'test' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid scheduler name', async () => {
      const { server } = await setup();
      const res = await server.inject({
        method: 'PUT',
        url: '/emails/schedulers/bad name!',
        payload: { schedule: { every: 1000 } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /{name}/schedulers/{schedulerName}', () => {
    it('removes a scheduler', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/schedulers/nonexistent' });
      expect(res.statusCode).toBe(204);
    });

    it('returns 400 for invalid scheduler name', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'DELETE', url: '/emails/schedulers/bad name!' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Queue name validation', () => {
    it('returns 400 for invalid queue name with special chars', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/queue!@%23/counts' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Bad Request');
    });

    it('returns 400 for queue name with spaces', async () => {
      const { server } = await setup();
      const res = await server.inject({ method: 'GET', url: '/queue%20name/counts' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Route prefix', () => {
    it('routes work under configured prefix', async () => {
      const { server, registry } = await buildTestApp(
        { emails: { processor: async () => ({}) } },
        { prefix: '/api/queues' },
      );
      cleanup = () => server.stop();

      const res = await server.inject({
        method: 'POST',
        url: '/api/queues/emails/jobs',
        payload: { name: 'test', data: {} },
      });
      expect(res.statusCode).toBe(201);

      const countsRes = await server.inject({ method: 'GET', url: '/api/queues/emails/counts' });
      expect(countsRes.statusCode).toBe(200);
    });
  });
});

describe('glideMQRoutes with restricted queues', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function buildRestrictedApp(allowedQueues: string[]) {
    const { server, registry } = await buildTestApp(
      { emails: {}, reports: {}, secret: {} },
      { allowedQueues },
    );
    cleanup = () => server.stop();
    return { server, registry };
  }

  it('allows access to whitelisted queues', async () => {
    const { server } = await buildRestrictedApp(['emails']);
    const res = await server.inject({ method: 'GET', url: '/emails/counts' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for non-whitelisted queue', async () => {
    const { server } = await buildRestrictedApp(['emails']);
    const res = await server.inject({ method: 'GET', url: '/secret/counts' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toBe('Not Found');
  });

  it('returns 404 for non-whitelisted queue job POST', async () => {
    const { server } = await buildRestrictedApp(['emails']);
    const res = await server.inject({ method: 'POST', url: '/secret/jobs', payload: { name: 'test', data: {} } });
    expect(res.statusCode).toBe(404);
  });

  it('allows multiple whitelisted queues', async () => {
    const { server } = await buildRestrictedApp(['emails', 'reports']);

    expect((await server.inject({ method: 'GET', url: '/emails/counts' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/reports/counts' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/secret/counts' })).statusCode).toBe(404);
  });
});
