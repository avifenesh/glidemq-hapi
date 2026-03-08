import type { Plugin, Server } from '@hapi/hapi';
import type { GlideMQPluginOptions, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';

export const glideMQPlugin: Plugin<GlideMQPluginOptions> = {
  name: '@glidemq/hapi',
  version: '0.1.0',
  register: async (server: Server, options: GlideMQPluginOptions) => {
    // Accept a pre-built QueueRegistry or create one from config
    const isPreBuilt = options instanceof QueueRegistryImpl;
    const registry: QueueRegistry = isPreBuilt
      ? (options as unknown as QueueRegistry)
      : new QueueRegistryImpl(options);

    // Eagerly initialize producers so connection errors surface early
    if (!isPreBuilt && options.producers) {
      for (const name of Object.keys(options.producers)) {
        registry.getProducer(name);
      }
    }

    server.decorate('server', 'glidemq', registry);

    server.ext({
      type: 'onPostStop',
      method: async () => {
        await registry.closeAll();
      },
    });
  },
};
