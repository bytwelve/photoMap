import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreferencesSaveQueue } from '../../src/renderer/preferences-save';
import { defaultAppSettings } from '../../src/shared/settings';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('preference saves before closing', () => {
  it('flushes the latest UI change immediately before the 450 ms debounce expires', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const queue = new PreferencesSaveQueue(write, vi.fn());
    queue.schedule(defaultAppSettings());
    const latest = { ...defaultAppSettings(), mode: 'memory' as const };
    queue.schedule(latest);
    expect(write).not.toHaveBeenCalled();
    await queue.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith(latest);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledOnce();
  });

  it('submits the final settings immediately and waits for every in-flight save', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const last = deferred();
    const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const queue = new PreferencesSaveQueue(write, vi.fn());
    queue.schedule(defaultAppSettings());
    await vi.advanceTimersByTimeAsync(450);
    const latest = { ...defaultAppSettings(), mode: 'batch' as const };
    queue.schedule(latest);
    let closed = false;
    const closing = queue.flush().then(() => { closed = true; });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(latest);
    expect(closed).toBe(false);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenLastCalledWith(latest);
    expect(closed).toBe(false);
    last.resolve();
    await closing;
    expect(closed).toBe(true);
  });

  it('reports a failed save and settles the flush, then accepts a later successful save', async () => {
    vi.useFakeTimers();
    const error = new Error('Disk is read-only');
    const report = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const queue = new PreferencesSaveQueue(write, report);
    queue.schedule(defaultAppSettings());
    await expect(queue.flush()).rejects.toBe(error);
    expect(report).toHaveBeenCalledWith(error);
    queue.schedule({ ...defaultAppSettings(), mode: 'batch' });
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
