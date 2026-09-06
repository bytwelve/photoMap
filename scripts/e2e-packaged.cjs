'use strict';

const suite = process.argv.includes('--map-data') ? 'map-regression' : 'public-smoke';
import(`../tests/e2e/${suite}.mjs`).then(module => module.main()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
