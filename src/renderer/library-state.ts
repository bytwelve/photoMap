import type { LibrarySnapshot, ScanProgress, ScanStatus } from '../shared/contracts';

const TERMINAL_SCAN_STATUSES = new Set<ScanStatus>([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);

export function isTerminalScanProgress(progress: ScanProgress): boolean {
  return TERMINAL_SCAN_STATUSES.has(progress.status);
}

export function shouldOfferScanMetadataLocations(
  progress: ScanProgress,
  promptedRunIds: ReadonlySet<string> = new Set(),
): boolean {
  return (progress.status === 'succeeded' || progress.status === 'partial')
    && progress.runId !== null
    && progress.metadata !== undefined
    && (
      progress.metadata.resolvedLocationCount > 0
      || progress.metadata.captureTimeCount > 0
    )
    && !promptedRunIds.has(progress.runId);
}

export function scanProcessedCount(progress: ScanProgress): number {
  return progress.counts.indexed + progress.counts.unchanged + progress.counts.errors;
}

type LibraryRefreshTask = () => Promise<void>;

interface PendingLibraryRefresh {
  progress: ScanProgress;
  task: LibraryRefreshTask;
  terminalRunIds?: ReadonlySet<string>;
}

interface RunningRefreshState {
  maxCatalogCommitCount: number;
}

export class LibraryRefreshCoordinator {
  private readonly runningStateByRun = new Map<string, RunningRefreshState>();
  private inFlight = false;
  private pendingRunning: PendingLibraryRefresh | undefined;
  private pendingTerminal: PendingLibraryRefresh | undefined;

  public requestRunning(
    progress: ScanProgress,
    terminalRunIds: ReadonlySet<string>,
    task: LibraryRefreshTask,
  ): void {
    if (progress.status !== 'running' || !progress.runId || terminalRunIds.has(progress.runId)) {
      return;
    }
    const catalogCommitCount = progress.catalogCommitCount ?? 0;
    if (catalogCommitCount <= 0) return;

    const key = `${progress.sourceId ?? 'none'}:${progress.runId}`;
    const state = this.runningStateByRun.get(key) ?? {
      maxCatalogCommitCount: 0,
    };
    if (catalogCommitCount <= state.maxCatalogCommitCount) return;
    state.maxCatalogCommitCount = catalogCommitCount;
    this.runningStateByRun.set(key, state);

    const request: PendingLibraryRefresh = { progress, task, terminalRunIds };
    if (this.inFlight) {
      this.pendingRunning = request;
      return;
    }
    this.start(request);
  }

  public requestTerminal(progress: ScanProgress, task: LibraryRefreshTask): void {
    if (progress.runId !== null) {
      this.runningStateByRun.delete(`${progress.sourceId ?? 'none'}:${progress.runId}`);
    }
    const request: PendingLibraryRefresh = { progress, task };
    if (this.inFlight) {
      this.pendingTerminal = request;
      return;
    }
    this.start(request);
  }

  private start(request: PendingLibraryRefresh): void {
    this.inFlight = true;
    void Promise.resolve()
      .then(request.task)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
        const terminal = this.pendingTerminal;
        this.pendingTerminal = undefined;
        if (terminal !== undefined) {
          this.pendingRunning = undefined;
          this.start(terminal);
          return;
        }
        const running = this.pendingRunning;
        this.pendingRunning = undefined;
        if (
          running !== undefined
          && running.progress.runId !== null
          && !running.terminalRunIds?.has(running.progress.runId)
        ) {
          this.start(running);
        }
      });
  }
}

function scanStatusRank(status: ScanStatus): number {
  if (TERMINAL_SCAN_STATUSES.has(status)) return 2;
  if (status === 'running') return 1;
  return 0;
}

export function preferLibrarySnapshot(
  current: LibrarySnapshot | undefined,
  candidate: LibrarySnapshot,
  terminalRunIds: ReadonlySet<string> = new Set(),
): LibrarySnapshot {
  if (!current) return candidate;
  const candidateRunId = candidate.scan.runId;
  const sameRun = current.scan.runId !== null && current.scan.runId === candidateRunId;
  const staleRunningState = candidate.scan.status === 'running'
    && candidateRunId !== null
    && (terminalRunIds.has(candidateRunId)
      || (sameRun && isTerminalScanProgress(current.scan)));
  if (staleRunningState) {
    return candidate.catalogRevision > current.catalogRevision && sameRun
      ? { ...candidate, scan: current.scan }
      : current;
  }
  if (
    sameRun
    && current.scan.status === 'running'
    && candidate.scan.status === 'running'
    && scanProcessedCount(candidate.scan) < scanProcessedCount(current.scan)
  ) {
    return candidate.catalogRevision > current.catalogRevision
      ? { ...candidate, scan: current.scan }
      : current;
  }
  if (candidate.catalogRevision > current.catalogRevision) return candidate;
  if (candidate.catalogRevision < current.catalogRevision) return current;

  if (
    candidate.scan.status === 'running'
    && candidateRunId
    && terminalRunIds.has(candidateRunId)
  ) return current;

  const currentSourceId = current.source?.sourceId ?? null;
  const candidateSourceId = candidate.source?.sourceId ?? null;
  if (currentSourceId !== candidateSourceId) {
    if (currentSourceId && !candidateSourceId) return current;
    if (currentSourceId && candidateSourceId) return current;
    return candidate;
  }

  if (current.scan.runId && current.scan.runId === candidateRunId) {
    const currentRank = scanStatusRank(current.scan.status);
    const candidateRank = scanStatusRank(candidate.scan.status);
    if (candidateRank < currentRank) return current;
  }
  return candidate;
}

export function applyScanProgress(
  current: LibrarySnapshot | undefined,
  progress: ScanProgress,
  terminalRunIds: ReadonlySet<string> = new Set(),
): LibrarySnapshot | undefined {
  if (!current) return current;
  const currentSourceId = current.source?.sourceId ?? null;
  if (progress.sourceId && currentSourceId && progress.sourceId !== currentSourceId) return current;
  if (
    progress.status === 'running'
    && progress.runId
    && terminalRunIds.has(progress.runId)
  ) return current;
  if (
    current.scan.runId
    && current.scan.runId === progress.runId
    && isTerminalScanProgress(current.scan)
    && !isTerminalScanProgress(progress)
  ) return current;
  if (
    current.scan.runId
    && current.scan.runId === progress.runId
    && current.scan.status === 'running'
    && progress.status === 'running'
    && scanProcessedCount(progress) < scanProcessedCount(current.scan)
  ) return current;
  return { ...current, scan: progress };
}
