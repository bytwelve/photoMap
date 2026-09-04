import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_MEDIA_FILE_NAME_LENGTH,
  type LibrarySnapshot,
  type ScanProgress,
} from '../../src/shared/contracts';
import {
  parseRenamePhotoRequest,
  parseResolveScanLocationsRequest,
  parseUpdateCaptureTimeRequest,
  parseUpdateNoteRequest,
} from '../../src/shared/schemas';
import type { LibraryScanOptions } from '../../src/main/services/library-scan/models';

const electronMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getName: () => 'PhotoMap',
    getVersion: () => '1.0.0',
    getPath: () => '',
    isPackaged: false,
  },
  dialog: electronMocks,
  shell: { openExternal: electronMocks.openExternal },
}));

import { PhotoMapController } from '../../src/main/app-controller';
import { defaultAppSettings } from '../../src/shared/settings';

type ControllerArguments = ConstructorParameters<typeof PhotoMapController>;

function createTestController(
  window: ControllerArguments[0],
  repository: ControllerArguments[1],
  scanner: ControllerArguments[2],
  regions: ControllerArguments[3],
  trashService: ControllerArguments[4],
  exportService: ControllerArguments[5],
  settingsStore: ControllerArguments[6] = { get: defaultAppSettings, update: async (settings) => settings },
  diagnostics: ControllerArguments[7] = { record: async () => undefined },
  mapData?: ControllerArguments[8],
  fileRenameService?: ControllerArguments[9],
): PhotoMapController {
  const getStatus = async () => {
    const ready = regions.isAvailable();
    return {
      items: [
        { kind: 'province' as const, label: '省份数据', imported: ready },
        { kind: 'city' as const, label: '城市数据', imported: ready },
      ],
      completed: ready ? 2 : 0,
      total: 2,
      ready,
    };
  };
  return new PhotoMapController(
    window, repository, scanner, regions, trashService, exportService, settingsStore, diagnostics,
    mapData ?? {
      initialize: getStatus,
      getStatus,
      importFiles: async () => { throw new Error('Unexpected map import in this test.'); },
    },
    fileRenameService,
  );
}

const temporaryRoots: string[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

afterEach(async () => {
  vi.clearAllMocks();
  while (temporaryRoots.length > 0) {
    const target = temporaryRoots.pop()!;
    expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(target).startsWith('photo-map-controller-')).toBe(true);
    await rm(target, { recursive: true, force: true });
  }
});

describe('strict GPS location decision IPC contract', () => {
  it('accepts_only_the_three_named_decisions_and_rejects_the_legacy_boolean_shape', () => {
    for (const decision of [
      'ignore',
      'overwrite-all-resolved',
      'fill-unlabeled-only',
    ] as const) {
      expect(parseResolveScanLocationsRequest({ runId: 'run-gps', decision })).toEqual({
        runId: 'run-gps',
        decision,
      });
    }

    expect(() => parseResolveScanLocationsRequest({ runId: 'run-gps', apply: true }))
      .toThrow('扫描地点确认请求格式无效');
    expect(() => parseResolveScanLocationsRequest({ runId: 'run-gps', decision: 'overwrite' }))
      .toThrow('扫描地点确认请求格式无效');
  });
});

describe('photo note IPC contract', () => {
  it('trims_notes_allows_clearing_and_rejects_content_over_60_characters', () => {
    expect(parseUpdateNoteRequest({ photoId: 'photo-1', note: '  山风吹过城墙。  ' })).toEqual({
      photoId: 'photo-1',
      note: '山风吹过城墙。',
    });
    expect(parseUpdateNoteRequest({ photoId: 'photo-1', note: '   ' })).toEqual({
      photoId: 'photo-1',
      note: '',
    });
    expect(() => parseUpdateNoteRequest({ photoId: 'photo-1', note: '记'.repeat(61) }))
      .toThrow('照片备注不能超过 60 个字符');
    expect(() => parseUpdateNoteRequest({ photoId: '', note: '记忆' }))
      .toThrow('照片备注更新请求格式无效');
  });
});

describe('capture time IPC contract', () => {
  it('normalizes_seconds_without_changing_timezone_and_rejects_invalid_calendar_values', () => {
    expect(parseUpdateCaptureTimeRequest({
      photoId: 'photo-1',
      localDateTime: '2026-06-17T15:44',
    })).toEqual({
      photoId: 'photo-1',
      localDateTime: '2026-06-17T15:44:00',
    });
    expect(parseUpdateCaptureTimeRequest({
      photoId: 'photo-1',
      localDateTime: '2024-02-29T23:59:59',
    }).localDateTime).toBe('2024-02-29T23:59:59');
    expect(() => parseUpdateCaptureTimeRequest({
      photoId: 'photo-1',
      localDateTime: '2026-02-29T15:44:34',
    })).toThrow('拍摄时间必须是有效的本地日期和时间');
    expect(() => parseUpdateCaptureTimeRequest({
      photoId: '',
      localDateTime: '2026-06-17T15:44:34',
    })).toThrow('拍摄时间更新请求格式无效');
  });
});

