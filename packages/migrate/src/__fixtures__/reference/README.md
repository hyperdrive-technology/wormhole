Verbatim copies of the `@wormhole/migrate` rules (and `lexical.ts` / `truncToTyped.ts`) as they
were before wormhole#5 rewrote their scans to run in linear time. Test-only: `linear-scan.test.ts`
runs both versions on random inputs and requires identical results, so the rewrite cannot change
what a rule matches. Do not edit these to "fix" them; they are the behavioural reference.

Two deliberate changes in `representedVariableRule.ts`, both matching the shipped rule:

- Nameless `AT` declarations match `^[ \t]*AT` instead of `^\s*AT`. The old `\s*` was the
  O(n^2) part and made a match swallow (and the replacement delete) the blank lines above the
  declaration.
- Each nameless declaration is replaced where it was matched. The old
  `next.replace(match[0], ...)` rewrote the first identical text, which for a repeated
  declaration was the alias written one iteration earlier (`Io_X Io_X AT ...`).
