import type { LocationAssignment } from './contracts';
import sourceData from './administrative-regions.data.json';

export type AdministrativeRegionLevel = 'province' | 'city';

export interface AdministrativeRegion {
  readonly level: AdministrativeRegionLevel;
  readonly code: string;
  readonly name: string;
  readonly parentProvinceCode: string | null;
}

export type AdministrativeLocationValidation =
  | { readonly valid: true }
  | {
    readonly valid: false;
    readonly reason: 'province-not-found' | 'city-province-mismatch';
  };

if (sourceData.schemaVersion !== 1 || sourceData.dataVersion.length === 0) {
  throw new Error('The bundled administrative-region dataset metadata is invalid.');
}

const regions = Object.freeze(sourceData.regions.map((region): AdministrativeRegion => {
  if (
    (region.level !== 'province' && region.level !== 'city') ||
    !/^156\d{6}$/u.test(region.code) ||
    region.name.length === 0 ||
    (region.level === 'province' && region.parentProvinceCode !== null) ||
    (region.level === 'city' && !/^156\d{6}$/u.test(region.parentProvinceCode ?? ''))
  ) {
    throw new Error('The bundled administrative-region directory is invalid.');
  }
  return Object.freeze({
    level: region.level,
    code: region.code,
    name: region.name,
    parentProvinceCode: region.parentProvinceCode,
  });
}));

export const PROVINCES: readonly AdministrativeRegion[] = Object.freeze(
  regions.filter((region) => region.level === 'province'),
);

export const CITIES: readonly AdministrativeRegion[] = Object.freeze(
  regions.filter((region) => region.level === 'city'),
);

const provinceByCode = new Map(PROVINCES.map((region) => [region.code, region]));
const cityByCode = new Map(CITIES.map((region) => [region.code, region]));
if (
  PROVINCES.length !== 34 ||
  CITIES.length !== 375 ||
  provinceByCode.size !== PROVINCES.length ||
  cityByCode.size !== CITIES.length ||
  !isStrictlyOrdered(PROVINCES) ||
  !isStrictlyOrdered(CITIES) ||
  CITIES.some((city) => !provinceByCode.has(city.parentProvinceCode ?? ''))
) {
  throw new Error('The bundled administrative-region directory is inconsistent.');
}

for (const source of sourceData.provenance.generatedFrom) {
  if (
    (source.level !== 'province' && source.level !== 'city') ||
    source.fileName.length === 0 ||
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength <= 0 ||
    !/^[a-f0-9]{64}$/u.test(source.sha256)
  ) {
    throw new Error('The bundled administrative-region provenance is invalid.');
  }
}

if (!sourceData.provenance.sourcePageUrl.startsWith('https://')) {
  throw new Error('The bundled administrative-region provenance source URL is invalid.');
}

const VALID_LOCATION: AdministrativeLocationValidation = Object.freeze({ valid: true });
const PROVINCE_NOT_FOUND: AdministrativeLocationValidation = Object.freeze({
  valid: false,
  reason: 'province-not-found',
});
const CITY_PROVINCE_MISMATCH: AdministrativeLocationValidation = Object.freeze({
  valid: false,
  reason: 'city-province-mismatch',
});

export function validateAdministrativeLocation(
  location: LocationAssignment,
): AdministrativeLocationValidation {
  if (!provinceByCode.has(location.provinceGb)) return PROVINCE_NOT_FOUND;
  if (location.cityGb === undefined) return VALID_LOCATION;
  const city = cityByCode.get(location.cityGb);
  return city?.parentProvinceCode === location.provinceGb
    ? VALID_LOCATION
    : CITY_PROVINCE_MISMATCH;
}

function isStrictlyOrdered(entries: readonly AdministrativeRegion[]): boolean {
  return entries.every((entry, index) => index === 0 || entries[index - 1]!.code < entry.code);
}
