import Hapi from '@hapi/hapi';
import type { Server } from '@hapi/hapi';
import type { QueueConfig, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';
import { glideMQRoutes } from './routes';

export async function createTestApp(
  queues: Record<string, QueueConfig>,
  opts?: { prefix?: string },
): Promise<{ server: Server; registry: QueueRegistry }> {
  const registry = new QueueRegistryImpl({ queues, testing: true });

  const server = Hapi.server({ port: 0 });

  server.decorate('server', 'glidemq', registry);

  // The routes plugin expects '@glidemq/hapi' as a dependency.
  // Since we manually decorated the server, register a stub plugin to satisfy the dependency.
  await server.register({
    plugin: {
      name: '@glidemq/hapi',
      version: '0.1.0',
      register: async () => {},
    },
  });

  await server.register({
    plugin: glideMQRoutes,
    options: { prefix: opts?.prefix },
  });

  server.ext({
    type: 'onPostStop',
    method: async () => {
      await registry.closeAll();
    },
  });

  await server.initialize();

  return { server, registry };
}
