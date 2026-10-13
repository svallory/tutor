#!/usr/bin/env node
// Builds a decision sheet page from a JSON file of questions and suggested
// answers. Runs with bun or node, no dependencies.
//
//   bun build.mjs questions.json            writes questions.html next to it
//   bun build.mjs questions.json out.html
//   cat questions.json | bun build.mjs - out.html

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_PATH = fileURLToPath(new URL('../assets/template.html', import.meta.url));

const USAGE = `Usage: build.mjs <questions.json | -> [out.html]

Builds the decision sheet page. Without out.html it writes next to the input,
with the extension changed to .html. Reading from stdin (-) needs out.html.
The JSON format is in the skill's SKILL.md.`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** Lowercase, dashes between words: "Zsh triage!" becomes "zsh-triage". */
export function slug(text) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'decisions';
}

/** The value the page gives the "Something else" option. Options can't use it. */
export const OTHER = '__other__';

/**
 * Labels longer than this get a warning. A label is the option's title in the
 * selector; the explanation belongs in its description, which the page shows
 * in a box beside the options.
 */
export const LONG_LABEL = 32;

/** The text a reader sees: no backticks or bold markers. */
const shown = (s) => s.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim();

/** FNV-1a, 32 bits, as hex. Only used to tell versions of a sheet apart. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function normalizeOptions(list, path, err, warn) {
  if (!Array.isArray(list)) {
    err(path, 'must be an array of strings or {value, label, description} objects');
    return null;
  }
  if (list.length < 2) err(path, 'needs at least 2 options');
  const seen = new Set();
  const options = [];
  list.forEach((o, i) => {
    const p = `${path}[${i}]`;
    let option;
    if (isText(o)) option = { value: o, label: o, description: '' };
    else if (isObject(o)) {
      if (!isText(o.value)) return err(`${p}.value`, 'required, a non-empty string');
      if (o.label !== undefined && !isText(o.label)) return err(`${p}.label`, 'must be a non-empty string');
      if (o.description !== undefined && typeof o.description !== 'string') return err(`${p}.description`, 'must be a string');
      option = { value: o.value, label: o.label ?? o.value, description: o.description ?? '' };
    } else return err(p, 'must be a non-empty string or a {value, label, description} object');
    if (option.value === OTHER) return err(`${p}.value`, `"${OTHER}" is reserved for the "Something else" option`);
    if (seen.has(option.value)) return err(p, `"${option.value}" is listed twice`);
    seen.add(option.value);
    const length = shown(option.label).length;
    if (length > LONG_LABEL) {
      warn(`${p}${isObject(o) ? '.label' : ''}`, `${length} characters; keep labels to a few words and put the rest in "description"`);
    }
    options.push(option);
  });
  return options;
}

/**
 * Related resources: file paths relative to the repo root, or web links. A
 * string is a link when it starts with http:// or https://, a path otherwise.
 * Objects carry an optional label and note.
 */
function normalizeResources(list, path, err) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    err(path, 'must be an array of paths, links or {path | url, label, note} objects');
    return [];
  }
  const out = [];
  list.forEach((r, i) => {
    const p = `${path}[${i}]`;
    let item;
    if (isText(r)) {
      const target = r.trim();
      item = { kind: /^https?:\/\//i.test(target) ? 'url' : 'path', target, label: '', note: '' };
    } else if (isObject(r)) {
      if (isText(r.path) === isText(r.url)) return err(p, 'needs exactly one of "path" (relative to the repo root) or "url"');
      if (r.label !== undefined && typeof r.label !== 'string') return err(`${p}.label`, 'must be a string');
      if (r.note !== undefined && typeof r.note !== 'string') return err(`${p}.note`, 'must be a string');
      item = isText(r.path)
        ? { kind: 'path', target: r.path.trim(), label: r.label ?? '', note: r.note ?? '' }
        : { kind: 'url', target: r.url.trim(), label: r.label ?? '', note: r.note ?? '' };
    } else return err(p, 'must be a string or a {path | url, label, note} object');
    out.push(item);
  });
  return out;
}

/** An optional block of text: undefined becomes '', anything but a string is an error. */
function optionalText(value, path, err) {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    err(path, 'must be a string');
    return '';
  }
  return value;
}

/**
 * Checks the input and turns it into what the page reads. Returns every
 * problem found, each prefixed with the path to it, instead of stopping at the
 * first one. Warnings point at things that build fine but read badly.
 */
