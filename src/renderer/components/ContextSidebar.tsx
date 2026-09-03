import { useEffect, useMemo, useState } from 'react';
import {
  CalendarBlank,
  CheckCircle,
  Eye,
  FileImage,
  Info,
  MapPin,
  Plus,
  Selection,
  StackSimple,
  Tag,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import type { AdministrativeRegion as RegionOption } from '../../shared/administrative-regions';
import { annotationPreviewUrl, isWallEligiblePhoto, shortRegionName } from '../domain';
import { formatFileCreatedAt } from '../format';
import type {
  AppMode,
  PhotoRecord,
  PhotoTypeTag,
  SelectedRegion,
} from '../model';

function LocationFields(props: {
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  provinceCode: string;
  cityCode: string;
  disabled?: boolean;
  onProvinceChange: (code: string) => void;
  onCityChange: (code: string) => void;
}): React.JSX.Element {
  const cityOptions = props.cities.filter((city) => city.parentProvinceCode === props.provinceCode);
  return (
    <div className="field-grid">
      <label><span>省份</span><select value={props.provinceCode} disabled={props.disabled} onChange={(event) => props.onProvinceChange(event.target.value)}><option value="">未选择</option>{props.provinces.map((province) => <option value={province.code} key={province.code}>{province.name}</option>)}</select></label>
      <label><span>城市（可选）</span><select value={props.cityCode} disabled={props.disabled || !props.provinceCode} onChange={(event) => props.onCityChange(event.target.value)}><option value="">只标记到省</option>{cityOptions.map((city) => <option value={city.code} key={city.code}>{city.name}</option>)}</select></label>
    </div>
  );
}

function SinglePhotoEditor(props: {
  photo: PhotoRecord;
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  photoTypes: readonly PhotoTypeTag[];
  onUpdateLocation: (ids: readonly string[], provinceCode?: string, cityCode?: string) => Promise<boolean>;
  onUpdateTypes: (ids: readonly string[], add: readonly string[], remove: readonly string[]) => Promise<boolean>;
  onRequestTrash: (ids: readonly string[]) => void;
}): React.JSX.Element {
  const [provinceCode, setProvinceCode] = useState(props.photo.location?.provinceCode ?? '');
  const [cityCode, setCityCode] = useState(props.photo.location?.cityCode ?? '');
  const [selectedTypes, setSelectedTypes] = useState(() => new Set(props.photo.types.map((type) => type.id)));
  const [saving, setSaving] = useState(false);
  const fileCreatedAt = formatFileCreatedAt(props.photo.fileCreatedAtMs);

  async function updateLocation(nextProvinceCode: string, nextCityCode: string): Promise<void> {
    const previousProvinceCode = provinceCode;
    const previousCityCode = cityCode;
    setProvinceCode(nextProvinceCode);
    setCityCode(nextCityCode);
    setSaving(true);
    const saved = await props.onUpdateLocation(
      [props.photo.id],
      nextProvinceCode || undefined,
      nextCityCode || undefined,
    );
    if (!saved) {
      setProvinceCode(previousProvinceCode);
      setCityCode(previousCityCode);
    }
    setSaving(false);
  }

  async function toggleType(typeId: string): Promise<void> {
    const wasSelected = selectedTypes.has(typeId);
    const previousTypes = selectedTypes;
    const nextTypes = new Set(previousTypes);
    if (wasSelected) nextTypes.delete(typeId);
    else nextTypes.add(typeId);
    setSelectedTypes(nextTypes);
    setSaving(true);
    const saved = await props.onUpdateTypes(
      [props.photo.id],
      wasSelected ? [] : [typeId],
      wasSelected ? [typeId] : [],
    );
    if (!saved) setSelectedTypes(previousTypes);
    setSaving(false);
  }

  return (
    <aside className="sidebar right-sidebar memory-right">
      <section className="right-header"><div><span>当前媒体</span><strong title={props.photo.name}>{props.photo.name}</strong></div></section>
      {props.photo.decodeState === 'valid'
        ? <img className="detail-hero" src={annotationPreviewUrl(props.photo)} alt={props.photo.name} />
        : <div className="detail-error"><FileImage size={30} /><span>{props.photo.decodeMessage}</span></div>}
      <dl className="metadata-list">
        <div><dt><CalendarBlank size={16} />创建时间</dt><dd>{fileCreatedAt}</dd></div>
        <div><dt><MapPin size={16} />地点</dt><dd>{props.photo.location ? [props.photo.location.provinceName, props.photo.location.cityName].filter(Boolean).join(' · ') : '未标注'}</dd></div>
        <div><dt><Tag size={16} />标签</dt><dd>{props.photo.types.length ? props.photo.types.map((type) => type.name).join('、') : '未标注'}</dd></div>
        <div><dt><FileImage size={16} />媒体状态</dt><dd>{props.photo.decodeState === 'valid' ? `${props.photo.width ?? '—'} × ${props.photo.height ?? '—'}` : props.photo.decodeMessage}</dd></div>
      </dl>
      <section className="tag-editor" aria-busy={saving}>
        <div className="section-label-row"><strong>地点标签</strong><span>至多一个省 / 市</span></div>
        <LocationFields
          provinces={props.provinces}
          cities={props.cities}
          provinceCode={provinceCode}
          cityCode={cityCode}
          disabled={saving}
          onProvinceChange={(code) => void updateLocation(code, '')}
          onCityChange={(code) => void updateLocation(provinceCode, code)}
        />
        <div className="section-label-row"><strong>标签</strong><span>可多选</span></div>
        <div className="type-choice-list">
          {props.photoTypes.map((type) => {
            const active = selectedTypes.has(type.id);
            return <button type="button" key={type.id} className={active ? 'active' : ''} aria-pressed={active} disabled={saving} onClick={() => void toggleType(type.id)}>{active && <CheckCircle size={14} weight="fill" />}{type.name}</button>;
          })}
        </div>
      </section>
      <div className="right-danger-zone"><button type="button" className="danger-action" onClick={() => props.onRequestTrash([props.photo.id])}><Trash size={16} />移入 Windows 回收站</button></div>
      <div className="right-note"><Info size={17} /><span>地点和标签只写入本地索引；EXIF / GPS 仅在扫描时本地读取，也不会改写源照片。</span></div>
    </aside>
  );
}

function BatchEditor(props: {
  selected: readonly PhotoRecord[];
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  photoTypes: readonly PhotoTypeTag[];
  onUpdateLocation: (ids: readonly string[], provinceCode?: string, cityCode?: string) => Promise<boolean>;
  onUpdateTypes: (ids: readonly string[], add: readonly string[], remove: readonly string[]) => Promise<boolean>;
  onClearSelection: () => void;
  onRequestTrash: (ids: readonly string[]) => void;
}): React.JSX.Element {
  const [provinceCode, setProvinceCode] = useState('');
  const [cityCode, setCityCode] = useState('');
  const [typeId, setTypeId] = useState(props.photoTypes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const ids = props.selected.map((photo) => photo.id);

  async function run(operation: () => Promise<boolean>): Promise<void> {
    setBusy(true);
    await operation();
    setBusy(false);
  }

  return (
    <aside className="sidebar right-sidebar batch-right">
      <section className="right-header"><div><span>批量标签</span><strong>已选 {props.selected.length.toLocaleString('zh-CN')} 项</strong></div></section>
      <div className="selected-preview">
        {props.selected.slice(0, 4).map((photo) => photo.decodeState === 'valid' ? <img src={photo.thumbnailUrl} alt="" key={photo.id} /> : <span key={photo.id}><FileImage size={18} /></span>)}
        {props.selected.length > 4 && <span>+{props.selected.length - 4}</span>}
        {props.selected.length === 0 && <div className="empty-selection"><Selection size={28} /><span>从中间选择媒体</span></div>}
      </div>
      <section className="tag-editor">
        <div className="section-label-row"><strong>地点操作</strong><span>替换或清除</span></div>
        <LocationFields
          provinces={props.provinces}
          cities={props.cities}
          provinceCode={provinceCode}
          cityCode={cityCode}
          onProvinceChange={(code) => { setProvinceCode(code); setCityCode(''); }}
          onCityChange={setCityCode}
        />
        <div className="explicit-actions">
          <button type="button" className="secondary-action" disabled={busy || ids.length === 0 || !provinceCode} onClick={() => void run(() => props.onUpdateLocation(ids, provinceCode, cityCode || undefined))}><MapPin size={15} />替换为该地点</button>
          <button type="button" className="secondary-action muted-danger" disabled={busy || ids.length === 0} onClick={() => void run(() => props.onUpdateLocation(ids))}>清除地点</button>
        </div>
        <div className="section-label-row"><strong>标签操作</strong><span>添加或移除</span></div>
        <label className="select-field"><span>标签</span><select value={typeId} onChange={(event) => setTypeId(event.target.value)}>{props.photoTypes.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</select></label>
        <div className="explicit-actions">
          <button type="button" className="secondary-action" disabled={busy || ids.length === 0 || !typeId} onClick={() => void run(() => props.onUpdateTypes(ids, [typeId], []))}><Plus size={15} />添加标签</button>
          <button type="button" className="secondary-action muted-danger" disabled={busy || ids.length === 0 || !typeId} onClick={() => void run(() => props.onUpdateTypes(ids, [], [typeId]))}>移除标签</button>
        </div>
      </section>
      <div className="batch-right-actions">
        <button type="button" className="danger-action" disabled={ids.length === 0 || busy} onClick={() => props.onRequestTrash(ids)}><Trash size={16} />移入回收站</button>
        <button type="button" className="secondary-action" disabled={ids.length === 0 || busy} onClick={props.onClearSelection}>取消选择</button>
      </div>
      <div className="right-note"><Info size={17} /><span>所有批量操作只作用于当前明确选中的媒体项，并返回成功、跳过与失败数量。</span></div>
    </aside>
  );
}

const FIXED_PHOTO_PAGE_SIZE = 72;

export function FixedPhotoDialog(props: {
  region: SelectedRegion;
  photos: readonly PhotoRecord[];
  displayablePhotoIds: ReadonlySet<string>;
  fixedPhotoIds: readonly string[];
  onSave: (photoIds: readonly string[]) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [draftIds, setDraftIds] = useState(() => new Set(props.fixedPhotoIds));
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(FIXED_PHOTO_PAGE_SIZE);
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const matchingPhotos = useMemo(
    () => normalizedQuery
      ? props.photos.filter((photo) => photo.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
      : props.photos,
    [normalizedQuery, props.photos],
  );
  const shownPhotos = matchingPhotos.slice(0, visibleCount);
  const availableSelectedCount = [...draftIds].filter((photoId) => props.displayablePhotoIds.has(photoId)).length;
  const unavailableSelectedCount = draftIds.size - availableSelectedCount;

  useEffect(() => {
    setVisibleCount(FIXED_PHOTO_PAGE_SIZE);
  }, [normalizedQuery]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose]);

  function togglePhoto(photoId: string): void {
    setDraftIds((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  return (
    <div
      className="modal-backdrop fixed-photo-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <section
        className="fixed-photo-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fixed-photo-dialog-title"
        data-testid="fixed-photo-dialog"
      >
        <header>
          <div>
            <span>照片墙专属设置</span>
            <h2 id="fixed-photo-dialog-title">固定{shortRegionName(props.region.name)}展示照片</h2>
          </div>
          <button type="button" className="secondary-action" onClick={props.onClose}>关闭</button>
        </header>
        <div className="fixed-photo-toolbar">
          <label>
            <span>查找照片</span>
            <input type="search" value={query} placeholder="输入文件名" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <strong>已选 {draftIds.size} 张</strong>
        </div>
        <p className="fixed-photo-scope-note">
          只在照片墙及其导出中使用所选照片；不会修改照片的省市地点，也不会影响批注模式。
        </p>
        <div className="fixed-photo-grid">
          {shownPhotos.map((photo) => {
            const selected = draftIds.has(photo.id);
            return (
              <button
                type="button"
                className={selected ? 'fixed-photo-option selected' : 'fixed-photo-option'}
                aria-pressed={selected}
                onClick={() => togglePhoto(photo.id)}
                key={photo.id}
              >
                <img src={photo.thumbnailUrl} alt="" loading="lazy" />
                <span className="fixed-photo-check" aria-hidden="true">{selected && <CheckCircle size={20} weight="fill" />}</span>
                <span className="fixed-photo-name" title={photo.name}>{photo.name}</span>
              </button>
            );
          })}
          {matchingPhotos.length === 0 && (
            <div className="fixed-photo-empty"><FileImage size={30} /><strong>没有匹配照片</strong><span>可清空搜索词后查看当前区域照片。</span></div>
          )}
        </div>
        {matchingPhotos.length > shownPhotos.length && (
          <button type="button" className="fixed-photo-more secondary-action" onClick={() => setVisibleCount((count) => count + FIXED_PHOTO_PAGE_SIZE)}>
            显示更多（剩余 {matchingPhotos.length - shownPhotos.length} 张）
          </button>
        )}
        <footer>
          <div className="fixed-photo-selection-status">
            <span>当前筛选下可用 {availableSelectedCount} 张</span>
            {unavailableSelectedCount > 0 && <small>另有 {unavailableSelectedCount} 张暂不在当前结果中，将继续保留固定设置。</small>}
          </div>
          <button type="button" className="secondary-action" disabled={draftIds.size === 0} onClick={() => setDraftIds(new Set())}>清空选择</button>
          <button type="button" className="secondary-action" onClick={props.onClose}>取消</button>
          <button type="button" className="primary-action" onClick={() => { props.onSave([...draftIds]); props.onClose(); }}>
            {draftIds.size === 0 ? '恢复自动选片' : `固定 ${draftIds.size} 张照片`}
          </button>
        </footer>
      </section>
    </div>
  );
}

function WallDetails(props: {
  selectedRegion?: SelectedRegion;
  allPhotos: readonly PhotoRecord[];
  photos: readonly PhotoRecord[];
  fixedPhotoIds: readonly string[];
  onOnlyRegion: (code: string) => void;
  onManageRegion: (code: string) => void;
  onCarouselRegion: (code: string) => void;
  onFixedPhotosChange: (region: SelectedRegion, photoIds: readonly string[]) => void;
}): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selected = props.selectedRegion;
  const regionPhotos = useMemo(() => selected
    ? props.photos.filter((photo) => isWallEligiblePhoto(photo) && (
        selected.level === 'province'
          ? photo.location?.provinceCode === selected.code
          : photo.location?.cityCode === selected.code
      ))
    : [], [props.photos, selected]);
  const allRegionPhotos = useMemo(() => selected
    ? props.allPhotos.filter((photo) => isWallEligiblePhoto(photo) && (
        selected.level === 'province'
          ? photo.location?.provinceCode === selected.code
          : photo.location?.cityCode === selected.code
      ))
    : [], [props.allPhotos, selected]);
  const selectablePhotos = useMemo(
    () => allRegionPhotos.filter((photo) => photo.decodeState === 'valid'),
    [allRegionPhotos],
  );
  const displayablePhotos = useMemo(
    () => regionPhotos.filter((photo) => photo.decodeState === 'valid'),
    [regionPhotos],
  );
  const displayablePhotoIds = new Set(displayablePhotos.map((photo) => photo.id));
  const availableFixedCount = props.fixedPhotoIds.filter((photoId) => displayablePhotoIds.has(photoId)).length;
  const typeCount = new Set(regionPhotos.flatMap((photo) => photo.types.map((type) => type.id))).size;
  const errorCount = regionPhotos.filter((photo) => photo.decodeState !== 'valid').length;

  useEffect(() => setPickerOpen(false), [selected?.code, selected?.level]);

  return (
    <>
      <aside className="sidebar right-sidebar wall-right">
        <section className="right-header"><div><span>区域详情</span><strong>{props.selectedRegion?.name ?? '选择一个行政区'}</strong></div></section>
        {!props.selectedRegion ? (
          <div className="context-empty"><MapPin size={32} weight="duotone" /><strong>点击地图查看区域</strong><span>照片数量与预览会来自当前筛选结果。</span></div>
        ) : (
          <>
            <div className="visited-status"><span /><strong>{regionPhotos.length > 0 ? '当前区域有匹配照片' : '当前区域暂无匹配照片'}</strong></div>
            <div className="region-stats">
              <div><span>照片数量</span><strong>{regionPhotos.length}</strong></div>
              <div><span>标签数量</span><strong>{typeCount}</strong></div>
              <div><span>异常图片</span><strong>{errorCount}</strong></div>
            </div>
            <section className="preview-section"><h3>照片预览</h3><div className="preview-grid">{displayablePhotos.slice(0, 6).map((photo) => <img src={photo.thumbnailUrl} alt={photo.name} key={photo.id} />)}{regionPhotos.length === 0 && <p>没有照片可预览</p>}</div></section>
            <section className="quick-actions">
              <h3>快速操作</h3>
              <button type="button" onClick={() => props.onOnlyRegion(props.selectedRegion?.code ?? '')}><Eye size={17} />只看{shortRegionName(props.selectedRegion.name)}</button>
              <button type="button" data-testid="annotate-region-batch" onClick={() => props.onManageRegion(props.selectedRegion?.code ?? '')}><Tag size={17} />批注区域照片</button>
              <button type="button" data-testid="annotate-region-carousel" onClick={() => props.onCarouselRegion(props.selectedRegion?.code ?? '')}><StackSimple size={17} />轮播区域照片</button>
              <button
                type="button"
                data-testid="fixed-region-photos"
                disabled={selectablePhotos.length === 0 && props.fixedPhotoIds.length === 0}
                title={selectablePhotos.length === 0 && props.fixedPhotoIds.length === 0 ? '当前区域没有可固定展示的有效照片' : undefined}
                onClick={() => setPickerOpen(true)}
              >
                <Selection size={17} />
                {props.fixedPhotoIds.length > 0
                  ? `管理固定照片（可用 ${availableFixedCount}/${props.fixedPhotoIds.length}）`
                  : '固定该区域展示照片'}
              </button>
              {props.fixedPhotoIds.length > 0 && <span className="quick-action-status">已启用照片墙固定展示</span>}
            </section>
          </>
        )}
        <div className="right-note"><Info size={17} /><span>固定照片只改变照片墙与导出，不会修改任何照片地点；导出会保留当前视口、筛选、密度与拼贴布局。</span></div>
      </aside>
      {pickerOpen && selected && (
        <FixedPhotoDialog
          key={`${selected.level}:${selected.code}`}
          region={selected}
          photos={selectablePhotos}
          displayablePhotoIds={displayablePhotoIds}
          fixedPhotoIds={props.fixedPhotoIds}
          onSave={(photoIds) => props.onFixedPhotosChange(selected, photoIds)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

export function ContextSidebar(props: {
  mode: AppMode;
  allPhotos: readonly PhotoRecord[];
  filteredPhotos: readonly PhotoRecord[];
  activePhoto?: PhotoRecord;
  selectedIds: ReadonlySet<string>;
  selectedRegion?: SelectedRegion;
  wallFixedPhotoIds: readonly string[];
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  photoTypes: readonly PhotoTypeTag[];
  onUpdateLocation: (ids: readonly string[], provinceCode?: string, cityCode?: string) => Promise<boolean>;
  onUpdateTypes: (ids: readonly string[], add: readonly string[], remove: readonly string[]) => Promise<boolean>;
  onClearSelection: () => void;
  onRequestTrash: (ids: readonly string[]) => void;
  onOnlyRegion: (code: string) => void;
  onManageRegion: (code: string) => void;
  onCarouselRegion: (code: string) => void;
  onWallFixedPhotosChange: (region: SelectedRegion, photoIds: readonly string[]) => void;
}): React.JSX.Element {
  if (props.mode === 'memory' && props.activePhoto) {
    return <SinglePhotoEditor key={props.activePhoto.id} photo={props.activePhoto} provinces={props.provinces} cities={props.cities} photoTypes={props.photoTypes} onUpdateLocation={props.onUpdateLocation} onUpdateTypes={props.onUpdateTypes} onRequestTrash={props.onRequestTrash} />;
  }
  if (props.mode === 'memory') {
    return <aside className="sidebar right-sidebar"><div className="context-empty"><WarningCircle size={30} /><strong>没有当前照片</strong><span>清空筛选后可以继续整理。</span></div></aside>;
  }
  if (props.mode === 'batch') {
    const selected = props.filteredPhotos.filter((photo) => props.selectedIds.has(photo.id));
    return <BatchEditor selected={selected} provinces={props.provinces} cities={props.cities} photoTypes={props.photoTypes} onUpdateLocation={props.onUpdateLocation} onUpdateTypes={props.onUpdateTypes} onClearSelection={props.onClearSelection} onRequestTrash={props.onRequestTrash} />;
  }
  return <WallDetails selectedRegion={props.selectedRegion} allPhotos={props.allPhotos} photos={props.filteredPhotos} fixedPhotoIds={props.wallFixedPhotoIds} onOnlyRegion={props.onOnlyRegion} onManageRegion={props.onManageRegion} onCarouselRegion={props.onCarouselRegion} onFixedPhotosChange={props.onWallFixedPhotosChange} />;
}
