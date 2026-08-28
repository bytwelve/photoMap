import type { MapDataKind } from '../../../shared/contracts';
import manifest from '../../../shared/map-data-manifest.json';

export interface MapDataFileContract {
  kind: MapDataKind;
  label: string;
  canonicalFileName: string;
  byteLength: number;
  sha256: string;
}

function contract(kind: MapDataKind): MapDataFileContract {
  const entry = manifest.files.find((file) => file.kind === kind);
  if (!entry) throw new Error(`Missing map data contract: ${kind}`);
  return Object.freeze({ ...entry, kind });
}

export const PROVINCE_MAP_DATA_CONTRACT = contract('province');
export const CITY_MAP_DATA_CONTRACT = contract('city');

export const PHOTO_MAP_DATA_CONTRACT: readonly MapDataFileContract[] = Object.freeze([
  PROVINCE_MAP_DATA_CONTRACT,
  CITY_MAP_DATA_CONTRACT,
]);