describe('photo file rename IPC contract', () => {
  it('trims_and_normalizes_a_valid_windows_file_name_without_changing_the_photo_id', () => {
    expect(parseRenamePhotoRequest({
      photoId: 'photo-1',
      newFileName: '  cafe\u0301 旅行.jpg  ',
    })).toEqual({
      photoId: 'photo-1',
      newFileName: 'café 旅行.jpg',
    });
    expect(parseRenamePhotoRequest({
      photoId: 'photo-1',
      newFileName: `${'a'.repeat(MAX_MEDIA_FILE_NAME_LENGTH - 4)}.jpg`,
    }).newFileName).toHaveLength(MAX_MEDIA_FILE_NAME_LENGTH);
  });

  it.each([
    [null, 'request must be an object'],
    [{ photoId: '', newFileName: 'photo.jpg' }, 'photo id is empty'],
    [{ photoId: 'p'.repeat(129), newFileName: 'photo.jpg' }, 'photo id is too long'],
    [{ photoId: 'photo-1' }, 'file name is missing'],
    [{ photoId: 'photo-1', newFileName: '' }, 'file name is empty'],
    [{ photoId: 'photo-1', newFileName: '.' }, 'dot path segment'],
    [{ photoId: 'photo-1', newFileName: '..' }, 'parent path segment'],
    [{ photoId: 'photo-1', newFileName: '../escape.jpg' }, 'forward-slash traversal'],
    [{ photoId: 'photo-1', newFileName: '..\\escape.jpg' }, 'backslash traversal'],
    [{ photoId: 'photo-1', newFileName: 'C:\\photos\\escape.jpg' }, 'absolute Windows path'],
    [{ photoId: 'photo-1', newFileName: 'bad<name.jpg' }, 'less-than character'],
    [{ photoId: 'photo-1', newFileName: 'bad:name.jpg' }, 'colon character'],
    [{ photoId: 'photo-1', newFileName: 'bad|name.jpg' }, 'pipe character'],
    [{ photoId: 'photo-1', newFileName: 'bad?name.jpg' }, 'question-mark character'],
    [{ photoId: 'photo-1', newFileName: 'bad*name.jpg' }, 'asterisk character'],
    [{ photoId: 'photo-1', newFileName: 'bad\u0001name.jpg' }, 'control character'],
    [{ photoId: 'photo-1', newFileName: 'photo.jpg.' }, 'trailing dot'],
    [{ photoId: 'photo-1', newFileName: 'CON.jpg' }, 'reserved CON device'],
    [{ photoId: 'photo-1', newFileName: 'aux' }, 'reserved AUX device'],
    [{ photoId: 'photo-1', newFileName: 'COM1.png' }, 'reserved COM device'],
    [{ photoId: 'photo-1', newFileName: 'COM¹.png' }, 'reserved superscript COM device'],
    [{ photoId: 'photo-1', newFileName: 'LPT9.jpeg' }, 'reserved LPT device'],
    [{ photoId: 'photo-1', newFileName: 'LPT³.jpeg' }, 'reserved superscript LPT device'],
    [{ photoId: 'photo-1', newFileName: `${'a'.repeat(MAX_MEDIA_FILE_NAME_LENGTH - 3)}.jpg` }, 'file name is too long'],
  ])('rejects_%s: %s', (value, _reason) => {
    expect(() => parseRenamePhotoRequest(value)).toThrow();
  });
});

