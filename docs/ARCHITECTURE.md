# Wormhole architecture

## Data flow

```text
Upload (file | directory | zip)
  → @wormhole/sdk loaders → VirtualFileTree (read-only, path-checked, size-limited)
  → ImporterHost.detectAll → ranked capabilities
  → ImporterHost.run → importer.import(tree, ctx)        e.g. @wormhole/iec61131-upgrade
        ctx.migrate.upgradeSource → @wormhole/migrate (ordered Edition 4 rule pipeline)
  → validated sources + diagnostics + preservation sidecars + summary
  → @wormhole/contract buildImporterArchive → deterministic importer-result.v1 zip
  → Hyperdrive IDE merge planner
  → compile → deploy
```

The `wormhole upgrade` CLI, the service and the UI still call `@wormhole/iec61131-upgrade`'s
`upgradeIec61131Source()` directly; moving them onto `ImporterHost` is a follow-up.

## Package roles

| Package | Responsibility |
|---------|----------------|
| `@wormhole/migrate` | Shared `upgradeSource()` orchestration; owns the legacy construct translators (`src/legacy/`) |
| `@wormhole/iec61131-upgrade` | First importer library + `wormhole upgrade` CLI |
| `@wormhole/contract` | Types, path validation, deterministic zip builders and the canonical JSON schemas (`schemas/`: `hyperdrive.importer-*.v1` plus the `wormhole.importer.v1` manifest) |
| `@wormhole/sdk` | Importer contract (`detect`/`import`), `wormhole.importer.v1` manifest validation, `VirtualFileTree` + zip/directory loaders, `ImporterHost` (limits, abort, result validation, archive), conformance kit. Its `prepare` build bundles contract and migrate into `dist/`, so importers install it straight from GitHub (`github:hyperdrive-technology/wormhole#<tag>&path:/packages/sdk`). See [WRITING_AN_IMPORTER.md](WRITING_AN_IMPORTER.md). |
| `@wormhole/ui` | TanStack Start app; server functions call the importer |
| `@wormhole/service` | REST surface used by the Hyperdrive IDE's remote-importer client |

## Transform tiers

1. **Tier A (auto):** octal → hex, `TRUNC` → typed, BCD → `HD_BCD.*`
2. **Tier B (structural):** nameless `AT`, direct-address alias declarations
3. **Tier C (preservation):** IL bodies → ST placeholder + `preservation/il/` sidecar
4. **Tier D (diagnostic):** VAR_ACCESS, VAR_GLOBAL, FB `WITH`, graphical deprecations

Normative reference: IEC 61131-3 Edition 4. Hyperdrive's compiler keeps legacy constructs out of its core language, so Wormhole rewrites them on the way in.

## Open and private importers

Wormhole (this repo, MIT) holds the contract, the pipeline, the service and UI, and the open importers. Vendor-specific importers, such as Rockwell L5X, live in **separate repositories**. Those can be private or commercial. They depend on the published contract and `@wormhole/sdk`, never the other way round:

- Nothing in this repo may import, vendor or describe the internals of a private importer.
- Private importers ship a `wormhole.importer.json` manifest (each capability maps onto `hyperdrive.importer-capabilities.v1`), implement the `@wormhole/sdk` importer interface, pass its conformance kit, and return the same result archive (`hyperdrive.importer-result.v1`) through `ImporterHost`.
- Host products embed importers by reference (path, npm, or tarball with integrity), the same way they embed Holodeck packages; integrity and signature checks are the host's job before `ImporterHost.register`.
- Golden fixtures in this repo must be self-authored or redistributable. Never commit customer or vendor project files.

## Determinism

Identical input gives a byte-identical result archive: the input tree is sorted and
NFC-normalised, archive entries are sorted within fixed sections, zip timestamps and the deflate
level are fixed (and timezone-independent), and `sourceFingerprint` hashes the tree, not how it
was loaded. The conformance kit's `archive-deterministic` check enforces this for every importer.
