# Writing a Wormhole importer

An importer turns a vendor or legacy PLC project into IEC 61131-3 Edition 4–oriented `.plc`
source, diagnostics and preservation sidecars. Wormhole is the open framework; importers can
live anywhere, including private repositories. This guide covers the `@wormhole/sdk` contract,
the security rules for untrusted input, the conformance kit and the versioning policy.

Start from [`templates/importer/`](../templates/importer/), a small standalone importer project.

## 1. The model: public framework, private importers

| Piece | Where | Licence |
|---|---|---|
| Contract (`hyperdrive.importer-*.v1` schemas, `wormhole.importer.v1` manifest schema) | `packages/contract/schemas/` in this repo | MIT |
| `@wormhole/sdk`: importer interface, `ImporterHost`, input trees, conformance kit | `packages/sdk/` in this repo | MIT |
| Open importers (IEC 61131-3 Edition 4 upgrade; PLCopen XML planned) | `packages/` in this repo | MIT |
| Vendor importers (for example `wormhole-importer-<vendor>`) | their own repositories, public or private | the author's choice |

Dependencies point one way. A vendor importer depends on `@wormhole/sdk`; nothing in this repo
imports, vendors or describes a private importer. Fixtures in this repo are self-authored or
redistributable, never customer or vendor project files. Keep the same rule in your own repo
unless it is private and you have the right to store the files.

## 2. Package layout

```
wormhole.importer.json   manifest: readable without running code
dist/index.js            entry module: default export is the importer
src/…                    your code
```

The layout follows Holodeck's package format on purpose. A host product (for example a
Hyperdrive extension) embeds importers **by reference**, the same way it embeds Holodeck
packages: it resolves a reference such as `{ "tarball": "acme-studio-1.2.0.tgz", "integrity":
"sha512-…" }` to a manifest plus entry module, checks integrity and signatures itself, then
calls `ImporterHost.register`. The manifest has no signature field and no host-specific
fields, so the same importer package works in Wormhole's service, in the Hyperdrive IDE, or
from npm.

## 3. The manifest (`wormhole.importer.v1`)

```json
{
  "schemaVersion": "wormhole.importer.v1",
  "id": "acme.studio",
  "name": "Acme Studio importer",
  "version": "1.2.0",
  "license": "LicenseRef-Acme-Commercial",
  "sdk": "^1.0.0",
  "entry": "dist/index.js",
  "capabilities": [
    {
      "id": "acme.studio",
      "displayName": "Acme Studio project export (.axp)",
      "vendor": "Acme Automation",
      "vendorFamily": "acme",
      "product": "Acme Studio",
      "productVersions": ["v20", "v32"],
      "inputs": {
        "fileExtensions": [".axp"],
        "mediaTypes": ["application/xml"],
        "containers": ["file", "zip"],
        "maxBytes": 52428800
      },
      "outputs": ["sources", "diagnostics", "preservation"],
      "coverageNotes": ["Ladder rungs are preserved, not converted"]
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Dotted, lowercase, at least two segments (`acme.studio`). Globally unique. |
| `version` | Semver. Written into results as `importerVersion`. |
| `license` | SPDX expression, or `LicenseRef-<name>` for proprietary importers. |
| `sdk` | Semver range of the SDK **API** (`WORMHOLE_SDK_API_VERSION`, currently `1.0.0`), not of the npm package. |
| `entry` | Optional package-relative path. No `..`, absolute paths, URLs, `%`, `?`, `#`, backslashes or surrounding whitespace. |
| `capabilities[].id` | Lowercase. Becomes `importerId` in `hyperdrive.importer-*.v1` documents, so it must be unique across every importer a host loads: prefix it with your vendor. |
| `inputs.fileExtensions` | Lowercase, with the dot; matching is case-insensitive. |
| `inputs.containers` | Which shapes the input may arrive in: `file`, `directory`, `zip`. The host refuses others. |
| `inputs.maxBytes` | Largest input the capability accepts. Maps to `maxUploadBytes`; the host never runs the capability on more. |
| `outputs` | Must include `sources` and `diagnostics`. |

