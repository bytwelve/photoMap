import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LocationAssignment } from '../../../shared/contracts';
import {
  CITIES,
  PROVINCES,
  validateAdministrativeLocation,
} from '../../../shared/administrative-regions';
import { PhotoMapError } from '../../../shared/errors';
import type { GpsCoordinates } from '../library-scan/exif-gps-reader';
import {
  CITY_MAP_DATA_CONTRACT,
  PROVINCE_MAP_DATA_CONTRACT,
} from '../map-data/map-data-contract';

type GeoPosition = [longitude: number, latitude: number];

interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: GeoPosition[][][];
}

interface RegionGeometry {
  gb: string;
  geometry: MultiPolygonGeometry;
}

interface CoordinateBounds {
  minLongitude: number;
  minLatitude: number;
  maxLongitude: number;
  maxLatitude: number;
}

interface PreparedRegion extends RegionGeometry {
  bounds: CoordinateBounds;
}

interface GeoJsonFeature {
  type?: unknown;
  properties?: { gb?: unknown; name?: unknown };
  geometry?: { type?: unknown; coordinates?: unknown };
}

interface GeoJsonCollection {
  type?: unknown;
  features?: unknown;
}

const GB_PATTERN = /^156\d{6}$/;
export class RegionCatalog {
  private readonly provinceGeometries: PreparedRegion[] = [];
  private readonly cityGeometries: PreparedRegion[] = [];
  private available = false;

  public async load(mapDataDirectory: string): Promise<void> {
    const [provinceBytes, cityBytes] = await Promise.all([
      readFile(path.join(mapDataDirectory, PROVINCE_MAP_DATA_CONTRACT.canonicalFileName)),
      readFile(path.join(mapDataDirectory, CITY_MAP_DATA_CONTRACT.canonicalFileName))
    ]);
    if (
      provinceBytes.length !== PROVINCE_MAP_DATA_CONTRACT.byteLength ||
      cityBytes.length !== CITY_MAP_DATA_CONTRACT.byteLength ||
      createHash('sha256').update(provinceBytes).digest('hex') !== PROVINCE_MAP_DATA_CONTRACT.sha256 ||
      createHash('sha256').update(cityBytes).digest('hex') !== CITY_MAP_DATA_CONTRACT.sha256
    ) {
      throw this.invalidMap('本地地图数据校验失败，地图与 GPS 地点解析已禁用。');
    }
    const provinces = new Set<string>();
    const cities = new Set<string>();
    const provinceGeometries: PreparedRegion[] = [];
    const cityGeometries: PreparedRegion[] = [];
    this.collect(
      JSON.parse(provinceBytes.toString('utf8')) as GeoJsonCollection,
      provinces,
      provinceGeometries,
    );
    this.collect(
      JSON.parse(cityBytes.toString('utf8')) as GeoJsonCollection,
      cities,
      cityGeometries,
    );
    if (
      !matchesAdministrativeRegionCodes(provinces, PROVINCES) ||
      !matchesAdministrativeRegionCodes(cities, CITIES)
    ) {
      throw this.invalidMap(
        '本地地图区域编码与内置行政区目录不一致，地图与 GPS 地点解析已禁用。',
      );
    }

    this.reset();
    this.provinceGeometries.push(...provinceGeometries);
    this.cityGeometries.push(...cityGeometries);
    this.available = true;
  }

  public reset(): void {
    this.available = false;
    this.provinceGeometries.length = 0;
    this.cityGeometries.length = 0;
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public resolveGps(gps: GpsCoordinates): LocationAssignment | null {
    if (!this.available) return null;
    return resolveGpsAgainstPreparedRegions(gps, this.provinceGeometries, this.cityGeometries);
  }

  public assertLocation(location: LocationAssignment): void {
    const validation = validateAdministrativeLocation(location);
    if (validation.valid) return;
    if (validation.reason === 'province-not-found') {
      throw new PhotoMapError('INVALID_REQUEST', '选择的省级区域不存在。');
    }
    throw new PhotoMapError('INVALID_REQUEST', '选择的市级区域与省级区域不匹配。');
  }

  private collect(
    collection: GeoJsonCollection,
    target: Set<string>,
    geometries: PreparedRegion[],
  ): void {
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
      throw this.invalidMap('本地地图数据格式无效。');
    }
    for (const value of collection.features) {
      const feature = value as GeoJsonFeature;
      const gb = feature.properties?.gb;
      const name = feature.properties?.name;
      if (name === '境界线') {
        continue;
      }
      if (
        feature.type !== 'Feature' ||
        typeof gb !== 'string' ||
        !GB_PATTERN.test(gb) ||
        feature.geometry?.type !== 'MultiPolygon'
      ) {
        throw this.invalidMap('本地地图区域字段无效。');
      }
      if (target.has(gb)) {
        throw this.invalidMap('本地地图区域编码重复。');
      }
      let prepared: PreparedRegion;
      try {
        prepared = prepareRegion({
          gb,
          geometry: {
            type: 'MultiPolygon',
            coordinates: feature.geometry.coordinates as GeoPosition[][][],
          },
        });
      } catch {
        throw this.invalidMap('本地地图区域几何无效。');
      }
      target.add(gb);
      geometries.push(prepared);
    }
  }

  private invalidMap(message: string): PhotoMapError {
    return new PhotoMapError('MAP_CONTRACT_INVALID', message, { scope: 'global' });
  }
}

function matchesAdministrativeRegionCodes(
  geometryCodes: ReadonlySet<string>,
  directoryRegions: readonly { readonly code: string }[],
): boolean {
  return geometryCodes.size === directoryRegions.length &&
    directoryRegions.every((region) => geometryCodes.has(region.code));
}

