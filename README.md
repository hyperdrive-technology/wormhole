# Wormhole

Wormhole is the **import and migration layer** for [Hyperdrive](https://github.com/hyperdrive-technology), an open IEC 61131-3 virtual PLC. It takes legacy or vendor PLC projects and produces:

- IEC 61131-3 **Edition 4–oriented `.plc`** source
- diagnostics
- **preservation sidecars** for anything that can't be converted losslessly

Wormhole stops at source. It does not emit Hyperdrive's compiled IR (`hyperdrive.ir.v1`); the Hyperdrive compiler owns that step.

## Open framework, pluggable importers

| Layer | Where | Licence |
|---|---|---|
| Contract, migration pipeline, service, UI, open importers (IEC 61131 Edition 4 upgrade; PLCopen XML / IEC 61131-10 planned) | this repo | MIT |
| Vendor-specific importers, e.g. Rockwell RSLogix 5000 / Studio 5000 (L5X) | separate repositories, which may be private or commercial | the importer author's choice |

Every importer targets the same public contract: the `hyperdrive.importer-*.v1` JSON schemas in [`packages/contract/schemas/`](packages/contract/schemas/), and [`@wormhole/sdk`](packages/sdk/), which provides the importer interface (`detect()` / `import()` over a read-only virtual file tree), the `wormhole.importer.v1` manifest, an `ImporterHost` that enforces limits and builds deterministic result archives, and a conformance kit. A vendor or OSS project can therefore maintain its own importer, public or private, without forking Wormhole. Start from [`templates/importer/`](templates/importer/) and read [Writing an importer](docs/WRITING_AN_IMPORTER.md).

## Layout

```text
wormhole/
├── apps/wormhole-ui/           @wormhole/ui: TanStack Start upload/review UI
├── packages/
│   ├── contract/               @wormhole/contract: importer archive types, zip builder, JSON schemas
│   ├── migrate/                @wormhole/migrate: upgradeSource() rule pipeline + legacy construct migrations
│   ├── sdk/                    @wormhole/sdk: importer contract, ImporterHost, input trees, conformance kit
│   ├── iec61131-upgrade/       @wormhole/iec61131-upgrade: first importer (implements the SDK) + `wormhole` CLI
│   └── service/                @wormhole/service: HTTP API for remote import jobs
├── templates/importer/         standalone starter for importers in their own repos
├── fixtures/                   golden legacy inputs
└── docs/                       ARCHITECTURE.md, WRITING_AN_IMPORTER.md
```

## Quick start

Requires Node 26 and pnpm 10.33.2.

```bash
pnpm install
pnpm dev                      # http://localhost:3001

# CLI upgrade
pnpm --filter @wormhole/iec61131-upgrade exec wormhole upgrade \
  --input fixtures/legacy/tier-a-legacy.plc \
  --output /tmp/upgraded.plc

pnpm test
pnpm typecheck
```

`pnpm test:compile-gate` also compiles the upgraded fixtures with the Hyperdrive compiler. It needs a Hyperdrive core checkout at `../core` or at `HYPERDRIVE_CORE_DIR`, and skips otherwise.

## First importer

- **Importer id:** `wormhole.iec61131-upgrade` ([`wormhole.importer.json`](packages/iec61131-upgrade/wormhole.importer.json)); **capability id:** `iec61131-ed4-upgrade`
- **Input:** `.plc` / `.st` legacy IEC 61131-3 source, as a file, a directory or a zip
- **Output:** upgraded source plus diagnostics, and optionally a `hyperdrive.importer-result.v1` zip
- Implements `@wormhole/sdk` and passes its conformance kit; the CLI and service call the same pipeline directly.

## Contributing and security

See the organisation's [contributing guide](https://github.com/hyperdrive-technology/.github/blob/main/CONTRIBUTING.md) and [security policy](https://github.com/hyperdrive-technology/.github/blob/main/SECURITY.md). Wormhole parses untrusted project files, so report path traversal, zip-slip and resource-exhaustion bugs privately.

## License

[MIT](LICENSE)
