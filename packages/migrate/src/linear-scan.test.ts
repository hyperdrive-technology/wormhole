// wormhole#5: the upgrade rules used to take O(n^2) time on hostile input, and the one
// synchronous upgradeSource call could not be interrupted by the import's wall-time limit.
// Two kinds of test here:
// - differential: the rewritten (linear) rules must report exactly what the old regex rules
//   reported, on many random inputs built from the tokens the rules care about;
// - scaling: quadrupling a hostile input must not take ~16x longer.
import { describe, expect, it } from 'vitest';

import { bcdShimRule as referenceBcd } from './__fixtures__/reference/bcdShimRule.js';
import { deprecatedConstructRule as referenceDeprecated } from './__fixtures__/reference/deprecatedConstructRule.js';
import { ilPreservationRule as referenceIl } from './__fixtures__/reference/ilPreservationRule.js';
import { scanSourceSpans as referenceScanSourceSpans } from './__fixtures__/reference/lexical.js';
import { octalLiteralRule as referenceOctal } from './__fixtures__/reference/octalLiteralRule.js';
import { representedVariableRule as referenceRepresented } from './__fixtures__/reference/representedVariableRule.js';
import { truncTypedRule as referenceTrunc } from './__fixtures__/reference/truncTypedRule.js';
import {
  bcdShimRule,
  deprecatedConstructRule,
  ilPreservationRule,
  octalLiteralRule,
  representedVariableRule,
  scanSourceSpans,
  truncTypedRule,
  upgradeSource,
  type UpgradeOptions,
  type UpgradeRule,
} from './index.js';
import { findCallSites, ForwardIndexOf, ForwardSearch, LastIndexBefore, LineIndex, lineNumberAt } from './scan.js';

/** Small seeded PRNG (mulberry32) so a failing case can be reproduced from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  'PROGRAM ', 'PROGRAM', 'FUNCTION_BLOCK ', 'FUNCTION ', 'function ', 'END_PROGRAM', 'END_FUNCTION', 'END_FUNCTION_BLOCK', 'end_program',
  'VAR', 'VAR\n', 'END_VAR', 'END_VAR\n', 'VAR_GLOBAL', 'var_global', 'VAR_ACCESS', 'xVAR_GLOBAL',
  'LD ', 'LDN ', 'ST ', 'ANDN ', 'JMPC ', 'S ', 'R ', 'LDX',
  'a', 'Foo', 'x1', '_b', 'Main', '1', '9', ' ', '  ', '\n', '\n', '\n', '\r', '\r\n', '\t', '\u2028',
  '(', '(', ')', ')', ',', ', ', ';', ':', ' : ', '.',
  'TRUNC', 'trunc', 'TRUNC(', 'TRUNC( ', 'A_TO_BCD', 'X_BCD_TO_INT', 'is_valid_bcd', 'IS_VALID_BCD', '_BCD_TO_', 'BCD_TO_',
  'AT ', 'AT', ' AT', 'at ', '%IX0.0', '%QW1', '%MD3.2', '%I*', '%IX0.0 : BOOL;', '%ix1', 'BOOL', 'WORD', 'Io_IX0_0', 'Io_', 'IX0_0',
  ' WITH ', 'WITH', 'R_EDGE', 'F_EDGE', 'BOOL R_EDGE',
  '<actionBlock ', '<actionblock', '<actionBlockX', 'referenceName="', 'ReferenceName="', '"', '"', '>', '=',
  '8#17', '8#1_0', '8#', '#',
  '//', '(*', '*)', '/*', '*/', "'", '$', '{', '}',
];

function randomSource(random: () => number, maxTokens: number): string {
  const count = Math.floor(random() * maxTokens);
  let text = '';
  for (let index = 0; index < count; index += 1) text += TOKENS[Math.floor(random() * TOKENS.length)];
  return text;
}

const RULE_PAIRS: Array<[string, UpgradeRule, UpgradeRule]> = [
  ['il-preservation', ilPreservationRule, referenceIl],
  ['trunc-to-typed', truncTypedRule, referenceTrunc],
  ['bcd-shim', bcdShimRule, referenceBcd],
  ['represented-variable-alias', representedVariableRule, referenceRepresented],
  ['octal-literal', octalLiteralRule, referenceOctal],
  ['deprecated-construct-hints', deprecatedConstructRule, referenceDeprecated],
];

