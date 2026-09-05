import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MapSnapshot, PhotoRecord, RegionFeature } from '../../src/renderer/model';
import {
  createSnapshot,
  drawShareCard,
  drawMapScene,
  layoutPhotosForRegion,
  loadImage,
  loadSceneImages,
} from '../../src/renderer/map-scene/scene';
import { featureBounds } from '../../src/renderer/map-scene/projection';
import type { CollagePoint } from '../../src/renderer/map-scene/collage-layout';
import { photoGeometryForRegion } from '../../src/renderer/map-scene/photo-geometry';
import { createDefaultShareDocument, moveShareElement } from '../../src/renderer/share-document';

afterEach(() => vi.unstubAllGlobals());

function photo(id: string): PhotoRecord {
  return {
    id,
    name: `${id}.png`,
    mediaUrl: `photomap-media://photo/${id}`,
    thumbnailUrl: `photomap-media://photo/${id}`,
    mediaKind: 'photo',
    mediaFormat: 'jpg',
    decodeState: 'valid',
    types: [],
  };
}

function polygonArea(points: readonly CollagePoint[]): number {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return next ? sum + point.x * next.y - point.y * next.x : sum;
  }, 0)) / 2;
}

const region: RegionFeature = {
  type: 'Feature',
  properties: { gb: '156420000', name: '湖北省' },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [110, 30],
      [114, 30],
      [114, 34],
      [110, 34],
      [110, 30],
    ]],
  },
};

function snapshotInput(): Omit<MapSnapshot, 'id' | 'createdAt'> {
  return {
    level: 'province',
    viewBox: { x: -500, y: -100, width: 3000, height: 1600 },
    camera: { zoom: 1, panX: 0, panY: 0 },
    density: 3,
    showPhotos: true,
    showPlaceNames: true,
    regions: [region],
    photosByRegion: new Map([['156420000', [photo('a'), photo('b'), photo('c')]]]),
  };
}

describe('PRD-FR-012 / PRD-FR-015 / PRD-FR-016 stable, unique collage layout', () => {
  it('prd_fr_016__canonical_input_unchanged__creates_snapshot_twice__snapshot_id_and_tiles_are_stable', () => {
    const first = createSnapshot(snapshotInput());
    const second = createSnapshot(snapshotInput());
    const firstTiles = layoutPhotosForRegion(
      region,
      first.photosByRegion.get('156420000') ?? [],
      first.density,
      first.id,
    );
    const secondTiles = layoutPhotosForRegion(
      region,
      second.photosByRegion.get('156420000') ?? [],
      second.density,
      second.id,
    );

    expect(second.id).toBe(first.id);
    expect(secondTiles).toEqual(firstTiles);
  });

  it('prd_fr_012__camera_only_change__keeps_snapshot_id_and_photo_layout_stable', () => {
    const initial = createSnapshot(snapshotInput());
    const moved = createSnapshot({
      ...snapshotInput(),
      camera: { zoom: 2.4, panX: 180, panY: -95 },
    });
    const initialTiles = layoutPhotosForRegion(
      region,
      initial.photosByRegion.get('156420000') ?? [],
      initial.density,
      initial.id,
    );
    const movedTiles = layoutPhotosForRegion(
      region,
      moved.photosByRegion.get('156420000') ?? [],
      moved.density,
      moved.id,
    );

    expect(moved.id).toBe(initial.id);
    expect(movedTiles).toEqual(initialTiles);
  });

  it('prd_fr_015__duplicate_candidate_ids__builds_region_layout__photo_id_is_never_repeated', () => {
    const duplicate = photo('same-photo');
    const tiles = layoutPhotosForRegion(
      region,
      [duplicate, duplicate, photo('other-photo')],
      5,
      'frozen-snapshot',
    );
    const photoIds = tiles.map((tile) => tile.photo.id);

    expect(new Set(photoIds).size).toBe(photoIds.length);
  });

  it('one_photo_in_a_wide_region__covers_the_entire_bounds_without_stretching_the_layout', () => {
    const wideRegion: RegionFeature = {
      ...region,
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [108, 30],
          [116, 30],
          [116, 32],
          [108, 32],
          [108, 30],
        ]],
      },
    };
    const bounds = featureBounds(wideRegion)!;
    const [tile] = layoutPhotosForRegion(wideRegion, [photo('only')], 9, 'single-photo');

    expect(tile).toMatchObject({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    expect(polygonArea(tile!.polygon)).toBeCloseTo(bounds.width * bounds.height, 8);
  });

  it('three_unique_photos__form_an_irregular_partition_covering_the_entire_bounds', () => {
    const bounds = featureBounds(region)!;
    const tiles = layoutPhotosForRegion(
      region,
      [photo('a'), photo('b'), photo('c')],
      9,
      'three-photo-partition',
    );

    expect(tiles).toHaveLength(3);
    expect(tiles.reduce((sum, tile) => sum + polygonArea(tile.polygon), 0))
      .toBeCloseTo(bounds.width * bounds.height, 8);
    expect(tiles.some(({ polygon }) => polygon.some((point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return Boolean(next && point.x !== next.x && point.y !== next.y);
    }))).toBe(true);
  });

  it('photo_only_geometry__excludes_sansha_and_ignores_far_south_hainan_polygons_for_layout', () => {
    const sansha: RegionFeature = {
      ...region,
      properties: { gb: '156460300', name: '三沙市' },
    };
    const hainan: RegionFeature = {
      type: 'Feature',
      properties: { gb: '156460000', name: '海南省' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[109, 18], [111, 18], [111, 20], [109, 20], [109, 18]]],
          [[[112, 15], [114, 15], [114, 16], [112, 16], [112, 15]]],
        ],
      },
    };
    const expectedBounds = featureBounds(photoGeometryForRegion(hainan)!)!;

    expect(layoutPhotosForRegion(sansha, [photo('sansha')], 9, 'south-sea')).toEqual([]);
    expect(layoutPhotosForRegion(hainan, [photo('hainan')], 9, 'south-sea')[0]).toMatchObject({
      x: expectedBounds.x,
      y: expectedBounds.y,
      width: expectedBounds.width,
      height: expectedBounds.height,
    });
  });

  it('place_name_visibility__changes_only_labels__keeps_photo_layout_seed_stable', () => {
    const visible = createSnapshot(snapshotInput());
    const hidden = createSnapshot({ ...snapshotInput(), showPlaceNames: false });

    expect(hidden.id).toBe(visible.id);
    expect(layoutPhotosForRegion(region, [photo('a'), photo('b')], 3, hidden.id)).toEqual(
      layoutPhotosForRegion(region, [photo('a'), photo('b')], 3, visible.id),
    );
  });

  it('fixed_region_selection__lays_out_every_selected_photo__does_not_apply_random_density_slice', () => {
    const selected = [photo('chosen-c'), photo('chosen-a'), photo('chosen-b'), photo('chosen-d')];
    const automatic = layoutPhotosForRegion(region, selected, 1, 'fixed-test', 'automatic');
    const fixed = layoutPhotosForRegion(region, selected, 1, 'fixed-test', 'fixed');

    expect(automatic.length).toBeLessThan(fixed.length);
    expect(fixed.map((tile) => tile.photo.id)).toEqual(selected.map(({ id }) => id));
    expect(new Set(fixed.map((tile) => tile.photo.id)).size).toBe(selected.length);
  });

  it('fixed_region_marker__changes_snapshot_identity__keeps_export_snapshot_semantics_frozen', () => {
    const automatic = createSnapshot(snapshotInput());
    const fixed = createSnapshot({
      ...snapshotInput(),
      fixedPhotoRegionCodes: new Set(['156420000']),
    });

    expect(fixed.id).not.toBe(automatic.id);
    expect(fixed.fixedPhotoRegionCodes?.has('156420000')).toBe(true);
  });
});

