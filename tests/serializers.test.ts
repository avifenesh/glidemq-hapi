import { describe, it, expect } from 'vitest';
import { serializeJob, serializeJobs } from '../src/serializers';

function fakeJob(overrides: Record<string, any> = {}) {
  return {
    id: '1',
    name: 'test',
    data: { key: 'value' },
    opts: { priority: 5 },
    attemptsMade: 0,
    returnvalue: undefined,
    failedReason: undefined,
    progress: 0,
    timestamp: 1700000000000,
    finishedOn: undefined,
    processedOn: undefined,
    ...overrides,
  } as any;
}

describe('serializeJob', () => {
  it('serializes a job with all fields', () => {
    const job = fakeJob({
      returnvalue: { result: true },
      progress: 50,
      finishedOn: 1700000001000,
      processedOn: 1700000000500,
    });
    const result = serializeJob(job);
    expect(result).toEqual({
      id: '1',
      name: 'test',
      data: { key: 'value' },
      opts: { priority: 5 },
      attemptsMade: 0,
      returnvalue: { result: true },
      failedReason: undefined,
      progress: 50,
      timestamp: 1700000000000,
      finishedOn: 1700000001000,
      processedOn: 1700000000500,
    });
  });

  it('handles undefined optional fields', () => {
    const result = serializeJob(fakeJob());
    expect(result.returnvalue).toBeUndefined();
    expect(result.failedReason).toBeUndefined();
    expect(result.finishedOn).toBeUndefined();
    expect(result.processedOn).toBeUndefined();
    expect(result.parentId).toBeUndefined();
    expect(result.parentQueue).toBeUndefined();
    expect(result.orderingKey).toBeUndefined();
    expect(result.cost).toBeUndefined();
    expect(result.schedulerName).toBeUndefined();
  });

  it('preserves complex data objects', () => {
    const data = { nested: { deep: [1, 2, 3] }, arr: ['a', 'b'] };
    const result = serializeJob(fakeJob({ data }));
    expect(result.data).toEqual(data);
  });

  it('handles failed job with reason', () => {
    const result = serializeJob(fakeJob({ failedReason: 'timeout', attemptsMade: 3 }));
    expect(result.failedReason).toBe('timeout');
    expect(result.attemptsMade).toBe(3);
  });

  it('includes parentId when present', () => {
    const result = serializeJob(fakeJob({ parentId: 'parent-1' }));
    expect(result.parentId).toBe('parent-1');
  });

  it('includes parentQueue when present', () => {
    const result = serializeJob(fakeJob({ parentQueue: 'parent-q' }));
    expect(result.parentQueue).toBe('parent-q');
  });

  it('includes orderingKey when present', () => {
    const result = serializeJob(fakeJob({ orderingKey: 'user-123' }));
    expect(result.orderingKey).toBe('user-123');
  });

  it('includes cost when present', () => {
    const result = serializeJob(fakeJob({ cost: 5 }));
    expect(result.cost).toBe(5);
  });

  it('includes schedulerName when present', () => {
    const result = serializeJob(fakeJob({ schedulerName: 'daily-report' }));
    expect(result.schedulerName).toBe('daily-report');
  });
});

describe('serializeJobs', () => {
  it('serializes an array of jobs', () => {
    const jobs = [fakeJob({ id: '1' }), fakeJob({ id: '2' }), fakeJob({ id: '3' })];
    const result = serializeJobs(jobs);
    expect(result).toHaveLength(3);
    expect(result.map((j) => j.id)).toEqual(['1', '2', '3']);
  });

  it('returns empty array for empty input', () => {
    expect(serializeJobs([])).toEqual([]);
  });
});
