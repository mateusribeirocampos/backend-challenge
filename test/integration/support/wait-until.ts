/**
 * Polls a condition until it holds or the time is up. Used instead of "sleep and hope":
 * the test moves on as soon as the state it needs exists, and fails with the
 * description if it never does.
 */
export async function waitUntil(
  description: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting until ${description}`);
}