describe('photo collage canvas drawing', () => {
  it('one_loaded_photo_after_another_fails__repartitions_to_full_bounds_and_only_crops_proportionally', () => {
    class MockPath2D {
      public moveTo(): void {}
      public lineTo(): void {}
      public closePath(): void {}
    }
    vi.stubGlobal('Path2D', MockPath2D);
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      drawImage: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const loadedImage = { naturalWidth: 400, naturalHeight: 200 } as HTMLImageElement;
    const bounds = featureBounds(region)!;

    try {
      drawMapScene(context, {
        width: 1200,
        height: 800,
        snapshot: createSnapshot({
          ...snapshotInput(),
          density: 9,
          showPlaceNames: false,
          photosByRegion: new Map([['156420000', [photo('loaded'), photo('failed')]]]),
        }),
        images: { photos: new Map([['loaded', loadedImage]]) },
      });

      expect(context.drawImage).toHaveBeenCalledTimes(1);
      const [, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height] =
        vi.mocked(context.drawImage).mock.calls[0]!;
      expect({ x, y, width, height }).toEqual(bounds);
      expect(sourceWidth / sourceHeight).toBeCloseTo(width / height, 8);
      expect(width / sourceWidth).toBeCloseTo(height / sourceHeight, 8);
      expect(sourceX).toBeGreaterThanOrEqual(0);
      expect(sourceY).toBeGreaterThanOrEqual(0);
      expect(sourceX + sourceWidth).toBeLessThanOrEqual(loadedImage.naturalWidth);
      expect(sourceY + sourceHeight).toBeLessThanOrEqual(loadedImage.naturalHeight);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('place-name layer visibility', () => {
  it('show_place_names_false__draws_map__omits_region_text_without_hiding_other_layers', () => {
    class MockPath2D {
      public moveTo(): void {}
      public lineTo(): void {}
      public closePath(): void {}
    }
    vi.stubGlobal('Path2D', MockPath2D);
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      drawImage: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    try {
      drawMapScene(context, {
        width: 1200,
        height: 800,
        snapshot: createSnapshot({ ...snapshotInput(), showPhotos: false, showPlaceNames: false }),
        images: { photos: new Map() },
      });

      expect(context.fill).toHaveBeenCalled();
      expect(context.stroke).toHaveBeenCalled();
      expect(context.strokeText).not.toHaveBeenCalled();
      expect(context.fillText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('show_place_names_true__draws_region_text', () => {
    class MockPath2D {
      public moveTo(): void {}
      public lineTo(): void {}
      public closePath(): void {}
    }
    vi.stubGlobal('Path2D', MockPath2D);
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      drawImage: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    try {
      drawMapScene(context, {
        width: 1200,
        height: 800,
        snapshot: createSnapshot({ ...snapshotInput(), showPhotos: false, showPlaceNames: true }),
        images: { photos: new Map() },
      });

      expect(context.strokeText).toHaveBeenCalledWith('湖北', expect.any(Number), expect.any(Number));
      expect(context.fillText).toHaveBeenCalledWith('湖北', expect.any(Number), expect.any(Number));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('share-card export canvas', () => {
  it('renders the photo before overlaid share text', () => {
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 320 })),
    } as unknown as CanvasRenderingContext2D;
    const initial = createDefaultShareDocument({ width: 1200, height: 800 });
    const document = moveShareElement(initial, 'text-1', 0, -400);

    drawShareCard(context, {
      snapshot: createSnapshot({ ...snapshotInput(), regions: [], photosByRegion: new Map() }),
      images: { photos: new Map() },
      document,
    });

    const finalPhotoPaint = Math.max(...vi.mocked(context.fillRect).mock.invocationCallOrder);
    const firstShareTextPaint = vi.mocked(context.fillText).mock.invocationCallOrder[0];
    expect(firstShareTextPaint).toBeGreaterThan(finalPhotoPaint);
  });

  it('current_viewport__builds_share_card__map_area_keeps_viewport_aspect_without_preview_gutter', () => {
    const document = createDefaultShareDocument({ width: 1200, height: 800 });

    expect({ width: document.width, height: document.height }).toEqual({ width: 1600, height: 1353 });
    expect(document.photo.rect).toEqual({ x: 64, y: 64, width: 1472, height: 981 });
    expect(document.texts[0]?.rect).toEqual({ x: 280, y: 1073, width: 1040, height: 88 });
    expect(document.photo.rect.width / document.photo.rect.height).toBeCloseTo(1200 / 800, 2);
  });
});

describe('scene image recovery', () => {
  it('shares pending and successful image loads but retries a failed URL', async () => {
    const created: ControlledImage[] = [];
    class ControlledImage {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public set src(_value: string) { created.push(this); }
    }
    vi.stubGlobal('Image', ControlledImage);
    const url = 'photomap-media://photo/cache-recovery?size=thumb';

    const first = loadImage(url);
    const concurrent = loadImage(url);
    expect(concurrent).toBe(first);
    expect(created).toHaveLength(1);
    created[0]!.onerror?.();
    await expect(first).rejects.toThrow('图片载入失败');

    const recovered = loadImage(url);
    expect(recovered).not.toBe(first);
    expect(created).toHaveLength(2);
    created[1]!.onload?.();
    await expect(recovered).resolves.toBe(created[1]);
    await expect(loadImage(url)).resolves.toBe(created[1]);
    expect(created).toHaveLength(2);
  });

  it('reloads a recovered photo from a refreshed library with the same layout ID and thumbnail URL', async () => {
    const recoveredPhoto = photo('scene-recovery');
    const attempts = new Map<string, number>();
    let unavailable = true;
    class RecoverableImage {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      public set src(url: string) {
        attempts.set(url, (attempts.get(url) ?? 0) + 1);
        if (unavailable && url === recoveredPhoto.thumbnailUrl) this.onerror?.();
        else this.onload?.();
      }
    }
    vi.stubGlobal('Image', RecoverableImage);
    const input = { ...snapshotInput(), photosByRegion: new Map([['156420000', [recoveredPhoto]]]) };
    const first = createSnapshot(input);
    const missing = await loadSceneImages(first);
    expect(missing.photos.has(recoveredPhoto.id)).toBe(false);

    unavailable = false;
    const refreshed = createSnapshot({
      ...input,
      photosByRegion: new Map([['156420000', [{ ...recoveredPhoto }]]]),
    });
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.photosByRegion).not.toBe(first.photosByRegion);
    const loaded = await loadSceneImages(refreshed);
    expect(loaded.photos.has(recoveredPhoto.id)).toBe(true);
    expect(attempts.get(recoveredPhoto.thumbnailUrl)).toBe(2);
    const mapAssetAttempts = [...attempts].filter(([url]) => url.startsWith('photomap-asset:'));
    expect(mapAssetAttempts).toHaveLength(4);
    for (const [, count] of mapAssetAttempts) expect(count).toBe(1);
  });
});
