import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowsClockwise, CaretRight, Check, CheckCircle, DownloadSimple, FolderOpen, MagnifyingGlass, Minus, Plus, SpinnerGap, StopCircle, X } from '@phosphor-icons/react';
import { MEDIA_KINDS } from '../../shared/contracts';
import type { AdministrativeRegion as RegionOption } from '../../shared/administrative-regions';
import { compareFilterItems, toggleCityLocationFilter, toggleProvinceLocationFilter } from '../domain';
import type { AppMode, FilterState, MediaKind, PhotoRecord, PhotoTypeTag, ScanProgress } from '../model';
import { FolderFilter } from './FolderFilter';
import { MediaKindFilter } from './MediaKindFilter';

function toggleSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function selectedCityParentCodes(
  cities: readonly RegionOption[],
  selectedCodes: ReadonlySet<string>,
): Set<string> {
  const parents = new Set<string>();
  for (const city of cities) {
    const cityCode = city.code;
    const provinceCode = city.parentProvinceCode ?? '';
    if (cityCode !== provinceCode && selectedCodes.has(cityCode)) parents.add(provinceCode);
  }
  return parents;
}

type FilterTab = 'location' | 'folder' | 'type';

const FILTER_TABS: readonly FilterTab[] = ['location', 'folder', 'type'];

