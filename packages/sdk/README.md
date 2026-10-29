# @wormhole/sdk

The importer SDK for [Wormhole](https://github.com/hyperdrive-technology/wormhole): everything
needed to write, run and test a PLC project importer outside the Wormhole repository.

| Entry point | Contents |
|---|---|
| `@wormhole/sdk` | `WormholeImporter` contract (`detect`, `import`), `defineImporter`, `wormhole.importer.v1` manifest validation, `VirtualFileTree`, `readZipTree`, text helpers, `ImporterHost`, `createImportContext` for unit tests |
| `@wormhole/sdk/node` | `loadInputFromPath` / `File` / `Directory` / `ZipFile`: turn a path into a `VirtualFileTree` |
| `@wormhole/sdk/conformance` | `runImporterConformance(importer, { fixtures })` → named check results |
| `@wormhole/sdk/conformance/vitest` | `describeImporterConformance(importer, { fixtures })` |
| `@wormhole/sdk/schemas/*` | The `wormhole.importer.v1` and `hyperdrive.importer-*.v1` JSON schemas |

Read [Writing an importer](../../docs/WRITING_AN_IMPORTER.md) and start from
[`templates/importer/`](../../templates/importer/).

Importer API version: `1.0.0` (`WORMHOLE_SDK_API_VERSION`), additive-only within v1.

Install (not on npm; see [§8 of the guide](../../docs/WRITING_AN_IMPORTER.md#8-depending-on-the-sdk-github-not-npm)):

```json
"dependencies": { "@wormhole/sdk": "github:hyperdrive-technology/wormhole#sdk-v0.1.0&path:/packages/sdk" },
"pnpm": { "onlyBuiltDependencies": ["@wormhole/sdk"] }
```
