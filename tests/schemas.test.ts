import { describe, it, expect } from 'vitest';
import {
  addJobSchema,
  getJobsQuerySchema,
  cleanQuerySchema,
  retryBodySchema,
  metricsQuerySchema,
  changePriorityBodySchema,
  changeDelayBodySchema,
  upsertSchedulerBodySchema,
  addAndWaitBodySchema,
} from '../src/schemas';

// Helper: returns { error, value } - error is undefined on success
function validate(schema: any, input: any) {
  const { error, value } = schema.validate(input);
  return { success: !error, data: value, error };
}

describe('schemas (Joi)', () => {
  it('all schemas are defined', () => {
    expect(addJobSchema).toBeDefined();
    expect(getJobsQuerySchema).toBeDefined();
    expect(cleanQuerySchema).toBeDefined();
    expect(retryBodySchema).toBeDefined();
    expect(metricsQuerySchema).toBeDefined();
    expect(changePriorityBodySchema).toBeDefined();
    expect(changeDelayBodySchema).toBeDefined();
    expect(upsertSchedulerBodySchema).toBeDefined();
    expect(addAndWaitBodySchema).toBeDefined();
  });

  describe('addJobSchema', () => {
    it('validates a correct job', () => {
      const result = validate(addJobSchema, { name: 'email', data: { to: 'user@test.com' } });
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('email');
      expect(result.data.data).toEqual({ to: 'user@test.com' });
      expect(result.data.opts).toEqual({});
    });

    it('rejects missing name', () => {
      expect(validate(addJobSchema, { data: {} }).success).toBe(false);
    });

    it('rejects empty name', () => {
      expect(validate(addJobSchema, { name: '', data: {} }).success).toBe(false);
    });

    it('defaults data to {} when omitted', () => {
      const result = validate(addJobSchema, { name: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.data).toEqual({});
    });

    it('accepts opts with delay and priority', () => {
      const result = validate(addJobSchema, { name: 'test', opts: { delay: 5000, priority: 1 } });
      expect(result.success).toBe(true);
      expect(result.data.opts).toEqual({ delay: 5000, priority: 1 });
    });

    it('accepts deduplication opts', () => {
      const result = validate(addJobSchema, {
        name: 'test',
        opts: { deduplication: { id: 'key', ttl: 5000, mode: 'throttle' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts ordering opts', () => {
      const result = validate(addJobSchema, {
        name: 'test',
        opts: { ordering: { key: 'user-1', concurrency: 1 } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts backoff opts', () => {
      const result = validate(addJobSchema, {
        name: 'test',
        opts: { backoff: { type: 'exponential', delay: 1000, jitter: 200 } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts parent opts', () => {
      const result = validate(addJobSchema, {
        name: 'test',
        opts: { parent: { queue: 'parent-q', id: 'parent-1' } },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('getJobsQuerySchema', () => {
    it('applies defaults', () => {
      const result = validate(getJobsQuerySchema, {});
      expect(result.success).toBe(true);
      expect(result.data.type).toBe('waiting');
      expect(result.data.start).toBe(0);
      expect(result.data.end).toBe(-1);
    });

    it('coerces string numbers', () => {
      const result = validate(getJobsQuerySchema, { start: '5', end: '10' });
      expect(result.success).toBe(true);
      expect(result.data.start).toBe(5);
      expect(result.data.end).toBe(10);
    });

    it('rejects invalid type', () => {
      expect(validate(getJobsQuerySchema, { type: 'invalid' }).success).toBe(false);
    });

    it('accepts all valid types', () => {
      for (const type of ['waiting', 'active', 'delayed', 'completed', 'failed']) {
        expect(validate(getJobsQuerySchema, { type }).success).toBe(true);
      }
    });
  });

  describe('cleanQuerySchema', () => {
    it('applies defaults', () => {
      const result = validate(cleanQuerySchema, {});
      expect(result.success).toBe(true);
      expect(result.data.grace).toBe(0);
      expect(result.data.limit).toBe(100);
      expect(result.data.type).toBe('completed');
    });

    it('rejects invalid type', () => {
      expect(validate(cleanQuerySchema, { type: 'waiting' }).success).toBe(false);
    });

    it('rejects negative grace', () => {
      expect(validate(cleanQuerySchema, { grace: -1 }).success).toBe(false);
    });

    it('rejects zero limit', () => {
      expect(validate(cleanQuerySchema, { limit: 0 }).success).toBe(false);
    });

    it('rejects negative limit', () => {
      expect(validate(cleanQuerySchema, { limit: -1 }).success).toBe(false);
    });

    it('accepts limit of 1', () => {
      const result = validate(cleanQuerySchema, { limit: 1 });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(1);
    });

    it('rejects non-integer grace', () => {
      expect(validate(cleanQuerySchema, { grace: 1.5 }).success).toBe(false);
    });
  });

  describe('retryBodySchema', () => {
    it('allows empty body', () => {
      expect(validate(retryBodySchema, {}).success).toBe(true);
    });

    it('parses count', () => {
      const result = validate(retryBodySchema, { count: 10 });
      expect(result.success).toBe(true);
      expect(result.data.count).toBe(10);
    });

    it('rejects count of 0', () => {
      expect(validate(retryBodySchema, { count: 0 }).success).toBe(false);
    });

    it('rejects negative count', () => {
      expect(validate(retryBodySchema, { count: -5 }).success).toBe(false);
    });

    it('rejects non-integer count', () => {
      expect(validate(retryBodySchema, { count: 3.7 }).success).toBe(false);
    });
  });

  describe('metricsQuerySchema', () => {
    it('accepts type=completed', () => {
      const result = validate(metricsQuerySchema, { type: 'completed' });
      expect(result.success).toBe(true);
      expect(result.data.type).toBe('completed');
    });

    it('accepts type=failed', () => {
      expect(validate(metricsQuerySchema, { type: 'failed' }).success).toBe(true);
    });

    it('rejects missing type', () => {
      expect(validate(metricsQuerySchema, {}).success).toBe(false);
    });

    it('rejects invalid type', () => {
      expect(validate(metricsQuerySchema, { type: 'waiting' }).success).toBe(false);
    });

    it('coerces start and end', () => {
      const result = validate(metricsQuerySchema, { type: 'completed', start: '5', end: '10' });
      expect(result.success).toBe(true);
      expect(result.data.start).toBe(5);
      expect(result.data.end).toBe(10);
    });
  });

  describe('changePriorityBodySchema', () => {
    it('accepts valid priority', () => {
      const result = validate(changePriorityBodySchema, { priority: 10 });
      expect(result.success).toBe(true);
    });

    it('accepts priority 0', () => {
      expect(validate(changePriorityBodySchema, { priority: 0 }).success).toBe(true);
    });

    it('accepts priority 2048', () => {
      expect(validate(changePriorityBodySchema, { priority: 2048 }).success).toBe(true);
    });

    it('rejects priority above 2048', () => {
      expect(validate(changePriorityBodySchema, { priority: 2049 }).success).toBe(false);
    });

    it('rejects negative priority', () => {
      expect(validate(changePriorityBodySchema, { priority: -1 }).success).toBe(false);
    });

    it('rejects non-integer priority', () => {
      expect(validate(changePriorityBodySchema, { priority: 1.5 }).success).toBe(false);
    });
  });

  describe('changeDelayBodySchema', () => {
    it('accepts valid delay', () => {
      expect(validate(changeDelayBodySchema, { delay: 5000 }).success).toBe(true);
    });

    it('accepts delay 0', () => {
      expect(validate(changeDelayBodySchema, { delay: 0 }).success).toBe(true);
    });

    it('rejects negative delay', () => {
      expect(validate(changeDelayBodySchema, { delay: -1 }).success).toBe(false);
    });

    it('rejects non-integer delay', () => {
      expect(validate(changeDelayBodySchema, { delay: 1.5 }).success).toBe(false);
    });
  });

  describe('upsertSchedulerBodySchema', () => {
    it('accepts cron pattern schedule', () => {
      const result = validate(upsertSchedulerBodySchema, {
        schedule: { pattern: '0 9 * * *', tz: 'America/New_York' },
        template: { name: 'report', data: { type: 'daily' } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts interval schedule', () => {
      const result = validate(upsertSchedulerBodySchema, {
        schedule: { every: 60000 },
      });
      expect(result.success).toBe(true);
    });

    it('accepts repeatAfterComplete', () => {
      const result = validate(upsertSchedulerBodySchema, {
        schedule: { every: 5000, repeatAfterComplete: true },
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing schedule', () => {
      expect(validate(upsertSchedulerBodySchema, { template: {} }).success).toBe(false);
    });

    it('template is optional', () => {
      expect(validate(upsertSchedulerBodySchema, { schedule: { every: 1000 } }).success).toBe(true);
    });
  });

  describe('addAndWaitBodySchema', () => {
    it('validates a correct addAndWait body', () => {
      const result = validate(addAndWaitBodySchema, {
        name: 'test',
        data: { x: 1 },
        waitTimeout: 10000,
      });
      expect(result.success).toBe(true);
      expect(result.data.name).toBe('test');
      expect(result.data.waitTimeout).toBe(10000);
    });

    it('rejects missing name', () => {
      expect(validate(addAndWaitBodySchema, { data: {} }).success).toBe(false);
    });

    it('waitTimeout is optional', () => {
      const result = validate(addAndWaitBodySchema, { name: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.waitTimeout).toBeUndefined();
    });

    it('rejects negative waitTimeout', () => {
      expect(validate(addAndWaitBodySchema, { name: 'test', waitTimeout: -1 }).success).toBe(false);
    });

    it('rejects zero waitTimeout', () => {
      expect(validate(addAndWaitBodySchema, { name: 'test', waitTimeout: 0 }).success).toBe(false);
    });

    it('accepts opts (shared schema with addJob)', () => {
      const result = validate(addAndWaitBodySchema, {
        name: 'test',
        opts: { delay: 1000, priority: 5 },
      });
      expect(result.success).toBe(true);
    });
  });
});
