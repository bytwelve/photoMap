import { describe, expect, it } from 'vitest';
import type { LibrarySnapshot, ScanProgress } from '../../src/shared/contracts';
import {
  applyScanProgress,
  isTerminalScanProgress,
  LibraryRefreshCoordinator,
  preferLibrarySnapshot,
  shouldOfferScanMetadataLocations,
} from '../../src/renderer/library-state';

function progress(status: ScanProgress['status'], runId = 'run-1', sourceId = 'source-1'): ScanProgress {
  return {
    runId,
    sourceId,
    status,
    counts: { discovered: 3, indexed: 2, unchanged: 0, errors: 1 },
  };
}

function snapshot(revision: number, status: ScanProgress['status'], runId = 'run-1', sourceId = 'source-1'): LibrarySnapshot {
  return {
    source: { sourceId, displayName: sourceId, availability: 'available' },
    photos: [],
    photoTypes: [],
    scan: progress(status, runId, sourceId),
    catalogRevision: revision,
  };
}

describe('renderer library snapshot priority', () => {
  it('prd_fr_007__offers_the_overwrite_decision_only_for_successful_scans_with_resolved_locations_and_only_once', () => {
    const withMetadata = {
      ...progress('succeeded'),
      metadata: {
        examined: 3,
        exifCount: 2,
        gpsCount: 1,
        resolvedLocationCount: 1,
        captureTimeCount: 0,
        metadataErrorCount: 0,
      },
    };
    expect(shouldOfferScanMetadataLocations(withMetadata)).toBe(true);
    expect(shouldOfferScanMetadataLocations(withMetadata, new Set(['run-1']))).toBe(false);
    expect(shouldOfferScanMetadataLocations({ ...withMetadata, status: 'cancelled' })).toBe(false);
    expect(shouldOfferScanMetadataLocations({ ...withMetadata, status: 'failed' })).toBe(false);
    expect(shouldOfferScanMetadataLocations({ ...withMetadata, metadata: undefined })).toBe(false);
    expect(shouldOfferScanMetadataLocations({
      ...withMetadata,
      metadata: { ...withMetadata.metadata, resolvedLocationCount: 0 },
    })).toBe(false);
    expect(shouldOfferScanMetadataLocations({
      ...withMetadata,
      metadata: {
        ...withMetadata.metadata,
        exifCount: 3,
        gpsCount: 0,
        resolvedLocationCount: 0,
      },
    })).toBe(false);
  });

  it('offers_metadata_confirmation_for_capture_times_without_locations_and_skips_empty_candidates', () => {
    const withCaptureTimes = {
      ...progress('succeeded'),
      metadata: {
        examined: 3,
        exifCount: 2,
        gpsCount: 0,
        resolvedLocationCount: 0,
        captureTimeCount: 2,
        metadataErrorCount: 0,
      },
    };

    expect(shouldOfferScanMetadataLocations(withCaptureTimes)).toBe(true);
    expect(shouldOfferScanMetadataLocations({
      ...withCaptureTimes,
      metadata: { ...withCaptureTimes.metadata, captureTimeCount: 0 },
    })).toBe(false);
  });

  it('keeps a higher catalog revision when an older async result resolves later', () => {
    const current = snapshot(8, 'succeeded');
    const stale = snapshot(7, 'running');
    expect(preferLibrarySnapshot(current, stale)).toBe(current);
  });

  it('does not replace terminal progress with running state from the same run', () => {
    const current = snapshot(8, 'partial');
    const stale = snapshot(8, 'running');
    expect(preferLibrarySnapshot(current, stale, new Set(['run-1']))).toBe(current);
    expect(applyScanProgress(current, progress('running'), new Set(['run-1']))).toBe(current);
  });

  it('accepts a terminal state and a newer revision', () => {
    const running = snapshot(7, 'running');
    const terminal = snapshot(8, 'partial');
    expect(preferLibrarySnapshot(running, terminal)).toBe(terminal);
    expect(isTerminalScanProgress(terminal.scan)).toBe(true);
  });

  it('ignores late progress from a different source', () => {
    const current = snapshot(9, 'running', 'run-new', 'source-new');
    const staleProgress = progress('failed', 'run-old', 'source-old');
    expect(applyScanProgress(current, staleProgress)).toBe(current);
  });

  it('does not switch sources on an equal-revision late terminal snapshot', () => {
    const current = snapshot(9, 'running', 'run-new', 'source-new');
    const stale = snapshot(9, 'succeeded', 'run-old', 'source-old');
    expect(preferLibrarySnapshot(current, stale)).toBe(current);
  });

  it('coalesces running catalog refreshes into bounded first-and-batch reads with one in flight', async () => {
    const coordinator = new LibraryRefreshCoordinator();
    const terminalRunIds = new Set<string>();
    const startedAt: number[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const runningAt = (processed: number): ScanProgress => ({
      ...progress('running'),
      counts: { discovered: 64, indexed: processed, unchanged: 0, errors: 0 },
      catalogCommitCount: processed < 17 ? 1 : processed < 33 ? 17 : 33,
    });
    const taskAt = (processed: number) => async (): Promise<void> => {
      startedAt.push(processed);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
    };

    coordinator.requestRunning(runningAt(1), terminalRunIds, taskAt(1));
    coordinator.requestRunning(runningAt(1), terminalRunIds, taskAt(1));
    await Promise.resolve();
    expect(startedAt).toEqual([1]);

    for (let processed = 2; processed <= 40; processed += 1) {
      coordinator.requestRunning(runningAt(processed), terminalRunIds, taskAt(processed));
    }
    expect(startedAt).toEqual([1]);
    releases.shift()?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(startedAt).toEqual([1, 33]);

    terminalRunIds.add('run-1');
    coordinator.requestTerminal(progress('succeeded'), taskAt(65));
    releases.shift()?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(startedAt).toEqual([1, 33, 65]);
    expect(maxActive).toBe(1);
    releases.shift()?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('rejects lower processed running progress and preserves terminal state from late snapshots', () => {
    const current = snapshot(8, 'running');
    current.scan.counts = { discovered: 4, indexed: 3, unchanged: 0, errors: 0 };
    const staleProgress = progress('running');
    staleProgress.counts = { discovered: 4, indexed: 1, unchanged: 0, errors: 0 };
    expect(applyScanProgress(current, staleProgress)).toBe(current);

    const terminal = snapshot(8, 'succeeded');
    const lateRunningWithNewCatalog = snapshot(9, 'running');
    const merged = preferLibrarySnapshot(terminal, lateRunningWithNewCatalog, new Set(['run-1']));
    expect(merged.catalogRevision).toBe(9);
    expect(merged.scan.status).toBe('succeeded');
  });
});
