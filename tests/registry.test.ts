import { describe, it, expect, afterEach } from 'vitest';
import { QueueRegistryImpl } from '../src/registry';

describe('QueueRegistryImpl', () => {
  let registry: QueueRegistryImpl;

  afterEach(async () => {
    if (registry) await registry.closeAll();
  });

  it('throws if no connection and not testing', () => {
    expect(() => new QueueRegistryImpl({ queues: { q: {} } })).toThrow('connection is required');
  });

  it('creates registry in testing mode without connection', () => {
    registry = new QueueRegistryImpl({ queues: { q: {} }, testing: true });
    expect(registry.testing).toBe(true);
  });

  it('lists configured queue names', () => {
    registry = new QueueRegistryImpl({ queues: { emails: {}, reports: {} }, testing: true });
    expect(registry.names()).toEqual(['emails', 'reports']);
  });

  it('has() returns true for configured queues', () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    expect(registry.has('emails')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
  });

  it('has() does not match prototype properties', () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    expect(registry.has('constructor')).toBe(false);
    expect(registry.has('toString')).toBe(false);
    expect(registry.has('hasOwnProperty')).toBe(false);
  });

  it('get() creates a TestQueue lazily', () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    const managed = registry.get('emails');
    expect(managed.queue).toBeDefined();
    expect(managed.worker).toBeNull();
  });

  it('get() creates a TestWorker when processor is provided', () => {
    registry = new QueueRegistryImpl({
      queues: { emails: { processor: async (_job) => ({ sent: true }) } },
      testing: true,
    });
    const managed = registry.get('emails');
    expect(managed.queue).toBeDefined();
    expect(managed.worker).toBeDefined();
  });

  it('get() returns same instance on repeated calls', () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    expect(registry.get('emails')).toBe(registry.get('emails'));
  });

  it('get() throws for unconfigured queue', () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    expect(() => registry.get('unknown')).toThrow('not configured');
  });

  it('closeAll() prevents further get() calls', async () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    registry.get('emails');
    await registry.closeAll();
    expect(() => registry.get('emails')).toThrow('closed');
  });

  it('closeAll() is idempotent', async () => {
    registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    await registry.closeAll();
    await registry.closeAll();
  });

  it('getConnection() returns configured connection', () => {
    const conn = { addresses: [{ host: 'localhost', port: 6379 }] } as any;
    registry = new QueueRegistryImpl({ queues: { q: {} }, testing: true, connection: conn });
    expect(registry.getConnection()).toBe(conn);
  });

  it('getConnection() returns undefined when not configured', () => {
    registry = new QueueRegistryImpl({ queues: { q: {} }, testing: true });
    expect(registry.getConnection()).toBeUndefined();
  });

  it('getPrefix() returns configured prefix', () => {
    registry = new QueueRegistryImpl({ queues: { q: {} }, testing: true, prefix: 'myapp' });
    expect(registry.getPrefix()).toBe('myapp');
  });

  it('getPrefix() returns undefined when not configured', () => {
    registry = new QueueRegistryImpl({ queues: { q: {} }, testing: true });
    expect(registry.getPrefix()).toBeUndefined();
  });

  describe('producers', () => {
    it('hasProducer() returns true for configured producers', () => {
      registry = new QueueRegistryImpl({ queues: {}, producers: { notifications: {} }, testing: true });
      expect(registry.hasProducer('notifications')).toBe(true);
      expect(registry.hasProducer('unknown')).toBe(false);
    });

    it('producerNames() lists configured producer names', () => {
      registry = new QueueRegistryImpl({ queues: {}, producers: { a: {}, b: {} }, testing: true });
      expect(registry.producerNames()).toEqual(['a', 'b']);
    });

    it('producerNames() returns empty array when no producers', () => {
      registry = new QueueRegistryImpl({ queues: {}, testing: true });
      expect(registry.producerNames()).toEqual([]);
    });

    it('getProducer() throws in testing mode', () => {
      registry = new QueueRegistryImpl({ queues: {}, producers: { notifications: {} }, testing: true });
      expect(() => registry.getProducer('notifications')).toThrow('not supported in testing mode');
    });

    it('getProducer() throws for unconfigured producer', () => {
      registry = new QueueRegistryImpl({ queues: {}, producers: { notifications: {} }, testing: true });
      expect(() => registry.getProducer('unknown')).toThrow('not configured');
    });

    it('getProducer() throws after closeAll()', async () => {
      registry = new QueueRegistryImpl({ queues: {}, producers: { notifications: {} }, testing: true });
      await registry.closeAll();
      expect(() => registry.getProducer('notifications')).toThrow('closed');
    });
  });
});
