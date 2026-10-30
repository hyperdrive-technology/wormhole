Verbatim copies of the `@wormhole/migrate` rules (and `lexical.ts` / `truncToTyped.ts`) as they
were before wormhole#5 rewrote their scans to run in linear time. Test-only: `linear-scan.test.ts`
runs both versions on random inputs and requires identical results, so the rewrite cannot change
what a rule matches. Do not edit these to "fix" them; they are the behavioural reference.

One deliberate change: `representedVariableRule.ts` here uses `^[ \t]*AT` instead of `^\s*AT`
for nameless `AT` declarations, matching the shipped rule. The old `\s*` was the O(n^2) part
and made a match swallow (and the replacement delete) the blank lines above the declaration.
