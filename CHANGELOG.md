# Changelog

## 0.4.0

- Expand the Hapi routes surface to track glide-mq 0.15.0: queue-wide events SSE, per-job lifecycle SSE, `jobs/wait`, workers, metrics, scheduler CRUD, usage summary, broadcast publish/SSE, DLQ inspection/replay, suspended-job inspection, revoke, and queue global rate-limit management.
- Add flow HTTP routes for `POST /flows`, `GET /flows/:id`, `GET /flows/:id/tree`, and `DELETE /flows/:id`.
- Require glide-mq >=0.15.0 for the new flow and proxy-parity endpoints.

## 0.3.0

- Added AI-native endpoints: flow usage, flow budget, job stream SSE
- Added AI fields to job serialization: `usage`, `signals`, `budgetKey`, `fallbackIndex`, `tpmTokens`
- Added AI event types to SSE: `usage`, `suspended`, `budget-exceeded`
- Added `serializer` option to `GlideMQConfig` and `ProducerConfig`
- Updated README to reflect merged routes API

## 0.2.0

- Migrated validation from Zod to Joi (native Hapi ecosystem)
- Merged `glideMQRoutes` into `glideMQPlugin` via `routes` option
- Added Boom error responses
- Added request decoration (`request.glidemq`)
- Removed dead `pfx` route prefix variable
- Added `.unknown(true)` to queue and producer config schemas for forward compatibility
- Fixed `package-lock.json` sync for CI
- Updated README to reflect Joi migration

## 0.1.0

- Initial release
- Hapi plugin (`glideMQPlugin`) with registry decoration and lifecycle management
- REST API routes plugin (`glideMQRoutes`) with 21 endpoints
- SSE event streaming via PassThrough stream
- Testing mode with `createTestApp` helper (no Valkey needed)
- Queue access control via `allowedQueues` / `allowedProducers`
- Route prefix support
