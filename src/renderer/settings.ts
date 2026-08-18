import type { MapDensity } from '../shared/contracts';
import type { MapLevel, MapCamera } from './model';

export interface RendererMapPreference {
  level: MapLevel;
  showPhotos: boolean;
  showPlaceNames: boolean;
  density: MapDensity;
  camera: MapCamera;
}
