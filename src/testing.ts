import Hapi from '@hapi/hapi';
import type { Server } from '@hapi/hapi';
import type { QueueConfig, QueueRegistry } from './types';
import { glideMQPlugin } from './plugin';

export async function createTestApp(
  queues: Record<string, QueueConfig>,
  opts?: { prefix?: string },
): Promise<{ server: Server; registry: QueueRegistry }> {
  const server = Hapi.server({ port: 0 });

  await server.register({
    plugin: glideMQPlugin,
    options: { queues, testing: true, routes: true },
    ...(opts?.prefix ? { routes: { prefix: opts.prefix } } : {}),
  });

  await server.initialize();
  return { server, registry: server.glidemq() };
}
