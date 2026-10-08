/**
 * Open loop: start a task every 1000 / perSecond ms, without waiting for the previous one.
 * If the system slows down, tasks overlap instead of the offered rate dropping, so a slow
 * answer cannot hide the requests that should have been sent meanwhile (the closed-loop
 * "coordinated omission" problem). Resolves when every started task finished.
 */
export async function runAtFixedRate(
  perSecond: number,
  durationMs: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  const startMs = Date.now();
  const intervalMs = 1000 / perSecond;
  const started: Promise<void>[] = [];
  for (let index = 0; ; index += 1) {
    const scheduledMs = startMs + index * intervalMs;
    if (scheduledMs >= startMs + durationMs) break;
    await Bun.sleep(Math.max(0, scheduledMs - Date.now()));
    started.push(task(index));
  }
  await Promise.all(started);
}
