import { describe, it, expect } from 'vitest';
import Hapi from '@hapi/hapi';
import { glideMQPlugin } from '../src/plugin';
import { QueueRegistryImpl } from '../src/registry';

describe('glideMQPlugin', () => {
  it('decorates server.glidemq with registry', async () => {
    const server = Hapi.server({ port: 0 });
    await server.register({
      plugin: glideMQPlugin,
      options: { queues: { test: {} }, testing: true },
    });
    await server.initialize();

    expect(server.glidemq).toBeDefined();
    expect(server.glidemq.testing).toBe(true);
    expect(server.glidemq.names()).toEqual(['test']);

    await server.stop();
  });

  it('shares same registry across requests', async () => {
    const server = Hapi.server({ port: 0 });
    await server.register({
      plugin: glideMQPlugin,
      options: { queues: { test: {} }, testing: true },
    });

    let firstRef: any;
    let secondRef: any;

    server.route({
      method: 'GET',
      path: '/first',
      handler: (request) => {
        firstRef = request.server.glidemq;
        return { ok: true };
      },
    });
    server.route({
      method: 'GET',
      path: '/second',
      handler: (request) => {
        secondRef = request.server.glidemq;
        return { ok: true };
      },
    });

    await server.initialize();
    await server.inject({ method: 'GET', url: '/first' });
    await server.inject({ method: 'GET', url: '/second' });

    expect(firstRef).toBe(secondRef);

    await server.stop();
  });

  it('exposes getConnection and getPrefix', async () => {
    const server = Hapi.server({ port: 0 });
    await server.register({
      plugin: glideMQPlugin,
      options: { queues: { test: {} }, testing: true, prefix: 'myprefix' },
    });
    await server.initialize();

    expect(server.glidemq.getConnection()).toBeUndefined();
    expect(server.glidemq.getPrefix()).toBe('myprefix');

    await server.stop();
  });

  it('throws if no connection and not testing', async () => {
    const server = Hapi.server({ port: 0 });
    await expect(
      server.register({
        plugin: glideMQPlugin,
        options: { queues: { test: {} } },
      }),
    ).rejects.toThrow('connection is required');
  });

  it('accepts a pre-constructed QueueRegistry', async () => {
    const registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    const server = Hapi.server({ port: 0 });
    await server.register({
      plugin: glideMQPlugin,
      options: registry as any,
    });
    await server.initialize();

    expect(server.glidemq.testing).toBe(true);
    expect(server.glidemq.names()).toEqual(['emails']);

    await server.stop();
  });

  it('closes registry on server stop', async () => {
    const server = Hapi.server({ port: 0 });
    await server.register({
      plugin: glideMQPlugin,
      options: { queues: { test: {} }, testing: true },
    });
    await server.initialize();

    const registry = server.glidemq;
    registry.get('test'); // Initialize a queue

    await server.stop();

    expect(() => registry.get('test')).toThrow('closed');
  });
});