describe('linear rules report exactly what the old regex rules reported (wormhole#5)', () => {
  it.each(RULE_PAIRS)('%s on random input', (_, rule, reference) => {
    for (let seed = 1; seed <= 4000; seed += 1) {
      const random = prng(seed);
      const source = randomSource(random, seed % 4 === 0 ? 120 : 40);
      for (const apply of [true, false]) {
        const options: UpgradeOptions = { sourceKind: 'st', fileName: 'r.st', apply };
        const actual = rule.run(source, options);
        const expected = reference.run(source, options);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          // Readable failure with the reproducer.
          expect({ seed, apply, source, result: actual }).toEqual({ seed, apply, source, result: expected });
        }
      }
    }
  });

  it('scanSourceSpans is unchanged on random input', () => {
    for (let seed = 1; seed <= 4000; seed += 1) {
      const source = randomSource(prng(seed), 60);
      expect(scanSourceSpans(source)).toEqual(referenceScanSourceSpans(source));
    }
  });

  it.each([
    ['an unclosed TRUNC before a closed one', 'TRUNC( a TRUNC(b)'],
    ['a TRUNC with only spaces', 'TRUNC(   )'],
    ['nested calls', 'foo(TRUNC(x), A_TO_BCD(y)) bar(p, q)'],
    ['an action indicator after a nested call', 'Act(f(x), Done) Act2(a,\n  b  )'],
    ['an actionBlock whose value contains >', '<actionBlock a="1" referenceName="x>y" b>'],
    ['two actionBlocks before one >', '<actionBlock referenceName="a" <actionBlock referenceName="b">'],
    ['an empty referenceName then a valid one', '<actionBlock referenceName="" referenceName="ok">'],
    ['a name that ends right before END_', 'PROGRAM aEND_PROGRAM\nPROGRAM b\nLD x\nEND_PROGRAM'],
    ['END_ inside a header name', 'FUNCTION_BLOCK fb\nLD a\nEND_FUNCTION_BLOCK END_FUNCTION'],
    ['VAR_GLOBAL without a preceding PROGRAM', 'VAR_GLOBAL PROGRAM P VAR_GLOBAL END_VAR'],
    ['an IL line after a CR', 'PROGRAM p\nx\rLD a\nEND_PROGRAM'],
    ['a declaration identical to an earlier mid-line one', 'PROGRAM p\nVAR\n  AT %IX0.0 : BOOL;\nEND_VAR\nEND_PROGRAM'],
    ['an alias name embedded in a longer identifier', 'VAR\nXIo_IX0_0 AT %IX0.0 : BOOL;\nEND_VAR\nx := %IX0.0;'],
    ['an AT that starts the next identifier', 'VAR\nx ATIo_IX0_0 AT %Q0 : BOOL;\nEND_VAR\nx := %IX0.0;'],
    ['a repeated nameless declaration', 'VAR\nAT %IX0.0 : BOOL;\n  AT %IX0.0 : BOOL;\nEND_VAR'],
    ['an alias suffix after an earlier Io_ in the same word', 'VAR\nIo_AIo_IX0_0 AT %Q0 : BOOL;\nEND_VAR\nx := %IX0.0;'],
    ['many unclosed comments and strings', "(* a (* b // c\n' d \" e { f /* g"],
  ])('handles %s the same way', (_, source) => {
    for (const [, rule, reference] of RULE_PAIRS) {
      for (const apply of [true, false]) {
        const options: UpgradeOptions = { sourceKind: 'st', fileName: 'r.st', apply };
        expect(rule.run(source, options)).toEqual(reference.run(source, options));
      }
    }
  });
});

describe('representedVariableRule replaces each nameless declaration in place (wormhole#5)', () => {
  it('rewrites a repeated declaration twice instead of re-aliasing the first one', () => {
    const result = representedVariableRule.run('VAR\nAT %IX0.0 : BOOL;\nAT %IX0.0 : BOOL;\nEND_VAR', {
      sourceKind: 'st',
      fileName: 'r.st',
      apply: true,
    });
    expect(result.source).toBe('VAR\nIo_IX0_0 AT %IX0.0 : BOOL;\nIo_IX0_0 AT %IX0.0 : BOOL;\nEND_VAR');
  });
});

describe('scan helpers', () => {
  it('LineIndex and lineNumberAt agree with counting newlines in the prefix', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const source = randomSource(prng(seed), 80);
      const lines = new LineIndex(source);
      for (let offset = 0; offset <= source.length; offset += 1) {
        const expected = source.slice(0, offset).split('\n').length;
        expect(lines.lineAt(offset)).toBe(expected);
        expect(lineNumberAt(source, offset)).toBe(expected);
      }
    }
  });

  it('ForwardSearch and ForwardIndexOf answer like a fresh search, in any query order', () => {
    const source = 'ab END_X cd END_Y ef';
    const search = new ForwardSearch(source, /END_[XY]/g);
    const indexOf = new ForwardIndexOf(source, 'END_');
    for (const from of [0, 3, 4, 9, 12, 13, 20, 2, 0, 15]) {
      const fresh = /END_[XY]/g;
      fresh.lastIndex = from;
      expect(search.from(from)?.index ?? null).toBe(fresh.exec(source)?.index ?? null);
      expect(indexOf.from(from)).toBe(source.indexOf('END_', from));
    }
  });

  it('LastIndexBefore answers like lastIndexOf, in any query order', () => {
    const source = 'a,b,,c(d,e)f,';
    const last = new LastIndexBefore(source, ',');
    for (const before of [0, 1, 2, 3, 5, 9, 13, 4, 0, 13]) {
      expect(last.before(before)).toBe(before === 0 ? -1 : source.lastIndexOf(',', before - 1));
    }
    expect(() => new LastIndexBefore('x', ',,')).toThrow(/single/);
  });

  it('findCallSites resumes after an accepted call and after a rejected head', () => {
    const source = 'f(g(x)) h (y) k(';
    const all = findCallSites(source, () => true).map((site) => site.text);
    expect(all).toEqual(['f(g(x)', 'h (y)']);
    const onlyG = findCallSites(source, (site) => site.name === 'g').map((site) => site.text);
    expect(onlyG).toEqual(['g(x)']);
  });

  it('ForwardSearch refuses a non-global pattern', () => {
    expect(() => new ForwardSearch('x', /x/)).toThrow(/global/);
  });
});