Unknown fields are errors, so typos fail loudly. `$schema` is allowed as an editor hint; the
schema ships in the SDK as `@wormhole/sdk/schemas/wormhole-importer.v1.schema.json`.

Each capability maps onto one entry of `hyperdrive.importer-capabilities.v1`
(`capabilityEntries()`, `toCapabilitiesDocument()`), which is what the service's
`GET /importers/capabilities` returns.

## 4. The contract

```ts
import { defineImporter, parseImporterManifest } from '@wormhole/sdk';
import manifestJson from '../wormhole.importer.json';

export default defineImporter({
  manifest: parseImporterManifest(manifestJson),
  detect({ files }) { … },          // → { capabilityId, confidence, reason } | null
  import({ files, capabilityId, options }, ctx) { … },   // → ImportResult
});
```

### `detect(input) → DetectResult | null`

- Deterministic and cheap. Look at paths, extensions and header bytes with
  `files.head(path, n)`; never parse the whole project. The conformance kit pads a fixture to
  2 MiB and fails `detect()` if it reads more than 256 KiB.
- `confidence` is 0..1. Hosts rank all importers with `ImporterHost.detectAll()`.
- Return `null` for input that is not yours. Never throw.

### `import(input, ctx) → ImportResult`

```ts
interface ImportResult {
  sources: Record<string, string>;                     // 'sources/<path>.plc' → text
  diagnostics: ImporterDiagnostic[];                   // hyperdrive.importer-diagnostics.v1 entries
  preservation?: Record<string, string | Uint8Array>;  // 'preservation/<path>' → sidecar
  assets?: Record<string, string | Uint8Array>;        // 'assets/<path>'
  unsupportedSemantics?: ImporterUnsupportedSemantic[];
  summary: { message: string; stats?: Record<string, number> };
}
```

- Every key is a full archive path, checked by the same rules as input paths plus Windows
  portability (no `<>:"|?*`, no trailing dot or space, no `CON`/`NUL`/`COM1`…, no two paths
  that differ only by case).
- **Never drop input that holds logic.** If a source file can't be written (its output path
  collides or isn't portable, or a sidecar would be overwritten), return no sources so the
  host fails the run with `NO_SOURCES`. Don't skip the file and report success. Empty and
  binary files may be skipped with a diagnostic. The template and the IEC 61131 importer
  both follow this rule (`filesLost` / `sourcesLost` in `summary.stats`).
- `input.files` is a `VirtualFileTree`: a read-only, in-memory map of relative path → bytes
  (`paths()`, `read()`, `head()`, `readText()`, `pathsWithExtension()`). Importers never get
  filesystem access. Reads return copies.
- `input.options` holds importer-specific switches (strings, numbers, booleans). The
  IEC 61131 importer reads `apply: false` for report-only runs.
- `input.narratives` is **reserved** for lane F3 (control narratives, cause-and-effect
  matrices, loop sheets). Its type is `never` in API 1.0 and `ImporterHost.run` rejects
  callers that set it.

`ctx` gives you:

| Member | Use |
|---|---|
| `signal` | Aborted on cancellation or when the wall-time limit passes. Pass it to async work. |
| `throwIfAborted()` | Call before work and inside long loops. A synchronous importer cannot be interrupted any other way. |
| `remainingMs()` | Time left before the wall-time limit. |
| `limits` | `maxInputBytes`, `maxInputFiles`, `maxOutputBytes`, `maxWallTimeMs` for this run. `maxOutputBytes` covers every archive entry exactly as written before compression (`manifest.json` and `diagnostics.json` pretty-printed, sources, preservation, assets) plus the `summary` returned on the outcome; `stats.outputBytes` reports the same number. |
| `logger` | Structured `debug/info/warn/error(message, fields)`. Logs are for operators; anything the user must see is a diagnostic. |
| `migrate` | `@wormhole/migrate`'s `upgradeSource()` and `defaultRules`: the Edition 4 legacy rules (octal literals, untyped `TRUNC`, BCD helpers, nameless `AT`, IL preservation, deprecated constructs) for free. Run your generated ST through it. |

