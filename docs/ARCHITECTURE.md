# Wormhole architecture

## Data flow

```text
Legacy .plc / .st
  → @wormhole/iec61131-upgrade (capability iec61131-ed4-upgrade)
  → @wormhole/migrate (ordered rule pipeline)
  → upgraded source + diagnostics + preservation map
  → @wormhole/contract (optional importer-result.v1 zip)
  → Hyperdrive IDE merge planner
  → compile → deploy
```

## Package roles

| Package | Responsibility |
|---------|----------------|
| `@wormhole/migrate` | Shared `upgradeSource()` orchestration; owns the legacy construct translators (`src/legacy/`) |
| `@wormhole/iec61131-upgrade` | First importer library + `wormhole upgrade` CLI |
| `@wormhole/contract` | Types, zip builder and the canonical `hyperdrive.importer-*.v1` JSON schemas (`schemas/`) |
| `@wormhole/ui` | TanStack Start app; server functions call the importer |
| `@wormhole/service` | REST surface used by the Hyperdrive IDE's remote-importer client |

## Transform tiers

1. **Tier A (auto):** octal → hex, `TRUNC` → typed, BCD → `HD_BCD.*`
2. **Tier B (structural):** nameless `AT`, direct-address alias declarations
3. **Tier C (preservation):** IL bodies → ST placeholder + `preservation/il/` sidecar
4. **Tier D (diagnostic):** VAR_ACCESS, VAR_GLOBAL, FB `WITH`, graphical deprecations

Normative reference: IEC 61131-3 Edition 4. Hyperdrive's compiler keeps legacy constructs out of its core language, so Wormhole rewrites them on the way in.

## Open and private importers

Wormhole (this repo, MIT) holds the contract, the pipeline, the service and UI, and the open importers. Vendor-specific importers, such as Rockwell L5X, live in **separate repositories**. Those can be private or commercial. They depend on the published contract (and, once it exists, `@wormhole/sdk`), never the other way round:

- Nothing in this repo may import, vendor or describe the internals of a private importer.
- Private importers register through the same capability manifest (`hyperdrive.importer-capabilities.v1`) and return the same result archive (`hyperdrive.importer-result.v1`).
- Golden fixtures in this repo must be self-authored or redistributable. Never commit customer or vendor project files.
