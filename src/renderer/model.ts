import type { DecodeState, MediaFormat, MediaKind } from '../shared/contracts';

// Only MediaKind is consumed through this module; renderer code that needs the other
// two imports them from the shared contract directly.
export type { MediaKind };

export type AppMode = 'wall' | 'memory' | 'batch';
export type MapLevel = 'province' | 'city';

export interface RegionLocation {
  provinceCode: string;
  provinceName: string;
  cityCode?: string;
  cityName?: string;
}

export interface PhotoTypeTag {
  id: string;
  name: string;
  builtin?: boolean;
}

export interface PhotoRecord {
  id: string;
  name: string;
  folderPath?: string;
  mediaUrl: string;
  thumbnailUrl: string;
  mediaKind: MediaKind;
  mediaFormat: MediaFormat;
  fileCreatedAtMs?: number;
  captureTimeLocal?: string | null;
  captureTimeOffsetMinutes?: number | null;
  captureTimeSource?: 'metadata' | 'user' | null;
  note?: string;
  decodeState: DecodeState;
  decodeMessage?: string;
  width?: number;
  height?: number;
  location?: RegionLocation;
  types: PhotoTypeTag[];
}

export interface LibraryState {
  sourceId?: string;
  sourceName?: string;
  sourceAvailable: boolean;
  photos: PhotoRecord[];
  photoTypes: PhotoTypeTag[];
  scan?: ScanProgress;
}

export interface ScanProgress {
  state: 'idle' | 'running' | 'complete' | 'partial' | 'cancelled' | 'failed';
  discovered: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped?: number;
  message?: string;
}

export interface FilterState {
  locationCodes: Set<string>;
  includeUnlocated: boolean;
  mediaKinds: Set<MediaKind>;
  folderPaths: Set<string>;
  typeIds: Set<string>;
  search: string;
}

export interface RegionFeatureProperties {
  name?: string;
  gb?: string;
  [key: string]: unknown;
}

export type Position = [number, number];
export type PolygonCoordinates = Position[][];
export type MultiPolygonCoordinates = Position[][][];

export interface RegionFeature {
  type: 'Feature';
  properties: RegionFeatureProperties;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: PolygonCoordinates | MultiPolygonCoordinates;
  };
}

export interface RegionCollection {
  type: 'FeatureCollection';
  features: RegionFeature[];
}

export interface SelectedRegion {
  code: string;
  name: string;
  level: MapLevel;
}

export type WallPhotoSelections = ReadonlyMap<string, readonly string[]>;

export interface MapCamera {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapSnapshot {
  id: string;
  level: MapLevel;
  viewBox: ViewBox;
  camera: MapCamera;
  density: number;
  showPhotos: boolean;
  showPlaceNames: boolean;
  regions: RegionFeature[];
  photosByRegion: ReadonlyMap<string, readonly PhotoRecord[]>;
  fixedPhotoRegionCodes?: ReadonlySet<string>;
  createdAt: number;
}

export interface OperationFeedback {
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}
