'use strict';

const { createHash } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(APP_ROOT, 'src', 'shared', 'administrative-regions.data.json');
const manifest = require('../src/shared/map-data-manifest.json');
const SOURCE_PAGE_URL = manifest.sourceUrl;
const EXCLUDED_FEATURE_NAME = '境界线';
const ORDERING = 'province-code-ascending-then-city-code-ascending';
const SOURCE_CONTRACTS = Object.freeze(manifest.files.map((entry) => Object.freeze({
  ...entry, level: entry.kind, fileName: entry.canonicalFileName,
})));

function usage() {
  return [
    'Usage:',
    '  node scripts/generate-administrative-regions.cjs --check <province.geojson> <city.geojson>',
    '  node scripts/generate-administrative-regions.cjs --write <province.geojson> <city.geojson>',
  ].join('\n');
}

function parseArguments(arguments_) {
  const [mode, provincePath, cityPath, ...extra] = arguments_;
  if (
    (mode !== '--check' && mode !== '--write') ||
    typeof provincePath !== 'string' ||
    typeof cityPath !== 'string' ||
    extra.length > 0
  ) {
    throw new Error(usage());
  }
  return { mode, sourcePaths: [provincePath, cityPath] };
}

async function readVerifiedSource(inputPath, contract) {
  const bytes = await readFile(path.resolve(inputPath));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== contract.byteLength || sha256 !== contract.sha256) {
    throw new Error(
      `${contract.fileName} does not match the supported byte contract ` +
      `(expected ${contract.byteLength} bytes / ${contract.sha256}, ` +
      `received ${bytes.byteLength} bytes / ${sha256}).`,
    );
  }

  let geoJson;
  try {
    geoJson = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${contract.fileName} is not valid UTF-8 JSON.`, { cause: error });
  }
  if (geoJson?.type !== 'FeatureCollection' || !Array.isArray(geoJson.features)) {
    throw new Error(`${contract.fileName} is not a GeoJSON FeatureCollection.`);
  }

  const codes = new Set();
  const regions = [];
  for (const feature of geoJson.features) {
    const properties = feature?.properties;
    const name = typeof properties?.name === 'string' ? properties.name.trim() : '';
    if (name === EXCLUDED_FEATURE_NAME) continue;

    const code = properties?.gb === undefined || properties?.gb === null
      ? ''
      : String(properties.gb).trim();
    if (feature?.type !== 'Feature' || name.length === 0 || !/^156\d{6}$/u.test(code)) {
      throw new Error(`${contract.fileName} contains an invalid administrative-region feature.`);
    }
    if (codes.has(code)) {
      throw new Error(`${contract.fileName} contains duplicate administrative code ${code}.`);
    }
    codes.add(code);
    regions.push({ code, name });
  }

  regions.sort((left, right) => (
    left.code < right.code ? -1 : left.code > right.code ? 1 : 0
  ));
  if (regions.length !== contract.regionCount) {
    throw new Error(
      `${contract.fileName} contains ${regions.length} usable regions; ` +
      `${contract.regionCount} are required.`,
    );
  }

  return {
    regions,
    source: {
      level: contract.level,
      fileName: contract.fileName,
      byteLength: bytes.byteLength,
      sha256,
    },
  };
}

function buildDataset(provinceSource, citySource) {
  const provinceCodes = new Set(provinceSource.regions.map((region) => region.code));
  const provinces = provinceSource.regions.map((region) => ({
    level: 'province',
    code: region.code,
    name: region.name,
    parentProvinceCode: null,
  }));
  const cities = citySource.regions.map((region) => {
    const parentProvinceCode = `${region.code.slice(0, 5)}0000`;
    if (!provinceCodes.has(parentProvinceCode)) {
      throw new Error(
        `${citySource.source.fileName} city ${region.code} has no province ${parentProvinceCode}.`,
      );
    }
    return {
      level: 'city',
      code: region.code,
      name: region.name,
      parentProvinceCode,
    };
  });
  const generatedFrom = [provinceSource.source, citySource.source];

  return {
    schemaVersion: 1,
    dataVersion: `geojson-sha256:${generatedFrom.map((source) => source.sha256).join('+')}`,
    provenance: {
      sourcePageUrl: SOURCE_PAGE_URL,
      generatedFrom,
      ordering: ORDERING,
      excludedFeatureName: EXCLUDED_FEATURE_NAME,
    },
    regions: [...provinces, ...cities],
  };
}

async function main() {
  const { mode, sourcePaths } = parseArguments(process.argv.slice(2));
  const [provinceSource, citySource] = await Promise.all(
    SOURCE_CONTRACTS.map((contract, index) => readVerifiedSource(sourcePaths[index], contract)),
  );
  const output = `${JSON.stringify(buildDataset(provinceSource, citySource), null, 2)}\n`;

  if (mode === '--write') {
    await writeFile(OUTPUT_PATH, output, 'utf8');
    console.log(`Wrote ${path.relative(APP_ROOT, OUTPUT_PATH)} from verified GeoJSON inputs.`);
    return;
  }

  const current = await readFile(OUTPUT_PATH, 'utf8');
  if (current !== output) {
    throw new Error(
      `${path.relative(APP_ROOT, OUTPUT_PATH)} is stale; rerun this command with --write.`,
    );
  }
  console.log(`${path.relative(APP_ROOT, OUTPUT_PATH)} matches the verified GeoJSON inputs.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
