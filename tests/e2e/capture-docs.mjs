import path from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import regions from '../../src/shared/administrative-regions.data.json' with { type: 'json' };
import { appRoot, mapDataFixturePath, localAppData, isolatedSourcePath, resultRoot, fixturePath } from './lib/config.mjs';
import { stagePortablePackage, removeTemporaryPackage } from './lib/package.mjs';
import { bootstrapCatalog } from './lib/maps.mjs';
import { seedCatalog, stageProjectFixtures } from './lib/fixtures.mjs';
import { openSession, shutdownSession } from './lib/session.mjs';
import { closeTrackedApplications } from './lib/evidence.mjs';
import { evaluate, waitForValue, screenshot, rendererErrorEvents } from './lib/cdp.mjs';
import { clickButtonExpression, setAnnotationBatchModeExpression } from './lib/ui.mjs';
import { assertCondition, delay } from './lib/utils.mjs';

// Match the README reference: the China outline fills about 94% of the map width.
const documentationCamera = { zoom: 1.65, panX: 30, panY: 100 };
const photoWallOnly = process.argv.includes('--photo-wall-only');

// These are explicit demonstration annotations, never inferred by production code.
const examples = [
  ['beijing-great-wall.png', '长城的秋日来信.png', '北京市', null, '山野', '山脊在暮色中延伸，秋风把这一刻留在路上。'],
  ['guilin-li-river.jpg', '漓江晨雾.jpg', '广西壮族自治区', '桂林市', '山野', '薄雾渐渐散开，水面映着远山。'],
  ['jiangnan-water-town.jpg', '水巷灯火.jpg', '江苏省', '苏州市', '水乡', '沿着水巷慢慢走，等一盏灯亮起来。'],
  ['shanghai-blue-hour.jpg', '浦江蓝调.jpg', '上海市', null, '城市', '城市亮起灯，江面收下了整片蓝色。'],
  ['sichuan-jiuzhaigou.jpg', '山林与碧湖.jpg', '四川省', '阿坝藏族羌族自治州', '山野', '把脚步放轻，让湖水和山林说话。'],
  ['wuhan-yellow-crane-tower.jpg', '江城晚风.jpg', '湖北省', '武汉市', '城市', '楼影、灯火和江风，都是这一站的记忆。'],
  ['yunnan-meili-mountain.jpg', '雪山的第一束光.jpg', '云南省', '迪庆藏族自治州', '山野', '晨光落在山尖，漫长的等待有了颜色。'],
].map(([fileName, displayName, provinceName, cityName, tag, note], index) => {
  const province = regions.regions.find(item => item.level === 'province' && item.name === provinceName);
  const city = cityName ? regions.regions.find(item => item.level === 'city' && item.name === cityName && item.parentProvinceCode === province?.code) : undefined;
  assertCondition(province && (!cityName || city), `Demo region missing: ${provinceName}/${cityName}`);
  return { fileName, displayName, tag, note, provinceGb: province.code, cityGb: city?.code, localDateTime: `2026-08-${String(index + 10).padStart(2, '0')}T18:30:00` };
});

// Six distinct public synthetic images per province demonstrate the collage.
// Reused images receive explicit demo locations, not inferred travel locations.
const collageDensity = 6;
const collageExamples = examples.flatMap((location, locationIndex) => [
  location,
  ...Array.from({ length: collageDensity - 1 }, (_, index) => {
    const source = examples[(locationIndex + index + 1) % examples.length];
    // The staged copy keeps the source bytes, so it has to keep the source extension:
    // the scanner classifies by extension and renaming across formats is rejected.
    const extension = path.extname(source.fileName);
    return {
      ...location,
      sourceFileName: source.fileName,
      fileName: `wall-${location.provinceGb}-${index + 2}${extension}`,
      displayName: `${location.displayName.slice(0, -4)}·拼贴${index + 2}${extension}`,
      note: '拼贴演示：复用项目合成照片，不代表实际拍摄地点。',
    };
  }),
]);

