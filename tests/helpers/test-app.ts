import Hapi from '@hapi/hapi';
import type { Server } from '@hapi/hapi';
import type { QueueConfig, QueueRegistry } from '../../src/types';
import { glideMQPlugin } from '../../src/plugin';

export async function buildTestApp(
  queues: Record<string, QueueConfig> = { default: {} },
  opts?: { prefix?: string; allowedQueues?: string[]; allowedProducers?: string[] },
): Promise<{ server: Server; registry: QueueRegistry }> {
  const server = Hapi.server({ port: 0 });

  await server.register({
    plugin: glideMQPlugin,
    options: {
      queues,
      testing: true,
      routes: {
        queues: opts?.allowedQueues,
        producers: opts?.allowedProducers,
      },
    },
    ...(opts?.prefix ? { routes: { prefix: opts.prefix } } : {}),
  });

  await server.initialize();
  return { server, registry: server.glidemq };
}
