# @glidemq/hapi

[![npm](https://img.shields.io/npm/v/@glidemq/hapi)](https://www.npmjs.com/package/@glidemq/hapi)
[![license](https://img.shields.io/npm/l/@glidemq/hapi)](https://github.com/avifenesh/glidemq-hapi/blob/main/LICENSE)

REST API and real-time SSE for [glide-mq](https://github.com/avifenesh/glide-mq) job queues, as a Hapi.js plugin. Two registrations -- declare queues, get 21 endpoints.

Turns a Hapi v21 server into a queue management gateway. Built for teams that run Hapi in production and need to expose queue operations to dashboards, CLI tools, or other services.

## Why @glidemq/hapi

- Use this when you need HTTP endpoints to manage glide-mq queues without writing route handlers yourself.
- Use this when you want live SSE streams of job events for dashboards or monitoring.
- Use this when serverless functions only need to enqueue jobs through lightweight Producer endpoints.
- Use this when you need to test queue logic in CI without a running Valkey instance.

## Install

```bash
npm install @glidemq/hapi glide-mq @hapi/hapi
```

Optional: `npm install zod`

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
          console.log("Sending to", job.data.to);
          return { sent: true };
        },
      },
    },
  },
});

await server.register({ plugin: glideMQRoutes });
await server.start();
```

The server now accepts `POST /emails/jobs` to enqueue jobs and `GET /emails/events` for live SSE. See the full endpoint table below.

## How it works

`glideMQPlugin` creates a `QueueRegistry`, decorates `server.glidemq` so every route handler can access it, eagerly initializes configured producers, and registers an `onPostStop` hook that closes all queues, workers, and producers on shutdown. `glideMQRoutes` depends on the core plugin and mounts 21 REST endpoints under an optional path prefix. Queue and worker instances are created lazily on first request; producers are created eagerly so connection errors surface at startup.

## Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/{name}/jobs` | Add a job to a queue |
| POST | `/{name}/jobs/wait` | Add a job and wait for result |
| GET | `/{name}/jobs` | List jobs by state |
| GET | `/{name}/jobs/{id}` | Get a single job |
| POST | `/{name}/jobs/{id}/priority` | Change job priority |
| POST | `/{name}/jobs/{id}/delay` | Change job delay |
| POST | `/{name}/jobs/{id}/promote` | Promote a delayed job |
| GET | `/{name}/counts` | Get job counts by state |
| GET | `/{name}/metrics` | Get completed or failed metrics |
| POST | `/{name}/pause` | Pause a queue |
| POST | `/{name}/resume` | Resume a paused queue |
| POST | `/{name}/drain` | Drain all waiting jobs |
| POST | `/{name}/retry` | Retry failed jobs |
| DELETE | `/{name}/clean` | Clean old completed or failed jobs |
| GET | `/{name}/workers` | List active workers |
| POST | `/{name}/produce` | Add a job via Producer |
| GET | `/{name}/schedulers` | List all schedulers |
| GET | `/{name}/schedulers/{schedulerName}` | Get a single scheduler |
| PUT | `/{name}/schedulers/{schedulerName}` | Upsert a scheduler |
| DELETE | `/{name}/schedulers/{schedulerName}` | Remove a scheduler |
| GET | `/{name}/events` | SSE event stream |

## Features

- **SSE event streaming** -- subscribe to `completed`, `failed`, `progress`, `active`, `waiting`, `stalled`, and `heartbeat` events on any queue via `GET /{name}/events`. Uses `PassThrough` streams with shared `QueueEvents` instances (ref-counted per queue).
- **Lightweight producers** -- configure `producers` for serverless or edge environments that only need to enqueue jobs. The `POST /{name}/produce` endpoint returns a job ID without requiring a worker.
- **Scheduler CRUD** -- create, read, update, and delete repeatable jobs through four endpoints. Supports cron patterns, fixed intervals, and `repeatAfterComplete` mode.
- **Testing without Valkey** -- `createTestApp` from `@glidemq/hapi/testing` spins up an in-memory server backed by `TestQueue` and `TestWorker`. Use `server.inject()` for assertions with no external dependencies.
- **Optional Zod validation** -- when `zod` is installed, all request bodies and query parameters are validated with structured error messages. Without it, the plugin falls back to manual checks.
- **Queue access control** -- pass `allowedQueues` or `allowedProducers` arrays in `GlideMQRoutesOptions` to restrict which queues the API exposes. Requests to unlisted queues return 404.
- **Route prefix** -- set `prefix` in `GlideMQRoutesOptions` to mount all 21 endpoints under a path like `/api/queues`.
- **Automatic cleanup** -- the `onPostStop` lifecycle hook closes workers first (to drain in-progress jobs), then queues and producers, using `Promise.allSettled` for reliability.

## Configuration

```ts
interface GlideMQPluginOptions {
  connection?: ConnectionOptions; // Required unless testing: true
  queues?: Record<string, QueueConfig>;
  producers?: Record<string, ProducerConfig>;
  prefix?: string;       // Key prefix for Valkey keys (default: 'glide')
  testing?: boolean;     // Use TestQueue/TestWorker, no Valkey needed
  serializer?: Serializer;
}

interface QueueConfig {
  processor?: (job: Job) => Promise<any>; // Omit for producer-only queues
  concurrency?: number;                   // Default: 1
  workerOpts?: Record<string, unknown>;
}

interface ProducerConfig {
  compression?: "none" | "gzip";
  serializer?: Serializer;
}
```

```ts
interface GlideMQRoutesOptions {
  queues?: string[];     // Restrict API to these queue names
  producers?: string[];  // Restrict produce API to these producer names
  prefix?: string;       // Route path prefix (e.g. '/api/queues')
}
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
expect(res.statusCode).toBe(201);

await server.stop();
```

## Direct registry access

```ts
server.route({
  method: "GET",
  path: "/pending-count",
  handler: async (request, h) => {
    const { queue } = request.server.glidemq.get("emails");
    const counts = await queue.getJobCounts();
    return h.response({ waiting: counts.waiting });
  },
});
```

## Limitations

- Requires a running Valkey or Redis instance for production use. Testing mode uses in-memory stubs only.
- No built-in authentication or authorization. Add Hapi auth strategies or gateway-level controls separately.
- `addAndWait` (the `POST /{name}/jobs/wait` endpoint) is not available in testing mode because `TestQueue` does not support it.
- Producers are not supported in testing mode. Use queue-based endpoints for test assertions.

## Ecosystem

| Package | Description |
|---------|-------------|
| [glide-mq](https://github.com/avifenesh/glide-mq) | Core queue library |
| [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | Hono REST + SSE middleware |
| [@glidemq/fastify](https://github.com/avifenesh/glidemq-fastify) | Fastify REST + SSE plugin |
| [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | NestJS module with decorators |
| [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard) | Web UI for queue monitoring |

## Contributing

Issues and pull requests are welcome at [github.com/avifenesh/glidemq-hapi](https://github.com/avifenesh/glidemq-hapi). Run `npm test` before submitting. See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

Apache-2.0
