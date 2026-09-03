import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapDataFileContract } from '../../src/main/services/map-data/map-data-contract';
import {
  MapDataService,
  type MapDataCatalogPort,
} from '../../src/main/services/map-data/map-data-service';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixtureContract(provinceBytes: Buffer, cityBytes: Buffer): readonly MapDataFileContract[] {
  return [
    {
      kind: 'province',
      label: '省份数据',
      canonicalFileName: 'china-provinces.geojson',
      byteLength: provinceBytes.length,
      sha256: digest(provinceBytes),
    },
    {
      kind: 'city',
      label: '城市数据',
      canonicalFileName: 'china-city-view.geojson',
      byteLength: cityBytes.length,
      sha256: digest(cityBytes),
    },
  ];
}

function catalogPort(loadFailure?: Error): MapDataCatalogPort & {
  load: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  let available = false;
  return {
    isAvailable: () => available,
    load: vi.fn(async () => {
      if (loadFailure !== undefined) throw loadFailure;
      available = true;
    }),
    reset: vi.fn(() => {
      available = false;
    }),
  };
}

async function temporaryMapDirectory(): Promise<{ root: string; mapDataDirectory: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photomap-map-data-service-'));
  temporaryRoots.push(root);
  return { root, mapDataDirectory: path.join(root, 'data', 'map-data', 'v1') };
}

