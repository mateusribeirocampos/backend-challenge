import { describe, expect, test } from 'bun:test';
import { countRequests, RequestRecorder } from '../../../load/http-load.js';

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