export function LeftSidebar(props: {
  mode: AppMode;
  sourceName: string;
  sourceAvailable: boolean;
  photos: readonly PhotoRecord[];
  mediaKindPhotos: readonly PhotoRecord[];
  photoTypes: readonly PhotoTypeTag[];
  provinces: readonly RegionOption[];
  cities: readonly RegionOption[];
  scan?: ScanProgress;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  onChooseSource: () => void;
  onRefresh: () => void;
  onCancelScan: () => void;
  onCreateType: (name: string) => Promise<boolean>;
  onOpenExport: () => void;
}): React.JSX.Element {
  const [filterTab, setFilterTab] = useState<FilterTab>(
    () => props.filters.folderPaths.size > 0 ? 'folder' : 'location',
  );
  const [expandedProvinceCodes, setExpandedProvinceCodes] = useState<Set<string>>(
    () => selectedCityParentCodes(props.cities, props.filters.locationCodes),
  );
  const [showCreateType, setShowCreateType] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [creatingType, setCreatingType] = useState(false);
  const locationCounts = useMemo(() => {
    const province = new Map<string, number>();
    const city = new Map<string, number>();
    for (const photo of props.photos) {
      const provinceCode = photo.location?.provinceCode;
      const cityCode = photo.location?.cityCode;
      if (provinceCode) province.set(provinceCode, (province.get(provinceCode) ?? 0) + 1);
      if (cityCode) city.set(cityCode, (city.get(cityCode) ?? 0) + 1);
    }
    return { province, city };
  }, [props.photos]);
  const unlocatedCount = useMemo(
    () => props.mediaKindPhotos.filter((photo) => !photo.location?.provinceCode).length,
    [props.mediaKindPhotos],
  );
  const citiesByProvince = useMemo(() => {
    const groups = new Map<string, RegionOption[]>();
    for (const city of props.cities) {
      const cityCode = city.code;
      const provinceCode = city.parentProvinceCode ?? '';
      if (!provinceCode || cityCode === provinceCode) continue;
      const group = groups.get(provinceCode) ?? [];
      group.push(city);
      groups.set(provinceCode, group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => left.code.localeCompare(right.code));
    }
    return groups;
  }, [props.cities]);
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const photo of props.photos) {
      for (const type of photo.types) counts.set(type.id, (counts.get(type.id) ?? 0) + 1);
    }
    return counts;
  }, [props.photos]);
  const mediaKindCounts = useMemo(() => {
    const counts = new Map<MediaKind, number>();
    for (const photo of props.mediaKindPhotos) {
      counts.set(photo.mediaKind, (counts.get(photo.mediaKind) ?? 0) + 1);
    }
    return counts;
  }, [props.mediaKindPhotos]);
  const search = props.filters.search.trim().toLocaleLowerCase('zh-CN');
  const provinceRows = props.provinces
    .map((province, sourceOrder) => {
      const code = province.code;
      const cities = citiesByProvince.get(code) ?? [];
      const name = province.name;
      const provinceNameMatchesSearch = Boolean(search) && name.toLocaleLowerCase('zh-CN').includes(search);
      const visibleCities = cities
        .map((city, citySourceOrder) => {
          const cityCode = city.code;
          const cityName = city.name;
          return {
            code: cityCode,
            name: cityName,
            pinned: props.filters.locationCodes.has(cityCode),
            photoCount: locationCounts.city.get(cityCode) ?? 0,
            sourceOrder: citySourceOrder,
            visible: !search
              || provinceNameMatchesSearch
              || (locationCounts.city.get(cityCode) ?? 0) > 0
              || props.filters.locationCodes.has(cityCode)
              || cityName.toLocaleLowerCase('zh-CN').includes(search),
          };
        })
        .filter(({ visible }) => visible)
        .sort(compareFilterItems);
      const allCityCodes = cities.map((city) => city.code);
      const pinned = props.filters.locationCodes.has(code)
        || allCityCodes.some((cityCode) => props.filters.locationCodes.has(cityCode));
      const visible = !search
        || (locationCounts.province.get(code) ?? 0) > 0
        || props.filters.locationCodes.has(code)
        || provinceNameMatchesSearch
        || visibleCities.length > 0;
      return {
        province,
        code,
        name,
        cities: visibleCities,
        allCityCodes,
        hasMatchingCity: Boolean(search) && cities.some((city) => city.name.toLocaleLowerCase('zh-CN').includes(search)),
        pinned,
        photoCount: locationCounts.province.get(code) ?? 0,
        sourceOrder: sourceOrder + 1,
        visible,
      };
    })
    .filter(({ visible }) => visible);
  const locationRows = [
    {
      kind: 'unlocated' as const,
      photoCount: unlocatedCount,
    },
    ...provinceRows
      .map((row) => ({ kind: 'province' as const, ...row }))
      .sort(compareFilterItems),
  ];
  const typeRows = props.photoTypes
    .map((type, sourceOrder) => ({
      type,
      pinned: props.filters.typeIds.has(type.id),
      photoCount: typeCounts.get(type.id) ?? 0,
      sourceOrder,
    }))
    .sort(compareFilterItems);
  const scan = props.scan;
  const mediaKindFilterActive = props.mode === 'wall'
    ? !props.filters.mediaKinds.has('photo')
    : props.filters.mediaKinds.size !== MEDIA_KINDS.length;
  const unlocatedUnavailable = props.mode === 'wall';
  const unlocatedActive = !unlocatedUnavailable && props.filters.includeUnlocated;
  const anyFilterActive = unlocatedActive
    || props.filters.locationCodes.size > 0
    || props.filters.folderPaths.size > 0
    || props.filters.typeIds.size > 0
    || mediaKindFilterActive
    || props.filters.search.trim().length > 0;
  const scanning = scan?.state === 'running';
  const progress = scan && scan.discovered > 0
    ? Math.min(100, Math.round(scan.processed / scan.discovered * 100))
    : 0;

  useEffect(() => {
    const selectedCityParents = selectedCityParentCodes(props.cities, props.filters.locationCodes);
    if (selectedCityParents.size === 0) return;
    setExpandedProvinceCodes((current) => {
      const next = new Set(current);
      let changed = false;
      for (const provinceCode of selectedCityParents) {
        if (!next.has(provinceCode)) {
          next.add(provinceCode);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [props.cities, props.filters.locationCodes]);

  function toggleProvinceExpanded(provinceCode: string): void {
    setExpandedProvinceCodes((current) => toggleSet(current, provinceCode));
  }

  function handleFilterTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: FilterTab,
  ): void {
    const currentIndex = FILTER_TABS.indexOf(currentTab);
    let nextTab: FilterTab | undefined;
    if (event.key === 'Home') nextTab = FILTER_TABS[0];
    if (event.key === 'End') nextTab = FILTER_TABS.at(-1);
    if (event.key === 'ArrowLeft') nextTab = FILTER_TABS[(currentIndex - 1 + FILTER_TABS.length) % FILTER_TABS.length];
    if (event.key === 'ArrowRight') nextTab = FILTER_TABS[(currentIndex + 1) % FILTER_TABS.length];
    if (!nextTab) return;
    event.preventDefault();
    if (nextTab === currentTab) return;
    setFilterTab(nextTab);
    const nextButton = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-filter-tab="${nextTab}"]`);
    nextButton?.focus();
  }

  async function createType(): Promise<void> {
    const name = newTypeName.trim();
    if (!name) return;
    setCreatingType(true);
    const created = await props.onCreateType(name);
    setCreatingType(false);
    if (created) {
      setNewTypeName('');
      setShowCreateType(false);
    }
  }

  return (
    <aside className="sidebar left-sidebar">
      <section className="sidebar-section source-section">
        <div className="sidebar-title"><h2>数据源</h2>{!props.sourceAvailable && <span className="warning-pill">不可用</span>}</div>
        <div className="folder-card">
          <FolderOpen size={20} weight="duotone" />
          <div><strong>{props.sourceName}</strong><span>{props.sourceAvailable ? '本机照片文件夹' : '请重新选择可访问的文件夹'}</span></div>
          <button type="button" onClick={props.onChooseSource}>更换</button>
        </div>
        {scanning ? (
          <div className="scan-progress" data-testid="scan-progress">
            <div><span>正在扫描 · {progress}%</span><strong>{scan.processed} / {scan.discovered || '—'}</strong></div>
            <progress value={progress} max={100} />
            <div className="scan-progress-meta"><span>成功 {scan.succeeded} · 异常 {scan.failed}</span><button type="button" onClick={props.onCancelScan}><StopCircle size={15} />取消</button></div>
          </div>
        ) : (
          <div className="scan-row">
            <span>
              {scan?.state === 'partial'
                ? `部分完成：${scan.failed} 项异常`
                : props.mode === 'wall'
                  ? `照片墙可用 ${props.photos.length.toLocaleString('zh-CN')} 张照片`
                  : `已索引 ${props.photos.length.toLocaleString('zh-CN')} 项媒体`}
            </span>
            <button type="button" onClick={props.onRefresh} aria-label="增量扫描"><ArrowsClockwise size={16} /></button>
          </div>
        )}
      </section>

      <section className="sidebar-section filter-section">
        <div className="sidebar-title"><h2>筛选与分类</h2>{anyFilterActive && (
          <button type="button" className="clear-link" onClick={() => props.onFiltersChange({ search: '', locationCodes: new Set(), includeUnlocated: false, mediaKinds: new Set(MEDIA_KINDS), folderPaths: new Set(), typeIds: new Set() })}>清空</button>
        )}</div>
        <label className="search-field">
          <MagnifyingGlass size={17} />
          <input
            value={props.filters.search}
            onChange={(event) => props.onFiltersChange({ ...props.filters, search: event.target.value })}
            placeholder="搜索媒体 / 文件夹 / 省市 / 标签"
          />
          {props.filters.search && <button type="button" aria-label="清空搜索" onClick={() => props.onFiltersChange({ ...props.filters, search: '' })}><X size={14} /></button>}
        </label>
        <div className="segmented filter-view-segmented" role="tablist" aria-label="筛选分类">
          <button
            type="button"
            id="location-filter-tab"
            data-filter-tab="location"
            role="tab"
            className={`${filterTab === 'location' ? 'active' : ''}${(unlocatedActive || props.filters.locationCodes.size > 0) ? ' has-filter' : ''}`}
            aria-selected={filterTab === 'location'}
            aria-controls={filterTab === 'location' ? 'location-filter-panel' : undefined}
            tabIndex={filterTab === 'location' ? 0 : -1}
            onClick={() => setFilterTab('location')}
            onKeyDown={(event) => handleFilterTabKeyDown(event, 'location')}
          >省市</button>
          <button
            type="button"
            id="folder-filter-tab"
            data-filter-tab="folder"
            role="tab"
            className={`${filterTab === 'folder' ? 'active' : ''}${props.filters.folderPaths.size > 0 ? ' has-filter' : ''}`}
            aria-selected={filterTab === 'folder'}
            aria-controls={filterTab === 'folder' ? 'folder-filter-panel' : undefined}
            tabIndex={filterTab === 'folder' ? 0 : -1}
            onClick={() => setFilterTab('folder')}
            onKeyDown={(event) => handleFilterTabKeyDown(event, 'folder')}
          >文件夹</button>
          <button
            type="button"
            id="type-filter-tab"
            data-filter-tab="type"
            role="tab"
            className={`${filterTab === 'type' ? 'active' : ''}${(props.filters.typeIds.size > 0 || mediaKindFilterActive) ? ' has-filter' : ''}`}
            aria-selected={filterTab === 'type'}
            aria-controls={filterTab === 'type' ? 'type-filter-panel' : undefined}
            tabIndex={filterTab === 'type' ? 0 : -1}
            onClick={() => setFilterTab('type')}
            onKeyDown={(event) => handleFilterTabKeyDown(event, 'type')}
          >类型</button>
        </div>
        {filterTab === 'location' && (
          <div id="location-filter-panel" role="tabpanel" aria-labelledby="location-filter-tab" className="filter-panel">
            <div className="section-label-row"><strong>省市（{props.provinces.length} 省 / {props.cities.length} 市）</strong><span>照片数</span></div>
            <div className="region-filter-list">
              {locationRows.map((row) => {
                if (row.kind === 'unlocated') {
                  return (
                    <div className={`province-filter-row unlocated-filter-row${unlocatedActive ? ' active' : ''}${unlocatedUnavailable ? ' unavailable' : ''}`} key="unlocated">
                      <span className="region-expand-spacer" aria-hidden="true" />
                      <button
                        type="button"
                        className="region-filter-option"
                        data-testid="unlocated-location-filter"
                        aria-label={`未标记地点，${unlocatedCount} 项${unlocatedUnavailable ? '，照片墙不可用' : ''}`}
                        aria-pressed={unlocatedActive}
                        disabled={unlocatedUnavailable}
                        onClick={() => props.onFiltersChange({
                          ...props.filters,
                          includeUnlocated: !props.filters.includeUnlocated,
                        })}
                      >
                        <span>未标记地点</span>
                        <span className="selection-state" aria-hidden="true">{unlocatedActive ? <Check size={12} weight="bold" /> : null}</span>
                        <small>{unlocatedCount}</small>
                      </button>
                    </div>
                  );
                }
                const { code, name, cities, allCityCodes, hasMatchingCity } = row;
                const active = props.filters.locationCodes.has(code);
                const selectedCityCount = allCityCodes.filter((cityCode) => props.filters.locationCodes.has(cityCode)).length;
                const partiallyActive = !active && selectedCityCount > 0;
                const expanded = expandedProvinceCodes.has(code) || hasMatchingCity;
                const cityListId = `province-cities-${code}`;
                return (
                  <div className="province-filter-group" key={code}>
                    <div className={`province-filter-row${active ? ' active' : ''}${partiallyActive ? ' partial' : ''}`}>
                      {cities.length > 0 ? (
                        <button
                          type="button"
                          className="region-expand-toggle"
                          aria-label={`${expanded ? '收起' : '展开'}${name}下的城市`}
                          aria-expanded={expanded}
                          aria-controls={expanded ? cityListId : undefined}
                          onClick={() => toggleProvinceExpanded(code)}
                        ><CaretRight size={13} aria-hidden="true" /></button>
                      ) : <span className="region-expand-spacer" aria-hidden="true" />}
                      <button
                        type="button"
                        className="region-filter-option"
                        aria-pressed={active}
                        aria-label={partiallyActive ? `${name}，已选择部分城市` : undefined}
                        onClick={() => props.onFiltersChange({
                          ...props.filters,
                          locationCodes: toggleProvinceLocationFilter(props.filters.locationCodes, code, allCityCodes),
                        })}
                      >
                        <span>{name}</span>
                        <span className="selection-state" aria-hidden="true">{active ? <Check size={12} weight="bold" /> : partiallyActive ? <Minus size={12} weight="bold" /> : null}</span>
                        <small>{locationCounts.province.get(code) ?? 0}</small>
                      </button>
                    </div>
                    {expanded && cities.length > 0 && (
                      <div className="city-filter-list" id={cityListId}>
                        {cities.map(({ code: cityCode, name: cityName }) => {
                          const cityActive = props.filters.locationCodes.has(cityCode);
                          return (
                            <button
                              type="button"
                              key={cityCode}
                              className={`city-filter-option${cityActive ? ' active' : ''}`}
                              aria-pressed={cityActive}
                              onClick={() => props.onFiltersChange({
                                ...props.filters,
                                locationCodes: toggleCityLocationFilter(props.filters.locationCodes, code, cityCode),
                              })}
                            >
                              <span>{cityName}</span>
                              <span className="selection-state" aria-hidden="true">{cityActive ? <Check size={12} weight="bold" /> : null}</span>
                              <small>{locationCounts.city.get(cityCode) ?? 0}</small>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {provinceRows.length === 0 && <p className="sidebar-empty">没有匹配的省市</p>}
            </div>
          </div>
        )}

        {filterTab === 'folder' && (
          <div id="folder-filter-panel" role="tabpanel" aria-labelledby="folder-filter-tab" className="filter-panel">
            <div className="section-label-row"><strong>子文件夹</strong><span>最多两层 · 媒体数</span></div>
            <FolderFilter
              photos={props.mediaKindPhotos}
              selectedPaths={props.filters.folderPaths}
              onSelectedPathsChange={(folderPaths) => props.onFiltersChange({ ...props.filters, folderPaths })}
            />
          </div>
        )}

        {filterTab === 'type' && (
          <div id="type-filter-panel" role="tabpanel" aria-labelledby="type-filter-tab" className="filter-panel">
            <div className="section-label-row media-kind-heading"><strong>媒体</strong><span>可多选</span></div>
            <MediaKindFilter
              mode={props.mode}
              selectedKinds={props.filters.mediaKinds}
              counts={mediaKindCounts}
              onToggle={(mediaKind) => props.onFiltersChange({
                ...props.filters,
                mediaKinds: toggleSet(props.filters.mediaKinds, mediaKind),
              })}
            />
            <div className="section-label-row type-heading">
              <strong>标签（{props.photoTypes.length}）</strong>
              <button type="button" aria-label="新建标签" onClick={() => setShowCreateType((current) => !current)}><Plus size={15} /></button>
            </div>
            {showCreateType && (
              <div className="inline-create">
                <input value={newTypeName} maxLength={24} autoFocus onChange={(event) => setNewTypeName(event.target.value)} placeholder="输入新标签" onKeyDown={(event) => event.key === 'Enter' && void createType()} />
                <button type="button" onClick={() => void createType()} disabled={creatingType || !newTypeName.trim()}>{creatingType ? <SpinnerGap className="spin" size={14} /> : <Check size={14} />}</button>
              </div>
            )}
            <div className="type-list">
              {typeRows.map(({ type, sourceOrder }) => {
                const active = props.filters.typeIds.has(type.id);
                return (
                  <button
                    type="button"
                    key={type.id}
                    className={active ? 'active' : ''}
                    aria-pressed={active}
                    onClick={() => props.onFiltersChange({ ...props.filters, typeIds: toggleSet(props.filters.typeIds, type.id) })}
                  >
                    <span className={`tag-dot tone-${sourceOrder % 5}`} /><span>{type.name}</span>{active && <Check size={12} weight="bold" />}<small>{typeCounts.get(type.id) ?? 0}</small>
                  </button>
                );
              })}
              {props.photoTypes.length === 0 && <p className="sidebar-empty">还没有标签</p>}
            </div>
          </div>
        )}
      </section>

      <div className="sidebar-footer">
        <button type="button" className="primary-action" disabled={props.mode !== 'wall'} onClick={props.onOpenExport}>
          <DownloadSimple size={18} weight="bold" />{props.mode === 'wall' ? '导出分享图' : '仅照片墙可导出'}
        </button>
        <span className="offline-note"><CheckCircle size={14} weight="fill" />完全离线 · 照片不上传</span>
      </div>
    </aside>
  );
}