describe('PRD-FR-003 non-blocking and cancellable first scan', () => {
  it('prd_fr_023__photo_picker_is_pending__shutdown__waits_for_scan_preparation_and_rejects_new_work', async () => {
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    electronMocks.showOpenDialog.mockReturnValueOnce(picker.promise);
    const idle: ScanProgress = {
      runId: null,
      sourceId: null,
      status: 'idle',
      counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
    };
    const repository = {
      getLibrarySnapshot: vi.fn((): LibrarySnapshot => ({
        source: null,
        photos: [],
        photoTypes: [],
        scan: idle,
        catalogRevision: 0,
      })),
    };
    const scanner = { scan: vi.fn() };
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => false } as never,
      {} as never,
      {} as never,
    );

    const choosing = controller.chooseLibrary();
    await vi.waitFor(() => expect(electronMocks.showOpenDialog).toHaveBeenCalledOnce());
    let shutdownSettled = false;
    const shuttingDown = controller.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    await expect(controller.refreshLibrary()).rejects.toMatchObject({
      code: 'SCAN_FAILED',
      message: expect.stringContaining('应用正在关闭'),
    });
    picker.resolve({ canceled: true, filePaths: [] });
    await expect(choosing).resolves.toEqual(expect.objectContaining({ cancelled: true }));
    await shuttingDown;
    expect(shutdownSettled).toBe(true);
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('prd_fr_003__saved_source_is_missing_at_startup__resume__marks_unavailable_and_broadcasts_terminal_failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const missingRoot = path.join(root, 'missing-library');
    const source = {
      sourceId: 'source-missing',
      rootPath: missingRoot,
      canonicalRootKey: missingRoot.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const markActiveSourceUnavailable = vi.fn();
    const repository = {
      getActiveSource: vi.fn(() => source),
      markActiveSourceUnavailable,
    };
    const scanner = { scan: vi.fn() };
    const record = vi.fn(async () => undefined);
    let resolveFailure!: () => void;
    const failedBroadcast = new Promise<void>((resolve) => { resolveFailure = resolve; });
    const send = vi.fn((_channel: string, progress: ScanProgress) => {
      if (progress.status === 'failed') resolveFailure();
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => true } as never,
      {} as never,
      {} as never,
      undefined,
      { record },
    );

    controller.resumeActiveLibrary();
    await failedBroadcast;

    expect(markActiveSourceUnavailable).toHaveBeenCalledTimes(1);
    expect(scanner.scan).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'photo-map:scan-progress',
      expect.objectContaining({
        sourceId: 'source-missing',
        runId: null,
        status: 'failed',
        counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 1 },
      }),
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'scan',
      errorCode: 'SOURCE_NOT_FOUND',
      counts: expect.objectContaining({ errors: 1 }),
    }));
  });

  it('prd_fr_003__folder_is_selected_and_scan_is_delayed__choose_then_cancel__returns_running_immediately_and_cancelled_after_abort', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });

    const activeSource = {
      sourceId: 'source-1',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const idle: ScanProgress = {
      runId: null,
      sourceId: null,
      status: 'idle',
      counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
    };
    const repository = {
      activateSource: vi.fn(() => activeSource),
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: {
          sourceId: activeSource.sourceId,
          displayName: path.basename(activeSource.rootPath),
          availability: activeSource.availability,
        },
        photos: [],
        photoTypes: [],
        scan: progress ?? idle,
        catalogRevision: 1,
      })),
      getActiveSource: vi.fn(() => activeSource),
    };
    let scannerSignal: AbortSignal | undefined;
    const scanner = {
      scan: vi.fn((
        sourceId: string,
        _rootPath: string,
        signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        scannerSignal = signal;
        const running: ScanProgress = {
          runId: 'run-1',
          sourceId,
          status: 'running',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        };
        options.onProgress(running);
        return new Promise<{ progress: ScanProgress }>((resolve) => {
          signal.addEventListener('abort', () => {
            const cancelled: ScanProgress = { ...running, status: 'cancelled' };
            options.onProgress(cancelled);
            resolve({ progress: cancelled });
          }, { once: true });
        });
      }),
    };
    const window = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    const controller = createTestController(
      window as never,
      repository as never,
      scanner as never,
      { isAvailable: () => true } as never,
      {} as never,
      {} as never,
    );

    const chosen = await controller.chooseLibrary();

    expect(chosen.cancelled).toBe(false);
    expect(chosen.library.scan.status).toBe('running');
    expect(scannerSignal?.aborted).toBe(false);
    const cancelled = await controller.cancelScan();
    expect(cancelled.cancelled).toBe(true);
    expect(scannerSignal?.aborted).toBe(true);
    expect(cancelled.library.scan.status).toBe('cancelled');
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(scanner.scan.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-and-resolve',
    }));
    expect(window.webContents.send).toHaveBeenCalledWith(
      'photo-map:scan-progress',
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('prd_fr_023__scanner_rejects_during_shutdown__shutdown__settles_the_persisted_run_before_rethrowing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });
    const source = {
      sourceId: 'source-shutdown-rejection',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const finishScanRun = vi.fn();
    const repository = {
      activateSource: vi.fn(() => source),
      getActiveSource: vi.fn(() => source),
      finishScanRun,
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? {
          runId: null,
          sourceId: null,
          status: 'idle',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        },
        catalogRevision: 1,
      })),
    };
    const scanner = {
      scan: vi.fn((
        sourceId: string,
        _rootPath: string,
        signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        options.onProgress({
          runId: 'run-shutdown-rejection',
          sourceId,
          status: 'running',
          counts: { discovered: 2, indexed: 1, unchanged: 0, errors: 0 },
        });
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('synthetic abort rejection')), {
            once: true,
          });
        });
      }),
    };
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => false } as never,
      {} as never,
      {} as never,
    );

    await controller.chooseLibrary();
    await expect(controller.shutdown()).rejects.toThrow('synthetic abort rejection');

    expect(finishScanRun).toHaveBeenCalledOnce();
    expect(finishScanRun).toHaveBeenCalledWith(
      'run-shutdown-rejection',
      expect.objectContaining({
        runId: 'run-shutdown-rejection',
        sourceId: source.sourceId,
        status: 'failed',
        counts: { discovered: 2, indexed: 1, unchanged: 0, errors: 1 },
      }),
    );
  });

  it('geometry_unavailable__refresh_and_resume__still_probes_time_but_defers_gps_resolution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const source = {
      sourceId: 'source-policy',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    let geometryReady = false;
    let runNumber = 0;
    const scanner = {
      scan: vi.fn(async (
        sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        runNumber += 1;
        const terminal: ScanProgress = {
          runId: `run-${runNumber}`,
          sourceId,
          status: 'succeeded',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        };
        options.onProgress(terminal);
        return { progress: terminal };
      }),
    };
    const repository = {
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? {
          runId: null,
          sourceId: null,
          status: 'idle',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        },
        catalogRevision: 1,
      })),
    };
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => geometryReady } as never,
      {} as never,
      {} as never,
    );

    await controller.refreshLibrary();
    expect(scanner.scan.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-without-resolve',
    }));

    geometryReady = true;
    controller.resumeActiveLibrary();
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(2));
    expect(scanner.scan.mock.calls[1]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-and-resolve',
    }));
  });

  it('prd_fr_003__saved_source_root_recovers_but_scan_fails__refresh__restores_available_without_misclassifying_scan_error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    let availability: 'available' | 'unavailable' = 'unavailable';
    const source = {
      sourceId: 'source-recovered',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
    };
    const markActiveSourceAvailable = vi.fn(() => { availability = 'available'; });
    const markActiveSourceUnavailable = vi.fn(() => { availability = 'unavailable'; });
    const repository = {
      getActiveSource: vi.fn(() => ({ ...source, availability })),
      markActiveSourceAvailable,
      markActiveSourceUnavailable,
    };
    const scanner = {
      scan: vi.fn(async () => {
        throw new Error('synthetic scan failure');
      }),
    };
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => false } as never,
      {} as never,
      {} as never,
    );

    await expect(controller.refreshLibrary()).rejects.toThrow('synthetic scan failure');

    expect(markActiveSourceAvailable).toHaveBeenCalledTimes(1);
    expect(markActiveSourceUnavailable).not.toHaveBeenCalled();
    expect(availability).toBe('available');
    expect(scanner.scan).toHaveBeenCalledTimes(1);
  });

  it('prd_fr_003__background_first_scan_rejects__settles_failure__persists_and_broadcasts_failed_progress', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });
    const activeSource = {
      sourceId: 'source-1',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const finishScanRun = vi.fn();
    const repository = {
      activateSource: vi.fn(() => activeSource),
      getActiveSource: vi.fn(() => activeSource),
      finishScanRun,
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: 'source-1', displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? {
          runId: null,
          sourceId: null,
          status: 'idle',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        },
        catalogRevision: 1,
      })),
    };
    let rejectScan: ((reason: Error) => void) | undefined;
    const scanner = {
      scan: vi.fn((
        sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        options.onProgress({
          runId: 'run-failed',
          sourceId,
          status: 'running',
          counts: { discovered: 2, indexed: 1, unchanged: 0, errors: 0 },
        });
        const metadata = {
          examined: 2,
          exifCount: 1,
          gpsCount: 1,
          resolvedLocationCount: 1,
          captureTimeCount: 0,
          metadataErrorCount: 0,
        };
        options.onLocationProposal?.({
          runId: 'run-failed',
          sourceId,
          summary: metadata,
          assignments: [{
            photoId: 'photo-1',
            location: { provinceGb: '156420000', cityGb: '156420100' },
          }],
          captureTimes: [],
        });
        options.onProgress({
          runId: 'run-failed',
          sourceId,
          status: 'succeeded',
          counts: { discovered: 2, indexed: 2, unchanged: 0, errors: 0 },
          metadata,
        });
        return new Promise<{ progress: ScanProgress }>((_resolve, reject) => {
          rejectScan = reject;
        });
      }),
    };
    let resolveFailed!: () => void;
    const failedBroadcast = new Promise<void>((resolve) => { resolveFailed = resolve; });
    const send = vi.fn((_channel: string, progress: ScanProgress) => {
      if (progress.status === 'failed') resolveFailed();
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => true } as never,
      {} as never,
      {} as never,
    );

    const chosen = await controller.chooseLibrary();
    expect(chosen.library.scan.status).toBe('succeeded');
    expect(chosen.library.scan.metadata).toBeDefined();
    rejectScan?.(new Error('synthetic scanner failure'));
    await failedBroadcast;

    expect(finishScanRun).toHaveBeenCalledWith(
      'run-failed',
      expect.objectContaining({
        status: 'failed',
        counts: expect.objectContaining({ errors: 1 }),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      'photo-map:scan-progress',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(controller.getLibrary().scan.metadata).toBeUndefined();
    expect(() => controller.resolveScanLocations({
      runId: 'run-failed',
      decision: 'overwrite-all-resolved',
    }))
      .toThrow('这次扫描的照片信息建议已失效');
  });
});