describe('upgradeSource scales linearly on hostile input (wormhole#5)', () => {
  // Each of these took ~16x longer for 4x the input before the rewrite (an IL header with no
  // END_ was 1.95 s at 300 KB through ImporterHost). Timing tests are noisy, so the bar is
  // loose: 4x the input may take at most 8x the time (quadratic would be ~16x), using the
  // best of three runs, plus a small absolute allowance for timer and GC jitter.
  const HOSTILE: Array<[string, (n: number) => string]> = [
    ['IL headers without END_', (n) => 'PROGRAM a LD x\n'.repeat(n)],
    ['POU headers without END_', (n) => 'PROGRAM a\n'.repeat(n)],
    ['many complete IL POUs', (n) => 'PROGRAM a\nLD x\nST y\nEND_PROGRAM\n'.repeat(n)],
    ['carriage returns inside a POU', (n) => `PROGRAM a\n${'\r'.repeat(n * 10)}LD x\nEND_PROGRAM\n`],
    ['blank lines', (n) => '\n'.repeat(n * 10)],
    ['line comments', (n) => '// c\n'.repeat(n)],
    ['unclosed TRUNC(', (n) => 'TRUNC( '.repeat(n)],
    ['TRUNC( a followed by spaces', (n) => `TRUNC( a${' '.repeat(n * 10)})`],
    ['unclosed BCD calls', (n) => 'A_TO_BCD('.repeat(n)],
    ['a long BCD-like identifier', (n) => `${'A_BCD_TO_1'.repeat(n)}(`],
    ['unclosed calls for action indicators', (n) => 'a( '.repeat(n)],
    ['nested unclosed calls sharing one )', (n) => `${'a( '.repeat(n)})`],
    ['PROGRAM without VAR_GLOBAL', (n) => 'PROGRAM '.repeat(n)],
    ['actionBlock heads without >', (n) => '<actionBlock '.repeat(n)],
    ['actionBlock regions without attributes', (n) => `${'<actionBlock >'.repeat(n)}referenceName="x"`],
    ['many octal literals', (n) => 'x := 8#17;\n'.repeat(n)],
    ['many nameless AT declarations', (n) => 'AT %IX0.0 : BOOL;\n'.repeat(n)],
    ['many distinct direct addresses', (n) => Array.from({ length: n }, (_, i) => `x := %IX${i}.0;`).join('\n')],
    ['many TRUNC calls', (n) => 'TRUNC(a)\n'.repeat(n)],
    ['many FB WITH hints', (n) => 'a WITH b;\n'.repeat(n)],
  ];

  function bestOfThree(source: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      upgradeSource(source, { sourceKind: 'st', fileName: 'hostile.st', apply: true });
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  it.each(HOSTILE)('%s', (_, make) => {
    const small = bestOfThree(make(5_000));
    const large = bestOfThree(make(20_000));
    expect(large).toBeLessThan(small * 8 + 40);
  });

  it('upgrades a 1 MB hostile file in well under a second', () => {
    const source = 'PROGRAM a LD x\n'.repeat(70_000);
    expect(source.length).toBeGreaterThan(1_000_000);
    expect(bestOfThree(source)).toBeLessThan(1_000);
  });
});

describe('upgradeSource checkpoint (wormhole#5)', () => {
  it('calls checkpoint between rules and per POU, and stops when it throws', () => {
    const source = 'PROGRAM a\nLD x\nEND_PROGRAM\n'.repeat(10);
    let calls = 0;
    upgradeSource(source, { sourceKind: 'st', fileName: 'a.st', apply: true, checkpoint: () => { calls += 1; } });
    expect(calls).toBeGreaterThanOrEqual(6 + 10);

    let seen = 0;
    const stop = new Error('stop');
    expect(() =>
      upgradeSource(source, {
        sourceKind: 'st',
        fileName: 'a.st',
        apply: true,
        checkpoint: () => {
          seen += 1;
          if (seen === 3) throw stop;
        },
      }),
    ).toThrow(stop);
    expect(seen).toBe(3);
  });

  it('stops a long IL scan part-way, not only between rules', () => {
    const source = 'PROGRAM a\nLD x\nEND_PROGRAM\n'.repeat(1_000);
    let seen = 0;
    expect(() =>
      ilPreservationRule.run(source, {
        sourceKind: 'st',
        fileName: 'a.st',
        apply: true,
        checkpoint: () => {
          seen += 1;
          if (seen === 10) throw new Error('stop');
        },
      }),
    ).toThrow('stop');
  });
});