export function normalize(data) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => { errors.push(`${path}: ${message}`); };
  const warn = (path, message) => { warnings.push(`${path}: ${message}`); };

  if (!isObject(data)) return { form: null, errors: ['(root): must be an object with "title" and "questions" or "groups"'], warnings };

  if (!isText(data.title)) err('title', 'required, a non-empty string');
  if (data.id !== undefined && !isText(data.id)) err('id', 'must be a non-empty string');
  if (data.intro !== undefined && typeof data.intro !== 'string') err('intro', 'must be a string');
  const context = optionalText(data.context, 'context', err);
  const resources = normalizeResources(data.resources, 'resources', err);
  const defaultOptions = data.options === undefined ? undefined : normalizeOptions(data.options, 'options', err, warn);
  if (data.other !== undefined && typeof data.other !== 'boolean') err('other', 'must be true or false');
  const defaultOther = typeof data.other === 'boolean' ? data.other : true;

  // Both shapes end up as [{title, description, items: [[question, path]]}].
  const raw = [];
  if (data.groups !== undefined && data.questions !== undefined) {
    err('(root)', 'use "groups" or "questions", not both');
  } else if (data.groups !== undefined) {
    if (!Array.isArray(data.groups) || data.groups.length === 0) err('groups', 'must be a non-empty array');
    else data.groups.forEach((g, i) => {
      const p = `groups[${i}]`;
      if (!isObject(g)) return err(p, 'must be an object with "questions"');
      if (g.title !== undefined && typeof g.title !== 'string') err(`${p}.title`, 'must be a string');
      if (g.description !== undefined && typeof g.description !== 'string') err(`${p}.description`, 'must be a string');
      if (!Array.isArray(g.questions) || g.questions.length === 0) err(`${p}.questions`, 'required, a non-empty array');
      raw.push({
        title: typeof g.title === 'string' ? g.title : '',
        description: typeof g.description === 'string' ? g.description : '',
        context: optionalText(g.context, `${p}.context`, err),
        resources: normalizeResources(g.resources, `${p}.resources`, err),
        items: (Array.isArray(g.questions) ? g.questions : []).map((q, j) => [q, `${p}.questions[${j}]`]),
      });
    });
  } else if (data.questions !== undefined) {
    if (!Array.isArray(data.questions) || data.questions.length === 0) err('questions', 'must be a non-empty array');
    else {
      // Questions may name a "group"; groups keep the order they first appear in.
      const byName = new Map();
      data.questions.forEach((q, i) => {
        const name = isObject(q) && typeof q.group === 'string' ? q.group : '';
        if (!byName.has(name)) {
          const group = { title: name, description: '', context: '', resources: [], items: [] };
          byName.set(name, group);
          raw.push(group);
        }
        byName.get(name).items.push([q, `questions[${i}]`]);
      });
    }
  } else {
    err('(root)', 'needs "questions" or "groups"');
  }

  const seen = new Map();
  let count = 0;
  const question = (q, p) => {
    if (!isObject(q)) return err(p, 'must be an object');
    let id = typeof q.id === 'number' && Number.isFinite(q.id) ? String(q.id) : q.id;
    if (!isText(id)) {
      err(`${p}.id`, 'required, a non-empty string or a number');
      id = '';
    } else if (seen.has(id)) err(`${p}.id`, `"${id}" is already used by ${seen.get(id)}`);
    else seen.set(id, p);
    if (!isText(q.title)) err(`${p}.title`, 'required, a non-empty string');
    // "summary" is the short reason shown with the question; "detail" is its
    // old name and still accepted. "details" is the long, collapsed version.
    if (q.summary !== undefined && q.detail !== undefined) err(`${p}.detail`, 'use "summary" (the short reason) or its old name "detail", not both');
    const summary = q.summary !== undefined
      ? optionalText(q.summary, `${p}.summary`, err)
      : optionalText(q.detail, `${p}.detail`, err);
    if (q.group !== undefined && typeof q.group !== 'string') err(`${p}.group`, 'must be a string');

    const type = q.type ?? 'choice';
    const out = {
      key: `q${++count}`,
      id,
      title: typeof q.title === 'string' ? q.title : '',
      summary,
      details: optionalText(q.details, `${p}.details`, err),
      resources: normalizeResources(q.resources, `${p}.resources`, err),
      type,
      options: [],
      suggested: '',
      placeholder: '',
      other: false,
    };
    if (q.other !== undefined && typeof q.other !== 'boolean') err(`${p}.other`, 'must be true or false');
    if (type === 'text') {
      if (q.other !== undefined) err(`${p}.other`, 'only choice questions have a "Something else" option');
      if (q.options !== undefined) err(`${p}.options`, 'text questions have no options; remove it or use type "choice"');
      if (q.suggested !== undefined && typeof q.suggested !== 'string') err(`${p}.suggested`, 'must be a string');
      else out.suggested = q.suggested ?? '';
      if (q.placeholder !== undefined && typeof q.placeholder !== 'string') err(`${p}.placeholder`, 'must be a string');
      else out.placeholder = q.placeholder ?? '';
    } else if (type === 'choice') {
      if (q.placeholder !== undefined) err(`${p}.placeholder`, 'only text questions have a placeholder');
      out.other = typeof q.other === 'boolean' ? q.other : defaultOther;
      const options = q.options === undefined ? defaultOptions : normalizeOptions(q.options, `${p}.options`, err, warn);
      if (options === undefined) err(`${p}.options`, 'required, unless the top level sets "options"');
      out.options = options ?? [];
      if (q.suggested !== undefined) {
        if (typeof q.suggested !== 'string') err(`${p}.suggested`, 'must be a string, the value of one option');
        else if (options && !options.some((o) => o.value === q.suggested)) {
          err(`${p}.suggested`, `"${q.suggested}" is not an option (${options.map((o) => `"${o.value}"`).join(', ')})`);
        } else out.suggested = q.suggested;
      }
    } else {
      err(`${p}.type`, 'must be "choice" or "text"');
    }
    return out;
  };

  const groups = raw.map((g) => ({
    title: g.title,
    description: g.description,
    context: g.context,
    resources: g.resources,
    questions: g.items.map(([q, p]) => question(q, p)).filter(Boolean),
  }));

  if (errors.length) return { form: null, errors, warnings };
  const title = data.title.trim();
  return {
    form: {
      title,
      id: data.id ? slug(data.id) : slug(title),
      intro: data.intro ?? '',
      context,
      resources,
      version: hash(JSON.stringify(groups)),
      groups,
    },
    errors,
    warnings,
  };
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Fills the template. The JSON is made safe to sit inside a <script> tag. */
export function render(form, template) {
  for (const mark of ['__TITLE__', '__FORM_DATA__']) {
    if (template.split(mark).length !== 2) throw new Error(`template must contain ${mark} exactly once`);
  }
  const json = JSON.stringify(form)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // Replacer functions, so "$&" and friends in the data stay literal.
  return template.replace('__TITLE__', () => escapeHtml(form.title)).replace('__FORM_DATA__', () => json);
}

