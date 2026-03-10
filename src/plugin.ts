import type { Plugin, Server, Request } from '@hapi/hapi';
import Joi from 'joi';
import type { GlideMQPluginOptions, GlideMQRoutesOptions, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';
import { optionsSchema } from './schemas';
import { registerRoutes } from './routes';

export const glideMQPlugin: Plugin<GlideMQPluginOptions> = {
  pkg: require('../package.json'),
  register: async (server: Server, options: GlideMQPluginOptions) => {
    // Set Joi as the validator for this plugin realm
    server.validator(Joi);

    // Validate options unless a pre-built registry was passed directly
    const isPreBuilt = options instanceof QueueRegistryImpl;
    if (!isPreBuilt) {
      const { error } = optionsSchema.validate(options, { allowUnknown: false });
      if (error) {
        throw new Error(`@glidemq/hapi: invalid options - ${error.message}`);
      }
    }

    const registry: QueueRegistry = isPreBuilt
      ? (options as unknown as QueueRegistry)
      : new QueueRegistryImpl(options);

    // Eagerly initialize producers so connection errors surface early
    if (!isPreBuilt && options.producers) {
      for (const name of Object.keys(options.producers)) {
        registry.getProducer(name);
      }
    }

    // Server decoration: server.glidemq() returns the registry
    server.decorate('server', 'glidemq', function (this: Server) {
      return registry;
    });

    // Request decoration: request.glidemq delegates to server.glidemq()
    server.decorate(
      'request',
      'glidemq',
      (request: Request) => (request.server as any).glidemq(),
      { apply: true },
    );

    // Conditionally register REST + SSE routes
    if (options.routes) {
      const routeOpts: GlideMQRoutesOptions =
        typeof options.routes === 'object' ? options.routes : {};
      registerRoutes(server, registry, routeOpts);
    }

    // Cleanup on server stop
    server.ext({
      type: 'onPostStop',
      method: async () => {
        await registry.closeAll();
      },
    });
  },
};
