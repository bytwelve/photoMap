import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeSlash, Info, MapPin, MapTrifold, SlidersHorizontal, WarningCircle } from '@phosphor-icons/react';
import { BEST_MAP_DENSITY, MAX_MAP_DENSITY, MIN_MAP_DENSITY, type MapDensity } from '../../../shared/contracts';
import { applyWallPhotoSelections, groupPhotosByRegion, isAdministrativeRegion, parentProvinceCode } from '../../domain';
import type { MapCamera, MapLevel, MapSnapshot, PhotoRecord, RegionCollection, RegionFeature, SelectedRegion, WallPhotoSelections } from '../../model';
import { clampCamera, mapPointFromScreen, MIN_MAP_ZOOM, panFromScreenDelta, zoomFromWheel } from '../../map-scene/interaction';
import { MAIN_VIEW_BOX, TERRAIN_BOUNDS, focusViewBox } from '../../map-scene/projection';
import { createSnapshot, drawMapScene, loadSceneImages, pathForFeature, type SceneImages } from '../../map-scene/scene';
import type { RendererMapPreference } from '../../settings';


interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}


export function densityFromWheel(current: MapDensity, deltaY: number): MapDensity {
  if (deltaY === 0) return current;
  const step = deltaY < 0 ? 1 : -1;
  return Math.max(MIN_MAP_DENSITY, Math.min(MAX_MAP_DENSITY, current + step)) as MapDensity;
}


function MapCanvas(props: {
  snapshot: MapSnapshot;
  selectedRegion?: SelectedRegion;
  onSelectRegion: (region: SelectedRegion) => void;
  onCameraChange: (camera: MapCamera) => void;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const [images, setImages] = useState<SceneImages>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = (): void => {
      const bounds = stage.getBoundingClientRect();
      setSize({ width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const camera = clampCamera(
      props.snapshot.camera,
      props.snapshot.viewBox,
      props.snapshot.level === 'province' ? TERRAIN_BOUNDS : props.snapshot.viewBox,
      size,
    );
    if (
      camera.zoom !== props.snapshot.camera.zoom
      || camera.panX !== props.snapshot.camera.panX
      || camera.panY !== props.snapshot.camera.panY
    ) {
      props.onCameraChange(camera);
    }
  }, [props.onCameraChange, props.snapshot, size]);

  // A scan can return the same layout ID with newly available photo files.
  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadSceneImages(props.snapshot).then((loaded) => {
      if (!active) return;
      setImages(loaded);
      setLoading(false);
    });
    return () => { active = false; };
  }, [props.snapshot.id, props.snapshot.photosByRegion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !images || size.width <= 0 || size.height <= 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    drawMapScene(context, {
      width: canvas.width,
      height: canvas.height,
      snapshot: props.snapshot,
      images,
      selectedRegionCode: props.selectedRegion?.code,
    });
  }, [images, props.selectedRegion?.code, props.snapshot, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      props.onCameraChange(clampCamera(
        { ...props.snapshot.camera, zoom: zoomFromWheel(props.snapshot.camera.zoom, event.deltaY) },
        props.snapshot.viewBox,
        props.snapshot.level === 'province' ? TERRAIN_BOUNDS : props.snapshot.viewBox,
        { width: bounds.width, height: bounds.height },
      ));
    };
    // React's delegated wheel listener is passive and cannot cancel page scrolling.
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [props.onCameraChange, props.snapshot]);

  const regionAtEvent = useCallback((event: React.PointerEvent<HTMLCanvasElement>): RegionFeature | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const bounds = canvas.getBoundingClientRect();
    const mapPoint = mapPointFromScreen(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      { width: bounds.width, height: bounds.height },
      props.snapshot.viewBox,
      props.snapshot.camera,
    );
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    return [...props.snapshot.regions].reverse().find((feature) => (
      context.isPointInPath(pathForFeature(feature), mapPoint.x, mapPoint.y, 'evenodd')
    ));
  }, [props.snapshot]);

  function startPointer(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
  }

  function movePointer(event: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || props.snapshot.camera.zoom <= MIN_MAP_ZOOM) return;
    const moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4;
    const delta = { x: event.clientX - drag.lastX, y: event.clientY - drag.lastY };
    dragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY, moved };
    if (!moved) return;
    if (!drag.moved) event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    props.onCameraChange(panFromScreenDelta(
      props.snapshot.camera,
      delta,
      props.snapshot.viewBox,
      { width: bounds.width, height: bounds.height },
      props.snapshot.level === 'province' ? TERRAIN_BOUNDS : props.snapshot.viewBox,
    ));
  }

  function finishPointer(event: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    if (drag.moved) return;
    const feature = regionAtEvent(event);
    const code = String(feature?.properties.gb ?? '');
    const name = String(feature?.properties.name ?? '');
    if (feature && code && name) props.onSelectRegion({ code, name, level: props.snapshot.level });
  }

  function keyboardNavigate(event: React.KeyboardEvent<HTMLCanvasElement>): void {
    if (props.snapshot.regions.length === 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      setFocusedIndex((current) => (current + 1) % props.snapshot.regions.length);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusedIndex((current) => (current - 1 + props.snapshot.regions.length) % props.snapshot.regions.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const feature = props.snapshot.regions[focusedIndex];
      const code = String(feature?.properties.gb ?? '');
      const name = String(feature?.properties.name ?? '');
      if (feature && code && name) props.onSelectRegion({ code, name, level: props.snapshot.level });
    }
  }

  return (
    <div className="map-stage" ref={stageRef}>
      <canvas
        ref={canvasRef}
        className={props.snapshot.camera.zoom > MIN_MAP_ZOOM ? 'map-canvas can-pan' : 'map-canvas'}
        data-testid="wall-canvas"
        data-snapshot-id={props.snapshot.id}
        tabIndex={0}
        aria-label="中国省市照片地图。单击行政区查看详情；滚轮缩放，放大后拖动；方向键选择行政区，按回车或空格确认。"
        onPointerDown={startPointer}
        onPointerMove={movePointer}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onKeyDown={keyboardNavigate}
      />
      {loading && <div className="map-loading"><MapTrifold size={26} weight="duotone" /><span>正在绘制离线地图…</span></div>}
    </div>
  );
}