describe('PRD-FR-007 confirmed scan location proposals', () => {
  async function createProposalController() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });
    const source = {
      sourceId: 'source-1',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    let revision = 1;
    const snapshot = (progress?: ScanProgress): LibrarySnapshot => ({
      source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
      photos: [],
      photoTypes: [],
      scan: progress ?? {
        runId: 'run-gps',
        sourceId: source.sourceId,
        status: 'succeeded',
        counts: { discovered: 2, indexed: 2, unchanged: 0, errors: 0 },
      },
      catalogRevision: revision,
    });
    const applySuggestedMetadata = vi.fn((
      _sourceId: string,
      assignments: readonly unknown[],
      captureTimes: readonly unknown[],
      _decision: 'overwrite-all-resolved' | 'fill-unlabeled-only',
    ) => {
      revision += 1;
      return {
        succeeded: Math.max(assignments.length, captureTimes.length),
        skipped: 0,
        failed: 0,
        locations: { succeeded: assignments.length, skipped: 0, failed: 0 },
        captureTimes: { succeeded: captureTimes.length, skipped: 0, failed: 0 },
        library: snapshot(),
      };
    });
    const repository = {
      activateSource: vi.fn(() => source),
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn(snapshot),
      applySuggestedMetadata,
    };
    const metadata = {
      examined: 2,
      exifCount: 2,
      gpsCount: 1,
      resolvedLocationCount: 1,
      captureTimeCount: 1,
      metadataErrorCount: 0,
    };
    const terminal: ScanProgress = {
      runId: 'run-gps',
      sourceId: source.sourceId,
      status: 'succeeded',
      counts: { discovered: 2, indexed: 2, unchanged: 0, errors: 0 },
      metadata,
    };
    const scanner = {
      scan: vi.fn(async (
        sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        options.onProgress({ ...terminal, sourceId, status: 'running', metadata: undefined });
        options.onLocationProposal?.({
          runId: 'run-gps',
          sourceId,
          summary: metadata,
          assignments: [{
            photoId: 'photo-1',
            location: { provinceGb: '156420000', cityGb: '156420100' },
          }],
          captureTimes: [{
            photoId: 'photo-1',
            captureTime: { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
          }],
        });
        options.onProgress(terminal);
        return { progress: terminal };
      }),
    };
    const assertLocation = vi.fn();
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => true, assertLocation } as never,
      {} as never,
      {} as never,
    );
    await controller.chooseLibrary();
    return { controller, applySuggestedMetadata, assertLocation };
  }

  it('user_confirms_current_run__proposal__overwrites_each_resolved_photo_once_and_expires', async () => {
    const { controller, applySuggestedMetadata, assertLocation } = await createProposalController();

    const result = controller.resolveScanLocations({
      runId: 'run-gps',
      decision: 'overwrite-all-resolved',
    });

    expect(result).toEqual(expect.objectContaining({
      applied: true,
      decision: 'overwrite-all-resolved',
      succeeded: 1,
      skipped: 0,
      failed: 0,
    }));
    expect(assertLocation).toHaveBeenCalledWith({
      provinceGb: '156420000',
      cityGb: '156420100',
    });
    expect(applySuggestedMetadata).toHaveBeenCalledWith(
      'source-1',
      [{
        photoId: 'photo-1',
        location: { provinceGb: '156420000', cityGb: '156420100' },
      }],
      [{
        photoId: 'photo-1',
        captureTime: { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
      }],
      'overwrite-all-resolved',
    );
    expect(controller.getLibrary().scan.metadata).toBeUndefined();
    expect(() => controller.resolveScanLocations({
      runId: 'run-gps',
      decision: 'overwrite-all-resolved',
    }))
      .toThrow('这次扫描的照片信息建议已失效');
  });

  it('user_fills_only_unlabeled_photos__proposal__passes_the_non_overwrite_decision_and_expires', async () => {
    const { controller, applySuggestedMetadata, assertLocation } = await createProposalController();

    const result = controller.resolveScanLocations({
      runId: 'run-gps',
      decision: 'fill-unlabeled-only',
    });

    expect(result).toEqual(expect.objectContaining({
      applied: true,
      decision: 'fill-unlabeled-only',
      succeeded: 1,
      skipped: 0,
      failed: 0,
    }));
    expect(assertLocation).toHaveBeenCalledWith({
      provinceGb: '156420000',
      cityGb: '156420100',
    });
    expect(applySuggestedMetadata).toHaveBeenCalledWith(
      'source-1',
      [{
        photoId: 'photo-1',
        location: { provinceGb: '156420000', cityGb: '156420100' },
      }],
      [{
        photoId: 'photo-1',
        captureTime: { localDateTime: '2026-06-17T15:44:34', offsetMinutes: 480 },
      }],
      'fill-unlabeled-only',
    );
    expect(() => controller.resolveScanLocations({
      runId: 'run-gps',
      decision: 'fill-unlabeled-only',
    })).toThrow('这次扫描的照片信息建议已失效');
  });

  it('user_keeps_existing_locations__proposal__is_discarded_without_any_catalog_write', async () => {
    const { controller, applySuggestedMetadata, assertLocation } = await createProposalController();

    const result = controller.resolveScanLocations({ runId: 'run-gps', decision: 'ignore' });

    expect(result).toEqual(expect.objectContaining({
      applied: false,
      decision: 'ignore',
      succeeded: 0,
      skipped: 0,
      failed: 0,
    }));
    expect(assertLocation).not.toHaveBeenCalled();
    expect(applySuggestedMetadata).not.toHaveBeenCalled();
    expect(controller.getLibrary().scan.metadata).toBeUndefined();
  });
});

