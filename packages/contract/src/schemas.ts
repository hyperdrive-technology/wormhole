/**
 * The canonical JSON schemas as importable objects, so validators (for example
 * `@wormhole/sdk`, which uses Ajv) never need filesystem access to find them. The same
 * files are also exported as `@wormhole/contract/schemas/*.json`.
 */
import importerCapabilitiesJson from '../schemas/hyperdrive-importer-capabilities.v1.schema.json';
import importerDiagnosticsJson from '../schemas/hyperdrive-importer-diagnostics.v1.schema.json';
import importerJobJson from '../schemas/hyperdrive-importer-job.v1.schema.json';
import importerResultJson from '../schemas/hyperdrive-importer-result.v1.schema.json';
import wormholeImporterManifestJson from '../schemas/wormhole-importer.v1.schema.json';

/** A JSON Schema document (draft 2020-12). Typed loosely so declaration output stays small. */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export const importerCapabilitiesSchema: JsonSchemaDocument = importerCapabilitiesJson;
export const importerDiagnosticsSchema: JsonSchemaDocument = importerDiagnosticsJson;
export const importerJobSchema: JsonSchemaDocument = importerJobJson;
export const importerResultSchema: JsonSchemaDocument = importerResultJson;
/** Schema of `wormhole.importer.json`, the importer package manifest (`wormhole.importer.v1`). */
export const wormholeImporterManifestSchema: JsonSchemaDocument = wormholeImporterManifestJson;
