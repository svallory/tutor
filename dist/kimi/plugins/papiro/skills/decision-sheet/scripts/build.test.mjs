import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LONG_LABEL, main, normalize, render, slug, TEMPLATE_PATH } from './build.mjs';

const SCRIPT = new URL('./build.mjs', import.meta.url).pathname;
const SAMPLE = new URL('../examples/sample.json', import.meta.url).pathname;
const template = readFileSync(TEMPLATE_PATH, 'utf8');

const choice = (over = {}) => ({ id: 1, title: 'Keep it', options: ['Keep', 'Drop'], suggested: 'Keep', ...over });
const sheet = (questions, over = {}) => ({ title: 'Sheet', questions, ...over });
const errorsOf = (data) => normalize(data).errors;
const warningsOf = (data) => normalize(data).warnings;

/** Pulls the embedded form back out of a built page, the way the page does. */
function embedded(html) {
  const m = html.match(/<script type="application\/json" id="form-data">([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  return JSON.parse(m[1]);
}

function capture() {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

describe('normalize: valid input', () => {
  test('flat questions without groups make one untitled group', () => {
    const { form, errors } = normalize(sheet([choice(), choice({ id: 2 })]));
    expect(errors).toEqual([]);
    expect(form.groups).toHaveLength(1);
    expect(form.groups[0].title).toBe('');
    expect(form.groups[0].questions.map((q) => q.id)).toEqual(['1', '2']);
  });

  test('flat questions are grouped by "group" in order of first appearance', () => {
    const { form } = normalize(sheet([
      choice({ id: 'a', group: 'B' }),
      choice({ id: 'b', group: 'A' }),
      choice({ id: 'c', group: 'B' }),
      choice({ id: 'd' }),
    ]));
    expect(form.groups.map((g) => g.title)).toEqual(['B', 'A', '']);
    expect(form.groups[0].questions.map((q) => q.id)).toEqual(['a', 'c']);
  });

  test('groups keep their title, description and order', () => {
    const { form, errors } = normalize({
      title: 'Sheet',
      groups: [
        { title: 'Keep', description: 'Mine', questions: [choice()] },
        { questions: [choice({ id: 2 })] },
      ],
    });
    expect(errors).toEqual([]);
    expect(form.groups.map((g) => [g.title, g.description])).toEqual([['Keep', 'Mine'], ['', '']]);
  });

  test('top-level options apply to questions that list none', () => {
    const { form, errors } = normalize(sheet([{ id: 1, title: 'x', suggested: 'Drop' }], { options: ['Keep', 'Drop'] }));
    expect(errors).toEqual([]);
    expect(form.groups[0].questions[0].options.map((o) => o.value)).toEqual(['Keep', 'Drop']);
  });

  test('a question\'s own options win over the top-level ones', () => {
    const { form } = normalize(sheet([choice({ options: ['A', 'B', 'C'], suggested: 'C' })], { options: ['Keep', 'Drop'] }));
    expect(form.groups[0].questions[0].options.map((o) => o.value)).toEqual(['A', 'B', 'C']);
  });

  test('string and object options normalize to {value, label, description}', () => {
    const { form } = normalize(sheet([choice({
      options: ['Plain', { value: 'v' }, { value: 'w', label: 'Dub', description: 'why' }],
      suggested: 'w',
    })]));
    expect(form.groups[0].questions[0].options).toEqual([
      { value: 'Plain', label: 'Plain', description: '' },
      { value: 'v', label: 'v', description: '' },
      { value: 'w', label: 'Dub', description: 'why' },
    ]);
  });

  test('numeric ids become strings and every question gets a DOM-safe key', () => {
    const { form } = normalize(sheet([choice({ id: 7 }), choice({ id: 'x y/z' })]));
    const qs = form.groups[0].questions;
    expect(qs.map((q) => q.id)).toEqual(['7', 'x y/z']);
    expect(qs.map((q) => q.key)).toEqual(['q1', 'q2']);
  });

  test('suggested is optional, and missing means "needs you"', () => {
    const { form, errors } = normalize(sheet([choice({ suggested: undefined })]));
    expect(errors).toEqual([]);
    expect(form.groups[0].questions[0].suggested).toBe('');
  });

  test('text questions keep placeholder and prefilled suggestion', () => {
    const { form, errors } = normalize(sheet([{ id: 1, type: 'text', title: 'Fonts', placeholder: 'Names', suggested: 'Inter' }]));
    expect(errors).toEqual([]);
    const q = form.groups[0].questions[0];
    expect([q.type, q.placeholder, q.suggested, q.options]).toEqual(['text', 'Names', 'Inter', []]);
  });

  test('id defaults to a slug of the title; a given id is slugged too', () => {
    expect(normalize(sheet([choice()], { title: '  Zsh Triage! (Mac) ' })).form.id).toBe('zsh-triage-mac');
    expect(normalize(sheet([choice()], { id: 'My Sheet' })).form.id).toBe('my-sheet');
    expect(normalize(sheet([choice()], { title: '🙈' })).form.id).toBe('decisions');
  });

  test('choice questions offer "Something else" unless turned off', () => {
    const qs = (data) => normalize(data).form.groups[0].questions;
    expect(qs(sheet([choice()]))[0].other).toBe(true);
    expect(qs(sheet([choice()], { other: false }))[0].other).toBe(false);
    expect(qs(sheet([choice({ other: true })], { other: false }))[0].other).toBe(true);
    expect(qs(sheet([choice({ other: false })]))[0].other).toBe(false);
    expect(qs(sheet([{ id: 1, type: 'text', title: 'Fonts' }]))[0].other).toBe(false);
  });

  test('version changes with the questions and not otherwise', () => {
    const v = (data) => normalize(data).form.version;
    const base = sheet([choice()]);
    expect(v(base)).toBe(v(sheet([choice()])));
    expect(v(base)).not.toBe(v(sheet([choice({ title: 'Other' })])));
    expect(v(base)).toBe(v({ ...base, intro: 'changed intro' }));
  });
});

describe('normalize: problems', () => {
  test('a non-object root is one clear error', () => {
    for (const bad of [null, [], 'x', 3]) expect(errorsOf(bad)).toEqual([expect.stringContaining('(root): must be an object')]);
  });

  test('missing title and missing questions are both reported', () => {
    expect(errorsOf({})).toEqual(['title: required, a non-empty string', '(root): needs "questions" or "groups"']);
  });

  test('blank title is rejected', () => {
    expect(errorsOf(sheet([choice()], { title: '   ' }))).toContain('title: required, a non-empty string');
  });

  test('groups and questions together are rejected', () => {
    expect(errorsOf({ title: 'S', questions: [choice()], groups: [] })).toContain('(root): use "groups" or "questions", not both');
  });

  test('empty lists are rejected', () => {
    expect(errorsOf(sheet([]))).toContain('questions: must be a non-empty array');
    expect(errorsOf({ title: 'S', groups: [] })).toContain('groups: must be a non-empty array');
    expect(errorsOf({ title: 'S', groups: [{ title: 'G', questions: [] }] })).toContain('groups[0].questions: required, a non-empty array');
  });

  test('duplicate ids name both places, also across groups and number/string', () => {
    const errors = errorsOf({ title: 'S', groups: [{ questions: [choice({ id: 3 })] }, { questions: [choice({ id: '3' })] }] });
    expect(errors).toEqual(['groups[1].questions[0].id: "3" is already used by groups[0].questions[0]']);
  });

  test('missing id and title are reported with their path', () => {
    expect(errorsOf(sheet([{ options: ['A', 'B'] }]))).toEqual([
      'questions[0].id: required, a non-empty string or a number',
      'questions[0].title: required, a non-empty string',
    ]);
  });

  test('a suggestion that is not an option lists the real options', () => {
    expect(errorsOf(sheet([choice({ suggested: 'keep' })]))).toEqual([
      'questions[0].suggested: "keep" is not an option ("Keep", "Drop")',
    ]);
  });

  test('a choice question with no options anywhere is rejected', () => {
    expect(errorsOf(sheet([{ id: 1, title: 'x' }]))).toEqual([
      'questions[0].options: required, unless the top level sets "options"',
    ]);
  });

  test('bad options: too few, duplicates, wrong shapes', () => {
    expect(errorsOf(sheet([choice({ options: ['Only'], suggested: undefined })]))).toContain('questions[0].options: needs at least 2 options');
    expect(errorsOf(sheet([choice({ options: ['A', 'A'], suggested: undefined })]))).toContain('questions[0].options[1]: "A" is listed twice');
    expect(errorsOf(sheet([choice({ options: 'A,B', suggested: undefined })]))[0]).toMatch(/^questions\[0\]\.options: must be an array/);
    const shapes = errorsOf(sheet([choice({ options: ['A', 5, { label: 'x' }, { value: 'v', label: '' }], suggested: undefined })]));
    expect(shapes).toEqual([
      'questions[0].options[1]: must be a non-empty string or a {value, label, description} object',
      'questions[0].options[2].value: required, a non-empty string',
      'questions[0].options[3].label: must be a non-empty string',
    ]);
  });

  test('"other" must be a boolean, only on choice questions, and its value is reserved', () => {
    expect(errorsOf(sheet([choice()], { other: 'yes' }))).toEqual(['other: must be true or false']);
    expect(errorsOf(sheet([choice({ other: 1 })]))).toEqual(['questions[0].other: must be true or false']);
    expect(errorsOf(sheet([{ id: 1, type: 'text', title: 'x', other: true }]))).toEqual([
      'questions[0].other: only choice questions have a "Something else" option',
    ]);
    expect(errorsOf(sheet([choice({ options: ['Keep', '__other__'] })]))).toEqual([
      'questions[0].options[1].value: "__other__" is reserved for the "Something else" option',
    ]);
    expect(errorsOf(sheet([choice({ options: ['Keep', { value: '__other__', label: 'Else' }] })]))).toEqual([
      'questions[0].options[1].value: "__other__" is reserved for the "Something else" option',
    ]);
  });

  test('broken top-level options are reported once, at the top', () => {
    expect(errorsOf(sheet([{ id: 1, title: 'x' }], { options: ['Only'] }))).toEqual(['options: needs at least 2 options']);
  });

  test('text questions reject options; choice questions reject placeholder', () => {
    expect(errorsOf(sheet([{ id: 1, type: 'text', title: 'x', options: ['A', 'B'] }]))[0]).toMatch(/text questions have no options/);
    expect(errorsOf(sheet([choice({ placeholder: 'p' })]))).toEqual(['questions[0].placeholder: only text questions have a placeholder']);
  });

  test('unknown type is rejected', () => {
    expect(errorsOf(sheet([choice({ type: 'multi' })]))).toContain('questions[0].type: must be "choice" or "text"');
  });

  test('wrong field types are reported', () => {
    const errors = errorsOf({
      title: 'S',
      intro: 3,
      id: '',
      groups: [{ title: 1, description: false, questions: [choice({ detail: 2, suggested: 1 }), 'nope'] }],
    });
    expect(errors).toEqual([
      'id: must be a non-empty string',
      'intro: must be a string',
      'groups[0].title: must be a string',
      'groups[0].description: must be a string',
      'groups[0].questions[0].detail: must be a string',
      'groups[0].questions[0].suggested: must be a string, the value of one option',
      'groups[0].questions[1]: must be an object',
    ]);
  });

  test('every problem is reported in one run', () => {
    const errors = errorsOf(sheet([choice({ suggested: 'x' }), choice({ title: '' }), choice({ id: 2, type: 'grid' })]));
    expect(errors).toHaveLength(4);
  });
});

describe('normalize: warnings', () => {
  const long = 'x'.repeat(LONG_LABEL + 1);

  test('short labels, and labels at the limit, warn about nothing', () => {
    const atLimit = 'y'.repeat(LONG_LABEL);
    expect(warningsOf(sheet([choice({ options: ['Keep', atLimit] })]))).toEqual([]);
    expect(warningsOf(sheet([choice({ options: [{ value: 'a', label: 'Short', description: 'z'.repeat(400) }, 'B'], suggested: 'a' })]))).toEqual([]);
  });

  test('a long string option warns at its own path', () => {
    expect(warningsOf(sheet([choice({ options: ['Keep', long] })]))).toEqual([
      `questions[0].options[1]: ${LONG_LABEL + 1} characters; keep labels to a few words and put the rest in "description"`,
    ]);
  });

  test('a long object label warns at .label, and a long value with a short label does not', () => {
    const options = [{ value: 'a', label: long }, { value: long, label: 'Short' }];
    expect(warningsOf(sheet([choice({ options, suggested: 'a' })]))).toEqual([
      expect.stringMatching(/^questions\[0\]\.options\[0\]\.label: /),
    ]);
  });

  test('code and bold markers do not count toward the length', () => {
    const marked = `\`${'c'.repeat(LONG_LABEL - 2)}\` **b**`;
    expect(warningsOf(sheet([choice({ options: ['Keep', marked] })]))).toEqual([]);
  });

  test('top-level options warn once, not once per question', () => {
    const data = sheet([{ id: 1, title: 'a' }, { id: 2, title: 'b' }], { options: ['Keep', long] });
    expect(warningsOf(data)).toEqual([expect.stringMatching(/^options\[1\]: /)]);
  });

  test('warnings never block the build, and come back with errors too', () => {
    const ok = normalize(sheet([choice({ options: ['Keep', long] })]));
    expect(ok.errors).toEqual([]);
    expect(ok.form).not.toBeNull();
    const bad = normalize(sheet([choice({ options: ['Keep', long], suggested: 'nope' })]));
    expect(bad.form).toBeNull();
    expect(bad.warnings).toHaveLength(1);
    expect(normalize(null).warnings).toEqual([]);
  });
});

describe('render', () => {
  const build = (data) => render(normalize(data).form, template);

  test('fills both placeholders and the data round-trips', () => {
    const data = sheet([choice()]);
    const html = build(data);
    expect(html).not.toContain('__TITLE__');
    expect(html).not.toContain('__FORM_DATA__');
    expect(html.startsWith('<title>Sheet</title>')).toBe(true);
    expect(embedded(html)).toEqual(normalize(data).form);
  });

  test('a </script> in the data cannot close the script tag', () => {
    const data = sheet([choice({ title: 'x </script><script>alert(1)</script>', detail: '<!-- <b>' })]);
    const html = build(data);
    expect(html.match(/<\/script>/g)).toHaveLength(template.match(/<\/script>/g).length);
    expect(embedded(html).groups[0].questions[0].title).toBe('x </script><script>alert(1)</script>');
  });

  test('the title is escaped in <title>', () => {
    expect(build(sheet([choice()], { title: 'A & B <i>"x"</i>' }))).toContain('<title>A &amp; B &lt;i&gt;&quot;x&quot;&lt;/i&gt;</title>');
  });

  test('$-patterns in the data stay literal', () => {
    const data = sheet([choice({ title: "costs $& and $' and $` and $1", options: ['$$', '$<x>'], suggested: '$$' })], { title: 'Pay $&' });
    const html = build(data);
    expect(html).toContain('<title>Pay $&amp;</title>');
    expect(embedded(html).groups[0].questions[0].title).toBe("costs $& and $' and $` and $1");
    expect(embedded(html).groups[0].questions[0].options[0].value).toBe('$$');
  });

  test('emoji and line separators survive', () => {
    const data = sheet([choice({ title: 'push-🙈', detail: 'a\u2028b\u2029c' })]);
    const html = build(data);
    expect(html).not.toMatch(/[\u2028\u2029]/);
    expect(embedded(html).groups[0].questions[0]).toMatchObject({ title: 'push-🙈', detail: 'a\u2028b\u2029c' });
  });

  test('a template without its placeholders is refused', () => {
    const form = normalize(sheet([choice()])).form;
    expect(() => render(form, '<title>x</title>')).toThrow(/__TITLE__/);
    expect(() => render(form, '__TITLE__ __FORM_DATA__ __FORM_DATA__')).toThrow(/__FORM_DATA__/);
  });
});

describe('slug', () => {
  test('accents fold, symbols become dashes', () => {
    expect(slug('Configuração do Mac')).toBe('configuracao-do-mac');
    expect(slug('--a--b--')).toBe('a-b');
  });
});

describe('main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-sheet-'));
  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  test('writes next to the input by default and reports the counts', () => {
    const input = write('sheet.json', JSON.stringify(sheet([choice(), choice({ id: 2, suggested: undefined })])));
    const c = capture();
    expect(main([input], c.io)).toBe(0);
    expect(existsSync(join(dir, 'sheet.html'))).toBe(true);
    expect(c.out).toEqual([`Wrote ${join(dir, 'sheet.html')}: 2 questions, 1 without a suggestion.`]);
  });

  test('writes to an explicit output path', () => {
    const input = write('a.json', JSON.stringify(sheet([choice()])));
    const output = join(dir, 'custom.html');
    const c = capture();
    expect(main([input, output], c.io)).toBe(0);
    expect(c.out).toEqual([`Wrote ${output}: 1 question.`]);
    expect(embedded(readFileSync(output, 'utf8')).title).toBe('Sheet');
  });

  test('invalid JSON and unreadable files exit 1 with a reason', () => {
    const c = capture();
    expect(main([write('bad.json', '{ nope')], c.io)).toBe(1);
    expect(c.err[0]).toMatch(/isn't valid JSON/);
    const d = capture();
    expect(main([join(dir, 'missing.json')], d.io)).toBe(1);
    expect(d.err[0]).toMatch(/^Can't read/);
  });

  test('validation problems exit 1, are all listed, and write nothing', () => {
    const input = write('invalid.json', JSON.stringify({ title: '', questions: [choice({ suggested: 'x' })] }));
    const c = capture();
    expect(main([input], c.io)).toBe(1);
    expect(c.err[0]).toBe(`${input} has 2 problems:`);
    expect(c.err.slice(1)).toHaveLength(2);
    expect(existsSync(join(dir, 'invalid.html'))).toBe(false);
  });

  test('warnings are printed but the page is still written', () => {
    const input = write('long.json', JSON.stringify(sheet([choice({ options: ['Keep', 'x'.repeat(LONG_LABEL + 5)] })])));
    const c = capture();
    expect(main([input], c.io)).toBe(0);
    expect(c.err[0]).toBe(`${input}: 1 warning:`);
    expect(c.err[1]).toMatch(/^  questions\[0\]\.options\[1\]: \d+ characters/);
    expect(existsSync(join(dir, 'long.html'))).toBe(true);
  });

  test('usage: no args and extra args exit 2, --help exits 0', () => {
    for (const args of [[], ['a', 'b', 'c']]) {
      const c = capture();
      expect(main(args, c.io)).toBe(2);
      expect(c.err[0]).toMatch(/^Usage:/);
    }
    const h = capture();
    expect(main(['--help'], h.io)).toBe(0);
    expect(h.out[0]).toMatch(/^Usage:/);
  });

  test('stdin needs an output path', () => {
    const c = capture();
    expect(main(['-'], c.io)).toBe(2);
    expect(c.err[0]).toMatch(/needs an output path/);
  });

  test('runs as a command, reading stdin', () => {
    const output = join(dir, 'piped.html');
    const run = Bun.spawnSync(['bun', SCRIPT, '-', output], { stdin: new TextEncoder().encode(readFileSync(SAMPLE)) });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`Wrote ${output}: 4 questions, 1 without a suggestion.\n`);
    expect(embedded(readFileSync(output, 'utf8')).groups.map((g) => g.title)).toEqual(['Shell', 'Editor']);
  });

  test('runs as a command and exits 1 on problems', () => {
    const run = Bun.spawnSync(['bun', SCRIPT, write('cmd-bad.json', '{"title":"x"}')]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain('(root): needs "questions" or "groups"');
  });
});
