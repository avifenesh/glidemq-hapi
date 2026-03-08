import Hapi from '@hapi/hapi';
import type { Server } from '@hapi/hapi';
import type { QueueConfig, QueueRegistry } from '../../src/types';
import { QueueRegistryImpl } from '../../src/registry';
import { glideMQRoutes } from '../../src/routes';

export async function buildTestApp(
  queues: Record<string, QueueConfig> = { default: {} },
  opts?: { prefix?: string; allowedQueues?: string[]; allowedProducers?: string[] },
): Promise<{ server: Server; registry: QueueRegistry }> {
  const registry = new QueueRegistryImpl({ queues, testing: true });
  const server = Hapi.server({ port: 0 });

  server.decorate('server', 'glidemq', registry);

  // Register stub to satisfy dependency
  await server.register({
    plugin: {
      name: '@glidemq/hapi',
      version: '0.1.0',
      register: async () => {},
    },
  });

  await server.register({
    plugin: glideMQRoutes,
    options: {
      prefix: opts?.prefix,
      queues: opts?.allowedQueues,
      producers: opts?.allowedProducers,
    },
  });

  await server.initialize();
  return { server, registry };
}
