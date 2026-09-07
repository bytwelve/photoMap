import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import regions from '../../src/shared/administrative-regions.data.json' with { type: 'json' };
import { appRoot, portableSourcePath, portableArtifactName, portableDataDirectoryName, temporaryDirectoryPrefix, temporaryOwnerFileName, runId, mapDataFixturePath, fixturePath, localAppData, isolatedSourcePath, resultRoot } from './lib/config.mjs';
import { assertMissing, assertNonEmptyOrdinaryFile, removeTemporaryPackage, verifyTemporaryOwnership } from './lib/package.mjs';
import { bootstrapCatalog } from './lib/maps.mjs';
import { seedCatalog, projectFixtureNames } from './lib/fixtures.mjs';
import { openSession, shutdownSession } from './lib/session.mjs';
import { closeTrackedApplications } from './lib/evidence.mjs';
import { evaluate, waitForValue, screenshot, rendererErrorEvents } from './lib/cdp.mjs';
import { clickButtonExpression } from './lib/ui.mjs';
import { dragExportBoardControl, exportDialogStateExpression, exportLayoutIsLegal } from './lib/export-ui.mjs';
import { assertCondition, delay } from './lib/utils.mjs';

// Documentation-only assignments: reused synthetic photos are not travel records.
// Give every province seven different photos for a denser collage.
const photoSources = [
  'beijing-great-wall.png', 'guilin-li-river.jpg', 'jiangnan-water-town.jpg',
  'shanghai-blue-hour.jpg', 'sichuan-jiuzhaigou.jpg',
  'wuhan-yellow-crane-tower.jpg', 'yunnan-meili-mountain.jpg',
];
const photosPerProvince = photoSources.length;
const provinces = regions.regions.filter(region => region.level === 'province');
const examples = provinces.flatMap(region => photoSources.map((source, index) => ({
  provinceGb: region.code,
  provinceName: region.name,
  source,
  // The staged copy keeps the source bytes, so it has to keep the source extension.
  fileName: `demo-${region.code}-${index + 1}${path.extname(source)}`,
})));
const referenceViewport = { width: 1195, height: 820 };
const camera = { zoom: 1.65, panX: 30, panY: 100 };