describe('MapDataService', () => {
  it('missing_files__initialize__reports_zero_of_two_and_resets_catalog', async () => {
    const { mapDataDirectory } = await temporaryMapDirectory();
    const provinceBytes = Buffer.from('small province fixture');
    const cityBytes = Buffer.from('small city fixture with another length');
    const catalog = catalogPort();
    const service = new MapDataService(
      mapDataDirectory,
      catalog,
      fixtureContract(provinceBytes, cityBytes),
    );

    await expect(service.initialize()).resolves.toEqual({
      items: [
        { kind: 'province', label: '省份数据', imported: false },
        { kind: 'city', label: '城市数据', imported: false },
      ],
      completed: 0,
      total: 2,
      ready: false,
    });
    expect(catalog.reset).toHaveBeenCalled();
    expect(catalog.load).not.toHaveBeenCalled();
  });

  it('mixed_arbitrary_names__import__keeps_valid_files_and_rejects_each_bad_selection', async () => {
    const { root, mapDataDirectory } = await temporaryMapDirectory();
    const provinceBytes = Buffer.from('province fixture bytes');
    const cityBytes = Buffer.from('city fixture bytes with a distinct size');
    const contract = fixtureContract(provinceBytes, cityBytes);
    const catalog = catalogPort();
    const service = new MapDataService(mapDataDirectory, catalog, contract);
    const selectedDirectory = path.join(root, 'not-a-file');
    const renamedProvince = path.join(root, '下载文件 (1).bin');
    const wrongCity = path.join(root, '中国_市.geojson');
    await mkdir(selectedDirectory);
    await writeFile(renamedProvince, provinceBytes);
    await writeFile(wrongCity, Buffer.alloc(cityBytes.length, 0x78));

    const first = await service.importFiles([
      renamedProvince,
      wrongCity,
      selectedDirectory,
      renamedProvince,
    ]);

    expect(first.accepted).toEqual(['province']);
    expect(first.rejected).toEqual([
      { fileName: '中国_市.geojson', reason: 'unrecognized' },
      { fileName: 'not-a-file', reason: 'source_unreadable' },
    ]);
    expect(first.status).toMatchObject({ completed: 1, total: 2, ready: false });
    await expect(readFile(path.join(mapDataDirectory, 'china-provinces.geojson')))
      .resolves.toEqual(provinceBytes);
    expect((await readdir(mapDataDirectory)).some((name) => name.includes('.photomap-'))).toBe(false);

    const renamedCity = path.join(root, 'anything.geojson');
    await writeFile(renamedCity, cityBytes);
    const second = await service.importFiles([renamedCity]);

    expect(second.accepted).toEqual(['city']);
    expect(second.rejected).toEqual([]);
    expect(second.status).toMatchObject({ completed: 2, total: 2, ready: true });
    await expect(readFile(path.join(mapDataDirectory, 'china-city-view.geojson')))
      .resolves.toEqual(cityBytes);
    expect(catalog.load).toHaveBeenLastCalledWith(mapDataDirectory);
  });

  it('stored_file_is_modified__get_status__fails_closed_and_resets_loaded_catalog', async () => {
    const { root, mapDataDirectory } = await temporaryMapDirectory();
    const provinceBytes = Buffer.from('province fixture');
    const cityBytes = Buffer.from('city fixture data');
    const catalog = catalogPort();
    const service = new MapDataService(
      mapDataDirectory,
      catalog,
      fixtureContract(provinceBytes, cityBytes),
    );
    const provinceSource = path.join(root, 'province.download');
    const citySource = path.join(root, 'city.download');
    await writeFile(provinceSource, provinceBytes);
    await writeFile(citySource, cityBytes);
    await service.importFiles([provinceSource, citySource]);

    await writeFile(
      path.join(mapDataDirectory, 'china-provinces.geojson'),
      Buffer.alloc(provinceBytes.length, 0x2e),
    );
    const status = await service.getStatus();

    expect(status).toMatchObject({ completed: 1, total: 2, ready: false });
    expect(status.error).toContain('校验失败');
    expect(catalog.reset).toHaveBeenCalled();
  });

  it('both_hashes_are_valid_but_catalog_load_fails__status_never_reports_ready', async () => {
    const { root, mapDataDirectory } = await temporaryMapDirectory();
    const provinceBytes = Buffer.from('province contract');
    const cityBytes = Buffer.from('city contract');
    const catalog = catalogPort(new Error('synthetic catalog rejection'));
    const service = new MapDataService(
      mapDataDirectory,
      catalog,
      fixtureContract(provinceBytes, cityBytes),
    );
    const provinceSource = path.join(root, 'a');
    const citySource = path.join(root, 'b');
    await writeFile(provinceSource, provinceBytes);
    await writeFile(citySource, cityBytes);

    const result = await service.importFiles([provinceSource, citySource]);

    expect(result.status).toMatchObject({ completed: 2, total: 2, ready: false });
    expect(result.status.error).toBe('synthetic catalog rejection');
    expect(catalog.reset).toHaveBeenCalled();
  });

  it('destination_write_fails__import__throws_map_import_failed_without_a_validation_rejection', async () => {
    const { root, mapDataDirectory } = await temporaryMapDirectory();
    const provinceBytes = Buffer.from('province write failure fixture');
    const cityBytes = Buffer.from('city write failure fixture');
    const sourcePath = path.join(root, 'renamed-province.data');
    await writeFile(sourcePath, provinceBytes);
    const writer = vi.fn(async () => {
      throw new Error('synthetic disk failure');
    });
    const service = new MapDataService(
      mapDataDirectory,
      catalogPort(),
      fixtureContract(provinceBytes, cityBytes),
      writer,
    );

    await expect(service.importFiles([sourcePath])).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: expect.stringContaining('无法保存省份数据'),
    });
    expect(writer).toHaveBeenCalledOnce();
    const status = await service.getStatus();
    expect(status).toEqual(expect.objectContaining({ completed: 0, ready: false }));
    expect(status.error).toBeUndefined();
  });

  it('concurrent_import_calls__service__serializes_writes_and_preserves_both_valid_files', async () => {
    const { root, mapDataDirectory } = await temporaryMapDirectory();
    const provinceBytes = Buffer.from('province concurrent fixture');
    const cityBytes = Buffer.from('city concurrent fixture data');
    const provinceSource = path.join(root, 'province.anything');
    const citySource = path.join(root, 'city.anything');
    await writeFile(provinceSource, provinceBytes);
    await writeFile(citySource, cityBytes);
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const writer = vi.fn(async (targetPath: string, bytes: Buffer) => {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      if (writer.mock.calls.length === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      await writeFile(targetPath, bytes);
      activeWrites -= 1;
    });
    const service = new MapDataService(
      mapDataDirectory,
      catalogPort(),
      fixtureContract(provinceBytes, cityBytes),
      writer,
    );

    const provinceImport = service.importFiles([provinceSource]);
    await firstWriteStarted.promise;
    const cityImport = service.importFiles([citySource]);
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);

    releaseFirstWrite.resolve();
    const [provinceResult, cityResult] = await Promise.all([provinceImport, cityImport]);

    expect(provinceResult.accepted).toEqual(['province']);
    expect(cityResult.accepted).toEqual(['city']);
    expect(cityResult.status).toMatchObject({ completed: 2, ready: true });
    expect(maximumActiveWrites).toBe(1);
  });
});
