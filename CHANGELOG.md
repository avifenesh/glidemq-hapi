# Changelog

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
