# @glidemq/hapi

[![npm](https://img.shields.io/npm/v/@glidemq/hapi)](https://www.npmjs.com/package/@glidemq/hapi)
[![license](https://img.shields.io/npm/l/@glidemq/hapi)](https://github.com/avifenesh/glidemq-hapi/blob/main/LICENSE)

Hapi v21 plugin that turns [glide-mq](https://github.com/avifenesh/glide-mq) queues into a REST API with real-time SSE. Works as a general-purpose job queue API and as an AI orchestration layer with built-in usage tracking, budget monitoring, flow orchestration over HTTP, streaming endpoints, queue-wide usage summaries, and broadcast pub/sub over HTTP.

## Why

- **Zero route boilerplate** - declare queues, get job CRUD, metrics, schedulers, and SSE endpoints
- **Testable without Valkey** - `createTestApp` builds an in-memory Hapi server for `server.inject()` assertions
- **Joi validation** - all request bodies and query params validated with structured error messages

## Install

```bash
npm install @glidemq/hapi glide-mq @hapi/hapi joi
```

Requires **glide-mq >= 0.14.0** and **Hapi 21+**.

## Quick start

```ts
import Hapi from "@hapi/hapi";
import { glideMQPlugin } from "@glidemq/hapi";

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
    routes: true, // mounts REST + SSE endpoints
  },
});

await server.start();
// POST /emails/jobs to enqueue, GET /emails/events for SSE
```

`glideMQPlugin` creates a registry on `server.glidemq` and optionally mounts routes. The `onPostStop` hook handles graceful shutdown.

## AI-native endpoints

glide-mq 0.14+ provides AI orchestration primitives - token/cost tracking, real-time streaming, human-in-the-loop suspend/signal, model failover chains, budget caps, dual-axis rate limiting, and vector search. This plugin exposes them as REST/SSE endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/{name}/flows/{id}/usage` | Aggregated token/cost usage for a flow |
| `GET` | `/{name}/flows/{id}/budget` | Budget status and remaining limits for a flow |
| `POST` | `/flows` | Create a tree flow or DAG over HTTP with `{ flow, budget? }` or `{ dag }` |
| `GET` | `/flows/{id}` | Inspect a flow snapshot with nodes, roots, counts, usage, and budget |
| `GET` | `/flows/{id}/tree` | Inspect the nested tree view for a submitted tree flow or DAG |
| `DELETE` | `/flows/{id}` | Revoke or flag remaining jobs in a flow and delete the HTTP flow record |
| `GET` | `/usage/summary` | Rolling usage totals across one or more queues |
| `GET` | `/{name}/jobs/{id}/stream` | SSE stream of a job's output chunks |
| `POST` | `/broadcast/{name}` | Publish a broadcast message with `subject` + payload |
| `GET` | `/broadcast/{name}/events?subscription=...` | Durable SSE stream for a broadcast subscription |

Job serialization includes AI fields when present: `usage`, `signals`, `budgetKey`, `fallbackIndex`, `tpmTokens`. SSE events include `usage`, `suspended`, and `budget-exceeded` event types.
HTTP-submitted budgets are currently supported for tree flows only, not DAG payloads.

All AI features are also accessible programmatically via the `server.glidemq` registry. See the [glide-mq docs](https://github.com/avifenesh/glide-mq) for details.

## Configuration

```ts
interface GlideMQPluginOptions {
  connection?: ConnectionOptions; // Required unless testing: true
  queues?: Record<string, QueueConfig>;
  producers?: Record<string, ProducerConfig>;
  prefix?: string;    // Valkey key prefix (default: "glide")
  testing?: boolean;  // In-memory mode, no Valkey needed
  routes?: boolean | GlideMQRoutesOptions; // Mount REST + SSE endpoints
}
```

Route access control via `GlideMQRoutesOptions`:

```ts
await server.register({
  plugin: glideMQPlugin,
  options: {
    connection: { addresses: [{ host: "localhost", port: 6379 }] },
    queues: { emails: { processor: async (job) => ({ sent: true }) } },
    routes: {
      queues: ["emails"],    // restrict to specific queues
      producers: ["emails"], // restrict to specific producers
    },
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
- `/flows*`, `/usage/summary`, and `/broadcast/*` require a live connection and are not available in testing mode.
- Producers are not supported in testing mode.

## Links

- [glide-mq](https://github.com/avifenesh/glide-mq) - core library
- [Full documentation](https://glidemq.dev/integrations/hapi)
- [Issues](https://github.com/avifenesh/glidemq-hapi/issues)
- [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | [@glidemq/fastify](https://github.com/avifenesh/glidemq-fastify) | [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard)

## License

[Apache-2.0](./LICENSE)
