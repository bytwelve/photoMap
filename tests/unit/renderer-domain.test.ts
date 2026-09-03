import { describe, expect, it } from 'vitest';

import { CITIES, PROVINCES } from '../../src/shared/administrative-regions';
import { MEDIA_KINDS, type MediaKind } from '../../src/shared/contracts';
import { folderPathFromRelativePath } from '../../src/shared/folder-filter';
import { regionNamesFromOptions, toLibraryState, toScanProgress } from '../../src/renderer/bridge';
import {
  activeFiltersForMode,
  applyWallPhotoSelections,
  buildFolderFilterTree,
  compareFilterItems,
  filterPhotos,
  groupPhotosByRegion,
  sortAnnotationPhotosByCreationTime,
  stablePhotoOrder,
  toggleChildFolderFilter,
  toggleCityLocationFilter,
  toggleProvinceLocationFilter,
  toggleParentFolderFilter,
  wallPhotoSelectionKey,
} from '../../src/renderer/domain';
import type { FilterState, PhotoRecord } from '../../src/renderer/model';

function photo(
  id: string,
  provinceCode: string | undefined,
  cityCode: string | undefined,
  typeIds: string[],
  decodeState: PhotoRecord['decodeState'] = 'valid',
  mediaKind: PhotoRecord['mediaKind'] = 'photo',
  folderPath?: string,
): PhotoRecord {
  return {
    id,
    name: `${id}.jpg`,
    mediaUrl: `photomap-media://photo/${id}`,
    thumbnailUrl: `photomap-media://photo/${id}`,
    mediaKind,
    mediaFormat: mediaKind === 'video' ? 'mp4' : 'jpg',
    folderPath,
    decodeState,
    location: provinceCode
      ? {
          provinceCode,
          provinceName: provinceCode,
          ...(cityCode ? { cityCode, cityName: cityCode } : {}),
        }
      : undefined,
    types: typeIds.map((typeId) => ({ id: typeId, name: typeId })),
  };
}

function filters(
  locationCodes: string[],
  typeIds: string[],
  includeUnlocated = false,
  mediaKinds: readonly MediaKind[] = MEDIA_KINDS,
  folderPaths: readonly string[] = [],
): FilterState {
  return {
    locationCodes: new Set(locationCodes),
    includeUnlocated,
    mediaKinds: new Set(mediaKinds),
    folderPaths: new Set(folderPaths),
    typeIds: new Set(typeIds),
    search: '',
  };
}

const catalog = [
  photo('a-x', '156420000', '156420100', ['portrait']),
  photo('b-y', '156310000', '156310000', ['landscape']),
  photo('b-x-y', '156310000', '156310000', ['portrait', 'landscape']),
  photo('unlocated-x', undefined, undefined, ['portrait']),
];

describe('filter item ordering', () => {
  it('selected_items__sort__pins_them_and_orders_only_remaining_items_by_photo_count', () => {
    const items = [
      { id: 'selected-later', pinned: true, photoCount: 1, sourceOrder: 3 },
      { id: 'count-8-later', pinned: false, photoCount: 8, sourceOrder: 2 },
      { id: 'selected-earlier', pinned: true, photoCount: 0, sourceOrder: 1 },
      { id: 'count-3', pinned: false, photoCount: 3, sourceOrder: 0 },
      { id: 'count-8-earlier', pinned: false, photoCount: 8, sourceOrder: 1 },
    ];

    expect([...items].sort(compareFilterItems).map(({ id }) => id)).toEqual([
      'selected-earlier',
      'selected-later',
      'count-8-earlier',
      'count-8-later',
      'count-3',
    ]);
  });
});

