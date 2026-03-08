import { describe, it, expect } from 'vitest';
import { buildSchemas, hasZod } from '../src/schemas';

describe('schemas', () => {
  it('hasZod returns true (zod is a devDep)', () => {
    expect(hasZod()).toBe(true);
  });

  it('buildSchemas returns all schemas', () => {
    const schemas = buildSchemas();
    expect(schemas).not.toBeNull();
    expect(schemas!.addJobSchema).toBeDefined();
    expect(schemas!.getJobsQuerySchema).toBeDefined();
    expect(schemas!.cleanQuerySchema).toBeDefined();
    expect(schemas!.retryBodySchema).toBeDefined();
    expect(schemas!.metricsQuerySchema).toBeDefined();
    expect(schemas!.changePriorityBodySchema).toBeDefined();
    expect(schemas!.changeDelayBodySchema).toBeDefined();
    expect(schemas!.upsertSchedulerBodySchema).toBeDefined();
    expect(schemas!.addAndWaitBodySchema).toBeDefined();
  });

  describe('addJobSchema', () => {
    const schemas = buildSchemas()!;

    it('validates a correct job', () => {
      const result = schemas.addJobSchema.safeParse({ name: 'email', data: { to: 'user@test.com' } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('email');
        expect(result.data.data).toEqual({ to: 'user@test.com' });
        expect(result.data.opts).toEqual({});
      }
    });

    it('rejects missing name', () => {
      expect(schemas.addJobSchema.safeParse({ data: {} }).success).toBe(false);
    });

    it('rejects empty name', () => {
      expect(schemas.addJobSchema.safeParse({ name: '', data: {} }).success).toBe(false);
    });

    it('defaults data to {} when omitted', () => {
      const result = schemas.addJobSchema.safeParse({ name: 'test' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.data).toEqual({});
    });

    it('accepts opts with delay and priority', () => {
      const result = schemas.addJobSchema.safeParse({ name: 'test', opts: { delay: 5000, priority: 1 } });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.opts).toEqual({ delay: 5000, priority: 1 });
    });

    it('accepts deduplication opts', () => {
      const result = schemas.addJobSchema.safeParse({
        name: 'test',
        opts: { deduplication: { id: 'key', ttl: 5000, mode: 'throttle' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts ordering opts', () => {
      const result = schemas.addJobSchema.safeParse({
        name: 'test',
        opts: { ordering: { key: 'user-1', concurrency: 1 } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts backoff opts', () => {
      const result = schemas.addJobSchema.safeParse({
        name: 'test',
        opts: { backoff: { type: 'exponential', delay: 1000, jitter: 200 } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts parent opts', () => {
      const result = schemas.addJobSchema.safeParse({
        name: 'test',
        opts: { parent: { queue: 'parent-q', id: 'parent-1' } },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('getJobsQuerySchema', () => {
    const schemas = buildSchemas()!;

    it('applies defaults', () => {
      const result = schemas.getJobsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('waiting');
        expect(result.data.start).toBe(0);
        expect(result.data.end).toBe(-1);
      }
    });

    it('coerces string numbers', () => {
      const result = schemas.getJobsQuerySchema.safeParse({ start: '5', end: '10' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.start).toBe(5);
        expect(result.data.end).toBe(10);
      }
    });

    it('rejects invalid type', () => {
      expect(schemas.getJobsQuerySchema.safeParse({ type: 'invalid' }).success).toBe(false);
    });

    it('accepts all valid types', () => {
      for (const type of ['waiting', 'active', 'delayed', 'completed', 'failed']) {
        expect(schemas.getJobsQuerySchema.safeParse({ type }).success).toBe(true);
      }
    });
  });

  describe('cleanQuerySchema', () => {
    const schemas = buildSchemas()!;

    it('applies defaults', () => {
      const result = schemas.cleanQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.grace).toBe(0);
        expect(result.data.limit).toBe(100);
        expect(result.data.type).toBe('completed');
      }
    });

    it('rejects invalid type', () => {
      expect(schemas.cleanQuerySchema.safeParse({ type: 'waiting' }).success).toBe(false);
    });

    it('rejects negative grace', () => {
      expect(schemas.cleanQuerySchema.safeParse({ grace: '-1' }).success).toBe(false);
    });

    it('rejects zero limit', () => {
      expect(schemas.cleanQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    });

    it('rejects negative limit', () => {
      expect(schemas.cleanQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
    });

    it('accepts limit of 1', () => {
      const result = schemas.cleanQuerySchema.safeParse({ limit: '1' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.limit).toBe(1);
    });

    it('rejects non-integer grace', () => {
      expect(schemas.cleanQuerySchema.safeParse({ grace: '1.5' }).success).toBe(false);
    });
  });

  describe('retryBodySchema', () => {
    const schemas = buildSchemas()!;

    it('allows empty body', () => {
      expect(schemas.retryBodySchema.safeParse({}).success).toBe(true);
    });

    it('parses count', () => {
      const result = schemas.retryBodySchema.safeParse({ count: 10 });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.count).toBe(10);
    });

    it('rejects count of 0', () => {
      expect(schemas.retryBodySchema.safeParse({ count: 0 }).success).toBe(false);
    });

    it('rejects negative count', () => {
      expect(schemas.retryBodySchema.safeParse({ count: -5 }).success).toBe(false);
    });

    it('rejects non-integer count', () => {
      expect(schemas.retryBodySchema.safeParse({ count: 3.7 }).success).toBe(false);
    });
  });

  describe('metricsQuerySchema', () => {
    const schemas = buildSchemas()!;

    it('accepts type=completed', () => {
      const result = schemas.metricsQuerySchema.safeParse({ type: 'completed' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe('completed');
    });

    it('accepts type=failed', () => {
      expect(schemas.metricsQuerySchema.safeParse({ type: 'failed' }).success).toBe(true);
    });

    it('rejects missing type', () => {
      expect(schemas.metricsQuerySchema.safeParse({}).success).toBe(false);
    });

    it('rejects invalid type', () => {
      expect(schemas.metricsQuerySchema.safeParse({ type: 'waiting' }).success).toBe(false);
    });

    it('coerces start and end', () => {
      const result = schemas.metricsQuerySchema.safeParse({ type: 'completed', start: '5', end: '10' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.start).toBe(5);
        expect(result.data.end).toBe(10);
      }
    });
  });

  describe('changePriorityBodySchema', () => {
    const schemas = buildSchemas()!;

    it('accepts valid priority', () => {
      const result = schemas.changePriorityBodySchema.safeParse({ priority: 10 });
      expect(result.success).toBe(true);
    });

    it('accepts priority 0', () => {
      expect(schemas.changePriorityBodySchema.safeParse({ priority: 0 }).success).toBe(true);
    });

    it('accepts priority 2048', () => {
      expect(schemas.changePriorityBodySchema.safeParse({ priority: 2048 }).success).toBe(true);
    });

    it('rejects priority above 2048', () => {
      expect(schemas.changePriorityBodySchema.safeParse({ priority: 2049 }).success).toBe(false);
    });

    it('rejects negative priority', () => {
      expect(schemas.changePriorityBodySchema.safeParse({ priority: -1 }).success).toBe(false);
    });

    it('rejects non-integer priority', () => {
      expect(schemas.changePriorityBodySchema.safeParse({ priority: 1.5 }).success).toBe(false);
    });
  });

  describe('changeDelayBodySchema', () => {
    const schemas = buildSchemas()!;

    it('accepts valid delay', () => {
      expect(schemas.changeDelayBodySchema.safeParse({ delay: 5000 }).success).toBe(true);
    });

    it('accepts delay 0', () => {
      expect(schemas.changeDelayBodySchema.safeParse({ delay: 0 }).success).toBe(true);
    });

    it('rejects negative delay', () => {
      expect(schemas.changeDelayBodySchema.safeParse({ delay: -1 }).success).toBe(false);
    });

    it('rejects non-integer delay', () => {
      expect(schemas.changeDelayBodySchema.safeParse({ delay: 1.5 }).success).toBe(false);
    });
  });

  describe('upsertSchedulerBodySchema', () => {
    const schemas = buildSchemas()!;

    it('accepts cron pattern schedule', () => {
      const result = schemas.upsertSchedulerBodySchema.safeParse({
        schedule: { pattern: '0 9 * * *', tz: 'America/New_York' },
        template: { name: 'report', data: { type: 'daily' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts interval schedule', () => {
      const result = schemas.upsertSchedulerBodySchema.safeParse({
        schedule: { every: 60000 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts repeatAfterComplete', () => {
      const result = schemas.upsertSchedulerBodySchema.safeParse({
        schedule: { every: 5000, repeatAfterComplete: true },
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing schedule', () => {
      expect(schemas.upsertSchedulerBodySchema.safeParse({ template: {} }).success).toBe(false);
    });

    it('template is optional', () => {
      expect(schemas.upsertSchedulerBodySchema.safeParse({ schedule: { every: 1000 } }).success).toBe(true);
    });
  });

  describe('addAndWaitBodySchema', () => {
    const schemas = buildSchemas()!;

    it('validates a correct addAndWait body', () => {
      const result = schemas.addAndWaitBodySchema.safeParse({
        name: 'test',
        data: { x: 1 },
        waitTimeout: 10000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('test');
        expect(result.data.waitTimeout).toBe(10000);
      }
    });

    it('rejects missing name', () => {
      expect(schemas.addAndWaitBodySchema.safeParse({ data: {} }).success).toBe(false);
    });

    it('waitTimeout is optional', () => {
      const result = schemas.addAndWaitBodySchema.safeParse({ name: 'test' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.waitTimeout).toBeUndefined();
    });

    it('rejects negative waitTimeout', () => {
      expect(schemas.addAndWaitBodySchema.safeParse({ name: 'test', waitTimeout: -1 }).success).toBe(false);
    });

    it('rejects zero waitTimeout', () => {
      expect(schemas.addAndWaitBodySchema.safeParse({ name: 'test', waitTimeout: 0 }).success).toBe(false);
    });

    it('accepts opts (shared schema with addJob)', () => {
      const result = schemas.addAndWaitBodySchema.safeParse({
        name: 'test',
        opts: { delay: 1000, priority: 5 },
      });
      expect(result.success).toBe(true);
    });
  });
});