describe('user-managed map data', () => {
  const missingStatus = {
    items: [
      { kind: 'province' as const, label: '省份数据', imported: false },
      { kind: 'city' as const, label: '城市数据', imported: false },
    ],
    completed: 0,
    total: 2,
    ready: false,
  };

  function createController(mapData: {
    getStatus: ReturnType<typeof vi.fn>;
    importFiles: ReturnType<typeof vi.fn>;
  }): PhotoMapController {
    return createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      {
        getActiveSource: vi.fn(() => null),
        getLibrarySnapshot: vi.fn(() => ({ photos: [] })),
      } as never,
      {} as never,
      { isAvailable: () => false } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );
  }

  it('prd_fr_003__map_becomes_ready_with_an_available_source__import__queues_one_gps_scan_after_unlock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const source = {
      sourceId: 'source-map-ready',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };
    let geometryReady = false;
    let runNumber = 0;
    const scanner = {
      scan: vi.fn(async (
        sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        runNumber += 1;
        const terminal: ScanProgress = {
          runId: `run-map-ready-${runNumber}`,
          sourceId,
          status: 'succeeded',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        };
        options.onProgress(terminal);
        return { progress: terminal };
      }),
    };
    const repository = {
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? {
          runId: null,
          sourceId: null,
          status: 'idle',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        },
        catalogRevision: 1,
      })),
    };
    const mapData = {
      getStatus: vi.fn(async () => geometryReady ? readyStatus : missingStatus),
      importFiles: vi.fn(async () => {
        geometryReady = true;
        return { accepted: ['province' as const, 'city' as const], rejected: [], status: readyStatus };
      }),
    };
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson', 'D:\\下载\\city.geojson'],
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => geometryReady } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    await expect(controller.importMapData()).resolves.toEqual(expect.objectContaining({
      cancelled: false,
      status: readyStatus,
    }));
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(1));
    expect(scanner.scan.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-and-resolve',
    }));

    await controller.importMapData();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scanner.scan).toHaveBeenCalledTimes(1);

    geometryReady = false;
    await controller.importMapData();
    await controller.refreshLibrary();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scanner.scan).toHaveBeenCalledTimes(2);
    expect(scanner.scan.mock.calls[1]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-and-resolve',
    }));
  });

  it('map_ready_supplemental_scan__trash_is_active__retries_after_the_file_guard_releases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const trashGate = deferred<never[]>();
    const source = {
      sourceId: 'source-map-ready-after-trash',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };
    let geometryReady = false;
    const scanner = {
      scan: vi.fn(async (
        sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        const terminal: ScanProgress = {
          runId: 'run-map-ready-after-trash',
          sourceId,
          status: 'succeeded',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        };
        options.onProgress(terminal);
        return { progress: terminal };
      }),
    };
    const repository = {
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? {
          runId: null,
          sourceId: null,
          status: 'idle',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        },
        catalogRevision: 1,
      })),
    };
    const mapData = {
      getStatus: vi.fn(async () => geometryReady ? readyStatus : missingStatus),
      importFiles: vi.fn(async () => {
        geometryReady = true;
        return { accepted: ['province' as const, 'city' as const], rejected: [], status: readyStatus };
      }),
    };
    const trashService = { moveConfirmed: vi.fn(() => trashGate.promise) };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson', 'D:\\下载\\city.geojson'],
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => geometryReady } as never,
      trashService as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    const trashing = controller.trashPhotos(['photo-1']);
    await vi.waitFor(() => expect(trashService.moveConfirmed).toHaveBeenCalledOnce());
    await expect(controller.importMapData()).resolves.toEqual(expect.objectContaining({
      cancelled: false,
      status: readyStatus,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scanner.scan).not.toHaveBeenCalled();

    trashGate.resolve([]);
    await expect(trashing).resolves.toEqual(expect.objectContaining({ items: [] }));
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());
    expect(scanner.scan.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-and-resolve',
    }));
  });

  it('prd_fr_003__map_import_stays_partial_with_an_available_source__import__does_not_queue_a_scan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const source = {
      sourceId: 'source-available',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const scanner = { scan: vi.fn() };
    const repository = {
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn(() => ({ photos: [] })),
    };
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(async () => ({
        accepted: ['province' as const],
        rejected: [],
        status: { ...missingStatus, completed: 1 },
      })),
    };
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson'],
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => false } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    await controller.importMapData();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('prd_fr_003__map_becomes_ready_without_an_active_source__import__does_not_queue_a_scan', async () => {
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };
    let geometryReady = false;
    const scanner = { scan: vi.fn() };
    const repository = {
      getActiveSource: vi.fn(() => null),
      getLibrarySnapshot: vi.fn(() => ({ photos: [] })),
    };
    const mapData = {
      getStatus: vi.fn(async () => geometryReady ? readyStatus : missingStatus),
      importFiles: vi.fn(async () => {
        geometryReady = true;
        return { accepted: ['province' as const, 'city' as const], rejected: [], status: readyStatus };
      }),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson', 'D:\\下载\\city.geojson'],
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => geometryReady } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    await controller.importMapData();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it('prd_fr_003__map_becomes_ready_with_a_stale_unavailable_source__import__revalidates_restores_and_scans_once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    let geometryReady = false;
    let availability: 'available' | 'unavailable' = 'unavailable';
    const source = {
      sourceId: 'source-recovered-for-map',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
    };
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };
    const scanner = {
      scan: vi.fn(async (
        sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        const terminal: ScanProgress = {
          runId: 'run-recovered-for-map',
          sourceId,
          status: 'succeeded',
          counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
        };
        options.onProgress(terminal);
        return { progress: terminal };
      }),
    };
    const markActiveSourceAvailable = vi.fn(() => { availability = 'available'; });
    const markActiveSourceUnavailable = vi.fn(() => { availability = 'unavailable'; });
    const repository = {
      getActiveSource: vi.fn(() => ({ ...source, availability })),
      markActiveSourceAvailable,
      markActiveSourceUnavailable,
      getLibrarySnapshot: vi.fn(() => ({ photos: [] })),
    };
    const mapData = {
      getStatus: vi.fn(async () => geometryReady ? readyStatus : missingStatus),
      importFiles: vi.fn(async () => {
        geometryReady = true;
        return { accepted: ['province' as const, 'city' as const], rejected: [], status: readyStatus };
      }),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson', 'D:\\下载\\city.geojson'],
    });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => geometryReady } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    await controller.importMapData();
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());

    expect(markActiveSourceAvailable).toHaveBeenCalledOnce();
    expect(markActiveSourceUnavailable).not.toHaveBeenCalled();
    expect(availability).toBe('available');
    expect(scanner.scan.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-and-resolve',
    }));
  });

  it('prd_fr_003__map_becomes_ready_with_a_still_unreadable_source__import__marks_unavailable_reports_failure_and_does_not_scan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const missingRoot = path.join(root, 'missing-library');
    const source = {
      sourceId: 'source-still-unreadable',
      rootPath: missingRoot,
      canonicalRootKey: missingRoot.toLocaleLowerCase('en-US'),
      availability: 'unknown' as const,
    };
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };
    let geometryReady = false;
    const scanner = { scan: vi.fn() };
    const markActiveSourceUnavailable = vi.fn();
    const repository = {
      getActiveSource: vi.fn(() => source),
      markActiveSourceUnavailable,
      getLibrarySnapshot: vi.fn(() => ({ photos: [] })),
    };
    const mapData = {
      getStatus: vi.fn(async () => geometryReady ? readyStatus : missingStatus),
      importFiles: vi.fn(async () => {
        geometryReady = true;
        return { accepted: ['province' as const, 'city' as const], rejected: [], status: readyStatus };
      }),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson', 'D:\\下载\\city.geojson'],
    });
    const send = vi.fn();
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => geometryReady } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    await controller.importMapData();
    await vi.waitFor(() => expect(markActiveSourceUnavailable).toHaveBeenCalledOnce());

    expect(scanner.scan).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'photo-map:scan-progress',
      expect.objectContaining({ sourceId: source.sourceId, status: 'failed' }),
    );
  });

  it('prd_fr_003__cancelled_or_failed_import_observes_ready_geometry__import__still_does_not_queue_a_scan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const source = {
      sourceId: 'source-cancel-failure',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };

    for (const mode of ['cancelled', 'failed'] as const) {
      let geometryReady = false;
      const scanner = { scan: vi.fn() };
      const repository = {
        getActiveSource: vi.fn(() => source),
        getLibrarySnapshot: vi.fn(() => ({ photos: [] })),
      };
      const mapData = {
        getStatus: vi.fn(async () => {
          geometryReady = true;
          return readyStatus;
        }),
        importFiles: vi.fn(async () => {
          geometryReady = true;
          throw new Error('synthetic import failure after geometry changed');
        }),
      };
      electronMocks.showOpenDialog.mockResolvedValueOnce(mode === 'cancelled'
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: ['D:\\下载\\province.geojson'] });
      const controller = createTestController(
        { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
        repository as never,
        scanner as never,
        { isAvailable: () => geometryReady } as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        mapData as never,
      );

      if (mode === 'cancelled') {
        await expect(controller.importMapData()).resolves.toEqual(expect.objectContaining({
          cancelled: true,
          status: readyStatus,
        }));
      } else {
        await expect(controller.importMapData()).rejects.toMatchObject({
          code: 'MAP_IMPORT_FAILED',
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scanner.scan).not.toHaveBeenCalled();
    }
  });

  it('opens a multi-file picker and keeps valid files when the selection is mixed', async () => {
    const readyStatus = {
      items: missingStatus.items.map((item) => ({ ...item, imported: true })),
      completed: 2,
      total: 2,
      ready: true,
    };
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(async () => ({
        accepted: ['province', 'city'],
        rejected: [{ fileName: 'notes.txt', reason: 'unrecognized' }],
        status: readyStatus,
      })),
    };
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['D:\\下载\\renamed-a.geojson', 'D:\\下载\\renamed-b.geojson', 'D:\\下载\\notes.txt'],
    });
    const controller = createController(mapData);

    const result = await controller.importMapData();

    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      properties: ['openFile', 'multiSelections'],
    }));
    expect(mapData.importFiles).toHaveBeenCalledWith([
      'D:\\下载\\renamed-a.geojson',
      'D:\\下载\\renamed-b.geojson',
      'D:\\下载\\notes.txt',
    ]);
    expect(result).toEqual({
      cancelled: false,
      accepted: ['province', 'city'],
      rejected: [{ fileName: 'notes.txt', reason: 'unrecognized' }],
      status: readyStatus,
    });
  });

  it('cancels without importing and returns the current zero-of-two status', async () => {
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(),
    };
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const controller = createController(mapData);

    await expect(controller.importMapData()).resolves.toEqual({
      cancelled: true,
      accepted: [],
      rejected: [],
      status: missingStatus,
    });
    expect(mapData.importFiles).not.toHaveBeenCalled();
  });

  it('prd_fr_023__map_import_is_in_flight__shutdown__waits_for_import_and_suppresses_new_tasks', async () => {
    const importOutcome = deferred<{
      accepted: ('province' | 'city')[];
      rejected: never[];
      status: typeof missingStatus;
    }>();
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(() => importOutcome.promise),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson'],
    });
    const controller = createController(mapData);
    const importing = controller.importMapData();
    await vi.waitFor(() => expect(mapData.importFiles).toHaveBeenCalledOnce());

    let shutdownSettled = false;
    const shuttingDown = controller.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await expect(controller.importMapData()).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: expect.stringContaining('应用正在关闭'),
    });

    importOutcome.resolve({ accepted: ['province'], rejected: [], status: missingStatus });
    await expect(importing).resolves.toEqual(expect.objectContaining({ cancelled: false }));
    await shuttingDown;
    expect(shutdownSettled).toBe(true);
  });

  it('map_picker_is_open__refresh_scan__is_rejected_until_the_dialog_releases_its_reservation', async () => {
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(),
    };
    electronMocks.showOpenDialog.mockReturnValueOnce(picker.promise);
    const controller = createController(mapData);

    const importing = controller.importMapData();
    await Promise.resolve();

    await expect(controller.refreshLibrary()).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: expect.stringContaining('地图数据导入中'),
    });
    picker.resolve({ canceled: true, filePaths: [] });
    await expect(importing).resolves.toEqual(expect.objectContaining({ cancelled: true }));
  });

  it('photo_picker_is_open__map_import__is_rejected_before_a_second_dialog_can_open', async () => {
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(),
    };
    electronMocks.showOpenDialog.mockReturnValueOnce(picker.promise);
    const controller = createController(mapData);

    const choosing = controller.chooseLibrary();
    await Promise.resolve();

    await expect(controller.importMapData()).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: expect.stringContaining('照片扫描进行中'),
    });
    expect(electronMocks.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(mapData.importFiles).not.toHaveBeenCalled();
    picker.resolve({ canceled: true, filePaths: [] });
    await expect(choosing).resolves.toEqual(expect.objectContaining({ cancelled: true }));
  });

  it('photo_scan_is_running__map_import__is_rejected_before_the_map_picker_can_open', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const scanRelease = deferred<void>();
    const source = {
      sourceId: 'source-1',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const running: ScanProgress = {
      runId: 'run-active',
      sourceId: source.sourceId,
      status: 'running',
      counts: { discovered: 1, indexed: 0, unchanged: 0, errors: 0 },
    };
    const repository = {
      activateSource: vi.fn(() => source),
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? running,
        catalogRevision: 1,
      })),
    };
    const scanner = {
      scan: vi.fn(async (
        _sourceId: string,
        _rootPath: string,
        _signal: AbortSignal,
        options: LibraryScanOptions,
      ) => {
        options.onProgress(running);
        await scanRelease.promise;
        return { progress: { ...running, status: 'succeeded' as const } };
      }),
    };
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => false } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      mapData as never,
    );

    await controller.chooseLibrary();
    expect(scanner.scan.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      gpsMetadataPolicy: 'probe-without-resolve',
    }));
    await expect(controller.refreshLibrary()).rejects.toMatchObject({
      code: 'SCAN_FAILED',
      message: expect.stringContaining('照片扫描正在进行'),
      retryability: 'retry',
    });
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    await expect(controller.importMapData()).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: expect.stringContaining('照片扫描进行中'),
    });
    expect(electronMocks.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(mapData.importFiles).not.toHaveBeenCalled();

    scanRelease.resolve(undefined);
    await controller.shutdown();
  });

  it('map_files_are_being_written__choose_scan__is_rejected_until_import_finishes', async () => {
    const importOutcome = deferred<{
      accepted: ('province' | 'city')[];
      rejected: never[];
      status: typeof missingStatus;
    }>();
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(() => importOutcome.promise),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson'],
    });
    const controller = createController(mapData);
    const importing = controller.importMapData();
    await vi.waitFor(() => expect(mapData.importFiles).toHaveBeenCalledOnce());

    await expect(controller.chooseLibrary()).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: expect.stringContaining('地图数据导入中'),
    });
    expect(electronMocks.showOpenDialog).toHaveBeenCalledTimes(1);

    importOutcome.resolve({ accepted: ['province'], rejected: [], status: missingStatus });
    await expect(importing).resolves.toEqual(expect.objectContaining({
      cancelled: false,
      accepted: ['province'],
    }));
  });

  it('map_storage_failure__import__surfaces_map_import_failed_instead_of_a_rejection_result', async () => {
    const mapData = {
      getStatus: vi.fn(async () => missingStatus),
      importFiles: vi.fn(async () => {
        throw new Error('synthetic storage failure');
      }),
    };
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\下载\\province.geojson'],
    });
    const controller = createController(mapData);

    await expect(controller.importMapData()).rejects.toMatchObject({
      code: 'MAP_IMPORT_FAILED',
      message: '地图数据导入未完成，请重试。',
    });
  });

  it('opens only the fixed official TianDiTu download page', async () => {
    electronMocks.openExternal.mockResolvedValue(undefined);
    const controller = createController({ getStatus: vi.fn(), importFiles: vi.fn() });

    await expect(controller.openMapDownload()).resolves.toEqual({ opened: true });
    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      'https://cloudcenter.tianditu.gov.cn/administrativeDivision',
    );
  });
});

