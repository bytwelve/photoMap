import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CITIES, PROVINCES } from '../../src/shared/administrative-regions';
import type { GpsCoordinates } from '../../src/main/services/library-scan/exif-gps-reader';
import { RegionCatalog } from '../../src/main/services/regions/region-catalog';

const fixtureContracts = vi.hoisted(() => ({
  province: { canonicalFileName: 'provinces.geojson', byteLength: 0, sha256: '' },
  city: { canonicalFileName: 'cities.geojson', byteLength: 0, sha256: '' },
}));

// Substitute only the accepted input identities; exercise the real file loader and resolver.
vi.mock('../../src/main/services/map-data/map-data-contract', () => ({
  PROVINCE_MAP_DATA_CONTRACT: fixtureContracts.province,
  CITY_MAP_DATA_CONTRACT: fixtureContracts.city,
}));

interface RegionFixture {
  gb: string;
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-regions-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

async function loadFixtureCatalog(
  provinces: readonly RegionFixture[],
  cities: readonly RegionFixture[],
): Promise<RegionCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-regions-'));
  temporaryRoots.push(root);
  for (const [kind, directory, overrides] of [
    ['province', PROVINCES, provinces],
    ['city', CITIES, cities],
  ] as const) {
    const supplied = new Map(overrides.map((region) => [region.gb, region]));
    expect([...supplied.keys()].every((code) => directory.some((region) => region.code === code))).toBe(true);
    const features = directory.map(({ code }) => ({
      type: 'Feature',
      properties: { gb: code },
      geometry: (supplied.get(code) ?? square(code, -175, -85, -174, -84)).geometry,
    }));
    const bytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }));
    const contract = fixtureContracts[kind];
    contract.byteLength = bytes.length;
    contract.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(root, contract.canonicalFileName), bytes);
  }
  const catalog = new RegionCatalog();
  await catalog.load(root);
  return catalog;
}

async function resolveFixtureGps(
  gps: GpsCoordinates,
  provinces: readonly RegionFixture[],
  cities: readonly RegionFixture[],
) {
  const catalog = await loadFixtureCatalog(provinces, cities);
  return catalog.resolveGps(gps);
}

function square(gb: string, minX: number, minY: number, maxX: number, maxY: number): RegionFixture {
  return {
    gb,
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[[
        minX, minY,
      ], [
        maxX, minY,
      ], [
        maxX, maxY,
      ], [
        minX, maxY,
      ], [
        minX, minY,
      ]]]],
    },
  };
}

describe('RegionCatalog GPS resolution', () => {
  it('geometry_unavailable__assert_location__still_uses_the_bundled_directory', () => {
    const catalog = new RegionCatalog();

    expect(catalog.isAvailable()).toBe(false);
    expect(() => catalog.assertLocation({
      provinceGb: '156420000',
      cityGb: '156420100',
    })).not.toThrow();
    expect(() => catalog.assertLocation({ provinceGb: '156000000' }))
      .toThrow('选择的省级区域不存在。');
    expect(() => catalog.assertLocation({
      provinceGb: '156430000',
      cityGb: '156420100',
    })).toThrow('选择的市级区域与省级区域不匹配。');
  });

  it('geometry_reset__does_not_disable_bundled_location_validation', async () => {
    const catalog = await loadFixtureCatalog([square('156420000', 100, 20, 120, 40)], []);
    expect(catalog.resolveGps({ latitude: 30, longitude: 110 })).toEqual({ provinceGb: '156420000' });

    catalog.reset();
    expect(catalog.resolveGps({ latitude: 30, longitude: 110 })).toBeNull();
    expect(catalog.isAvailable()).toBe(false);
    expect(() => catalog.assertLocation({ provinceGb: '156420000' })).not.toThrow();
  });

  it('explicitly_unsupported_map_datum__resolve__returns_null_instead_of_misplacing_the_photo', async () => {
    expect(await resolveFixtureGps(
      { latitude: 30, longitude: 110, mapDatum: 'Tokyo' },
      [square('156420000', 100, 20, 120, 40)],
      [square('156420100', 105, 25, 115, 35)],
    )).toBeNull();
  });

  it('synthetic_shanghai_regions__point_in_shanghai__resolves_unique_province_and_city', async () => {
    expect(await resolveFixtureGps(
      { latitude: 31.2304, longitude: 121.4737 },
      [square('156310000', 120, 30, 123, 33)],
      [square('156310000', 120, 30, 123, 33)],
    )).toEqual({
      provinceGb: '156310000',
      cityGb: '156310000',
    });
  });

  it('point_outside_map__resolve__returns_null', async () => {
    expect(await resolveFixtureGps(
      { latitude: -20, longitude: -140 },
      [square('156110000', 100, 20, 110, 30)],
      [],
    )).toBeNull();
  });

  it('point_in_overlapping_provinces__resolve__returns_null_instead_of_guessing', async () => {
    const provinces = [
      square('156110000', 100, 20, 110, 30),
      square('156120000', 105, 25, 115, 35),
    ];

    expect(await resolveFixtureGps(
      { latitude: 27, longitude: 107 },
      provinces,
      [],
    )).toBeNull();
  });

  it('point_in_two_child_cities__resolve__safely_falls_back_to_the_unique_province', async () => {
    const provinces = [square('156420000', 100, 20, 120, 40)];
    const cities = [
      square('156420100', 100, 20, 111, 31),
      square('156420200', 105, 25, 115, 35),
    ];

    expect(await resolveFixtureGps(
      { latitude: 27, longitude: 107 },
      provinces,
      cities,
    )).toEqual({ provinceGb: '156420000' });
  });

  it('point_in_one_child_city__resolve__returns_the_parent_and_city', async () => {
    const provinces = [square('156420000', 100, 20, 120, 40)];
    const cities = [square('156420100', 105, 25, 115, 35)];

    expect(await resolveFixtureGps(
      { latitude: 30, longitude: 110 },
      provinces,
      cities,
    )).toEqual({ provinceGb: '156420000', cityGb: '156420100' });
  });
});
