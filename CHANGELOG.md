# Changelog

## 0.1.0

- Initial release
- Hapi plugin (`glideMQPlugin`) with registry decoration and lifecycle management
- REST API routes plugin (`glideMQRoutes`) with 21 endpoints
- SSE event streaming via PassThrough stream
- Optional Zod validation with manual fallback
- Testing mode with `createTestApp` helper (no Valkey needed)
- Queue access control via `allowedQueues` / `allowedProducers`
- Route prefix support
