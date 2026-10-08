import { describe, expect, test } from 'bun:test';
import { countRequests, RequestRecorder, timedPost } from '../../../load/http-load.js';

const sample = (status: number, startedAtMs = 1000) => ({ startedAtMs, latencyMs: 5, status });

describe('countRequests', () => {
  test('classes: 2xx accepted, 422 business answer, 503 apart from other 5xx, 0 = no answer at all', () => {
    const counts = countRequests([
      sample(201),
      sample(201),
      sample(200),
      sample(202),
      sample(422),
      sample(503),
      sample(500),
      sample(409),
      sample(0),
    ]);

    expect(counts).toEqual({
      total: 9,
      accepted: 4,
      businessRejections: 1,
      unavailable: 1,
      otherServerErrors: 1,
      otherClientErrors: 1,
      networkErrors: 1,
      byStatus: { '200': 1, '201': 2, '202': 1, '409': 1, '422': 1, '500': 1, '503': 1, network: 1 },
    });
  });
});

describe('RequestRecorder.inWindow', () => {
  test('keeps the requests STARTED in [start, end): warm-up and the tail after the window are out', () => {
    const recorder = new RequestRecorder();
    for (const startedAtMs of [999, 1000, 1500, 1999, 2000]) recorder.record(sample(201, startedAtMs));

    expect(recorder.inWindow(1000, 2000).map((each) => each.startedAtMs)).toEqual([1000, 1500, 1999]);
  });
});

describe('timedPost', () => {
  function serve(status: number, body: string, contentType: string) {
    return Bun.serve({ port: 0, fetch: () => new Response(body, { status, headers: { 'content-type': contentType } }) });
  }

  test('an answer whose body is not JSON is ONE sample with its status, not also a network error', async () => {
    const server = serve(502, '<html>bad gateway</html>', 'text/html');
    try {
      const recorder = new RequestRecorder();
      const answer = await timedPost(`http://127.0.0.1:${server.port}`, '/x', {}, {}, recorder);

      expect(recorder.inWindow(0, Number.MAX_SAFE_INTEGER).map((each) => each.status)).toEqual([502]);
      expect(answer?.status).toBe(502);
      expect(answer?.body).toEqual({});
    } finally {
      server.stop(true);
    }
  });

  test('a JSON answer keeps its body; no answer at all is one network error', async () => {
    const server = serve(201, '{"status":"PROCESSED"}', 'application/json');
    const recorder = new RequestRecorder();
    try {
      const answer = await timedPost(`http://127.0.0.1:${server.port}`, '/x', {}, {}, recorder);
      expect(answer?.body).toEqual({ status: 'PROCESSED' });
    } finally {
      server.stop(true);
    }
    expect(await timedPost('http://127.0.0.1:1', '/x', {}, {}, recorder)).toBeUndefined();

    expect(recorder.inWindow(0, Number.MAX_SAFE_INTEGER).map((each) => each.status)).toEqual([201, 0]);
  });
});