describe('PRD-FR-009 / PRD-AC-004 shared filter truth table', () => {
  it('prd_fr_009__multiple_locations_selected__filters__matches_location_group_with_or', () => {
    expect(filterPhotos(catalog, filters(['156420000', '156310000'], [])).map(({ id }) => id))
      .toEqual(['a-x', 'b-y', 'b-x-y']);
  });

  it('prd_fr_009__multiple_types_selected__filters__matches_type_group_with_or', () => {
    expect(filterPhotos(catalog, filters([], ['portrait', 'landscape'])).map(({ id }) => id))
      .toEqual(['a-x', 'b-y', 'b-x-y', 'unlocated-x']);
  });

  it('prd_fr_009__location_and_type_groups_selected__filters__combines_groups_with_and', () => {
    expect(filterPhotos(catalog, filters(['156420000'], ['landscape'])).map(({ id }) => id))
      .toEqual([]);
    expect(filterPhotos(catalog, filters(['156310000'], ['portrait'])).map(({ id }) => id))
      .toEqual(['b-x-y']);
  });

  it('prd_fr_009__one_filter_group_empty__filters__empty_group_does_not_restrict', () => {
    expect(filterPhotos(catalog, filters([], [])).map(({ id }) => id)).toEqual(
      catalog.map(({ id }) => id),
    );
  });

  it('media_kind_filters__multiple_selected__uses_or_within_media_and_and_between_filter_groups', () => {
    const mediaCatalog = [
      photo('plain-photo', '156420000', undefined, ['landscape'], 'valid', 'photo'),
      photo('plain-video', '156420000', undefined, ['landscape'], 'valid', 'video'),
      photo('live-photo', '156310000', undefined, ['portrait'], 'valid', 'live'),
    ];

    expect(filterPhotos(mediaCatalog, filters([], [], false, ['video', 'live'])).map(({ id }) => id))
      .toEqual(['plain-video', 'live-photo']);
    expect(filterPhotos(mediaCatalog, filters(['156420000'], ['landscape'], false, ['video'])).map(({ id }) => id))
      .toEqual(['plain-video']);
    expect(filterPhotos(mediaCatalog, filters([], [], false, [])).map(({ id }) => id))
      .toEqual([]);
  });

  it('unlocated_filter__selected__matches_only_photos_without_a_province', () => {
    const provinceOnly = photo('province-only', '156420000', undefined, ['portrait']);

    expect(filterPhotos([...catalog, provinceOnly], filters([], [], true)).map(({ id }) => id))
      .toEqual(['unlocated-x']);
  });

  it('unlocated_and_region_filters__selected_with_type__uses_location_or_then_type_and', () => {
    expect(filterPhotos(catalog, filters(['156420000'], ['portrait'], true)).map(({ id }) => id))
      .toEqual(['a-x', 'unlocated-x']);
  });

  it('photo_wall__unlocated_filter__is_inactive_without_changing_the_annotation_preference', () => {
    const annotationFilters = filters([], [], true);
    const wallFilters = activeFiltersForMode(annotationFilters, 'wall');

    expect(wallFilters.includeUnlocated).toBe(false);
    expect(annotationFilters.includeUnlocated).toBe(true);
    expect(activeFiltersForMode(annotationFilters, 'batch')).toBe(annotationFilters);
    expect(filterPhotos(catalog, wallFilters).map(({ id }) => id)).toEqual(
      catalog.map(({ id }) => id),
    );
  });

  it('direct_municipality__same_province_and_city_code__uses_one_filter_code_for_both_annotation_depths', () => {
    const provinceOnly = photo('shanghai-province-only', '156310000', undefined, []);
    const cityTagged = photo('shanghai-city', '156310000', '156310000', []);
    const hubei = photo('hubei', '156420000', '156420100', []);

    expect(filterPhotos([provinceOnly, cityTagged, hubei], filters(['156310000'], []))
      .map(({ id }) => id))
      .toEqual(['shanghai-province-only', 'shanghai-city']);
  });

  it('unlocated_filter__searched_by_label__keeps_unlocated_photos_discoverable', () => {
    const state = filters([], [], true);
    state.search = '未标记';

    expect(filterPhotos(catalog, state).map(({ id }) => id)).toEqual(['unlocated-x']);
  });

  it('sdd_filter_spec__province_selected__normalizes_away_redundant_child_cities', () => {
    const selected = new Set(['156420100', '156420200', '156310000']);

    expect([...toggleProvinceLocationFilter(
      selected,
      '156420000',
      ['156420100', '156420200'],
    )].sort()).toEqual(['156310000', '156420000']);
  });

  it('sdd_filter_spec__city_selected_under_selected_province__replaces_parent_and_keeps_other_regions', () => {
    const selected = new Set(['156420000', '156310000']);
    const narrowed = toggleCityLocationFilter(selected, '156420000', '156420100');

    expect([...narrowed].sort()).toEqual(['156310000', '156420100']);
    expect([...toggleCityLocationFilter(narrowed, '156420000', '156420100')])
      .toEqual(['156310000']);
  });
});

