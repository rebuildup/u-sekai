import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Exercise the transitive PostCSS installation used by the declared Vite dependency.
const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve('vite'))('postcss') as typeof import('postcss');
const flatMap = {
  version: 3,
  sources: ['input.css'],
  sourcesContent: ['a{}'],
  names: [],
  mappings: 'AAAA',
};

function indexedMap(line: number, column = 0, map: object = flatMap) {
  return { version: 3, sections: [{ offset: { line, column }, map }] };
}

function inputWithMap(map: object) {
  return new postcss.Input('a{}', {
    from: 'output.css',
    map: { prev: JSON.stringify(map) },
  });
}

describe('PostCSS source-map security (CVE-2026-93749)', () => {
  // Only construct the consumer: converting an unpatched malicious map could hang.
  it.each([
    { name: 'oversized line', map: indexedMap(10_000_001) },
    { name: 'negative line', map: indexedMap(-1) },
    { name: 'fractional line', map: indexedMap(0.5) },
    { name: 'negative column', map: indexedMap(0, -1) },
    { name: 'oversized cumulative line', map: indexedMap(6_000_000, 0, indexedMap(6_000_000)) },
  ])('rejects $name offsets before source-map conversion', ({ map }) => {
    expect(() => inputWithMap(map)).toThrow(/Section offset/);
  });

  it('preserves ordinary flat source-map positions', () => {
    expect(inputWithMap(flatMap).map.consumer().originalPositionFor({ line: 1, column: 0 }))
      .toMatchObject({ source: 'input.css', line: 1, column: 0 });
  });

  it('preserves ordinary indexed source-map positions', () => {
    const positions: number[] = [];
    inputWithMap(indexedMap(1)).map.consumer().eachMapping((mapping) => {
      positions.push(mapping.generatedLine);
    });
    expect(positions).toEqual([2]);
  });
});