describe('photo file mutation coordination', () => {
  it('reports_partial_changed_and_index_failed_results_without_losing_per_file_details', async () => {
    const items = [
      { photoId: 'partial-photo', status: 'partial', movedFileNames: ['companion.mov'], failureReason: 'access_denied' },
      { photoId: 'changed-photo', status: 'changed' },
      { photoId: 'index-photo', status: 'index_failed', movedFileNames: ['photo.jpg'] },
    ] as const;
    const library = { photos: [] };
    const diagnostics = { record: vi.fn(async () => undefined) };
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      { getLibrarySnapshot: vi.fn(() => library) } as never,
      {} as never,
      { isAvailable: () => false } as never,
      { moveConfirmed: vi.fn(async () => items) } as never,
      {} as never,
      undefined,
      diagnostics,
    );

    const result = await controller.trashPhotos(items.map((item) => item.photoId));

    expect(result.items).toBe(items);
    expect(result.library).toBe(library);
    expect(diagnostics.record).toHaveBeenCalledWith({
      stage: 'trash',
      errorCode: 'RECYCLE_PARTIAL',
      counts: expect.objectContaining({ partial: 1, changed: 1, indexFailed: 1, moved: 0 }),
    });
  });

  function createMutationController(
    fileRenameService: { renamePhoto: ReturnType<typeof vi.fn> },
    trashService: { moveConfirmed: ReturnType<typeof vi.fn> },
  ): PhotoMapController {
    return createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      { getLibrarySnapshot: vi.fn(() => ({ photos: [] })) } as never,
      {} as never,
      { isAvailable: () => false } as never,
      trashService as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      fileRenameService as never,
    );
  }

  it('rejects_trash_while_a_scan_is_in_flight_and_releases_the_guard_afterward', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'photo-map-controller-'));
    temporaryRoots.push(root);
    const scanGate = deferred<void>();
    const source = {
      sourceId: 'source-scan-trash',
      rootPath: root,
      canonicalRootKey: root.toLocaleLowerCase('en-US'),
      availability: 'available' as const,
    };
    const idle: ScanProgress = {
      runId: null,
      sourceId: null,
      status: 'idle',
      counts: { discovered: 0, indexed: 0, unchanged: 0, errors: 0 },
    };
    const repository = {
      activateSource: vi.fn(() => source),
      getActiveSource: vi.fn(() => source),
      getLibrarySnapshot: vi.fn((progress?: ScanProgress): LibrarySnapshot => ({
        source: { sourceId: source.sourceId, displayName: 'library', availability: 'available' },
        photos: [],
        photoTypes: [],
        scan: progress ?? idle,
        catalogRevision: 1,
      })),
    };
    const scanner = { scan: vi.fn(() => scanGate.promise) };
    const trashService = { moveConfirmed: vi.fn(async () => []) };
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
    const controller = createTestController(
      { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
      repository as never,
      scanner as never,
      { isAvailable: () => false } as never,
      trashService as never,
      {} as never,
    );

    await controller.chooseLibrary();
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());

    await expect(controller.trashPhotos(['photo-1'])).rejects.toMatchObject({
      code: 'RECYCLE_FAILED',
      message: expect.stringContaining('照片扫描进行中'),
    });
    expect(trashService.moveConfirmed).not.toHaveBeenCalled();

    scanGate.resolve(undefined);
    await controller.cancelScan();
    await expect(controller.trashPhotos(['photo-1'])).resolves.toEqual(expect.objectContaining({
      items: [],
    }));
  });

  it('rejects_trash_while_a_scan_picker_is_pending', async () => {
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    const fileRenameService = { renamePhoto: vi.fn() };
    const trashService = { moveConfirmed: vi.fn(async () => []) };
    electronMocks.showOpenDialog.mockReturnValueOnce(picker.promise);
    const controller = createMutationController(fileRenameService, trashService);

    const choosing = controller.chooseLibrary();
    await vi.waitFor(() => expect(electronMocks.showOpenDialog).toHaveBeenCalledOnce());

    await expect(controller.trashPhotos(['photo-1'])).rejects.toMatchObject({
      code: 'RECYCLE_FAILED',
      message: expect.stringContaining('照片扫描进行中'),
    });
    expect(trashService.moveConfirmed).not.toHaveBeenCalled();

    picker.resolve({ canceled: true, filePaths: [] });
    await expect(choosing).resolves.toEqual(expect.objectContaining({ cancelled: true }));
    await expect(controller.trashPhotos(['photo-1'])).resolves.toEqual(expect.objectContaining({
      items: [],
    }));
  });

  it('rejects_scan_while_a_trash_operation_is_in_flight_and_releases_the_guard_afterward', async () => {
    const trashGate = deferred<never[]>();
    const fileRenameService = { renamePhoto: vi.fn() };
    const trashService = { moveConfirmed: vi.fn(() => trashGate.promise) };
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    const controller = createMutationController(fileRenameService, trashService);

    const trashing = controller.trashPhotos(['photo-1']);
    await vi.waitFor(() => expect(trashService.moveConfirmed).toHaveBeenCalledOnce());

    await expect(controller.chooseLibrary()).rejects.toMatchObject({
      code: 'SCAN_FAILED',
      message: expect.stringContaining('移入回收站'),
    });
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();

    trashGate.resolve([]);
    await expect(trashing).resolves.toEqual(expect.objectContaining({ items: [] }));
    await expect(controller.chooseLibrary()).resolves.toEqual(expect.objectContaining({ cancelled: true }));
    expect(electronMocks.showOpenDialog).toHaveBeenCalledOnce();
  });

  it('rejects_trash_while_a_rename_is_in_flight_and_releases_the_guard_afterward', async () => {
    const renameGate = deferred<{ renamed: boolean; fileName: string }>();
    const fileRenameService = { renamePhoto: vi.fn(() => renameGate.promise) };
    const trashService = { moveConfirmed: vi.fn(async () => []) };
    const controller = createMutationController(fileRenameService, trashService);

    const renaming = controller.renamePhoto({ photoId: 'photo-1', newFileName: 'renamed.jpg' });
    await vi.waitFor(() => expect(fileRenameService.renamePhoto).toHaveBeenCalledOnce());

    await expect(controller.trashPhotos(['photo-1'])).rejects.toMatchObject({
      code: 'RECYCLE_FAILED',
      message: expect.stringContaining('文件重命名正在进行'),
    });
    expect(trashService.moveConfirmed).not.toHaveBeenCalled();

    renameGate.resolve({ renamed: true, fileName: 'renamed.jpg' });
    await expect(renaming).resolves.toEqual(expect.objectContaining({
      renamed: true,
      fileName: 'renamed.jpg',
    }));
    await expect(controller.trashPhotos(['photo-1'])).resolves.toEqual(expect.objectContaining({
      items: [],
    }));
  });

  it('rejects_rename_while_a_trash_operation_is_in_flight', async () => {
    const trashGate = deferred<never[]>();
    const fileRenameService = { renamePhoto: vi.fn() };
    const trashService = { moveConfirmed: vi.fn(() => trashGate.promise) };
    const controller = createMutationController(fileRenameService, trashService);

    const trashing = controller.trashPhotos(['photo-1']);
    await vi.waitFor(() => expect(trashService.moveConfirmed).toHaveBeenCalledOnce());

    await expect(controller.renamePhoto({
      photoId: 'photo-1',
      newFileName: 'renamed.jpg',
    })).rejects.toMatchObject({
      code: 'RENAME_FAILED',
      message: expect.stringContaining('移入回收站'),
    });
    expect(fileRenameService.renamePhoto).not.toHaveBeenCalled();

    trashGate.resolve([]);
    await expect(trashing).resolves.toEqual(expect.objectContaining({ items: [] }));
  });

  it('waits_for_an_in_flight_rename_during_shutdown_and_rejects_new_file_mutations', async () => {
    const renameGate = deferred<{ renamed: boolean; fileName: string }>();
    const fileRenameService = { renamePhoto: vi.fn(() => renameGate.promise) };
    const trashService = { moveConfirmed: vi.fn(async () => []) };
    const controller = createMutationController(fileRenameService, trashService);

    const renaming = controller.renamePhoto({ photoId: 'photo-1', newFileName: 'renamed.jpg' });
    await vi.waitFor(() => expect(fileRenameService.renamePhoto).toHaveBeenCalledOnce());
    let shutdownSettled = false;
    const shuttingDown = controller.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    await expect(controller.trashPhotos(['photo-1'])).rejects.toMatchObject({
      code: 'RECYCLE_FAILED',
      message: expect.stringContaining('应用正在关闭'),
    });

    renameGate.resolve({ renamed: true, fileName: 'renamed.jpg' });
    await renaming;
    await shuttingDown;
    expect(shutdownSettled).toBe(true);
  });
});