Text helpers: `decodeText()` (UTF-8, BOM, UTF-16, Windows-1252 fallback), `normalizeNewlines()`
(CRLF/CR → LF), `looksBinary()`. Nested archives: call `readZipTree(bytes, { limits })` yourself
on an entry; the host never expands zips inside zips.

## 5. What the host does

`ImporterHost` from `@wormhole/sdk`, with loaders from `@wormhole/sdk/node`:

```ts
const host = new ImporterHost();
host.register(importer);                               // manifest, sdk range, duplicate ids
const input = await loadInputFromPath(uploadPath);     // file, directory or .zip → tree
const [best] = host.detectAll(input.tree);
const outcome = await host.run({ capabilityId: best.capabilityId, input, signal, limits });
if (outcome.status === 'succeeded') save(outcome.archive.zipBytes);
```

`run()` only throws for misuse (unknown capability, bad limits or options, the reserved
`narratives` field). Everything else is a failed outcome with schema-valid diagnostics:

| `failure.code` | When |
|---|---|
| `INPUT_REJECTED` | The input could not be loaded safely, or its container kind is not accepted. |
| `LIMIT_EXCEEDED` | Input files/bytes, output bytes or wall time over the limit. |
| `ABORTED` | The caller cancelled. |
| `IMPORTER_THREW` | `import()` threw something other than the abort reason. |
| `INVALID_RESULT` | Wrong shape, schema-invalid diagnostics, or unsafe/colliding output paths. |
| `NO_SOURCES` | The importer produced no `.plc`, usually because the input was unusable. |

A successful run returns the `hyperdrive.importer-result.v1` archive: `manifest.json`,
`diagnostics.json`, then sources, preservation and assets, each sorted. Archives are
**byte-identical for identical input**: sorted entries, fixed timestamps, fixed compression
level, and a `sourceFingerprint` (SHA-256 over the input tree) that does not depend on how the
tree was built. The manifest's `importerId` is the capability id and `importerVersion` is the
manifest version.

Trust model: importers run in-process, like any npm dependency. The host defends against
hostile **input** and buggy importers, not against hostile importer code. Run importers you do
not trust in a worker or a separate process.

## 6. Security rules for untrusted input

Treat every byte of a project file as hostile.

1. **Paths.** Never build filesystem paths from input names. The SDK already rejects
   absolute paths, `..` segments, drive letters, backslashes, control characters and
   duplicates on the way in, and refuses unsafe output paths on the way out. Keep your own
   derived paths inside `sources/`, `preservation/` and `assets/`.
2. **Size.** Respect `ctx.limits`. Do not allocate based on lengths declared inside the input
   (record counts, string lengths) without checking them against the bytes that are actually
   there.
3. **Time.** Call `ctx.throwIfAborted()` in every loop over input-controlled data. Avoid
   regular expressions with nested quantifiers over untrusted text; they can backtrack
   exponentially.
4. **Parsers.** Disable external entities and DTD processing in XML parsers (XXE). Never
   `eval`, `new Function` or `require` anything derived from input.
5. **Archives.** Do not expand nested archives automatically. If you must, use
   `readZipTree` with the remaining budget.
6. **Errors.** Garbage, truncated, non-UTF-8 or CRLF input must produce diagnostics, not
   exceptions. Throwing is reported as an importer crash.
7. **Output.** Escape what you emit: a comment taken from the input must not be able to close
   an ST comment (`*)`) or inject code.
8. **Secrets.** Projects can contain passwords and keys. Do not log input contents.

## 7. Conformance

```ts
// src/conformance.test.ts
import { describeImporterConformance } from '@wormhole/sdk/conformance/vitest';
import importer from './index.js';

describeImporterConformance(importer, {
  fixtures: [{ name: 'basic project', files: { 'Main.axp': readFixture('basic.axp') } }],
});
```

`runImporterConformance(importer, { fixtures })` from `@wormhole/sdk/conformance` is
framework-agnostic and returns named results; the vitest helper registers one test per check.
Fixtures are known-good inputs that must import successfully.

