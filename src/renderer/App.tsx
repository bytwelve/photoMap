import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SpinnerGap, WarningCircle } from '@phosphor-icons/react';
import { MEDIA_KINDS, type ScanLocationDecision, type ScanMetadataSummary, type WindowAction } from '../shared/contracts';
import { CITIES, PROVINCES } from '../shared/administrative-regions';
import { errorMessage, isAppError, regionNamesFromOptions, toLibraryState, unwrapResult } from './bridge';
import { activeFiltersForMode, filterPhotos, intersectSelection, isWallEligiblePhoto, sortAnnotationPhotosByCreationTime, type PostcardEntryOrigin, wallPhotoSelectionKey } from './domain';
import type { AppMode, MapSnapshot, SelectedRegion, WallPhotoSelections } from './model';
import { BatchView } from './features/batch/BatchView';
import { trashResultFeedback } from './features/batch/trash-feedback';
import { ContextSidebar } from './components/ContextSidebar';
import { ExportDialog, TrashConfirmation } from './features/export/ExportDialog';
import { PostcardView } from './features/postcard/PostcardView';
import { MapDataSetup } from './components/MapDataSetup';
import { PhotoWall } from './features/photo-wall/PhotoWall';
import { ScanMetadataDialog } from './components/ScanMetadataDialog';
import { EmptySource, Header, StatusBar, Toast } from './components/Shell';
import { LeftSidebar } from './components/LeftSidebar';
import { isTerminalScanProgress, shouldOfferScanMetadataLocations } from './library-state';
import { normalizeAppSettings, rendererPreferencesFromSettings, safeDefaultSettings } from './settings';
import { useFeedback } from './hooks/useFeedback';
import { useAppPreferences, EMPTY_FILTERS } from './hooks/useAppPreferences';
import { useLibraryScan } from './hooks/useLibraryScan';
import { usePhotoActions } from './hooks/usePhotoActions';
import { useMapData } from './hooks/useMapData';
import { readWallAppInfo, wallMapGate } from './map-data-state';

const ADMINISTRATIVE_REGION_NAMES = regionNamesFromOptions(PROVINCES, CITIES);

interface MetadataPrompt {
  runId: string;
  total: number;
  summary: ScanMetadataSummary;
}

