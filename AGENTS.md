# Wormhole — agent instructions

Import/migration layer for Hyperdrive: external or legacy PLC source → Edition 4–oriented `.plc`, diagnostics, preservation sidecars. Never emits `hyperdrive.ir.v1` (compiler-owned).

## Stack

- **TypeScript** end-to-end
- **TanStack Start** for [`apps/wormhole-ui/`](apps/wormhole-ui/)
- Library packages under [`packages/`](packages/) — importers call `@wormhole/migrate`, archives via `@wormhole/contract`

## Boundaries

- **Public repo (MIT).** Never commit secrets, customer/vendor project files, local paths, or details of private importers. Vendor importers (for example Rockwell L5X) live in separate, possibly private, repos that depend on this contract; see `docs/ARCHITECTURE.md` § Open and private importers.
- Standalone build: no imports from Hyperdrive core. Legacy construct translators live in `packages/migrate/src/legacy/` (moved from core on 2026-10-28).
- `packages/contract/schemas/` is the canonical copy of the `hyperdrive.importer-*.v1` schemas. Keep it identical to Hyperdrive core's `docs/schemas/` copy until core consumes this package. It also holds `wormhole-importer.v1.schema.json` (the importer manifest), which is Wormhole-only. All v1 schemas change additively only.
- `@wormhole/sdk` is the public importer API. Its v1 is additive-only (`WORMHOLE_SDK_API_VERSION`); see `docs/WRITING_AN_IMPORTER.md` § Versioning. Every importer in `packages/` must pass `@wormhole/sdk/conformance`.

## Commands

```bash
cd wormhole && pnpm install
pnpm dev                    # wormhole-ui on :3001
pnpm test                   # all package tests
pnpm test:compile-gate      # upgraded fixtures → Hyperdrive compiler (needs ../core or HYPERDRIVE_CORE_DIR; skips otherwise)
HYPERDRIVE_CORE_DIR=../core pnpm test:schema-sync   # contract schemas identical to core's docs/schemas/ (path relative to repo root; missing dir fails)
```