async function main() {
  assertCondition(mapDataFixturePath, 'Provide PHOTOMAP_E2E_MAP_DATA_FIXTURES for documentation screenshots.');
  assertCondition(process.versions.node === (await readFile(path.join(appRoot, '.node-version'), 'utf8')).trim(), 'Use the pinned Node version.');
  const expectedVersion = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')).version;
  const images = path.join(appRoot, 'docs/images');
  await Promise.all([mkdir(localAppData, { recursive: true }), mkdir(isolatedSourcePath, { recursive: true }), mkdir(images, { recursive: true })]);
  let runtime;
  let session;
  try {
    runtime = await stagePortablePackage();
    await bootstrapCatalog(runtime, {});
    await seedCatalog(runtime);
    await stageProjectFixtures();
    await Promise.all(collageExamples.filter(item => item.sourceFileName).map(item => (
      copyFile(path.join(fixturePath, item.sourceFileName), path.join(isolatedSourcePath, item.fileName))
    )));
    session = await openSession(runtime, 'documentation');
    const { client } = session;
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitForValue(client, 'window.photoMap?.getLibrary().then(r => r.ok ? r.value.photos.length : 0)', count => count === collageExamples.length, 120_000);
    await evaluate(client, `(async () => {
      const unwrap = r => { if (!r.ok) throw new Error(r.error.userMessage); return r.value; };
      const library = unwrap(await window.photoMap.getLibrary());
      const tags = new Map();
      for (const item of ${JSON.stringify(collageExamples)}) {
        const photo = library.photos.find(photo => photo.fileName === item.fileName);
        if (!photo) throw new Error('Demo photo missing');
        if (!tags.has(item.tag)) tags.set(item.tag, unwrap(await window.photoMap.createType({ name: item.tag })).typeId);
        unwrap(await window.photoMap.updateLocations({ photoIds: [photo.photoId], location: { provinceGb: item.provinceGb, ...(item.cityGb ? { cityGb: item.cityGb } : {}) } }));
        unwrap(await window.photoMap.updateTypes({ photoIds: [photo.photoId], addTypeIds: [tags.get(item.tag)], removeTypeIds: [] }));
        unwrap(await window.photoMap.updateNote({ photoId: photo.photoId, note: item.note }));
        unwrap(await window.photoMap.updateCaptureTime({ photoId: photo.photoId, localDateTime: item.localDateTime }));
        unwrap(await window.photoMap.renamePhoto({ photoId: photo.photoId, newFileName: item.displayName }));
      }
      const settings = unwrap(await window.photoMap.getSettings());
      unwrap(await window.photoMap.updateSettings({
        ...settings,
        map: { ...settings.map, density: ${collageDensity}, camera: ${JSON.stringify(documentationCamera)} },
      }));
    })()`);
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__documentationPaintedPhotos = new Set();
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.dataset.testid === 'wall-canvas'
          && args[0]?.src?.startsWith('photomap-media://photo/')) {
          window.__documentationPaintedPhotos.add(args[0].src);
        }
        return Reflect.apply(drawImage, this, args);
      };
    })()` });
    await client.send('Page.reload');
    await waitForValue(client, 'Boolean(document.querySelector("[data-testid=wall-canvas]"))', Boolean);
    await waitForValue(client, 'window.__documentationPaintedPhotos.size', count => count === collageExamples.length, 120_000);
    await delay(2200);
    const capture = async (name) => {
      const actualVersion = await evaluate(client, 'window.photoMap.getAppInfo().then(result => result.ok ? result.value.version : null)');
      assertCondition(actualVersion === expectedVersion, `Screenshot package version ${actualVersion} differs from source ${expectedVersion}.`);
      await waitForValue(client, `document.body.innerText.includes(${JSON.stringify('版本 ')} + ${JSON.stringify(expectedVersion)})`, Boolean);
      await delay(700);
      await copyFile(await screenshot(client, name), path.join(images, name));
    };
    await capture('photo-wall.png');
    if (photoWallOnly) {
      assertCondition(rendererErrorEvents(client).length === 0, 'Documentation session emitted renderer errors.');
      await writeFile(path.join(resultRoot, 'documentation.json'), JSON.stringify({ applicationVersion: expectedVersion, synthetic: true, viewport: { width: 1600, height: 1000 }, camera: documentationCamera, density: collageDensity, examples: collageExamples, paintedPhotoCount: collageExamples.length, output: 'docs/images/photo-wall.png' }, null, 2) + '\n');
      console.log(`Documentation photo wall captured in ${images}`);
      return;
    }
    assertCondition(await evaluate(client, clickButtonExpression('批注模式')), 'Annotation button missing.');
    await waitForValue(client, `(() => { const img = document.querySelector('[data-testid="postcard-current"] img'); return img?.complete && img.naturalWidth > 0; })()`, Boolean);
    await capture('postcard.png');
    assertCondition(await evaluate(client, setAnnotationBatchModeExpression(true)), 'Batch button missing.');
    await waitForValue(client, 'document.querySelectorAll(".photo-card").length', count => count === collageExamples.length);
    await waitForValue(client, '[...document.querySelectorAll(".photo-card img")].every(img => img.complete && img.naturalWidth > 0)', Boolean);
    assertCondition(await evaluate(client, clickButtonExpression('全选当前结果')), 'Batch select-all button missing.');
    await waitForValue(client, 'document.querySelectorAll(".photo-card-selection[aria-pressed=true]").length', count => count === collageExamples.length);
    await capture('batch.png');
    assertCondition(await evaluate(client, clickButtonExpression('照片墙模式')), 'Wall button missing.');
    await waitForValue(client, 'Boolean(document.querySelector("[data-testid=wall-canvas]"))', Boolean);
    assertCondition(await evaluate(client, clickButtonExpression('导出分享图')), 'Export button missing.');
    await waitForValue(client, 'Boolean(document.querySelector("[data-testid=export-dialog]"))', Boolean);
    await delay(1500);
    await capture('export.png');
    assertCondition(rendererErrorEvents(client).length === 0, 'Documentation session emitted renderer errors.');
    await writeFile(path.join(resultRoot, 'documentation.json'), JSON.stringify({ applicationVersion: expectedVersion, synthetic: true, viewport: { width: 1600, height: 1000 }, camera: documentationCamera, density: collageDensity, examples: collageExamples, paintedPhotoCount: collageExamples.length, output: 'docs/images' }, null, 2) + '\n');
    console.log(`Documentation screenshots captured in ${images}`);
  } finally {
    if (session) await shutdownSession(session);
    if (runtime) { await closeTrackedApplications(runtime); await removeTemporaryPackage(runtime); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
