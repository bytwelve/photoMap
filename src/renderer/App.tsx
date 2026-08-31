import { useEffect, useState } from 'react';
import type { LibrarySnapshot, WindowAction, ScanLocationDecision, MapDataStatus } from '../shared/contracts';
import { PROVINCES, CITIES } from '../shared/administrative-regions';
import { errorMessage, regionNamesFromOptions, toLibraryState, unwrapResult } from './bridge';
import { PHOTO_MAP_ASSETS, DEFAULT_APP_SETTINGS } from '../shared/contracts';
import type { MapSnapshot, RegionCollection, SelectedRegion, WallPhotoSelections } from './model';
import type { RendererMapPreference } from './settings';
import { PhotoWall } from './features/photo-wall/PhotoWall';
import { loadRegionCollection } from './map-scene/scene';
import { ExportDialog } from './features/export/ExportDialog';
import { MapDataSetup } from './components/MapDataSetup';
import { PostcardPlayableMedia } from './features/postcard/PostcardMedia';

const names = regionNamesFromOptions(PROVINCES, CITIES);

export function App(): React.JSX.Element {
  const [raw, setRaw] = useState<LibrarySnapshot>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [version, setVersion] = useState('');
  const [query, setQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [province, setProvince] = useState('');
  const [city, setCity] = useState('');
  const [typeId, setTypeId] = useState('');
  const [newType, setNewType] = useState('');
  const [mode, setMode] = useState<'batch' | 'wall' | 'memory'>('wall');
  const [provinces, setProvinces] = useState<RegionCollection>();
  const [cities, setCities] = useState<RegionCollection>();
  const [mapError, setMapError] = useState('');
  const [mapPreference, setMapPreference] = useState<RendererMapPreference>(DEFAULT_APP_SETTINGS.map);
  const [selectedRegion, setSelectedRegion] = useState<SelectedRegion>();
  const [fixedPhotos, setFixedPhotos] = useState<WallPhotoSelections>(new Map());
  const [activeId, setActiveId] = useState('');
  const [snapshot, setSnapshot] = useState<MapSnapshot>();
  const [exportOpen, setExportOpen] = useState(false);
  const [mapData, setMapData] = useState<MapDataStatus>();
  const [mapBusy, setMapBusy] = useState(false);
  const [dismissedRun, setDismissedRun] = useState<string>();
  const [note, setNote] = useState('');
  const [autoPlay, setAutoPlay] = useState(false);
  const [mediaFilter, setMediaFilter] = useState('all');

  async function execute(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await work(); } catch (error) { setFeedback(errorMessage(error)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    void execute(async () => {
      setRaw(unwrapResult(await window.photoMap.getLibrary()));
      const info = unwrapResult(await window.photoMap.getAppInfo());
      setVersion(info.version);
      setMapData(info.mapData);
      if (info.mapData.ready) await loadMaps();
    });
    return window.photoMap.subscribeScanProgress((scan) => {
      setRaw((current) => current ? { ...current, scan } : current);
      if (scan.status !== 'running' && scan.status !== 'idle') {
        void execute(async () => { setRaw(unwrapResult(await window.photoMap.getLibrary())); });
      }
    });
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 7000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const library = raw ? toLibraryState(raw, names) : undefined;
  const allPhotos = library?.photos ?? [];
  const photos = allPhotos.filter((photo) => {
    const locationMatch = !locationFilter || (locationFilter === 'unlocated' ? !photo.location : photo.location?.provinceCode === locationFilter || photo.location?.cityCode === locationFilter);
    return locationMatch && (!typeFilter || photo.types.some((tag) => tag.id === typeFilter))
      && (!query || [photo.name, photo.location?.provinceName, photo.location?.cityName, ...photo.types.map((tag) => tag.name)].some((value) => value?.includes(query)))
      && (mediaFilter === 'all' || photo.mediaKind === mediaFilter)
      ;
  });
  useEffect(() => {
    const visible = new Set(photos.map((photo) => photo.id));
    setSelected((current) => new Set([...current].filter((id) => visible.has(id))));
  }, [raw, query, locationFilter, typeFilter, mediaFilter]);

  function togglePhoto(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function updateLocation(): Promise<void> {
    await execute(async () => {
      const result = unwrapResult(await window.photoMap.updateLocations({ photoIds: [...selected], location: province ? { provinceGb: province, ...(city ? { cityGb: city } : {}) } : null }));
      setRaw(result.library);
      setFeedback(`已更新 ${result.succeeded} 张照片的地点，失败 ${result.failed} 张`);
    });
  }

  async function updateTypes(remove: boolean): Promise<void> {
    if (!typeId) return;
    await execute(async () => {
      const result = unwrapResult(await window.photoMap.updateTypes({ photoIds: [...selected], addTypeIds: remove ? [] : [typeId], removeTypeIds: remove ? [typeId] : [] }));
      setRaw(result.library);
      setFeedback(`已更新 ${result.succeeded} 张照片的类型`);
    });
  }

  async function createType(): Promise<void> {
    if (!newType.trim()) return;
    await execute(async () => {
      const created = unwrapResult(await window.photoMap.createType({ name: newType.trim() }));
      setRaw(unwrapResult(await window.photoMap.getLibrary()));
      setTypeId(created.typeId);
      setNewType('');
    });
  }

  async function trashSelection(): Promise<void> {
    if (selected.size === 0 || !window.confirm(`将 ${selected.size} 项源文件移入 Windows 回收站？`)) return;
    await execute(async () => {
      const result = unwrapResult(await window.photoMap.trashPhotos({ photoIds: [...selected], confirmed: true }));
      setRaw(result.library);
      setSelected(new Set());
      setFeedback(`已移入回收站 ${result.items.filter((item) => item.status === 'moved').length} 项`);
    });
  }

  async function loadMaps(): Promise<void> {
    try {
      const [provinceData, cityData] = await Promise.all([loadRegionCollection(PHOTO_MAP_ASSETS.provinceMap), loadRegionCollection(PHOTO_MAP_ASSETS.cityMap)]);
      setProvinces(provinceData);
      setCities(cityData);
      setMapError('');
    } catch (error) { setMapError(errorMessage(error)); }
  }

  function fixSelectedPhotos(): void {
    if (!selectedRegion) return;
    const key = `${selectedRegion.level}:${selectedRegion.code}`;
    setFixedPhotos((current) => new Map(current).set(key, [...selected]));
    setFeedback(`已固定 ${selected.size} 张照片`);
  }
  const activeIndex = Math.max(0, photos.findIndex((photo) => photo.id === activeId));
  const active = photos[activeIndex];
  const previous = photos[activeIndex - 1];
  const next = photos[activeIndex + 1];

  function navigate(direction: number): void {
    const target = photos[Math.max(0, Math.min(photos.length - 1, activeIndex + direction))];
    if (target) setActiveId(target.id);
  }

  useEffect(() => {
    if (mode !== 'memory') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === 'ArrowLeft') navigate(-1);
      if (event.key === 'ArrowRight') navigate(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, activeIndex, photos]);

  async function importMaps(): Promise<void> {
    setMapBusy(true);
    try {
      const result = unwrapResult(await window.photoMap.importMapData());
      setMapData(result.status);
      if (result.status.ready) await loadMaps();
      if (result.rejected.length) setFeedback(`有 ${result.rejected.length} 份地图未通过校验`);
      if (result.status.ready && result.accepted.length > 0 && raw?.source) {
        setRaw(unwrapResult(await window.photoMap.refreshLibrary()).library);
      }
    } catch (error) { setFeedback(errorMessage(error)); }
    finally { setMapBusy(false); }
  }

  const scan = raw?.scan;
  const metadataPrompt = scan?.metadata && scan.runId && scan.runId !== dismissedRun && (scan.status === 'succeeded' || scan.status === 'partial') && scan.metadata.examined > 0 ? scan : undefined;

  async function resolveMetadata(decision: ScanLocationDecision): Promise<void> {
    if (!metadataPrompt?.runId) return;
    await execute(async () => {
      const result = unwrapResult(await window.photoMap.resolveScanLocations({ runId: metadataPrompt.runId!, decision }));
      setRaw(result.library);
      setDismissedRun(metadataPrompt.runId!);
      setFeedback(decision === 'ignore' ? '已保留现有标注' : `已处理 ${result.succeeded} 项扫描信息`);
    });
  }

  useEffect(() => { setNote(active?.note ?? ''); }, [active?.id, active?.note]);
  useEffect(() => {
    if (!autoPlay || mode !== 'memory' || !active) return;
    const timer = window.setTimeout(() => {
      if (next) setActiveId(next.id);
      else { setAutoPlay(false); }
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [autoPlay, mode, active?.id, next?.id]);

  async function saveNote(): Promise<void> {
    if (!active) return;
    await execute(async () => { setRaw(unwrapResult(await window.photoMap.updateNote({ photoId: active.id, note })).library); setFeedback('备注已保存'); });
  }

  async function chooseSource(): Promise<void> {
    await execute(async () => {
      const result = unwrapResult(await window.photoMap.chooseLibrary());
      if (!result.cancelled) setRaw(result.library);
    });
  }

  async function refresh(): Promise<void> {
    await execute(async () => { setRaw(unwrapResult(await window.photoMap.refreshLibrary()).library); });
  }

  const windowAction = (action: WindowAction): void => { void execute(async () => { unwrapResult(await window.photoMap.windowAction(action)); }); };

  return <div className="desktop-app" data-testid="app-shell">
    <header className="app-header"><h1>用照片拼地图</h1>
      <nav><button className={mode === 'wall' ? 'active' : ''} onClick={() => setMode('wall')}>照片墙</button><button className={mode === 'memory' ? 'active' : ''} onClick={() => setMode('memory')}>明信片批注</button><button className={mode === 'batch' ? 'active' : ''} onClick={() => setMode('batch')}>批量整理</button></nav>
      <button onClick={() => windowAction('minimize')}>最小化</button><button onClick={() => windowAction('toggleMaximize')}>最大化</button><button onClick={() => windowAction('close')}>关闭</button>
    </header>
    <div className="source-toolbar"><strong>{library?.sourceName ?? '尚未选择照片文件夹'}</strong><button disabled={busy} onClick={() => void chooseSource()}>选择照片文件夹</button><button disabled={busy || !raw?.source} onClick={() => void refresh()}>重新扫描</button>
      {raw?.scan.status === 'running' && <button onClick={() => void execute(async () => { setRaw(unwrapResult(await window.photoMap.cancelScan()).library); })}>取消扫描</button>}
      {mode === 'wall' && <button disabled={!snapshot} onClick={() => setExportOpen(true)}>导出分享图</button>}
    </div>
    {mode === 'wall' && !mapData?.ready ? mapData ? <MapDataSetup status={mapData} busy={mapBusy} onDownload={() => void execute(async () => { unwrapResult(await window.photoMap.openMapDownload()); })} onImport={() => void importMaps()} /> : <main className="empty-library"><h2>正在确认地图数据状态</h2><button onClick={() => void execute(async () => { setMapData(unwrapResult(await window.photoMap.getAppInfo()).mapData); })}>重试</button></main> :
    !raw?.source ? <main className="empty-library"><h2>把照片放回走过的地方</h2><p>选择一个照片文件夹，递归扫描后建立本地索引。</p><button disabled={busy} onClick={() => void chooseSource()}>选择照片文件夹</button></main> : <div className="library-layout">
      <aside className="library-sidebar">
        <h2>组合筛选</h2><input aria-label="搜索照片" value={query} placeholder="照片名、地点、类型" onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="地点筛选" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}><option value="">全部地点</option><option value="unlocated">未标记地点</option>{PROVINCES.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}{CITIES.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}</select>
        <select aria-label="类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">全部类型</option>{library?.photoTypes.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>
        <select aria-label="媒体类型" value={mediaFilter} onChange={(event) => setMediaFilter(event.target.value)}><option value="all">所有媒体</option><option value="photo">照片</option><option value="video">视频</option><option value="live">实况照片</option></select>
        <h2>已选择 {selected.size} 项</h2><button onClick={() => setSelected(new Set(photos.map((photo) => photo.id)))}>全选当前结果</button><button onClick={() => setSelected(new Set())}>取消选择</button>
        <select aria-label="标注省份" value={province} onChange={(event) => { setProvince(event.target.value); setCity(''); }}><option value="">清除地点</option>{PROVINCES.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}</select>
        <select aria-label="标注城市" disabled={!province} value={city} onChange={(event) => setCity(event.target.value)}><option value="">仅标记省份</option>{CITIES.filter((region) => region.parentProvinceCode === province).map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}</select>
        <button disabled={busy || !selected.size} onClick={() => void updateLocation()}>应用地点</button>
        <select aria-label="标注类型" value={typeId} onChange={(event) => setTypeId(event.target.value)}><option value="">选择类型</option>{library?.photoTypes.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>
        <button disabled={busy || !selected.size || !typeId} onClick={() => void updateTypes(false)}>添加类型</button><button disabled={busy || !selected.size || !typeId} onClick={() => void updateTypes(true)}>移除类型</button>
        <input aria-label="新类型" placeholder="创建自定义类型" value={newType} onChange={(event) => setNewType(event.target.value)} /><button disabled={busy || !newType.trim()} onClick={() => void createType()}>创建类型</button>
        <button disabled={busy || !selected.size} onClick={() => void trashSelection()}>移入回收站</button>
        {selectedRegion && <><h2>{selectedRegion.name}</h2><button onClick={() => { setLocationFilter(selectedRegion.code); setMode('batch'); }}>整理该区域照片</button><button disabled={!selected.size} onClick={fixSelectedPhotos}>固定已选照片</button><button onClick={() => setFixedPhotos((current) => { const value = new Map(current); value.delete(`${selectedRegion.level}:${selectedRegion.code}`); return value; })}>恢复自动选片</button><button onClick={() => { setLocationFilter(selectedRegion.code); setMode('memory'); }}>翻阅该区域明信片</button></>}
      </aside>
      <section className="library-content">
        {mode === 'wall' ? <PhotoWall provinces={provinces} cities={cities} mapError={mapError} photos={allPhotos} fixedPhotoSelections={fixedPhotos} selectedRegion={selectedRegion} mapPreference={mapPreference} onMapPreferenceChange={setMapPreference} onSelectedRegionChange={setSelectedRegion} onSnapshotChange={setSnapshot} /> :
        mode === 'memory' ? active ? <section className="memory-workspace postcard-workspace"><div className="memory-deck"><div className="memory-paper back-two" /><div className="memory-paper back-one" /><figure className="memory-paper front">{active.decodeState === 'valid' ? active.mediaKind === 'video' || active.mediaKind === 'live' ? <PostcardPlayableMedia photo={active} active={true} /> : <img src={active.mediaFormat === 'heic' || active.mediaFormat === 'avif' ? active.thumbnailUrl : active.mediaUrl} alt={active.name} /> : <div className="photo-problem">{active.decodeMessage}</div>}<figcaption>{active.name} · {active.location?.cityName ?? active.location?.provinceName ?? '未标记地点'}</figcaption></figure></div><div className="memory-controls"><button disabled={!previous} onClick={() => navigate(-1)}>上一张</button><span>{activeIndex + 1} / {photos.length}</span><button disabled={!next} onClick={() => navigate(1)}>{'下一张'}</button><button onClick={() => setSelected(new Set([active.id]))}>标注此照片</button><button onClick={() => setAutoPlay((current) => !current)}>{autoPlay ? '暂停翻阅' : '自动翻阅'}</button></div><div className="memory-note"><input aria-label="明信片备注" maxLength={60} value={note} placeholder="为这一刻写下一句话" onChange={(event) => setNote(event.target.value)} /><button disabled={busy} onClick={() => void saveNote()}>保存备注</button></div><div className="memory-thumbnails">{photos.map((photo) => <button key={photo.id} className={photo.id === active.id ? 'active' : ''} onClick={() => setActiveId(photo.id)}><img src={photo.thumbnailUrl} alt={photo.name} /></button>)}</div></section> : <div className="empty-library">没有符合筛选的照片</div> :
photos.length === 0 ? <div className="empty-library">没有符合条件的照片</div> : <div className="photo-grid">{photos.map((photo) => <article key={photo.id} className={selected.has(photo.id) ? 'photo-tile selected' : 'photo-tile'}><label><input type="checkbox" aria-label={`选择 ${photo.name}`} checked={selected.has(photo.id)} onChange={() => togglePhoto(photo.id)} />选择</label>{photo.decodeState === 'valid' ? <img src={photo.thumbnailUrl} alt={photo.name} loading="lazy" onDoubleClick={() => { setActiveId(photo.id); setMode('memory'); }} /> : <div className="photo-problem">{photo.decodeMessage}</div>}<footer>{photo.name}<br />{photo.location?.cityName ?? photo.location?.provinceName ?? '未标记地点'} · {photo.types.map((tag) => tag.name).join('、')} · {photo.mediaKind === 'video' ? '视频' : photo.mediaKind === 'live' ? '实况' : '照片'}</footer></article>)}</div>}
      </section>
    </div>}
    <footer className="app-status"><span>{photos.length} 项照片</span><span>扫描：{raw?.scan.status ?? 'idle'} · 已发现 {raw?.scan.counts.discovered ?? 0} 项 · 异常 {raw?.scan.counts.errors ?? 0} 项</span><span>完全离线 · {version}</span></footer>
    {exportOpen && snapshot && <ExportDialog snapshot={snapshot} viewportSize={{ width: 1200, height: 720 }} onClose={() => setExportOpen(false)} onSaved={setFeedback} />}
    {metadataPrompt && <div className="dialog-overlay"><section className="simple-dialog" role="dialog" aria-modal="true"><h2>确认扫描到的照片信息</h2><p>发现 {metadataPrompt.metadata?.gpsCount} 张含 GPS 的照片，{metadataPrompt.metadata?.resolvedLocationCount} 张可定位，{metadataPrompt.metadata?.captureTimeCount} 张含拍摄时间。</p><footer><button disabled={busy} onClick={() => void resolveMetadata('fill-unlabeled-only')}>仅补充未标记信息</button><button disabled={busy} onClick={() => void resolveMetadata('overwrite-all-resolved')}>使用扫描信息覆盖</button><button disabled={busy} onClick={() => void resolveMetadata('ignore')}>保留现有信息</button></footer></section></div>}
    {feedback && <div className="feedback-message" role="status">{feedback}</div>}
  </div>;
}