describe('settings and export shutdown completion', () => {
  function savingController(write: () => Promise<void>, exportSave: () => Promise<void>) {
    return createTestController(
      {} as never, {} as never, {} as never, { isAvailable: () => false } as never,
      {} as never, { save: exportSave } as never,
      { get: defaultAppSettings, update: async (settings) => { await write(); return settings; } },
    );
  }

  it.each(['settings', 'export'] as const)('waits for an in-flight %s save and rejects new saves after shutdown starts', async (kind) => {
    const pending = deferred<void>();
    const write = vi.fn(() => pending.promise);
    const controller = savingController(write, write);
    if (kind === 'export') electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'saved.png' });
    const request = { dataUrl: '', format: 'png' as const, suggestedName: 'saved.png' };
    const save = kind === 'settings' ? controller.updateSettings(defaultAppSettings()) : controller.saveExport(request);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    let closed = false;
    const closing = controller.shutdown().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(controller.updateSettings(defaultAppSettings())).rejects.toMatchObject({ code: 'SETTINGS_WRITE_FAILED' });
    await expect(controller.saveExport(request)).rejects.toMatchObject({ code: 'EXPORT_WRITE_FAILED' });
    pending.resolve();
    await save;
    await closing;
    expect(closed).toBe(true);
  });

  it.each(['settings', 'export'] as const)('releases shutdown when an in-flight %s save fails', async (kind) => {
    const gate = deferred<void>();
    const write = vi.fn(async () => { await gate.promise; throw new Error('disk write failed'); });
    const controller = savingController(write, write);
    if (kind === 'export') electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'saved.png' });
    const save = kind === 'settings' ? controller.updateSettings(defaultAppSettings())
      : controller.saveExport({ dataUrl: '', format: 'png', suggestedName: 'saved.png' });
    const failed = expect(save).rejects.toThrow('disk write failed');
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const closing = controller.shutdown();
    gate.resolve();
    await failed;
    await expect(closing).resolves.toBeUndefined();
  });

  it('waits for an export picker to cancel without requiring a disk write', async () => {
    const picker = deferred<{ canceled: boolean }>();
    electronMocks.showSaveDialog.mockReturnValueOnce(picker.promise);
    const write = vi.fn(async () => undefined);
    const controller = savingController(write, write);
    const save = controller.saveExport({ dataUrl: '', format: 'png', suggestedName: 'saved.png' });
    let closed = false;
    const closing = controller.shutdown().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    picker.resolve({ canceled: true });
    await expect(save).resolves.toEqual({ cancelled: true });
    await closing;
    expect(write).not.toHaveBeenCalled();
  });
});
