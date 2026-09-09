import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chooseTracks, readingAssets, tracks } from '../src/api/coursera';
import { retryAfter, validateUrl } from '../src/api/http';
import { parseCourse } from '../src/parsers/course';
import {
  htmlToMarkdown,
  htmlToText,
  normalizeMarkdownCode,
} from '../src/parsers/reading';
import { parseVtt, toSrt } from '../src/parsers/webvtt';
import { slugFromInput } from '../src/shared/errors';
import { lecture, outline, reading, vtt } from './fixtures';

describe('course and resources', () => {
  it('preserves explicit order even when linked arrays are shuffled', () => {
    const course = parseCourse(outline, 'test');
    expect(course.modules.map((m) => m.title)).toEqual(['First', 'Second']);
    expect(course.modules[0].lessons[0].items.map((i) => i.id)).toEqual([
      'v1',
      'locked',
      'quiz',
    ]);
    expect(course.modules[0].lessons[0].items[1].locked).toBe(true);
  });
  it('rejects the real anonymous preview as an incomplete course', () => {
    const raw = JSON.parse(
      readFileSync('tests/fixtures/preview-outline.json', 'utf8'),
    );
    expect(() => parseCourse(raw, 'test')).toThrow(/sign in/i);
  });
  it('selects VTT rather than SRT from the real lecture structure', () => {
    const raw = JSON.parse(
      readFileSync('tests/fixtures/preview-lecture.json', 'utf8'),
    );
    expect(tracks(raw)).toHaveLength(1);
    expect(tracks(raw)[0].url).toContain('fileExtension=vtt');
    expect(tracks(lecture)).toHaveLength(1);
  });
  it('distinguishes no subtitles from unknown schemas', () => {
    expect(tracks({ elements: [{ subtitlesVtt: {} }] })).toEqual([]);
    expect(() => tracks({ elements: [{}] })).toThrow(/unrecognized/i);
  });
  it('supports language fallback and all-language mode', () => {
    const all = [
      ...tracks(lecture),
      { language: 'fr', url: '/fr.vtt', key: 'fr:0' },
    ];
    expect(chooseTracks(all, 'zh-CN', false)[0].language).toBe('en');
    expect(chooseTracks(all, 'en', true)).toHaveLength(2);
  });
  it('recognizes reading assets and reports unsupported siblings', () => {
    expect(readingAssets(reading).assets[0].format).toBe('html');
    expect(
      readingAssets({
        elements: [{}],
        linked: { 'openCourseAssets.v1': [{ id: 'pdf', typeName: 'pdf' }] },
      }).unsupported,
    ).toBe(1);
  });
});
describe('text parsing', () => {
  it('parses VTT and outputs standard SRT', () => {
    const { cues } = parseVtt(vtt);
    expect(cues[0].startMs).toBe(1000);
    expect(toSrt(cues)).toContain('00:00:01,000 --> 00:00:02,500');
  });
  it('handles BOM, IDs, comments, settings, entities, speakers, and repeated speech', () => {
    const raw =
      '\uFEFFWEBVTT\r\n\r\nNOTE comment\r\nignore\r\n\r\ncue-1\r\n01:02:03.456 --> 01:02:04.000 align:start\r\n<v Alice>Hello &amp; <i>world</i>\r\nsecond line\r\n\r\n01:02:04.000 --> 01:02:05.000\r\nHello &amp; world\r\n';
    const { cues } = parseVtt(raw);
    expect(cues).toHaveLength(2);
    expect(cues[0].speaker).toBe('Alice');
    expect(cues[0].text).toBe('Hello & world\nsecond line');
    expect(cues[0].startMs).toBe(3723456);
  });
  it('reports malformed cues instead of silently returning empty success', () => {
    expect(() => parseVtt('WEBVTT\n\nbad block')).toThrow();
    expect(parseVtt('WEBVTT\n\n').cues).toEqual([]);
    expect(() => parseVtt('<html>login</html>')).toThrow();
  });
  it('preserves structure and excludes executable HTML and links', () => {
    const html =
      '<h2>Title</h2><p>A &amp; B <a href="/learn/demo">course</a><a href="javascript:alert(1)">bad</a></p><script>evil()</script><pre>if (a &lt; b) {\n  run();\n}</pre>';
    const md = htmlToMarkdown(html, 'https://www.coursera.org/learn/test');
    expect(md).toContain('## Title');
    expect(md).toContain('https://www.coursera.org/learn/demo');
    expect(md).toContain('if (a < b)');
    expect(md).not.toContain('javascript:');
    expect(md).not.toContain('evil()');
    expect(htmlToText(html)).toContain('A & B');
  });
});
describe('request boundaries', () => {
  it('parses Retry-After and validates origins and course paths', () => {
    expect(retryAfter('10', 100)).toBe(10100);
    expect(retryAfter('Wed, 09 Sep 2026 12:00:00 GMT')).toBe(
      Date.parse('2026-09-09T12:00:00Z'),
    );
    expect(() => validateUrl('https://evil.test/file.vtt')).toThrow();
    expect(() =>
      validateUrl('https://www.coursera.org.evil.test/file'),
    ).toThrow();
    expect(
      slugFromInput('https://www.coursera.org/learn/test/home/module/1'),
    ).toBe('test');
    expect(() => slugFromInput('https://evil.test/learn/test')).toThrow();
  });
});

it('preserves ordered lists and emits Markdown table separators', () => {
  const md = htmlToMarkdown(
    '<ol start="3"><li>Three</li><li>Four</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    'https://www.coursera.org',
  );
  expect(md).toContain('3. Three\n4. Four');
  expect(md).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |');
});
it('parses supported CML and rejects unrecognized semantic elements', () => {
  const make = (value: string) => ({
    elements: [{}],
    linked: {
      'openCourseAssets.v1': [
        { id: 'cml', typeName: 'cml', definition: { value } },
      ],
    },
  });
  const result = readingAssets(
    make(
      '<co-content><heading level="3">Title</heading><text>Hello</text></co-content>',
    ),
  );
  expect(result.assets[0].content).toContain('<h3>Title</h3>');
  expect(() =>
    readingAssets(
      make(
        '<co-content><unknown-resource>lost</unknown-resource></co-content>',
      ),
    ),
  ).toThrow(/unsupported/i);
});
it('normalizes multiline single-backtick code to fenced blocks', () => {
  const source =
    '`resources = [socketA, socketB]\nwhile (!resources.isEmpty()) {\n  consumeData(data)\n}`';
  expect(normalizeMarkdownCode(source)).toBe(
    '\n\n```\nresources = [socketA, socketB]\nwhile (!resources.isEmpty()) {\n  consumeData(data)\n}\n```\n\n',
  );
});