export function main(argv, io = { out: console.log, err: console.error }) {
  const [input, output, ...extra] = argv;
  if (input === '-h' || input === '--help') {
    io.out(USAGE);
    return 0;
  }
  if (!input || extra.length) {
    io.err(USAGE);
    return 2;
  }
  if (input === '-' && !output) {
    io.err('Reading from stdin (-) needs an output path: build.mjs - out.html');
    return 2;
  }

  let text;
  try {
    text = readFileSync(input === '-' ? 0 : input, 'utf8');
  } catch (e) {
    io.err(`Can't read ${input}: ${e.message}`);
    return 1;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    io.err(`${input} isn't valid JSON: ${e.message}`);
    return 1;
  }

  const { form, errors, warnings } = normalize(data);
  if (warnings.length) {
    io.err(`${input}: ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
    for (const w of warnings) io.err(`  ${w}`);
  }
  if (errors.length) {
    io.err(`${input} has ${errors.length} problem${errors.length === 1 ? '' : 's'}:`);
    for (const e of errors) io.err(`  ${e}`);
    return 1;
  }

  const target = output ?? `${input.replace(/\.json$/i, '')}.html`;
  writeFileSync(target, render(form, readFileSync(TEMPLATE_PATH, 'utf8')));
  const questions = form.groups.flatMap((g) => g.questions);
  const open = questions.filter((q) => !q.suggested).length;
  io.out(`Wrote ${target}: ${questions.length} question${questions.length === 1 ? '' : 's'}${open ? `, ${open} without a suggestion` : ''}.`);
  return 0;
}

const invokedPath = (() => {
  try { return realpathSync(process.argv[1]); } catch { return ''; }
})();
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
