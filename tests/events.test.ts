import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { buildTestApp } from './helpers/test-app';

describe('SSE events (testing mode)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns SSE content-type', async () => {
    const { server } = await buildTestApp({
      emails: {
        processor: async (_job: any) => ({ sent: true }),
      },
    });

    // SSE requires a real HTTP connection since inject() waits for res.end()
    await server.start();
    cleanup = () => server.stop();

    const address = `http://localhost:${(server.info as any).port}`;

    const { statusCode, contentType } = await new Promise<{ statusCode: number; contentType: string }>(
      (resolve, reject) => {
        const req = http.get(`${address}/emails/events`, (res) => {
          resolve({
            statusCode: res.statusCode!,
            contentType: res.headers['content-type'] ?? '',
          });
          res.destroy(); // Close immediately, we only need headers
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      },
    );

    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
  });

  it('returns 404 for unconfigured queue', async () => {
    const { server } = await buildTestApp({ emails: {} });
    cleanup = () => server.stop();

    const res = await server.inject({
      method: 'GET',
      url: '/unknown/events',
    });
    expect(res.statusCode).toBe(404);
  });
});