async function stageDocumentationPackage() {
  // Copy only application files. An already-used portable package may have a
  // real library next to it; never copy, scan, or alter that PhotoMapData folder.
  await assertNonEmptyOrdinaryFile(path.join(portableSourcePath, 'PhotoMap.exe'), 'Portable executable');
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), temporaryDirectoryPrefix));
  const applicationDirectory = path.join(temporaryRoot, portableArtifactName);
  const runtime = {
    temporaryRoot, applicationDirectory,
    ownerPath: path.join(temporaryRoot, temporaryOwnerFileName),
    ownerToken: `${runId}:${randomUUID()}`,
    executablePath: path.join(applicationDirectory, 'PhotoMap.exe'),
    photoMapDataRoot: path.join(applicationDirectory, portableDataDirectoryName),
    mapDataDirectory: path.join(applicationDirectory, portableDataDirectoryName, 'data/map-data/v1'),
    activeLaunches: new Set(),
  };
  await writeFile(runtime.ownerPath, `${runtime.ownerToken}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await verifyTemporaryOwnership(runtime);
    await cp(portableSourcePath, applicationDirectory, {
      recursive: true, force: false, errorOnExist: true,
      filter: source => path.relative(portableSourcePath, source).split(path.sep)[0].toLowerCase() !== portableDataDirectoryName.toLowerCase(),
    });
    await assertMissing(runtime.photoMapDataRoot, 'Isolated documentation library before launch');
    return runtime;
  } catch (error) {
    await removeTemporaryPackage(runtime);
    throw error;
  }
}

async function main() {
  assertCondition(mapDataFixturePath, 'Provide PHOTOMAP_E2E_MAP_DATA_FIXTURES.');
  assertCondition(process.versions.node === (await readFile(path.join(appRoot, '.node-version'), 'utf8')).trim(), 'Use the pinned Node version.');
  assertCondition(provinces.length === 34 && examples.length === 34 * photosPerProvince, 'Every province needs multiple demonstration photos.');
  assertCondition(path.resolve(fixturePath) === path.join(appRoot, 'tests/fixtures/photos'), 'Documentation exports must use the verified public synthetic fixtures, not PHOTOMAP_E2E_PHOTO_FIXTURES overrides.');
  const fixtureNames = await projectFixtureNames();
  assertCondition(examples.every(example => fixtureNames.includes(example.source)), 'Use verified public synthetic photos only.');
  const expectedVersion = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')).version;
  const output = path.join(appRoot, 'docs/images/share-card.png');
  await Promise.all([mkdir(localAppData, { recursive: true }), mkdir(isolatedSourcePath, { recursive: true })]);
  let runtime;
  let session;
  try {
    runtime = await stageDocumentationPackage();
    console.log('Preparing isolated documentation library.');
    await bootstrapCatalog(runtime, {});
    await seedCatalog(runtime);
    await Promise.all(examples.map(example => copyFile(path.join(fixturePath, example.source), path.join(isolatedSourcePath, example.fileName))));
    session = await openSession(runtime, 'share-documentation');
    const { client } = session;
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitForValue(client, 'window.photoMap?.getLibrary().then(r => r.ok ? r.value.photos.length : 0)', count => count === examples.length, 120_000);
    const coverage = await evaluate(client, `(async () => {
      const unwrap = r => { if (!r.ok) throw new Error(r.error.userMessage); return r.value; };
      const library = unwrap(await window.photoMap.getLibrary());
      for (const example of ${JSON.stringify(examples)}) {
        const photo = library.photos.find(photo => photo.fileName === example.fileName);
        if (!photo) throw new Error('Missing demo photo: ' + example.fileName);
        unwrap(await window.photoMap.updateLocations({ photoIds: [photo.photoId], location: { provinceGb: example.provinceGb } }));
      }
      const settings = unwrap(await window.photoMap.getSettings());
      unwrap(await window.photoMap.updateSettings({ ...settings, map: { ...settings.map, showPhotos: true, density: ${photosPerProvince}, camera: ${JSON.stringify(camera)} } }));
      const result = unwrap(await window.photoMap.getLibrary());
      return result.photos.map(photo => ({ photoId: photo.photoId, provinceGb: photo.location?.provinceGb, decodeState: photo.decodeState }));
    })()`);
    assertCondition(provinces.every(province => coverage.filter(item => item.provinceGb === province.code).length === photosPerProvince), 'Every province must have seven photos.');
    await client.send('Page.reload');
    await waitForValue(client, 'Boolean(document.querySelector("[data-testid=wall-canvas]"))', Boolean);
    // Resize the actual app viewport to the reference's map aspect ratio. No
    // export pixels, geography, production defaults, or image assets are edited.
    let viewport = { width: 1600, height: 1000 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bounds = await evaluate(client, `(() => { const r = document.querySelector('[data-testid="wall-canvas"]').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
      viewport = { width: Math.round(viewport.width + referenceViewport.width - bounds.width), height: Math.round(viewport.height + referenceViewport.height - bounds.height) };
      await client.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
      await delay(300);
    }
    await delay(1800);
    await evaluate(client, `(() => {
      window.__documentationPaintedPhotos = new Set();
      window.__documentationVisiblePhotos = new Set();
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.dataset.testid === 'export-output-canvas'
          && args[0]?.src?.startsWith('photomap-media://photo/')) {
          window.__documentationPaintedPhotos.add(args[0].src);
          // Observe changed pixels inside each tile's transformed bounds. A draw
          // call alone is not enough: province clipping can hide entire tiles.
          const [x, y, width, height] = args.slice(-4);
          const transform = this.getTransform();
          const left = Math.max(0, Math.floor(transform.a * x + transform.e));
          const top = Math.max(0, Math.floor(transform.d * y + transform.f));
          const right = Math.min(this.canvas.width, Math.ceil(transform.a * (x + width) + transform.e));
          const bottom = Math.min(this.canvas.height, Math.ceil(transform.d * (y + height) + transform.f));
          const w = right - left;
          const h = bottom - top;
          if (w > 0 && h > 0) {
            const before = this.getImageData(left, top, w, h).data;
            const result = Reflect.apply(drawImage, this, args);
            const after = this.getImageData(left, top, w, h).data;
            if (after.some((value, index) => value !== before[index])) {
              window.__documentationVisiblePhotos.add(args[0].src);
            }
            return result;
          }
        }
        return Reflect.apply(drawImage, this, args);
      };
    })()`);
    assertCondition(await evaluate(client, clickButtonExpression('导出分享图')), 'Export action missing.');
    let state = await waitForValue(client, exportDialogStateExpression(), value => value?.loaded && value.dataUrlLength > 100_000);
    const defaultState = state;
    const paintedPhotoCount = await evaluate(client, 'window.__documentationPaintedPhotos.size');
    assertCondition(paintedPhotoCount === examples.length, 'Every province photo must load and be drawn into the export canvas.');
    const visiblePhotoIds = new Set(await evaluate(client, '[...window.__documentationVisiblePhotos].map(url => new URL(url).pathname.slice(1))'));
    const visiblePhotosByProvince = provinces.map(province => ({
      provinceName: province.name,
      provinceGb: province.code,
      visiblePhotoCount: coverage.filter(item => item.provinceGb === province.code && visiblePhotoIds.has(item.photoId)).length,
    }));
    assertCondition(visiblePhotosByProvince.every(item => item.visiblePhotoCount >= 2), 'Every province must visibly contain more than one photo: ' + JSON.stringify(visiblePhotosByProvince));
    // Keep the default frame, title and their positions; remove only surplus
    // bottom space, leaving the default 48 px inset below the title.
    const targetHeight = Math.ceil(Math.max(...state.items.map(item => item.y + item.height)) + 48);
    await dragExportBoardControl(client, undefined, 0, 0);
    const scale = await evaluate(client, `document.querySelector('[data-testid="export-board"]').getBoundingClientRect().height / ${state.height}`);
    await dragExportBoardControl(client, 's', 0, (targetHeight - state.height) * scale);
    state = await waitForValue(client, exportDialogStateExpression(), value => value?.loaded && Math.abs(value.height - targetHeight) <= 1);
    assertCondition(exportLayoutIsLegal(state), 'Invalid export layout.');
    const photo = state.items.find(item => item.kind === 'photo');
    assertCondition(Math.abs(photo.width / photo.height - referenceViewport.width / referenceViewport.height) < 0.001, 'Reference map aspect ratio changed.');
    assertCondition(state.items.some(item => item.kind === 'text' && item.text === '我的照片地图'), 'Default title missing.');
    const appVersion = await evaluate(client, 'window.photoMap.getAppInfo().then(r => r.ok ? r.value.version : null)');
    assertCondition(appVersion === expectedVersion, 'Application package version differs from source.');
    // This is the full-resolution output canvas from the export feature, drawn
    // by drawShareCard, also used by renderSnapshotToDataUrl for the Save action.
    // Reading it avoids a native save dialog and excludes editor controls.
    const dataUrl = await evaluate(client, `document.querySelector('[data-testid="export-output-canvas"]').toDataURL('image/png')`);
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    assertCondition(png.readUInt32BE(16) === state.width && png.readUInt32BE(20) === state.height, 'PNG dimensions differ from the export board.');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, png);
    await screenshot(client, 'share-editor.png');
    assertCondition(rendererErrorEvents(client).length === 0, 'Renderer errors occurred.');
    await writeFile(path.join(resultRoot, 'share-documentation.json'), JSON.stringify({
      applicationVersion: appVersion, synthetic: true, referenceViewport, camera, examples,
      provinceCoverage: coverage, photosPerProvince, paintedPhotoCount, visiblePhotosByProvince, defaultExport: defaultState, export: state, output: 'docs/images/share-card.png',
      sha256: createHash('sha256').update(png).digest('hex'),
    }, null, 2) + '\n', 'utf8');
    console.log(`Exported ${state.width} × ${state.height} PNG covering all 34 provinces: ${output}`);
  } finally {
    if (session) await shutdownSession(session);
    if (runtime) { await closeTrackedApplications(runtime); await removeTemporaryPackage(runtime); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
