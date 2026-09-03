import { describe, expect, it } from 'vitest';

import {
  CITIES,
  PROVINCES,
  validateAdministrativeLocation,
} from '../../src/shared/administrative-regions';

import sourceData from '../../src/shared/administrative-regions.data.json';

describe('bundled administrative-region directory', () => {
  it('generated_directory__provenance__retains_the_verified_source_contract', () => {
    // The generator verifies these source hashes before writing the self-contained directory.
    const expectedSources = [
      {
        level: 'province',
        fileName: 'china-provinces.geojson',
        byteLength: 1_698_398,
        sha256: '3af8294f9ad61cc2bf84c1bb7e4bbf86a6336c68d754b699a0e6ddc33ef81486',
      },
      {
        level: 'city',
        fileName: 'china-city-view.geojson',
        byteLength: 4_265_699,
        sha256: 'd7a6f05b7e58cf758d74bd71ed0ea2ce981ef99436e4881e9a68098c3cd80b3b',
      },
    ] as const;

    expect(sourceData.schemaVersion).toBe(1);
    expect(sourceData.dataVersion).toBe(
      `geojson-sha256:${expectedSources.map((source) => source.sha256).join('+')}`,
    );
    expect(sourceData.provenance.sourcePageUrl)
      .toBe('https://cloudcenter.tianditu.gov.cn/administrativeDivision');
    expect(sourceData.provenance.generatedFrom).toEqual(expectedSources);
    expect(sourceData.provenance.ordering)
      .toBe('province-code-ascending-then-city-code-ascending');
    expect(sourceData.provenance.excludedFeatureName).toBe('境界线');
  });

  it('generated_records__read__are_complete_stably_ordered_and_frozen', () => {
    expect(PROVINCES).toHaveLength(34);
    expect(CITIES).toHaveLength(375);
    expect(sourceData.regions).toEqual([...PROVINCES, ...CITIES]);
    expect(PROVINCES.map((region) => region.code)).toEqual(
      [...PROVINCES].map((region) => region.code).sort(),
    );
    expect(CITIES.map((region) => region.code)).toEqual(
      [...CITIES].map((region) => region.code).sort(),
    );
    expect(Object.isFrozen(PROVINCES)).toBe(true);
    expect(Object.isFrozen(CITIES[0])).toBe(true);
  });

  it('municipality_records__retain_distinct_levels_and_validate_their_shared_code', () => {
    expect(PROVINCES.find((region) => region.code === '156310000')).toEqual({
      level: 'province',
      code: '156310000',
      name: '上海市',
      parentProvinceCode: null,
    });
    expect(CITIES.find((region) => region.code === '156310000')).toEqual({
      level: 'city',
      code: '156310000',
      name: '上海市',
      parentProvinceCode: '156310000',
    });
    expect(validateAdministrativeLocation({ provinceGb: '156310000', cityGb: '156310000' }))
      .toEqual({ valid: true });
    expect(validateAdministrativeLocation({ provinceGb: '156420000', cityGb: '156310000' }))
      .toEqual({ valid: false, reason: 'city-province-mismatch' });
  });

  it('every_city__belongs_to_one_bundled_province_and_is_a_valid_assignment', () => {
    for (const city of CITIES) {
      const parents = PROVINCES.filter((province) => province.code === city.parentProvinceCode);
      expect(parents).toHaveLength(1);
      expect(validateAdministrativeLocation({ provinceGb: parents[0]!.code, cityGb: city.code }))
        .toEqual({ valid: true });
    }
  });

  it('location_assignment__validate__checks_the_bundled_parent_child_relationship', () => {
    expect(validateAdministrativeLocation({ provinceGb: '156420000' })).toEqual({ valid: true });
    expect(validateAdministrativeLocation({
      provinceGb: '156420000',
      cityGb: '156420100',
    })).toEqual({ valid: true });
    expect(validateAdministrativeLocation({ provinceGb: '156000000' })).toEqual({
      valid: false,
      reason: 'province-not-found',
    });
    expect(validateAdministrativeLocation({
      provinceGb: '156430000',
      cityGb: '156420100',
    })).toEqual({
      valid: false,
      reason: 'city-province-mismatch',
    });
  });
});