export function PhotoWall(props: {
  provinces?: RegionCollection;
  cities?: RegionCollection;
  mapError?: string;
  photos: readonly PhotoRecord[];
  fixedPhotoSelections: WallPhotoSelections;
  selectedRegion?: SelectedRegion;
  mapPreference: RendererMapPreference;
  onMapPreferenceChange: (preference: RendererMapPreference) => void;
  onSelectedRegionChange: (region: SelectedRegion) => void;
  onSnapshotChange: (snapshot: MapSnapshot) => void;
}): React.JSX.Element {
  const densitySliderRef = useRef<HTMLInputElement>(null);
  const provinceRegions = useMemo(
    () => (props.provinces?.features ?? [])
      .filter(isAdministrativeRegion)
      .sort((left, right) => String(left.properties.gb ?? '').localeCompare(String(right.properties.gb ?? ''))),
    [props.provinces],
  );
  const firstPhotoProvince = props.photos.find((photo) => photo.location?.provinceCode)?.location?.provinceCode;
  const fallbackProvince = provinceRegions.find((feature) => feature.properties.gb === firstPhotoProvince)
    ?? provinceRegions[0];
  const selectedProvinceCode = props.selectedRegion
    ? (props.selectedRegion.level === 'province' ? props.selectedRegion.code : parentProvinceCode(props.selectedRegion.code))
    : String(fallbackProvince?.properties.gb ?? '');
  const cityRegions = useMemo(
    () => (props.cities?.features ?? []).filter((feature) => (
      isAdministrativeRegion(feature)
      && parentProvinceCode(String(feature.properties.gb ?? '')) === selectedProvinceCode
    )).sort((left, right) => String(left.properties.gb ?? '').localeCompare(String(right.properties.gb ?? ''))),
    [props.cities, selectedProvinceCode],
  );
  const { level, showPhotos, showPlaceNames, density, camera } = props.mapPreference;
  const regions = level === 'province' ? provinceRegions : cityRegions;
  const viewBox = useMemo(
    () => (level === 'province' ? MAIN_VIEW_BOX : focusViewBox(cityRegions)),
    [cityRegions, level],
  );
  const grouped = useMemo(() => groupPhotosByRegion(props.photos, level), [level, props.photos]);
  const wallPhotoGroups = useMemo(
    () => applyWallPhotoSelections(grouped, level, props.fixedPhotoSelections),
    [grouped, level, props.fixedPhotoSelections],
  );
  const snapshot = useMemo(() => createSnapshot({
    level,
    viewBox,
    camera,
    density,
    showPhotos,
    showPlaceNames,
    regions,
    photosByRegion: wallPhotoGroups.photosByRegion,
    fixedPhotoRegionCodes: wallPhotoGroups.fixedRegionCodes,
  }), [camera, density, level, regions, showPhotos, showPlaceNames, viewBox, wallPhotoGroups]);
  const validPhotos = props.photos.filter((photo) => photo.decodeState === 'valid');

  useEffect(() => {
    const slider = densitySliderRef.current;
    if (!slider) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const nextDensity = densityFromWheel(props.mapPreference.density, event.deltaY);
      if (nextDensity !== props.mapPreference.density) {
        props.onMapPreferenceChange({ ...props.mapPreference, density: nextDensity });
      }
    };
    slider.addEventListener('wheel', handleWheel, { passive: false });
    return () => slider.removeEventListener('wheel', handleWheel);
  }, [props.mapPreference, props.onMapPreferenceChange]);

  useEffect(() => props.onSnapshotChange(snapshot), [props.onSnapshotChange, snapshot]);

  useEffect(() => {
    const clamped = clampCamera(camera, viewBox, level === 'province' ? TERRAIN_BOUNDS : viewBox);
    if (clamped.zoom !== camera.zoom || clamped.panX !== camera.panX || clamped.panY !== camera.panY) {
      props.onMapPreferenceChange({ ...props.mapPreference, camera: clamped });
    }
  }, [camera, level, props.mapPreference, props.onMapPreferenceChange, viewBox]);

  function switchLevel(next: MapLevel): void {
    props.onMapPreferenceChange({
      ...props.mapPreference,
      level: next,
      camera: { zoom: MIN_MAP_ZOOM, panX: 0, panY: 0 },
    });
    if (next === 'province' && props.selectedRegion?.level === 'city') {
      const parentCode = parentProvinceCode(props.selectedRegion.code);
      const parent = provinceRegions.find((feature) => feature.properties.gb === parentCode);
      const name = String(parent?.properties.name ?? '');
      if (parent && name) props.onSelectedRegionChange({ code: parentCode, name, level: 'province' });
    }
    if (next === 'city' && cityRegions.length > 0) {
      const currentCity = props.selectedRegion?.level === 'city'
        ? cityRegions.find((feature) => feature.properties.gb === props.selectedRegion?.code)
        : undefined;
      const first = currentCity ?? cityRegions[0];
      const code = String(first?.properties.gb ?? '');
      const name = String(first?.properties.name ?? '');
      if (code && name) props.onSelectedRegionChange({ code, name, level: 'city' });
    }
  }

  return (
    <main className="workspace wall-workspace">
      <section className="wall-card has-operation-guide">
        <div className="wall-toolbar">
          <div className="density-control">
            <span className="density-title"><SlidersHorizontal size={16} />显示密度</span>
            <span>稀疏</span>
            <input
              ref={densitySliderRef}
              data-testid="map-density"
              type="range"
              min={MIN_MAP_DENSITY}
              max={MAX_MAP_DENSITY}
              step={1}
              value={density}
              aria-label="照片显示密度"
              aria-valuetext={density === BEST_MAP_DENSITY ? '最佳' : `密度 ${density}`}
              onChange={(event) => props.onMapPreferenceChange({
                ...props.mapPreference,
                density: Number(event.target.value) as MapDensity,
              })}
            />
            <span>密集</span>
            <button
              type="button"
              className={density === BEST_MAP_DENSITY ? 'density-best active' : 'density-best'}
              data-testid="density-best"
              aria-pressed={density === BEST_MAP_DENSITY}
              onClick={() => props.onMapPreferenceChange({
                ...props.mapPreference,
                density: BEST_MAP_DENSITY,
              })}
            >最佳</button>
          </div>
          <div className="wall-toolbar-actions">
            <div className="segmented" role="group" aria-label="地图层级" data-testid="map-level">
              <button type="button" className={level === 'province' ? 'active' : ''} onClick={() => switchLevel('province')}>省级视图</button>
              <button type="button" className={level === 'city' ? 'active' : ''} onClick={() => switchLevel('city')} disabled={cityRegions.length === 0}>市级视图</button>
            </div>
            <button type="button" data-testid="photo-visibility" className={showPhotos ? 'visibility-toggle active' : 'visibility-toggle'} aria-pressed={showPhotos} onClick={() => props.onMapPreferenceChange({ ...props.mapPreference, showPhotos: !showPhotos })}>
              {showPhotos ? <Eye size={17} /> : <EyeSlash size={17} />}{showPhotos ? '显示照片' : '隐藏照片'}
            </button>
            <button type="button" data-testid="place-name-visibility" className={showPlaceNames ? 'visibility-toggle active' : 'visibility-toggle'} aria-pressed={showPlaceNames} onClick={() => props.onMapPreferenceChange({ ...props.mapPreference, showPlaceNames: !showPlaceNames })}>
              <MapPin size={17} />{showPlaceNames ? '显示地名' : '隐藏地名'}
            </button>
          </div>
        </div>
        <div
          id="wall-operation-guide"
          className="operation-guide wall-operation-guide"
          data-testid="wall-operation-guide"
          role="note"
        >
          <Info size={17} aria-hidden="true" />
          <span>单击行政区查看详情，滚轮缩放地图，放大后按住拖动</span>
        </div>
        {props.mapError || !props.provinces || !props.cities ? (
          <div className="map-error"><WarningCircle size={32} weight="duotone" /><strong>离线地图不可用</strong><span>{props.mapError ?? '正在校验本地地图包…'}</span></div>
        ) : (
          <MapCanvas
            snapshot={snapshot}
            selectedRegion={props.selectedRegion}
            onSelectRegion={props.onSelectedRegionChange}
            onCameraChange={(nextCamera) => props.onMapPreferenceChange({ ...props.mapPreference, camera: nextCamera })}
          />
        )}
        {validPhotos.length === 0 && !props.mapError && (
          <div className="wall-empty-note">当前没有可填入地图的已标地点照片，行政底图仍可浏览。</div>
        )}
      </section>
    </main>
  );
}