function resolveGpsAgainstPreparedRegions(
  gps: GpsCoordinates,
  provinces: readonly PreparedRegion[],
  cities: readonly PreparedRegion[],
): LocationAssignment | null {
  if (!isValidGps(gps)) return null;
  const point: GeoPosition = [gps.longitude, gps.latitude];
  const provinceHits = provinces.filter((region) => regionContainsPoint(region, point));
  if (provinceHits.length !== 1) return null;

  const province = provinceHits[0]!;
  const cityHits = cities.filter((region) =>
    parentProvinceGb(region.gb) === province.gb && regionContainsPoint(region, point));
  if (cityHits.length === 1) {
    return { provinceGb: province.gb, cityGb: cityHits[0]!.gb };
  }
  return { provinceGb: province.gb };
}

function prepareRegion(region: RegionGeometry): PreparedRegion {
  if (!GB_PATTERN.test(region.gb) || region.geometry.type !== 'MultiPolygon') {
    throw new Error('Invalid region identity.');
  }
  const coordinates = validateAndCopyCoordinates(region.geometry.coordinates);
  return {
    gb: region.gb,
    geometry: { type: 'MultiPolygon', coordinates },
    bounds: coordinateBounds(coordinates),
  };
}

function validateAndCopyCoordinates(value: unknown): GeoPosition[][][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('MultiPolygon must contain at least one polygon.');
  }
  return value.map((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      throw new Error('Polygon must contain an exterior ring.');
    }
    return polygon.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 4) {
        throw new Error('Linear ring is incomplete.');
      }
      const positions = ring.map((position): GeoPosition => {
        if (
          !Array.isArray(position) ||
          position.length !== 2 ||
          typeof position[0] !== 'number' ||
          typeof position[1] !== 'number' ||
          !Number.isFinite(position[0]) ||
          !Number.isFinite(position[1]) ||
          position[0] < -180 ||
          position[0] > 180 ||
          position[1] < -90 ||
          position[1] > 90
        ) {
          throw new Error('Invalid GeoJSON position.');
        }
        return [position[0], position[1]];
      });
      const first = positions[0]!;
      const last = positions[positions.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) {
        throw new Error('Linear ring is not closed.');
      }
      return positions;
    });
  });
}

function coordinateBounds(coordinates: GeoPosition[][][]): CoordinateBounds {
  let minLongitude = Number.POSITIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  for (const polygon of coordinates) {
    for (const ring of polygon) {
      for (const [longitude, latitude] of ring) {
        minLongitude = Math.min(minLongitude, longitude);
        minLatitude = Math.min(minLatitude, latitude);
        maxLongitude = Math.max(maxLongitude, longitude);
        maxLatitude = Math.max(maxLatitude, latitude);
      }
    }
  }
  return { minLongitude, minLatitude, maxLongitude, maxLatitude };
}

function regionContainsPoint(region: PreparedRegion, point: GeoPosition): boolean {
  const [longitude, latitude] = point;
  const bounds = region.bounds;
  if (
    longitude < bounds.minLongitude ||
    longitude > bounds.maxLongitude ||
    latitude < bounds.minLatitude ||
    latitude > bounds.maxLatitude
  ) {
    return false;
  }
  return region.geometry.coordinates.some((polygon) => polygonContainsPoint(polygon, point));
}

function polygonContainsPoint(polygon: GeoPosition[][], point: GeoPosition): boolean {
  const exterior = ringPointRelation(polygon[0]!, point);
  if (exterior === 'outside') return false;
  if (exterior === 'boundary') return true;
  for (let index = 1; index < polygon.length; index += 1) {
    const hole = ringPointRelation(polygon[index]!, point);
    if (hole === 'boundary') return true;
    if (hole === 'inside') return false;
  }
  return true;
}

function ringPointRelation(
  ring: GeoPosition[],
  point: GeoPosition,
): 'inside' | 'outside' | 'boundary' {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous]!;
    const end = ring[index]!;
    if (pointOnSegment(point, start, end)) return 'boundary';
    const crossesLatitude = (start[1] > point[1]) !== (end[1] > point[1]);
    if (crossesLatitude) {
      const longitudeAtLatitude = start[0] +
        ((point[1] - start[1]) * (end[0] - start[0])) / (end[1] - start[1]);
      if (point[0] < longitudeAtLatitude) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

function pointOnSegment(point: GeoPosition, start: GeoPosition, end: GeoPosition): boolean {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const cross = (point[0] - start[0]) * deltaY - (point[1] - start[1]) * deltaX;
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(deltaX), Math.abs(deltaY));
  if (Math.abs(cross) > tolerance) return false;
  return point[0] >= Math.min(start[0], end[0]) - tolerance &&
    point[0] <= Math.max(start[0], end[0]) + tolerance &&
    point[1] >= Math.min(start[1], end[1]) - tolerance &&
    point[1] <= Math.max(start[1], end[1]) + tolerance;
}

function isValidGps(gps: GpsCoordinates): boolean {
  const normalizedDatum = gps.mapDatum?.replace(/[\s_-]/gu, '').toUpperCase();
  const supportedDatum = normalizedDatum === undefined || normalizedDatum === 'WGS84';
  return supportedDatum &&
    Number.isFinite(gps.latitude) &&
    Number.isFinite(gps.longitude) &&
    gps.latitude >= -90 &&
    gps.latitude <= 90 &&
    gps.longitude >= -180 &&
    gps.longitude <= 180;
}

function parentProvinceGb(cityGb: string): string {
  return `${cityGb.slice(0, 5)}0000`;
}