| Check | Fails when |
|---|---|
| `manifest-valid` | Schema or semantic manifest errors, an `sdk` range that excludes this SDK, a capability mapping that breaks `hyperdrive.importer-capabilities.v1`, or `ImporterHost.register` refusing the importer. |
| `detect-deterministic` | Different answers for the same input (including reversed insertion order), a known-good fixture not recognised, or an invalid answer. |
| `detect-cheap` | `detect()` reads more than the budget from a 2 MiB-padded fixture. |
| `outputs-schema-valid` | A fixture fails to import, or the archive's manifest/diagnostics do not validate (Ajv) or do not match the zip's entries. |
| `output-paths-safe` | Any output path is unsafe, unportable, not in normal form, outside its section, or collides by case. |
| `archive-deterministic` | Two runs on the same input give different archive bytes. |
| `abort-honoured` | `import()` completes with an already-aborted signal, or throws something other than the abort reason. |
| `limits-honoured` | A run over the file, byte, output or wall-time limit does not end as `LIMIT_EXCEEDED` with valid diagnostics. |
| `garbage-input-diagnosed` | Empty, random, NUL, invalid-UTF-8, truncated or CRLF variants of a fixture make `detect()` or `import()` throw, or unusable input produces no warning or error. A truncated zip must be rejected cleanly. |

Run conformance in CI on every change. The template's workflow does.

## 8. Depending on the SDK (GitHub, not npm)

`@wormhole/sdk` is not published to npm (Des, 2026-10-29). Every importer, including private
ones, depends on it straight from the public GitHub repository, as a pnpm git subdirectory
dependency:

```json
{
  "dependencies": {
    "@wormhole/sdk": "github:hyperdrive-technology/wormhole#sdk-v0.1.0&path:/packages/sdk"
  },
  "pnpm": { "onlyBuiltDependencies": ["@wormhole/sdk"] }
}
```

How it works with pnpm 10.33.2:

1. pnpm downloads the repository at the ref (`#sdk-v0.1.0`; a commit SHA also works, and
   `#main` works but moves) and selects `packages/sdk` (`&path:/packages/sdk`).
2. It runs `pnpm install` for Wormhole's workspace inside that copy, so the SDK's internal
   `workspace:*` dependencies resolve, then runs the SDK's `prepare` script, which builds
   `dist/` and bundles `@wormhole/contract` and `@wormhole/migrate` into it.
3. pnpm 10 refuses to run a git-hosted dependency's build scripts unless the consumer lists
   it in `onlyBuiltDependencies` (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), so that entry is
   required.
4. `pnpm-lock.yaml` records the resolved commit. Commit it: CI and every clone then build
   against exactly the same SDK.

Wormhole is public, so private importer repos need no token to install it. Upgrade by
changing the ref, running `pnpm install` and the tests, and committing `package.json` and
`pnpm-lock.yaml` together.

Release tags are named `sdk-v<package version>` and point at commits on `main`.
[`templates/importer/`](../templates/importer/) uses exactly this pattern, and
`scripts/verify-template.sh` exercises it in Wormhole's CI. That script copies the template
out of the repository and installs the SDK from the commit under test (`git+file://` in
place of `github:`) through the same fetch, workspace install and `prepare` build.

## 9. Versioning

- **SDK API version** (`WORMHOLE_SDK_API_VERSION`, `1.0.0`). Importers declare `"sdk": "^1.0.0"`.
  `ImporterHost.register` refuses importers whose range excludes the host's API version.
- **v1 is additive-only.** New optional result fields, context members, input fields (such as
  F3's `narratives`) and diagnostics codes bump the minor version. Nothing in v1 is removed or
  changes meaning. An importer that uses a 1.x addition declares `^1.x.0`, so older hosts
  refuse it instead of misreading it.
- **Schemas.** `wormhole.importer.v1` and `hyperdrive.importer-*.v1` change only additively
  (new optional properties). A breaking change means `v2` schemas and SDK API 2.0.0.
- **Your importer's version** is yours. Bump the major version when its output changes in a way
  users must review.

Diagnostics codes: use your own prefix (`ACME_STUDIO_*`). `WORMHOLE_INPUT_*` and `WORMHOLE_RUN_*`
belong to the SDK.
