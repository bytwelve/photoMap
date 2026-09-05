'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseMarkdownLinks, withoutFencedCode } = require('./markdown-links.cjs');
const manifest = require('./build/input-manifest.json');

function collectMarkdownFiles(root) {
  const excluded = new Set(manifest.excludedDirectoryNames.map((name) => name.toLowerCase()));
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      // Do not follow links into local data, dependencies or another checkout.
      if (entry.isDirectory() && !excluded.has(entry.name.toLowerCase())) collect(relative);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(relative);
    }
  }
  collect('');
  return files.sort();
}

function createAnchorReader() {
  const cache = new Map();
  return function anchors(file) {
    if (cache.has(file)) return cache.get(file);
    const result = new Set();
    const source = withoutFencedCode(fs.readFileSync(file, 'utf8'));
    const headings = [...source.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => ({ index: match.index, text: match[1] }));
    for (const match of source.matchAll(/^([^\n]+)\r?\n {0,3}(?:=+|-+)\s*$/gm)) {
      headings.push({ index: match.index, text: match[1] });
    }
    headings.sort((left, right) => left.index - right.index);
    for (const heading of headings) {
      const base = heading.text.replace(/<[^>]*>/g, '').replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
      let slug = base;
      for (let suffix = 1; result.has(slug); suffix += 1) slug = `${base}-${suffix}`;
      result.add(slug);
    }
    for (const match of source.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
    cache.set(file, result);
    return result;
  };
}

function gitAvailable(root) {
  // A source ZIP nested in someone else's checkout must not borrow its refs.
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  return spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

function checkDocuments(root, files = collectMarkdownFiles(root)) {
  root = path.resolve(root);
  const excluded = new Set(manifest.excludedDirectoryNames.map(name => name.toLowerCase()));
  const anchors = createAnchorReader();
  const hasGit = gitAvailable(root);
  const failures = [];
  let checked = 0;
  let checkedRefs = 0;
  let skippedRefs = 0;
  const verifyRef = (ref) => {
    if (!ref || ref.startsWith('-')) throw new Error('invalid Git reference');
    const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Git reference does not exist: ${ref}`);
  };
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const { links, definitions } = parseMarkdownLinks(source);
    for (const link of [...links, ...definitions]) {
      const url = link.url;
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(url)) continue;
      try {
        // GitHub repository-relative release/compare URLs are not filesystem paths.
        const route = url.match(/^\.\.\/\.\.\/(compare|releases\/tag)\/([^?#]+)(?:[?#].*)?$/);
        if (route) {
          const refs = route[1] === 'compare' ? decodeURIComponent(route[2]).split(/\.{2,3}/) : [decodeURIComponent(route[2])];
          if (route[1] === 'compare' && refs.length !== 2) throw new Error('invalid GitHub comparison URL');
          if (hasGit) {
            refs.forEach(verifyRef);
            checkedRefs += 1;
          } else skippedRefs += 1;
          continue;
        }
        checked += 1;
        const hash = url.indexOf('#');
        const pathname = (hash < 0 ? url : url.slice(0, hash)).split('?', 1)[0];
        const fragment = hash < 0 ? '' : url.slice(hash + 1);
        const target = pathname ? path.resolve(root, path.dirname(file), decodeURIComponent(pathname)) : path.join(root, file);
        const relative = path.relative(root, target);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
          throw new Error('target is outside the repository');
        }
        if (relative.split(path.sep).some(part => excluded.has(part.toLowerCase()))) {
          throw new Error('target is local-only or generated content');
        }
        if (!fs.existsSync(target)) throw new Error('target does not exist');
        if (fragment && /\.md$/i.test(target) && !anchors(target).has(decodeURIComponent(fragment))) {
          throw new Error('heading anchor does not exist');
        }
      } catch (error) {
        failures.push(`${file}: ${url}: ${error.message}`);
      }
    }
  }
  return { checked, checkedRefs, skippedRefs, files: files.length, failures };
}

module.exports = { checkDocuments, collectMarkdownFiles };
if (require.main === module) {
  const result = checkDocuments(path.resolve(__dirname, '..'));
  if (result.failures.length) {
    console.error(result.failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Verified ${result.checked} local document links and images in ${result.files} Markdown files; ${result.checkedRefs} GitHub ref links verified.`);
    if (result.skippedRefs) console.log(`Skipped ${result.skippedRefs} GitHub ref links: this source directory has no usable Git metadata.`);
  }
}
