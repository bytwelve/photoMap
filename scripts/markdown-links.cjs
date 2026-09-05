'use strict';

const blank = (value) => value.replace(/[^\r\n]/g, ' ');
const normalizeLabel = (label) => label.replace(/\\([[\]\\])/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase();

// Keep character offsets intact so callers can also rewrite links for packaged docs.
function withoutFencedCode(source) {
  let fence;
  return source.replace(/[^\n]*(?:\n|$)/g, (line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && match) { fence = match[1]; return blank(line); }
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && line.slice(match[0].length).trim() === '') fence = undefined;
      return blank(line);
    }
    return line;
  }).replace(/<!--[\s\S]*?-->/g, blank);
}

function parseMarkdownLinks(source) {
  let searchable = withoutFencedCode(source).replace(/(`+)([\s\S]*?)\1(?!`)/g, blank);
  const definitions = [];
  const byLabel = new Map();
  searchable = searchable.replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]+>|[^\s]+)(?:[^\n]*)$/gm, (raw, label, target, start) => {
    const definition = { start, end: start + raw.length, label, url: target.replace(/^<|>$/g, '') };
    definitions.push(definition);
    if (!byLabel.has(normalizeLabel(label))) byLabel.set(normalizeLabel(label), definition);
    return blank(raw);
  });
  const links = [];
  const bracket = /(!?)\[([^\]\n]*(?:\\\][^\]\n]*)*)\]/g;
  for (let match; (match = bracket.exec(searchable));) {
    const start = match.index;
    if (start > 0 && searchable[start - 1] === '\\') continue;
    const image = match[1] === '!';
    const label = source.slice(start + (image ? 2 : 1), bracket.lastIndex - 1);
    let end = bracket.lastIndex;
    let url;
    if (searchable[end] === '(') {
      const destination = searchable.slice(end).match(/^\(\s*(?:<([^>\n]*)>|((?:[^\s()\\]|\\.|\([^()]*\))*))(?:\s+["'][^\n]*?["'])?\s*\)/);
      if (!destination) continue;
      url = (destination[1] ?? destination[2]).replace(/\\([\\() ])/g, '$1');
      end += destination[0].length;
    } else {
      const reference = searchable.slice(end).match(/^[ \t]*(?:\r?\n[ \t]*)?\[([^\]\n]*)\]/);
      const definition = byLabel.get(normalizeLabel(reference?.[1] || label));
      if (!definition) continue; // Undefined shortcut text is ordinary Markdown, not a link.
      url = definition.url;
      if (reference) end += reference[0].length;
    }
    links.push({ start, end, label, image, url });
    bracket.lastIndex = end;
  }
  for (const match of searchable.matchAll(/<(?:a|img|source)\b[^>]*?\b(href|src)\s*=\s*(["'])(.*?)\2[^>]*>/gi)) {
    links.push({ start: match.index, end: match.index + match[0].length, label: match[0], image: match[1].toLowerCase() === 'src', url: match[3], html: true });
  }
  return { links, definitions };
}

module.exports = { parseMarkdownLinks, withoutFencedCode };
