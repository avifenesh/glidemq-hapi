# Changelog

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
