import path from 'node:path';

import { fileURLToPath } from 'node:url';
import mapManifest from '../../../src/shared/map-data-manifest.json' with { type: 'json' };

export const appRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const defaultPortableArtifactName = 'PhotoMap-portable-win32-x64';

export const portableArtifactName = process.env.PHOTOMAP_E2E_PORTABLE_ARTIFACT?.trim()
  || defaultPortableArtifactName;

export const stageRawForgePackage = process.env.PHOTOMAP_E2E_STAGE_RAW_FORGE === '1';

export const rawForgeArtifactName = 'PhotoMap-win32-x64';

export const allowedPortableArtifactNames = new Set([
  defaultPortableArtifactName,
]);

export const portableSourcePath = path.join(
  appRoot,
  'out',
  stageRawForgePackage ? rawForgeArtifactName : portableArtifactName,
);

export const portableMarkerName = 'photomap.portable';

export const portableDataDirectoryName = 'PhotoMapData';

export const temporaryDirectoryPrefix = 'photomap-packaged-e2e-';

export const temporaryOwnerFileName = '.photomap-e2e-owner';

export const fixturePath = path.resolve(process.env.PHOTOMAP_E2E_PHOTO_FIXTURES?.trim() || path.join(appRoot, 'tests/fixtures/photos'));

export const mapDataFixturePath = process.env.PHOTOMAP_E2E_MAP_DATA_FIXTURES?.trim() ? path.resolve(process.env.PHOTOMAP_E2E_MAP_DATA_FIXTURES) : undefined;

export const mapDataContracts = Object.freeze(Object.fromEntries(mapManifest.files.map(entry => [entry.kind, Object.freeze({ ...entry, fileName: entry.canonicalFileName, sha256: entry.sha256.toUpperCase() })])));

export const runId = new Date().toISOString().replace(/[-:.]/g, '');

export const resultRoot = path.join(appRoot, 'test-results', `packaged-e2e-${runId}`);

export const localAppData = path.join(resultRoot, 'localappdata-sentinel');

export const isolatedSourcePath = path.join(resultRoot, 'scan-source');

export const runtimeEvidenceRoot = path.join(resultRoot, 'runtime-evidence');

export const UI_OBSERVER_SOURCE = `(() => {
  if (window.__photoMapE2EUiObservation) return;
  const observation = {
    counts: [],
    sawZero: false,
    sawSeven: false,
    maxVisibleWhileScanning: 0,
    maxScanProcessed: 0,
    sawScanProgress: false
  };
  Object.defineProperty(window, '__photoMapE2EUiObservation', {
    value: observation,
    configurable: false,
    enumerable: false,
    writable: false
  });
  const integerFromText = (text) => {
    const match = String(text ?? '').replaceAll(',', '').match(/\\d+/);
    return match ? Number(match[0]) : null;
  };
  const sample = () => {
    const count = integerFromText(document.querySelector('[data-testid="library-photo-count"]')?.textContent);
    const scanProgress = document.querySelector('[data-testid="scan-progress"]');
    if (Number.isInteger(count)) {
      if (!observation.counts.includes(count)) observation.counts.push(count);
      if (count === 0) observation.sawZero = true;
      if (count === 7) observation.sawSeven = true;
      if (scanProgress) observation.maxVisibleWhileScanning = Math.max(observation.maxVisibleWhileScanning, count);
    }
    if (scanProgress) {
      observation.sawScanProgress = true;
      const processed = integerFromText(scanProgress.querySelector('strong')?.textContent);
      if (Number.isInteger(processed)) observation.maxScanProcessed = Math.max(observation.maxScanProcessed, processed);
    }
  };
  const begin = () => {
    sample();
    new MutationObserver(sample).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['value', 'class']
    });
  };
  if (document.documentElement) begin();
  else document.addEventListener('DOMContentLoaded', begin, { once: true });
})();`;

if (!allowedPortableArtifactNames.has(portableArtifactName)) throw new Error(`Unexpected portable artifact: ${portableArtifactName}`);