export function App(): React.JSX.Element {
  const { feedback, announce } = useFeedback();
  const { mode, setMode, filters, setFilters, mapPreference, setMapPreference, setSettingsReady } = useAppPreferences(announce);
  const { rawLibrary, setRawLibrary, acceptLibrarySnapshot, reloadAfterTerminal, pendingSourceChangeRef } = useLibraryScan(announce);
  const { createType, updateLocation, updateTypes, updateNote, updateCaptureTime, renamePhoto } = usePhotoActions({ acceptLibrarySnapshot, setRawLibrary, announce });
  const { provinces, cities, appInfo, setAppInfo, appInfoError, setAppInfoError, mapError, mapDataBusy, loadMapCollections, clearMapCollections, importMapData, openMapDownload } = useMapData(announce);

  const [startupError, setStartupError] = useState<string>();

  const [loading, setLoading] = useState(true);

  const [sourceBusy, setSourceBusy] = useState(false);

  const [selectedRegion, setSelectedRegion] = useState<SelectedRegion>();

  const [activePhotoId, setActivePhotoId] = useState<string>();

  const [postcardEntryOrigin, setPostcardEntryOrigin] = useState<PostcardEntryOrigin>();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [wallPhotoSelections, setWallPhotoSelections] = useState<WallPhotoSelections>(() => new Map());

  const [wallSnapshot, setWallSnapshot] = useState<MapSnapshot>();

  const [exportOpen, setExportOpen] = useState(false);

  const [trashRequest, setTrashRequest] = useState<readonly string[]>();

  const [trashBusy, setTrashBusy] = useState(false);

  const [metadataPrompt, setMetadataPrompt] = useState<MetadataPrompt>();

  const [pendingMetadataDecision, setPendingMetadataDecision] = useState<ScanLocationDecision>();

  const promptedMetadataRunIdsRef = useRef(new Set<string>());

  const modeTransitionRevisionRef = useRef(0);

  const library = useMemo(
    () => rawLibrary ? toLibraryState(rawLibrary, ADMINISTRATIVE_REGION_NAMES) : undefined,
    [rawLibrary],
  );

  const allPhotos = library?.photos ?? [];

  const activeFilters = useMemo(() => activeFiltersForMode(filters, mode), [filters, mode]);

  const filteredPhotos = useMemo(() => filterPhotos(allPhotos, activeFilters), [activeFilters, allPhotos]);

  const wallPhotos = useMemo(() => allPhotos.filter(isWallEligiblePhoto), [allPhotos]);

  const annotationPhotos = useMemo(
    () => sortAnnotationPhotosByCreationTime(filteredPhotos),
    [filteredPhotos],
  );

  const activePhoto = annotationPhotos.find((photo) => photo.id === activePhotoId) ?? annotationPhotos[0];

  const selectedRegionFixedPhotoIds = selectedRegion
    ? wallPhotoSelections.get(wallPhotoSelectionKey(selectedRegion.level, selectedRegion.code)) ?? []
    : [];

  const completePostcardEntry = useCallback((): void => {
    setPostcardEntryOrigin(undefined);
  }, []);

  const loadApplication = useCallback(async (): Promise<void> => {
    setLoading(true);
    setSettingsReady(false);
    setStartupError(undefined);
    setAppInfoError(undefined);
    const libraryPromise = window.photoMap.getLibrary();
    const infoPromise = window.photoMap.getAppInfo();
    const settingsPromise = window.photoMap.getSettings();
    const [libraryResult, infoResult, settingsResult] = await Promise.allSettled([
      libraryPromise,
      infoPromise,
      settingsPromise,
    ]);
    if (libraryResult.status === 'fulfilled') {
      try { acceptLibrarySnapshot(unwrapResult(libraryResult.value)); } catch (error) { setStartupError(errorMessage(error)); }
    } else {
      setStartupError(errorMessage(libraryResult.reason));
    }
    if (infoResult.status === 'fulfilled' && infoResult.value.ok) {
      setAppInfo(infoResult.value.value);
      setAppInfoError(undefined);
      await loadMapCollections(infoResult.value.value.mapData);
    } else {
      setAppInfo(undefined);
      clearMapCollections();
      let reason = '应用信息暂时不可用';
      if (infoResult.status === 'rejected') reason = errorMessage(infoResult.reason);
      else if (!infoResult.value.ok) reason = infoResult.value.error.userMessage;
      setAppInfoError(reason);
      setStartupError((current) => current ?? reason);
    }
    if (settingsResult.status === 'fulfilled' && settingsResult.value.ok) {
      const preferences = rendererPreferencesFromSettings(normalizeAppSettings(settingsResult.value.value));
      setMode(preferences.mode);
      setFilters(preferences.filters);
      setMapPreference(preferences.map);
    } else {
      const preferences = rendererPreferencesFromSettings(safeDefaultSettings());
      setMode(preferences.mode);
      setFilters(preferences.filters);
      setMapPreference(preferences.map);
      let reason = '设置内容无效';
      if (settingsResult.status === 'rejected') reason = errorMessage(settingsResult.reason);
      else if (!settingsResult.value.ok) reason = settingsResult.value.error.userMessage;
      announce(`设置加载失败，已使用安全默认值：${reason}`, 'warning');
    }
    setSettingsReady(true);
    setLoading(false);
  }, [acceptLibrarySnapshot, announce, clearMapCollections, loadMapCollections]);

  useEffect(() => { void loadApplication(); }, [loadApplication]);

  useEffect(() => {
    const progress = rawLibrary?.scan;
    if (progress === undefined) return;

    const metadataDecisionIsCurrent = shouldOfferScanMetadataLocations(progress);
    setMetadataPrompt((current) =>
      current !== undefined
        && (current.runId !== progress.runId || !metadataDecisionIsCurrent)
        ? undefined
        : current,
    );
    const metadata = progress.metadata;
    if (
      !shouldOfferScanMetadataLocations(progress, promptedMetadataRunIdsRef.current)
      || progress.runId === null
      || metadata === undefined
    ) {
      return;
    }
    promptedMetadataRunIdsRef.current.add(progress.runId);
    setMetadataPrompt({
      runId: progress.runId,
      total: metadata.examined,
      summary: metadata,
    });
  }, [rawLibrary?.scan]);

  useEffect(() => {
    if (annotationPhotos.length === 0) {
      if (activePhotoId) setActivePhotoId(undefined);
      return;
    }
    if (!activePhotoId || !annotationPhotos.some((photo) => photo.id === activePhotoId)) {
      setActivePhotoId(annotationPhotos[0]?.id);
    }
  }, [activePhotoId, annotationPhotos]);

  useEffect(() => {
    const next = intersectSelection(selectedIds, filteredPhotos);
    const removed = selectedIds.size - next.size;
    if (removed > 0) {
      setSelectedIds(next);
      announce(`筛选变化后，已从选择中移除 ${removed} 项媒体`, 'info');
    }
  }, [filteredPhotos]);

  async function chooseSource(): Promise<void> {
    setSourceBusy(true);
    setMetadataPrompt(undefined);
    pendingSourceChangeRef.current = true;
    try {
      const result = unwrapResult(await window.photoMap.chooseLibrary());
      if (!result.cancelled) {
        acceptLibrarySnapshot(result.library);
        if (isTerminalScanProgress(result.library.scan)) void reloadAfterTerminal(result.library.scan);
        setFilters(EMPTY_FILTERS);
        setSelectedIds(new Set());
        setWallPhotoSelections(new Map());
        announce(`已选择“${result.library.source?.displayName ?? '照片文件夹'}”`);
      }
    } catch (error) {
      announce(errorMessage(error), 'error');
      if (!rawLibrary?.source) setStartupError(errorMessage(error));
    } finally {
      pendingSourceChangeRef.current = false;
      setSourceBusy(false);
    }
  }

  async function refreshSource(): Promise<void> {
    try {
      const result = unwrapResult(await window.photoMap.refreshLibrary());
      acceptLibrarySnapshot(result.library);
      if (isTerminalScanProgress(result.library.scan)) void reloadAfterTerminal(result.library.scan);
      const failed = result.library.scan.counts.errors
        + (result.library.scan.metadata?.metadataErrorCount ?? 0);
      announce(
        failed > 0 ? `扫描部分完成：${failed} 项异常，其余媒体已可使用` : '增量扫描完成',
        failed > 0 ? 'warning' : 'success',
      );
    } catch (error) {
      announce(errorMessage(error), 'error');
      try {
        acceptLibrarySnapshot(unwrapResult(await window.photoMap.getLibrary()));
      } catch {
        // The original refresh error is more useful; a failed recovery read is non-destructive.
      }
    }
  }

  async function cancelScan(): Promise<void> {
    try {
      const result = unwrapResult(await window.photoMap.cancelScan());
      acceptLibrarySnapshot(result.library);
      if (isTerminalScanProgress(result.library.scan)) void reloadAfterTerminal(result.library.scan);
      announce(result.cancelled ? '扫描已安全取消，已完成结果仍会保留' : '当前没有可取消的扫描', 'info');
    } catch (error) {
      announce(errorMessage(error), 'error');
    }
  }

  async function resolveMetadataLocations(decision: ScanLocationDecision): Promise<void> {
    if (!metadataPrompt) return;
    setPendingMetadataDecision(decision);
    try {
      const result = unwrapResult(await window.photoMap.resolveScanLocations({
        runId: metadataPrompt.runId,
        decision,
      }));
      acceptLibrarySnapshot(result.library);
      if (decision === 'overwrite-all-resolved' || decision === 'fill-unlabeled-only') {
        const action = decision === 'overwrite-all-resolved' ? '更新' : '补充';
        const details = [
          `地址 ${result.locations.succeeded} 张`,
          `拍摄时间 ${result.captureTimes.succeeded} 张`,
          ...(result.locations.skipped + result.captureTimes.skipped > 0
            ? [`跳过 ${result.locations.skipped + result.captureTimes.skipped} 项`]
            : []),
        ];
        announce(`已${action}扫描到的照片信息：${details.join('，')}`);
      } else {
        announce('已忽略本次扫描到的 GPS 与拍摄时间，保留现有信息', 'info');
      }
      setMetadataPrompt(undefined);
    } catch (error) {
      if (isAppError(error) && error.code === 'INVALID_REQUEST') {
        setMetadataPrompt(undefined);
        try {
          acceptLibrarySnapshot(unwrapResult(await window.photoMap.getLibrary()));
        } catch {
          // The original stale-decision message remains the actionable feedback.
        }
      }
      announce(errorMessage(error), 'error');
    } finally {
      setPendingMetadataDecision(undefined);
    }
  }

  function changeMode(nextMode: AppMode, preservePostcardEntry = false): void {
    const revision = modeTransitionRevisionRef.current + 1;
    modeTransitionRevisionRef.current = revision;
    if (!preservePostcardEntry) setPostcardEntryOrigin(undefined);
    if (nextMode !== 'wall') {
      setMode(nextMode);
      return;
    }

    void (async () => {
      const result = await readWallAppInfo(() => window.photoMap.getAppInfo());
      if (modeTransitionRevisionRef.current !== revision) return;
      if (!result.ok) {
        setAppInfoError(result.error);
        clearMapCollections();
        setMode('wall');
        announce(`地图数据状态刷新失败：${result.error}`, 'error');
        return;
      }

      setAppInfo(result.appInfo);
      setAppInfoError(undefined);
      await loadMapCollections(result.appInfo.mapData);
      if (modeTransitionRevisionRef.current === revision) setMode('wall');
    })();
  }

  function openPostcardFromBatch(id: string, origin?: PostcardEntryOrigin): void {
    setActivePhotoId(id);
    if (!origin) {
      changeMode('memory');
      return;
    }
    setPostcardEntryOrigin(origin);
    changeMode('memory', true);
  }

  async function confirmTrash(): Promise<void> {
    const ids = trashRequest;
    if (!ids?.length) return;
    setTrashBusy(true);
    try {
      const result = unwrapResult(await window.photoMap.trashPhotos({ photoIds: [...ids], confirmed: true }));
      acceptLibrarySnapshot(result.library);
      const movedIds = new Set(result.items.filter((item) => item.status === 'moved').map((item) => item.photoId));
      setSelectedIds((current) => new Set([...current].filter((id) => !movedIds.has(id))));
      const feedback = trashResultFeedback(result.items);
      announce(feedback.message, feedback.tone);
      setTrashRequest(undefined);
    } catch (error) {
      announce(errorMessage(error), 'error');
    } finally {
      setTrashBusy(false);
    }
  }

  function clearFilters(): void {
    setFilters({ search: '', locationCodes: new Set(), includeUnlocated: false, mediaKinds: new Set(MEDIA_KINDS), folderPaths: new Set(), typeIds: new Set() });
  }

  function selectOnlyRegion(code: string): void {
    setFilters((current) => ({ ...current, search: '', locationCodes: new Set([code]), includeUnlocated: false }));
  }

  function manageRegion(code: string): void {
    selectOnlyRegion(code);
    changeMode('batch');
  }

  function carouselRegion(code: string): void {
    selectOnlyRegion(code);
    changeMode('memory');
  }

  function updateWallFixedPhotos(region: SelectedRegion, photoIds: readonly string[]): void {
    const uniquePhotoIds = [...new Set(photoIds)];
    const key = wallPhotoSelectionKey(region.level, region.code);
    setWallPhotoSelections((current) => {
      const next = new Map(current);
      if (uniquePhotoIds.length === 0) next.delete(key);
      else next.set(key, uniquePhotoIds);
      return next;
    });
    announce(
      uniquePhotoIds.length === 0
        ? `已恢复${region.name}的自动选片，仅照片墙显示会变化`
        : `已为${region.name}固定 ${uniquePhotoIds.length} 张照片，仅影响照片墙显示`,
      'info',
    );
  }

  function openExportDialog(): void {
    if (!wallSnapshot) return;
    setExportOpen(true);
  }

  function closeExportDialog(): void {
    setExportOpen(false);
  }

  async function windowAction(action: WindowAction): Promise<void> {
    try {
      unwrapResult(await window.photoMap.windowAction(action));
    } catch (error) {
      announce(errorMessage(error), 'error');
    }
  }

  const receiveWallSnapshot = useCallback((snapshot: MapSnapshot): void => {
    setWallSnapshot(snapshot);
  }, []);

  const wallViewportSize = (): { width: number; height: number } => {
    const bounds = document.querySelector<HTMLCanvasElement>('[data-testid="wall-canvas"]')?.getBoundingClientRect();
    return { width: bounds?.width ?? 1200, height: bounds?.height ?? 720 };
  };

  if (loading) {
    return (
      <div className="desktop-app boot-screen">
        <Header mode={mode} onModeChange={changeMode} onWindowAction={(action) => void windowAction(action)} />
        <main><SpinnerGap className="spin" size={34} /><strong>正在打开本地照片地图</strong><span>校验索引与离线地图包…</span></main>
      </div>
    );
  }

  const mapGate = wallMapGate(mode, appInfo, appInfoError);

  if (mapGate === 'app-info-error') {
    return (
      <div className="desktop-app" data-testid="app-shell">
        <Header mode={mode} onModeChange={changeMode} onWindowAction={(action) => void windowAction(action)} />
        <main className="fatal-screen" data-testid="map-data-info-error">
          <WarningCircle size={36} />
          <strong>无法确认地图数据状态</strong>
          <span>{appInfoError ?? '应用信息暂时不可用，请重试。'}</span>
          <button type="button" onClick={() => void loadApplication()}>重试</button>
        </main>
        <Toast feedback={feedback} />
      </div>
    );
  }

  if (mapGate === 'map-data-setup' && appInfo !== undefined) {
    return (
      <div className="desktop-app" data-testid="app-shell">
        <Header mode={mode} onModeChange={changeMode} onWindowAction={(action) => void windowAction(action)} />
        <MapDataSetup
          status={appInfo.mapData}
          busy={mapDataBusy}
          onDownload={() => void openMapDownload()}
          onImport={() => void importMapData()}
        />
        <footer className="empty-status"><span>完全离线 · 地图与照片不上传</span><span>版本 {appInfo.version}</span></footer>
        <Toast feedback={feedback} />
      </div>
    );
  }

  if (!rawLibrary?.source) {
    return (
      <div className="desktop-app" data-testid="app-shell">
        <Header mode={mode} onModeChange={changeMode} onWindowAction={(action) => void windowAction(action)} />
        <EmptySource busy={sourceBusy} error={startupError} onChoose={() => void chooseSource()} onRetry={() => void loadApplication()} />
        <footer className="empty-status"><span>完全离线 · 照片不上传</span>{appInfo?.version && <span>版本 {appInfo.version}</span>}</footer>
        <Toast feedback={feedback} />
      </div>
    );
  }

  if (!library) {
    return <div className="fatal-screen"><WarningCircle size={36} /><strong>本地索引暂时不可用</strong><button type="button" onClick={() => void loadApplication()}>重试</button></div>;
  }

  return (
    <div className="desktop-app" data-testid="app-shell">
      <Header mode={mode} onModeChange={changeMode} onWindowAction={(action) => void windowAction(action)} />
      {!library.sourceAvailable && <div className="source-unavailable-banner"><WarningCircle size={16} /><span>当前照片文件夹不可访问；上次索引仍保留。可重新选择文件夹或重试扫描。</span><button type="button" onClick={() => void chooseSource()}>重新选择</button></div>}
      <div className={[
        'app-body',
        library.sourceAvailable ? '' : 'has-banner',
        mode === 'memory' ? 'postcard-layout' : '',
      ].filter(Boolean).join(' ')}>
        <LeftSidebar
          mode={mode}
          sourceName={library.sourceName ?? '照片文件夹'}
          sourceAvailable={library.sourceAvailable}
          photos={mode === 'wall' ? wallPhotos : allPhotos}
          mediaKindPhotos={allPhotos}
          photoTypes={library.photoTypes}
          provinces={PROVINCES}
          cities={CITIES}
          scan={library.scan}
          filters={filters}
          onFiltersChange={setFilters}
          onChooseSource={() => void chooseSource()}
          onRefresh={() => void refreshSource()}
          onCancelScan={() => void cancelScan()}
          onCreateType={createType}
          onOpenExport={openExportDialog}
        />

        {mode === 'wall' && (
          <PhotoWall
            provinces={provinces}
            cities={cities}
            mapError={mapError}
            photos={filteredPhotos}
            fixedPhotoSelections={wallPhotoSelections}
            selectedRegion={selectedRegion}
            mapPreference={mapPreference}
            onMapPreferenceChange={setMapPreference}
            onSelectedRegionChange={setSelectedRegion}
            onSnapshotChange={receiveWallSnapshot}
          />
        )}
        {mode === 'memory' && (
          <PostcardView
            photos={annotationPhotos}
            activeId={activePhoto?.id}
            provinces={PROVINCES}
            cities={CITIES}
            photoTypes={library.photoTypes}
            onActiveIdChange={setActivePhotoId}
            onClearFilters={clearFilters}
            onGoBatch={() => changeMode('batch')}
            onUpdateLocation={updateLocation}
            onUpdateTypes={updateTypes}
            onUpdateNote={updateNote}
            onUpdateCaptureTime={updateCaptureTime}
            onRenamePhoto={renamePhoto}
            onRequestTrash={setTrashRequest}
            entryOrigin={postcardEntryOrigin}
            onEntryAnimationComplete={completePostcardEntry}
          />
        )}
        {mode === 'batch' && (
          <BatchView
            photos={annotationPhotos}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            onSelectionMessage={(message) => announce(message, 'info')}
            onClearFilters={clearFilters}
            onGoCarousel={() => changeMode('memory')}
            onOpenPostcard={openPostcardFromBatch}
            onPostcardEntrySettled={completePostcardEntry}
          />
        )}

        {mode !== 'memory' && (
          <ContextSidebar
            mode={mode}
            allPhotos={allPhotos}
            filteredPhotos={mode === 'batch' ? annotationPhotos : filteredPhotos}
            activePhoto={activePhoto}
            selectedIds={selectedIds}
            selectedRegion={selectedRegion}
            wallFixedPhotoIds={selectedRegionFixedPhotoIds}
            provinces={PROVINCES}
            cities={CITIES}
            photoTypes={library.photoTypes}
            onUpdateLocation={updateLocation}
            onUpdateTypes={updateTypes}
            onClearSelection={() => setSelectedIds(new Set())}
            onRequestTrash={setTrashRequest}
            onOnlyRegion={selectOnlyRegion}
            onManageRegion={manageRegion}
            onCarouselRegion={carouselRegion}
            onWallFixedPhotosChange={updateWallFixedPhotos}
          />
        )}
      </div>
      <StatusBar
        count={mode === 'wall' ? wallPhotos.length : allPhotos.length}
        unitLabel={mode === 'wall' ? '张可用照片' : '项媒体'}
        scan={library.scan}
        version={appInfo?.version}
      />
      {exportOpen && wallSnapshot && <ExportDialog snapshot={wallSnapshot} viewportSize={wallViewportSize()} onClose={closeExportDialog} onSaved={(message) => announce(message)} />}
      {trashRequest && <TrashConfirmation count={trashRequest.length} busy={trashBusy} onCancel={() => setTrashRequest(undefined)} onConfirm={() => void confirmTrash()} />}
      {metadataPrompt && (
        <ScanMetadataDialog
          total={metadataPrompt.total}
          exifCount={metadataPrompt.summary.exifCount}
          gpsCount={metadataPrompt.summary.gpsCount}
          resolvedLocationCount={metadataPrompt.summary.resolvedLocationCount}
          captureTimeCount={metadataPrompt.summary.captureTimeCount}
          metadataErrorCount={metadataPrompt.summary.metadataErrorCount}
          busy={pendingMetadataDecision !== undefined}
          pendingDecision={pendingMetadataDecision}
          onDecision={(decision) => void resolveMetadataLocations(decision)}
        />
      )}
      <Toast feedback={feedback} />
    </div>
  );
}
