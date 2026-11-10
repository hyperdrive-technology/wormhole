#!/usr/bin/env node
/**
 * dev-check — the one local entry point for checks in this repo (wormhole).
 *
 *   scripts/dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e]
 *
 * Tiers (see TESTING.md and ~/dev/hyperdrive/.agents/plans/dev-loop-shift-left.md):
 *   fast  (L1, pre-push hook) typecheck + tests of the touched workspace packages AND their
 *         dependents (pnpm --filter … --parallel), plus whatever else the diff selects
 *   push  (L2, before a PR/review) every step except build and the packed-template check
 *   full  (L3, before merging a minor PR) every step PR CI runs (ci.yml), whatever the diff
 *
 * Optional cross-repo gates, only when HYPERDRIVE_CORE_DIR points at a Hyperdrive core
 * checkout (never implicitly: they read, and compile-gate regenerates files in, that checkout):
 *   schema-sync   push/full, or fast when packages/contract/schemas/ changed
 *   compile-gate  full only
 *
 * The diff is HEAD + staged + unstaged + untracked-not-ignored files against the merge-base of
 * HEAD and `--base` (default origin/main). Fail closed: a changed file no rule owns selects the
 * whole `push` set; a toolchain / lockfile / workflow / root-config change selects `full`; an
 * unreadable diff selects `full`.
 *
 * The last line printed is exactly
 *   dev-check: <mode> PASS|FAIL in <N>s — <step>=<passed count or ok|FAIL>; …
 * and every run (not --list) writes .dev-check/last.json, which
 * ~/dev/hyperdrive/scripts/ci-local-status.sh reads to post `ci/local`.
 *
 * Single source of truth with CI: scripts/dev-check.test.mjs pins that every `run:` command in
 * .github/workflows/ci.yml is a `full` step here (same directory, same command) and vice versa.
 *
 * The repo-specific part is STEPS + RULES + the workspace graph below; the rest is shared in
 * shape with holodeck-sdk/scripts/dev-check.mjs (keep the two runners in step).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MODES = ['fast', 'push', 'full'];

/**
 * Every check this repo has, in run order.
 * - cwd: directory relative to the repo root.
 * - scoped: in `fast`, runs only for the selected workspace packages (`scopedCommand`);
 *   `push`/`full`, or a selection that covers every package, run `command`.
 * - fullOnly: skipped by `push` (build/pack steps; `full` and a selecting diff still run them).
 * - needsCore: runs only when HYPERDRIVE_CORE_DIR is set.
 * - ci: false = local-only (not in ci.yml); the pin test exempts it.
 * - install: the dependency install; run only when node_modules is missing or stale.
 */
export const STEPS = [
  { name: 'install', cwd: '.', command: 'pnpm install --frozen-lockfile', install: true },
  { name: 'typecheck', cwd: '.', command: 'pnpm typecheck', scoped: 'typecheck' },
  { name: 'test', cwd: '.', command: 'pnpm test', scoped: 'test' },
  { name: 'schema-sync', cwd: '.', command: 'pnpm test:schema-sync', needsCore: true, ci: false },
  { name: 'dev-check-selftest', cwd: '.', command: 'node --test "scripts/*.test.mjs"' },
  { name: 'build', cwd: '.', command: 'pnpm build', fullOnly: true },
  { name: 'verify-template', cwd: '.', command: 'scripts/verify-template.sh', fullOnly: true },
  { name: 'compile-gate', cwd: '.', command: 'pnpm test:compile-gate', needsCore: true, fullOnly: true, ci: false },
];

/** pnpm command for a scoped step over some packages: `pnpm --filter a --filter b --parallel run <script>`. */
export function scopedCommand(script, packages) {
  return `pnpm ${packages.map((p) => `--filter ${p}`).join(' ')} --parallel run ${script}`;
}

/**
 * Path rules, first match wins.
 * - escalate: 'full' = can affect everything (toolchain, lockfile, workflows, root config).
 * - packages: workspace package names this path belongs to; `withDependents` adds every package
 *   that depends on them (transitively), so a contract change re-checks its consumers.
 * - select: extra step names. `select: []` and no packages = inert (nothing reads it).
 * A path matching no rule is unowned and selects the whole `push` set (fail closed).
 * `packages/<dir>/` and `apps/<dir>/` are matched from the workspace graph (see packagesForPath).
 */