describe('folder filter hierarchy', () => {
  const folderCatalog = [
    photo('root-file', '156420000', undefined, ['landscape']),
    photo('travel-direct', '156420000', undefined, ['landscape'], 'valid', 'photo', '旅行'),
    photo('travel-wuhan', '156420000', '156420100', ['portrait'], 'valid', 'photo', '旅行/武汉'),
    photo('travel-beijing', '156110000', '156110000', ['landscape'], 'valid', 'photo', '旅行/北京'),
    photo('travel-backup', '156420000', undefined, ['landscape'], 'valid', 'photo', '旅行旧'),
    photo('work-wuhan', '156420000', '156420100', ['landscape'], 'valid', 'video', '工作/武汉'),
  ];

  it('relative_paths__project_to_at_most_two_folder_levels_without_limiting_scan_depth', () => {
    expect(folderPathFromRelativePath('root.jpg')).toBeUndefined();
    expect(folderPathFromRelativePath('旅行\\a.jpg')).toBe('旅行');
    expect(folderPathFromRelativePath('旅行\\武汉\\东湖\\a.jpg')).toBe('旅行/武汉');
    expect(folderPathFromRelativePath('D:\\private\\a.jpg')).toBeUndefined();
    expect(folderPathFromRelativePath('\\\\server\\share\\a.jpg')).toBeUndefined();
    expect(folderPathFromRelativePath('/private/family/a.jpg')).toBeUndefined();
    expect(folderPathFromRelativePath('旅行//武汉/a.jpg')).toBeUndefined();
    expect(folderPathFromRelativePath('旅行/../private/a.jpg')).toBeUndefined();
  });

  it('folder_tree__builds_two_levels_with_descendant_counts_and_full_child_keys', () => {
    const tree = buildFolderFilterTree(folderCatalog);
    const travel = tree.find(({ path }) => path === '旅行');
    const work = tree.find(({ path }) => path === '工作');

    expect(travel).toMatchObject({ name: '旅行', photoCount: 3 });
    expect(travel?.children.map(({ path, photoCount }) => [path, photoCount])).toEqual([
      ['旅行/北京', 1],
      ['旅行/武汉', 1],
    ]);
    expect(work?.children).toEqual([
      expect.objectContaining({ path: '工作/武汉', name: '武汉', photoCount: 1 }),
    ]);
  });

  it('folder_group__uses_or_within_the_group_and_segment_boundaries_for_parent_matches', () => {
    expect(filterPhotos(folderCatalog, filters([], [], false, MEDIA_KINDS, ['旅行'])).map(({ id }) => id))
      .toEqual(['travel-direct', 'travel-wuhan', 'travel-beijing']);
    expect(filterPhotos(folderCatalog, filters([], [], false, MEDIA_KINDS, ['旅行/武汉', '工作/武汉'])).map(({ id }) => id))
      .toEqual(['travel-wuhan', 'work-wuhan']);
  });

  it('folder_group__combines_with_location_type_and_media_groups_using_and', () => {
    expect(filterPhotos(folderCatalog, filters(
      ['156420000'],
      ['landscape'],
      false,
      ['photo'],
      ['旅行'],
    )).map(({ id }) => id)).toEqual(['travel-direct']);
  });

  it('folder_name__searches__matches_media_inside_that_folder', () => {
    const state = filters([], []);
    state.search = '武汉';

    expect(filterPhotos(folderCatalog, state).map(({ id }) => id))
      .toEqual(['travel-wuhan', 'work-wuhan']);
  });

  it('parent_and_child_toggles__remove_redundancy_and_compare_windows_paths_case_insensitively', () => {
    expect([...toggleParentFolderFilter(
      new Set(['旅行/武汉', '工作']),
      '旅行',
    )].sort()).toEqual(['工作', '旅行']);
    expect([...toggleParentFolderFilter(new Set(['旅行', '旅行/已删除', '工作']), '旅行')])
      .toEqual(['工作']);
    expect([...toggleChildFolderFilter(new Set(['旅行', '工作']), '旅行', '旅行/武汉')].sort())
      .toEqual(['工作', '旅行/武汉']);
    expect([...toggleChildFolderFilter(new Set(['TRAVEL/WUHAN']), 'Travel', 'Travel/Wuhan')])
      .toEqual([]);
  });
});

describe('annotation photo ordering', () => {
  it('sorts from the earliest creation time to the latest, then puts missing times last with id tie-breakers', () => {
    const photos = [
      photo('missing-b', undefined, undefined, []),
      { ...photo('later', undefined, undefined, []), fileCreatedAtMs: 200 },
      { ...photo('same-b', undefined, undefined, []), fileCreatedAtMs: 100 },
      photo('missing-a', undefined, undefined, []),
      { ...photo('same-a', undefined, undefined, []), fileCreatedAtMs: 100 },
    ];
    const originalOrder = photos.map(({ id }) => id);

    expect(sortAnnotationPhotosByCreationTime(photos).map(({ id }) => id)).toEqual([
      'same-a',
      'same-b',
      'later',
      'missing-a',
      'missing-b',
    ]);
    expect(photos.map(({ id }) => id)).toEqual(originalOrder);
  });
});

