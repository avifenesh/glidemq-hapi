# @glidemq/hapi

[![npm](https://img.shields.io/npm/v/@glidemq/hapi)](https://www.npmjs.com/package/@glidemq/hapi)
[![license](https://img.shields.io/npm/l/@glidemq/hapi)](https://github.com/avifenesh/glidemq-hapi/blob/main/LICENSE)

Hapi v21 plugin that turns [glide-mq](https://github.com/avifenesh/glide-mq) queues into a REST API with real-time SSE - two registrations, 21 endpoints.

## Why

- **Zero route boilerplate** - declare queues, get job CRUD, metrics, schedulers, and SSE endpoints
- **Testable without Valkey** - `createTestApp` builds an in-memory Hapi server for `server.inject()` assertions
- **Joi validation** - all request bodies and query params validated with structured error messages

## Install

```bash
npm install @glidemq/hapi glide-mq @hapi/hapi joi
```

Requires **glide-mq >= 0.13.0** and **Hapi 21+**.

## Quick start

```ts
import Hapi from "@hapi/hapi";
import { glideMQPlugin, glideMQRoutes } from "@glidemq/hapi";

const server = Hapi.server({ port: 3000 });

await server.register({
  plugin: glideMQPlugin,
  options: {
    connection: { addresses: [{ host: "localhost", port: 6379 }] },
    queues: {
      emails: {
        processor: async (job) => {
          await sendEmail(job.data.to, job.data.subject);
          return { sent: true };
        },
      },
    },
  },
});

await server.register({ plugin: glideMQRoutes });
await server.start();
// POST /emails/jobs to enqueue, GET /emails/events for SSE
```

`glideMQPlugin` creates a registry on `server.glidemq`. The `onPostStop` hook handles graceful shutdown.

## AI-native features

glide-mq 0.13+ provides AI orchestration primitives - token/cost tracking, real-time streaming, human-in-the-loop suspend/signal, model failover chains, budget caps, dual-axis rate limiting, and vector search. All are accessible through this plugin via the REST API or `server.glidemq` registry. See the [glide-mq docs](https://github.com/avifenesh/glide-mq) for details.

## Configuration

```ts
interface GlideMQPluginOptions {
  connection?: ConnectionOptions; // Required unless testing: true
  queues?: Record<string, QueueConfig>;
  producers?: Record<string, ProducerConfig>;
  prefix?: string;    // Valkey key prefix (default: "glide")
  testing?: boolean;  // In-memory mode, no Valkey needed
}
```

Route access control via `GlideMQRoutesOptions`:

```ts
await server.register({
  plugin: glideMQRoutes,
  options: {
    prefix: "/api/queues",
    allowedQueues: ["emails"],
    allowedProducers: ["emails"],
  },
});
```

## Testing

```ts
import { createTestApp } from "@glidemq/hapi/testing";

const { server } = await createTestApp({
  emails: { processor: async (job) => ({ sent: true }) },
});

const res = await server.inject({
  method: "POST",
  url: "/emails/jobs",
  payload: { name: "welcome", data: { to: "user@test.com" } },
});
// res.statusCode === 201

await server.stop();
```

## Limitations

- No built-in authentication. Add Hapi auth strategies or gateway-level controls separately.
- `addAndWait` (`POST /{name}/jobs/wait`) is not available in testing mode.
- Producers are not supported in testing mode.

## Links

- [glide-mq](https://github.com/avifenesh/glide-mq) - core library
- [Full documentation](https://avifenesh.github.io/glide-mq.dev/integrations/hapi)
- [Issues](https://github.com/avifenesh/glidemq-hapi/issues)
- [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | [@glidemq/fastify](https://github.com/avifenesh/glidemq-fastify) | [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard)

## License

[Apache-2.0](./LICENSE)