export const RULES = [
  { pattern: /^\.github\/workflows\//, escalate: 'full', why: 'CI workflow' },
  { pattern: /^\.node-version$/, escalate: 'full', why: 'Node toolchain pin' },
  { pattern: /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/, escalate: 'full', why: 'root dependencies / lockfile / workspace' },
  // Every package's vitest.config.ts imports it.
  { pattern: /^workspace-aliases\.ts$/, escalate: 'full', why: 'shared Vite/Vitest source aliases' },
  { pattern: /^(packages|apps)\/[^/]+\//, workspace: true, withDependents: true, why: 'workspace package' },
  // The template's tests and types run inside @wormhole/sdk (its vitest.config/tsconfig include
  // them); the packed-SDK check installs it out of repo.
  { pattern: /^templates\/importer\//, packages: ['@wormhole/sdk'], select: ['verify-template'], why: 'importer template' },
  // fixtures/legacy is read by iec61131-upgrade's conformance test (and the compile gate).
  { pattern: /^fixtures\//, packages: ['@wormhole/iec61131-upgrade'], withDependents: true, why: 'legacy fixtures' },
  { pattern: /^scripts\/verify-template\.sh$/, select: ['verify-template'], why: 'packed-template check' },
  { pattern: /^(scripts|\.githooks)\//, select: ['dev-check-selftest'], why: 'dev tooling' },
  { pattern: /^[^/]+\.md$/, select: [], why: 'top-level Markdown' },
  { pattern: /^docs\//, select: [], why: 'docs (no test reads them)' },
  { pattern: /^(LICENSE|\.gitignore)$/, select: [], why: 'inert' },
  { pattern: /^\.github\/(CODEOWNERS|dependabot\.yml|actionlint\.yaml)$/, select: [], why: 'inert GitHub config' },
];

/** packages/contract/schemas/ is mirrored in core's docs/schemas (schema-sync). */
const SCHEMA_SYNC_INPUT = /^packages\/contract\/schemas\//;

/**
 * The install step runs only when node_modules is missing or older than the lockfile (pnpm
 * rewrites INSTALL_MARKER on every install).
 */
const INSTALL_MARKER = 'node_modules/.modules.yaml';
const INSTALL_INPUT = 'pnpm-lock.yaml';

/** @returns {string | undefined} why an install is needed, or undefined when node_modules is current */
export function installReason(root = REPO_ROOT) {
  const marker = join(root, INSTALL_MARKER);
  if (!existsSync(marker)) return `${INSTALL_MARKER} missing`;
  if (statSync(join(root, INSTALL_INPUT)).mtimeMs > statSync(marker).mtimeMs) return `${INSTALL_INPUT} is newer than the last install`;
  return undefined;
}

/**
 * The workspace graph from packages/* and apps/* package.json files:
 * [{ name, dir: 'packages/sdk', deps: [workspace package names it depends on] }].
 */
export function loadWorkspace(root = REPO_ROOT) {
  const out = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const manifest = join(groupDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      const deps = Object.entries(all).filter(([, spec]) => String(spec).startsWith('workspace:')).map(([name]) => name);
      out.push({ name: pkg.name, dir: `${group}/${entry.name}`, deps: deps.sort() });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `names` plus every package that depends on one of them, transitively; sorted. */
export function withDependents(workspace, names) {
  const result = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of workspace) {
      if (!result.has(pkg.name) && pkg.deps.some((d) => result.has(d))) {
        result.add(pkg.name);
        grew = true;
      }
    }
  }
  return [...result].sort();
}

// ---------------------------------------------------------------------------------------------
// Pure planning logic (unit-tested in dev-check.test.mjs).
// ---------------------------------------------------------------------------------------------

/** @returns {{ mode: string, base: string, list: boolean, e2e: boolean }} */
export function parseArgs(argv) {
  const out = { mode: 'fast', base: 'origin/main', list: false, e2e: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (MODES.includes(arg)) out.mode = arg;
    else if (arg === '--list') out.list = true;
    else if (arg === '--e2e') out.e2e = true;
    else if (arg === '--base') {
      if (!argv[i + 1]) throw new Error('--base needs a ref');
      out.base = argv[++i];
    } else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg} (usage: dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e])`);
  }
  return out;
}

/**
 * Classifies one changed path.
 * @returns {{ kind: 'owned'|'inert'|'full'|'unowned', select: string[], packages: string[], why: string }}
 */
export function classify(file, workspace) {
  const rule = RULES.find((r) => r.pattern.test(file));
  if (!rule) return { kind: 'unowned', select: [], packages: [], why: 'no rule owns it' };
  if (rule.escalate) return { kind: 'full', select: [], packages: [], why: rule.why };
  let packages = rule.packages ?? [];
  if (rule.workspace) {
    const pkg = workspace.find((p) => file.startsWith(`${p.dir}/`));
    // A directory under packages/ or apps/ that is not a workspace package (no package.json).
    if (!pkg) return { kind: 'unowned', select: [], packages: [], why: 'not a workspace package' };
    packages = [pkg.name];
  }
  if (rule.withDependents) packages = withDependents(workspace, packages);
  const select = [...(rule.select ?? [])];
  if (packages.length) select.unshift('typecheck', 'test');
  if (SCHEMA_SYNC_INPUT.test(file)) select.push('schema-sync');
  return { kind: select.length ? 'owned' : 'inert', select, packages, why: rule.why };
}

const RANK = { fast: 0, push: 1, full: 2 };

/**
 * Decides what to run.
 * @param {{ mode: string, changed: string[] | null, install?: string, coreDir?: string, workspace?: ReturnType<typeof loadWorkspace> }} input
 *   changed: changed paths, or null when the diff could not be read (fail closed → full).
 *   install: why node_modules needs an install (adds the install step), if it does.
 *   coreDir: HYPERDRIVE_CORE_DIR; unset drops the needsCore steps.
 */
export function plan({ mode, changed, install, coreDir, workspace = loadWorkspace() }) {
  const reasons = [];
  let effective = mode;
  const escalate = (to, reason) => {
    reasons.push(reason);
    if (RANK[to] > RANK[effective]) effective = to;
  };
  const selected = new Map();
  const select = (name, why) => {
    if (!selected.has(name)) selected.set(name, why);
  };
  const packages = new Set();

  if (changed === null) escalate('full', 'could not read the diff: full (fail closed)');
  const files = changed ?? [];
  const nothingChanged = changed !== null && files.length === 0;

  for (const file of files) {
    const c = classify(file, workspace);
    if (c.kind === 'full') escalate('full', `${file}: ${c.why} → full`);
    else if (c.kind === 'unowned') escalate('push', `${file}: ${c.why} → push (fail closed)`);
    for (const name of c.select) select(name, `${file} (${c.why})`);
    for (const p of c.packages) packages.add(p);
  }

  const allPackages = workspace.map((p) => p.name).sort();
  const scope = [...packages].sort();
  const steps = [];
  for (const step of STEPS) {
    if (step.needsCore && !coreDir) continue;
    let why;
    if (step.install) why = install;
    else if (effective === 'full') why = selected.get(step.name) ?? 'full: every CI step';
    else if (effective === 'push') why = step.fullOnly ? selected.get(step.name) : (selected.get(step.name) ?? 'push: every non-build step');
    else why = selected.get(step.name);
    if (!why) continue;
    let command = step.command;
    if (effective === 'fast' && step.scoped && scope.length < allPackages.length) {
      command = scopedCommand(step.scoped, scope);
      why = `${why}; packages ${scope.join(', ')}`;
    }
    steps.push({ ...step, command, why });
  }
  if (nothingChanged && effective !== 'full') return { mode: effective, requested: mode, reasons, nothingChanged, steps: [] };
  return { mode: effective, requested: mode, reasons, nothingChanged, steps };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Passed-test count from a step's output, or null when it printed none. Sums every summary
 * line, so recursive (`pnpm -r`) runs and multi-file `node --test` runs add up.
 * Recognises Vitest (`Tests  12 passed (12)`, `Tests  163 passed | 6 skipped (169)`) and
 * node:test (`ℹ pass 12` spec reporter, `# pass 12` TAP reporter).
 */
export function passedCount(output) {
  const text = output.replace(ANSI, '');
  let total = null;
  for (const re of [/\bTests\s+(\d+) passed\b/g, /^[ℹ#] pass (\d+)$/gm]) {
    for (const m of text.matchAll(re)) total = (total ?? 0) + Number(m[1]);
  }
  return total;
}

/** The contract's last line. */
export function summaryLine(mode, results, seconds, note) {
  const pass = results.every((r) => r.result === 'pass');
  const parts = results.map((r) => `${r.name}=${r.result === 'pass' ? (r.passed ?? 'ok') : 'FAIL'}`);
  const tail = parts.length ? parts.join('; ') : note;
  return `dev-check: ${mode} ${pass ? 'PASS' : 'FAIL'} in ${Math.round(seconds)}s — ${tail}`;
}

// ---------------------------------------------------------------------------------------------
// Git and process plumbing.
// ---------------------------------------------------------------------------------------------

function git(args, cwd = REPO_ROOT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Changed paths vs the merge-base of HEAD and `base`: committed, staged and unstaged changes
 * (`git diff <merge-base>` compares the working tree) plus untracked files that are not ignored.
 * Returns { base: <merge-base sha or the ref>, changed: string[] | null } (null = unreadable).
 */
export function changedFiles(baseRef, cwd = REPO_ROOT) {
  const mergeBase = git(['merge-base', 'HEAD', baseRef], cwd)?.trim();
  if (!mergeBase) return { base: baseRef, changed: null };
  const diff = git(['diff', '--name-only', '--no-renames', mergeBase], cwd);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  if (diff === null || untracked === null) return { base: mergeBase, changed: null };
  const files = new Set([...diff.split('\n'), ...untracked.split('\n')].filter(Boolean));
  return { base: mergeBase, changed: [...files].sort() };
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = performance.now();
    const env = { ...process.env };
    if (process.stdout.isTTY && !env.NO_COLOR) env.FORCE_COLOR = '1';
    const child = spawn('sh', ['-c', step.command], { cwd: join(REPO_ROOT, step.cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      output += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      const seconds = (performance.now() - started) / 1000;
      resolve({ name: step.name, command: step.command, seconds: Number(seconds.toFixed(2)), result: code === 0 ? 'pass' : 'fail', passed: code === 0 ? passedCount(output) : null });
    });
  });
}

function writeLast(record) {
  const dir = join(REPO_ROOT, '.dev-check');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last.json'), `${JSON.stringify(record, null, 2)}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`dev-check: ${error.message}`);
    return 2;
  }
  if (args.help) {
    console.log('usage: scripts/dev-check.sh [fast|push|full] [--base <ref>] [--list] [--e2e]\nSee TESTING.md.');
    return 0;
  }
  const started = performance.now();
  const { base, changed } = changedFiles(args.base);
  const coreDir = process.env.HYPERDRIVE_CORE_DIR || undefined;
  const p = plan({ mode: args.mode, changed, install: installReason(), coreDir });

  const header = p.mode === p.requested ? p.mode : `${p.requested} → ${p.mode}`;
  console.log(`dev-check ${header} (base ${base.slice(0, 12)}, ${changed === null ? 'diff unreadable' : `${changed.length} changed file(s)`})`);
  for (const reason of p.reasons) console.log(`  escalated: ${reason}`);
  if (!coreDir) console.log('  HYPERDRIVE_CORE_DIR unset: schema-sync and compile-gate skipped (set it to a core checkout to run them)');
  if (args.e2e) console.log('  --e2e: this repo has no browser/service e2e steps');

  if (args.list) {
    if (!p.steps.length) console.log('  nothing to run');
    for (const step of p.steps) console.log(`  ${step.name.padEnd(20)} [${step.cwd}] ${step.command}\n  ${''.padEnd(20)} ← ${step.why}`);
    return 0;
  }

  const results = [];
  for (const step of p.steps) {
    console.log(`\n▶ ${step.name}: (cd ${step.cwd} && ${step.command})   ← ${step.why}`);
    const r = await runStep(step);
    console.log(`${r.result === 'pass' ? '✔' : '✘'} ${step.name} ${r.seconds.toFixed(1)}s${r.passed !== null ? ` (${r.passed} passed)` : ''}`);
    results.push(r);
  }
  const seconds = (performance.now() - started) / 1000;
  const note = p.nothingChanged ? `nothing changed vs ${base.slice(0, 12)}` : 'nothing selected (inert files only)';
  const summary = summaryLine(p.mode, results, seconds, note);
  const pass = results.every((r) => r.result === 'pass');
  writeLast({
    mode: p.mode,
    requested: p.requested,
    result: pass ? 'PASS' : 'FAIL',
    head: git(['rev-parse', 'HEAD'])?.trim() ?? null,
    dirty: (git(['status', '--porcelain']) ?? 'unknown').trim() !== '',
    base,
    seconds: Number(seconds.toFixed(1)),
    steps: results,
    summary,
  });
  console.log(`\n${summary}`);
  return pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