describe('PRD-FR-015 / PRD-FR-016 deterministic collage inputs', () => {
  it('prd_fr_016__same_photos_and_seed__orders_twice__order_is_stable', () => {
    const candidates = [catalog[2]!, catalog[0]!, catalog[1]!];
    const first = stablePhotoOrder(candidates, 'source:province:156420000:best');
    const second = stablePhotoOrder(candidates, 'source:province:156420000:best');

    expect(second.map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    expect(new Set(first.map(({ id }) => id)).size).toBe(first.length);
  });

  it('prd_fr_013__province_and_city_views__group_photos__uses_explicit_level_and_skips_decode_errors', () => {
    const photos = [
      photo('province-only', '156420000', undefined, []),
      photo('city-valid', '156420000', '156420100', []),
      photo('city-corrupt', '156420000', '156420100', [], 'corrupt'),
    ];

    expect(groupPhotosByRegion(photos, 'province').get('156420000')?.map(({ id }) => id))
      .toEqual(['city-valid', 'province-only']);
    expect(groupPhotosByRegion(photos, 'city').get('156420100')?.map(({ id }) => id))
      .toEqual(['city-valid']);
  });
});

describe('photo-wall media eligibility', () => {
  it('prd_ac_005__located_photo_video_and_live__group_by_region__keeps_only_the_regular_photo', () => {
    const candidates = [
      photo('photo', '156420000', '156420100', [], 'valid', 'photo'),
      photo('video', '156420000', '156420100', [], 'valid', 'video'),
      photo('live', '156420000', '156420100', [], 'valid', 'live'),
      photo('unlocated-photo', undefined, undefined, [], 'valid', 'photo'),
    ];

    expect(groupPhotosByRegion(candidates, 'province').get('156420000')?.map(({ id }) => id))
      .toEqual(['photo']);
  });
});

describe('PRD-FR-016 wall-only fixed photo selections', () => {
  it('fixed_region_selection__applies_exact_ids__does_not_mutate_original_candidates', () => {
    const photos = [
      photo('hubei-a', '156420000', '156420100', []),
      photo('hubei-b', '156420000', '156420100', []),
      photo('hubei-c', '156420000', '156420200', []),
    ];
    const grouped = groupPhotosByRegion(photos, 'province');
    const selection = new Map([
      [wallPhotoSelectionKey('province', '156420000'), ['hubei-b', 'missing', 'hubei-a', 'hubei-b']],
    ]);

    const applied = applyWallPhotoSelections(grouped, 'province', selection);

    expect(applied.photosByRegion.get('156420000')?.map(({ id }) => id)).toEqual(['hubei-b', 'hubei-a']);
    expect([...applied.fixedRegionCodes]).toEqual(['156420000']);
    expect(grouped.get('156420000')?.map(({ id }) => id)).toEqual(['hubei-a', 'hubei-b', 'hubei-c']);
    expect(photos.map((item) => item.location?.provinceCode)).toEqual([
      '156420000',
      '156420000',
      '156420000',
    ]);
  });

  it('same_gb_at_province_and_city_levels__uses_distinct_fixed_selections', () => {
    const provincePhoto = photo('beijing-province', '156110000', undefined, []);
    const cityPhoto = photo('beijing-city', '156110000', '156110000', []);
    const groups = new Map([['156110000', [provincePhoto, cityPhoto]]]);
    const selections = new Map([
      [wallPhotoSelectionKey('province', '156110000'), ['beijing-province']],
      [wallPhotoSelectionKey('city', '156110000'), ['beijing-city']],
    ]);

    expect(applyWallPhotoSelections(groups, 'province', selections).photosByRegion
      .get('156110000')?.map(({ id }) => id)).toEqual(['beijing-province']);
    expect(applyWallPhotoSelections(groups, 'city', selections).photosByRegion
      .get('156110000')?.map(({ id }) => id)).toEqual(['beijing-city']);
  });

  it('fixed_photo_filtered_out__keeps_region_fixed_and_empty__never_falls_back_to_random', () => {
    const fallback = photo('random-fallback', '156420000', undefined, []);
    const selections = new Map([
      [wallPhotoSelectionKey('province', '156420000'), ['currently-filtered-out']],
    ]);

    const applied = applyWallPhotoSelections(
      new Map([['156420000', [fallback]]]),
      'province',
      selections,
    );

    expect(applied.photosByRegion.get('156420000')).toEqual([]);
    expect(applied.fixedRegionCodes.has('156420000')).toBe(true);
  });

  it('fixed_selection_removed__restores_complete_automatic_candidate_group', () => {
    const candidates = [
      photo('first', '156420000', undefined, []),
      photo('second', '156420000', undefined, []),
    ];
    const grouped = groupPhotosByRegion(candidates, 'province');
    const applied = applyWallPhotoSelections(grouped, 'province', new Map());

    expect(applied.photosByRegion.get('156420000')?.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(applied.fixedRegionCodes.size).toBe(0);
  });
});

describe('PRD-FR-003 scan progress presentation', () => {
  it('prd_fr_003__scan_has_valid_and_failed_files__maps_progress__counts_each_discovered_file_once', () => {
    const progress = toScanProgress({
      runId: 'run-1',
      sourceId: 'source-1',
      status: 'partial',
      counts: { discovered: 3, indexed: 2, unchanged: 0, errors: 1 },
    });

    expect(progress.processed).toBe(3);
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(1);
  });
});

describe('library snapshot bridge', () => {
  it('photo_summary__has_file_creation_time__maps_it_to_the_renderer_record', () => {
    const library = toLibraryState({
      source: { sourceId: 'source-1', displayName: '照片', availability: 'available' },
      photos: [{
        photoId: 'photo-1',
        fileName: 'photo.jpg',
        folderPath: '旅行/武汉',
        mediaUrl: 'photomap-media://photo/photo-1',
        thumbnailUrl: 'photomap-media://photo/photo-1?size=thumb',
        fileCreatedAtMs: 1_777_000_000_000,
        captureTime: {
          localDateTime: '2026-06-17T15:44:34',
          offsetMinutes: 480,
          source: 'metadata',
        },
        note: '',
        mediaKind: 'photo',
        mediaFormat: 'jpg',
        pixelWidth: 2,
        pixelHeight: 3,
        decodeState: 'valid',
        lifecycleState: 'active',
        location: null,
        typeIds: [],
      }],
      photoTypes: [],
      scan: {
        runId: null,
        sourceId: 'source-1',
        status: 'succeeded',
        counts: { discovered: 1, indexed: 1, unchanged: 0, errors: 0 },
      },
      catalogRevision: 1,
    }, { provinces: new Map(), cities: new Map() });

    expect(library.photos[0]?.fileCreatedAtMs).toBe(1_777_000_000_000);
    expect(library.photos[0]?.folderPath).toBe('旅行/武汉');
    expect(library.photos[0]?.captureTimeLocal).toBe('2026-06-17T15:44:34');
    expect(library.photos[0]?.captureTimeOffsetMinutes).toBe(480);
    expect(library.photos[0]?.captureTimeSource).toBe('metadata');
  });

  it('located_photo__without_geojson__resolves_names_from_the_built_in_directory', () => {
    const library = toLibraryState({
      source: { sourceId: 'source-1', displayName: '照片', availability: 'available' },
      photos: [{
        photoId: 'photo-1',
        fileName: 'wuhan.jpg',
        folderPath: null,
        mediaUrl: 'photomap-media://photo/photo-1',
        thumbnailUrl: 'photomap-media://photo/photo-1?size=thumb',
        fileCreatedAtMs: null,
        captureTime: null,
        note: '',
        mediaKind: 'photo',
        mediaFormat: 'jpg',
        pixelWidth: 2,
        pixelHeight: 3,
        decodeState: 'valid',
        lifecycleState: 'active',
        location: { provinceGb: '156420000', cityGb: '156420100' },
        typeIds: [],
      }],
      photoTypes: [],
      scan: {
        runId: null,
        sourceId: 'source-1',
        status: 'succeeded',
        counts: { discovered: 1, indexed: 1, unchanged: 0, errors: 0 },
      },
      catalogRevision: 1,
    }, regionNamesFromOptions(PROVINCES, CITIES));

    expect(library.photos[0]?.location).toEqual({
      provinceCode: '156420000',
      provinceName: '湖北省',
      cityCode: '156420100',
      cityName: '武汉市',
    });
    expect(library.photos[0]?.captureTimeLocal).toBeNull();
    expect(library.photos[0]?.captureTimeOffsetMinutes).toBeNull();
    expect(library.photos[0]?.captureTimeSource).toBeNull();
  });
});
