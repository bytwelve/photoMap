import { useCallback, useEffect, useRef, useState } from 'react';
import { type LibrarySnapshot, type ScanProgress as ContractScanProgress } from '../../shared/contracts';
import { errorMessage, unwrapResult } from '../bridge';
import type { OperationFeedback } from '../model';
import { applyScanProgress, isTerminalScanProgress, LibraryRefreshCoordinator, preferLibrarySnapshot } from '../library-state';



export function useLibraryScan(announce: (message: string, kind?: OperationFeedback['kind']) => void) {
  const [rawLibrary, setRawLibrary] = useState<LibrarySnapshot>();

  const terminalRunIdsRef = useRef(new Set<string>());

  const terminalRefreshKeysRef = useRef(new Set<string>());

  const libraryRefreshCoordinatorRef = useRef(new LibraryRefreshCoordinator());

  const activeSourceIdRef = useRef<string | null>(null);

  const pendingSourceChangeRef = useRef(false);

  const acceptLibrarySnapshot = useCallback((candidate: LibrarySnapshot): void => {
    setRawLibrary((current) => preferLibrarySnapshot(current, candidate, terminalRunIdsRef.current));
  }, []);

  const reloadAfterTerminal = useCallback((progress: ContractScanProgress): void => {
    if (!isTerminalScanProgress(progress)) return;
    if (progress.runId) terminalRunIdsRef.current.add(progress.runId);
    const key = `${progress.sourceId ?? 'none'}:${progress.runId ?? 'none'}:${progress.status}`;
    if (terminalRefreshKeysRef.current.has(key)) return;
    terminalRefreshKeysRef.current.add(key);
    libraryRefreshCoordinatorRef.current.requestTerminal(progress, async () => {
      try {
        acceptLibrarySnapshot(unwrapResult(await window.photoMap.getLibrary()));
      } catch (error) {
        announce(`扫描已结束，但目录刷新失败：${errorMessage(error)}`, 'warning');
      }
    });
  }, [acceptLibrarySnapshot, announce]);

  const reloadDuringScan = useCallback((progress: ContractScanProgress): void => {
    libraryRefreshCoordinatorRef.current.requestRunning(
      progress,
      terminalRunIdsRef.current,
      async () => {
        try {
          acceptLibrarySnapshot(unwrapResult(await window.photoMap.getLibrary()));
        } catch {
          // A later batch or the mandatory terminal refresh retries this read.
        }
      },
    );
  }, [acceptLibrarySnapshot]);

  useEffect(() => {
    activeSourceIdRef.current = rawLibrary?.source?.sourceId ?? null;
  }, [rawLibrary?.source?.sourceId]);

  useEffect(() => {
    const unsubscribe = window.photoMap.subscribeScanProgress((progress: ContractScanProgress) => {
      if (isTerminalScanProgress(progress) && progress.runId) terminalRunIdsRef.current.add(progress.runId);
      setRawLibrary((current) => applyScanProgress(current, progress, terminalRunIdsRef.current));
      const activeSourceId = activeSourceIdRef.current;
      const relevantSource = pendingSourceChangeRef.current
        || !activeSourceId
        || !progress.sourceId
        || progress.sourceId === activeSourceId;
      if (relevantSource && progress.status === 'running') reloadDuringScan(progress);
      if (relevantSource && isTerminalScanProgress(progress)) {
        reloadAfterTerminal(progress);
      }
    });
    return unsubscribe;
  }, [reloadAfterTerminal, reloadDuringScan]);

  return { rawLibrary, setRawLibrary, acceptLibrarySnapshot, reloadAfterTerminal, pendingSourceChangeRef };
}
