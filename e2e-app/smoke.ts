/**
 * Smoke test: real Hapi server with local glide-mq + Valkey.
 *
 * Usage: npx tsx e2e-app/smoke.ts
 *
 * Requires a running Valkey/Redis on localhost:6379.
 */

import Hapi from '@hapi/hapi';
import http from 'http';
import { glideMQPlugin, glideMQRoutes, QueueRegistryImpl } from '../src/index';
import { Queue } from 'glide-mq';

const CONNECTION = { addresses: [{ host: 'localhost', port: 6379 }] };
const QUEUE_NAME = '__hapi_smoke_test__';

// ── Helpers ──────────────────────────────────────────────────────────────

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function get(url: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: JSON.parse(data) });
      });
    }).on('error', reject);
  });
}

// ── Cleanup helper ───────────────────────────────────────────────────────

async function flushQueue() {
  const q = new Queue(QUEUE_NAME, { connection: CONNECTION });
  try {
    await q.drain();
    await q.clean(0, 1000, 'completed' as any);
    await q.clean(0, 1000, 'failed' as any);
  } finally {
    await q.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 @glidemq/hapi smoke test\n');

  // 0. Flush any leftover state
  await flushQueue();

  // 1. Create Hapi server with real Valkey connection
  const server = Hapi.server({ port: 0, host: 'localhost' });

  await server.register({
    plugin: glideMQPlugin,
    options: {
      connection: CONNECTION,
      queues: {
        [QUEUE_NAME]: {
          processor: async (job) => {
            return { processed: true, echo: job.data };
          },
          concurrency: 2,
        },
      },
    },
  });

  await server.register({
    plugin: glideMQRoutes,
    options: { prefix: '/api' },
  });

  await server.start();
  const base = `http://localhost:${server.info.port}/api`;
  console.log(`  Server started on ${server.info.uri}\n`);

  try {
    // ── Test 1: Add a job via REST ────────────────────────────────────
    console.log('--- Test 1: Add a job ---');
    const addRes = await server.inject({
      method: 'POST',
      url: `/api/${QUEUE_NAME}/jobs`,
      payload: { name: 'smoke-job', data: { hello: 'world' } },
    });
    assert(addRes.statusCode === 201, `POST /jobs returned ${addRes.statusCode} (expected 201)`);
    const addedJob = JSON.parse(addRes.payload);
    assert(!!addedJob.id, `Job has id: ${addedJob.id}`);
    assert(addedJob.name === 'smoke-job', `Job name is smoke-job`);
    assert(addedJob.data.hello === 'world', `Job data preserved`);
    console.log();

    // ── Test 2: Get job by ID ─────────────────────────────────────────
    console.log('--- Test 2: Get job by ID ---');
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/${QUEUE_NAME}/jobs/${addedJob.id}`,
    });
    assert(getRes.statusCode === 200, `GET /jobs/${addedJob.id} returned 200`);
    const fetchedJob = JSON.parse(getRes.payload);
    assert(fetchedJob.id === addedJob.id, `Fetched job matches`);
    console.log();

    // ── Test 3: Get counts ────────────────────────────────────────────
    console.log('--- Test 3: Job counts ---');
    const countsRes = await server.inject({
      method: 'GET',
      url: `/api/${QUEUE_NAME}/counts`,
    });
    assert(countsRes.statusCode === 200, `GET /counts returned 200`);
    const counts = JSON.parse(countsRes.payload);
    assert(typeof counts.waiting === 'number', `Has waiting count: ${counts.waiting}`);
    assert(typeof counts.active === 'number', `Has active count: ${counts.active}`);
    assert(typeof counts.completed === 'number', `Has completed count: ${counts.completed}`);
    console.log();

    // ── Test 4: List jobs ─────────────────────────────────────────────
    console.log('--- Test 4: List jobs ---');
    const listRes = await server.inject({
      method: 'GET',
      url: `/api/${QUEUE_NAME}/jobs?type=waiting`,
    });
    assert(listRes.statusCode === 200, `GET /jobs?type=waiting returned 200`);
    const jobs = JSON.parse(listRes.payload);
    assert(Array.isArray(jobs), `Response is an array`);
    console.log();

    // ── Test 5: Wait for processing and check completed ───────────────
    console.log('--- Test 5: Wait for processing ---');
    // Add a second job and give the worker time to process
    await server.inject({
      method: 'POST',
      url: `/api/${QUEUE_NAME}/jobs`,
      payload: { name: 'smoke-job-2', data: { seq: 2 } },
    });

    // Wait a bit for the worker to process
    await new Promise((r) => setTimeout(r, 2000));

    const counts2Res = await server.inject({
      method: 'GET',
      url: `/api/${QUEUE_NAME}/counts`,
    });
    const counts2 = JSON.parse(counts2Res.payload);
    assert(counts2.completed >= 1, `At least 1 completed job (got ${counts2.completed})`);
    console.log();

    // ── Test 6: Get workers ───────────────────────────────────────────
    console.log('--- Test 6: Get workers ---');
    const workersRes = await server.inject({
      method: 'GET',
      url: `/api/${QUEUE_NAME}/workers`,
    });
    assert(workersRes.statusCode === 200, `GET /workers returned 200`);
    const workers = JSON.parse(workersRes.payload);
    assert(Array.isArray(workers), `Workers is an array (length: ${workers.length})`);
    console.log();

    // ── Test 7: Pause and resume ──────────────────────────────────────
    console.log('--- Test 7: Pause and resume ---');
    const pauseRes = await server.inject({ method: 'POST', url: `/api/${QUEUE_NAME}/pause` });
    assert(pauseRes.statusCode === 204, `POST /pause returned 204`);

    const resumeRes = await server.inject({ method: 'POST', url: `/api/${QUEUE_NAME}/resume` });
    assert(resumeRes.statusCode === 204, `POST /resume returned 204`);
    console.log();

    // ── Test 8: Clean completed jobs ──────────────────────────────────
    console.log('--- Test 8: Clean completed jobs ---');
    const cleanRes = await server.inject({
      method: 'DELETE',
      url: `/api/${QUEUE_NAME}/clean?type=completed&grace=0&limit=100`,
    });
    assert(cleanRes.statusCode === 200, `DELETE /clean returned 200`);
    const cleanBody = JSON.parse(cleanRes.payload);
    assert(typeof cleanBody.removed === 'number', `Removed ${cleanBody.removed} jobs`);
    console.log();

    // ── Test 9: 404 for unknown queue ─────────────────────────────────
    console.log('--- Test 9: 404 for unknown queue ---');
    const unknownRes = await server.inject({
      method: 'GET',
      url: `/api/nonexistent/counts`,
    });
    assert(unknownRes.statusCode === 404, `GET /nonexistent/counts returned 404`);
    console.log();

    // ── Test 10: 400 for invalid queue name ───────────────────────────
    console.log('--- Test 10: Invalid queue name ---');
    const invalidRes = await server.inject({
      method: 'GET',
      url: `/api/bad!name/counts`,
    });
    assert(invalidRes.statusCode === 400, `GET /bad!name/counts returned 400`);
    console.log();

    // ── Test 11: SSE event stream ─────────────────────────────────────
    console.log('--- Test 11: SSE event stream ---');
    const { statusCode: sseStatus, contentType: sseCT } = await new Promise<{
      statusCode: number;
      contentType: string;
    }>((resolve, reject) => {
      const req = http.get(`${base}/${QUEUE_NAME}/events`, (res) => {
        resolve({
          statusCode: res.statusCode!,
          contentType: res.headers['content-type'] ?? '',
        });
        res.destroy();
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('SSE timeout'));
      });
    });
    assert(sseStatus === 200, `SSE returned 200`);
    assert(sseCT.includes('text/event-stream'), `SSE content-type is text/event-stream`);
    console.log();

    // ── Test 12: Direct registry access ───────────────────────────────
    console.log('--- Test 12: Direct registry access ---');
    const registry = server.glidemq;
    assert(registry.testing === false, `Registry is not in testing mode`);
    assert(registry.has(QUEUE_NAME), `Registry has queue "${QUEUE_NAME}"`);
    const managed = registry.get(QUEUE_NAME);
    assert(!!managed.queue, `Managed queue exists`);
    assert(!!managed.worker, `Managed worker exists`);
    console.log();

    // ── Test 13: Add and wait ─────────────────────────────────────────
    console.log('--- Test 13: Add and wait ---');
    const waitRes = await server.inject({
      method: 'POST',
      url: `/api/${QUEUE_NAME}/jobs/wait`,
      payload: { name: 'wait-job', data: { msg: 'sync' }, waitTimeout: 10000 },
    });
    assert(waitRes.statusCode === 200, `POST /jobs/wait returned 200`);
    const waitBody = JSON.parse(waitRes.payload);
    assert(waitBody.returnvalue !== undefined, `returnvalue present: ${JSON.stringify(waitBody.returnvalue)}`);
    console.log();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ALL 13 TESTS PASSED');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } finally {
    // Cleanup
    await flushQueue();
    await server.stop();
    console.log('\n  Server stopped. Cleanup complete.\n');
  }
}

main().catch((err) => {
  console.error('\n❌ SMOKE TEST FAILED:', err.message);
  process.exit(1);
});
