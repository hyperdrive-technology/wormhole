import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import {
  importerCapabilitiesSchema,
  importerDiagnosticsSchema,
  importerResultSchema,
  wormholeImporterManifestSchema,
  type JsonSchemaDocument,
} from '@wormhole/contract';

/**
 * JSON Schema validation with Ajv, the canonical JSON Schema validator for JavaScript, so
 * the SDK checks exactly what the published schemas say instead of a hand-written copy.
 *
 * `strictTypes` is off because the contract schemas use bare `not: { pattern }` guards
 * (without a sibling `type`), which are valid JSON Schema but trip Ajv's extra-strict lint.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });

const cache = new Map<JsonSchemaDocument, ValidateFunction>();

function compiled(schema: JsonSchemaDocument): ValidateFunction {
  let validate = cache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema as Record<string, unknown>);
    cache.set(schema, validate);
  }
  return validate;
}

/** Every schema violation as `"<json pointer> <message>"`; empty when valid. */
export function schemaProblems(schema: JsonSchemaDocument, value: unknown): string[] {
  const validate = compiled(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => {
    const where = error.instancePath === '' ? '(root)' : error.instancePath;
    const extra =
      error.keyword === 'additionalProperties'
        ? ` "${String((error.params as { additionalProperty?: unknown }).additionalProperty)}"`
        : error.keyword === 'enum'
          ? ` (${JSON.stringify((error.params as { allowedValues?: unknown }).allowedValues)})`
          : '';
    return `${where} ${error.message ?? error.keyword}${extra}`;
  });
}

export const SCHEMAS = {
  manifest: wormholeImporterManifestSchema,
  result: importerResultSchema,
  diagnostics: importerDiagnosticsSchema,
  capabilities: importerCapabilitiesSchema,
} as const;

export function resultManifestProblems(value: unknown): string[] {
  return schemaProblems(SCHEMAS.result, value);
}

export function diagnosticsReportProblems(value: unknown): string[] {
  return schemaProblems(SCHEMAS.diagnostics, value);
}

export function capabilitiesDocumentProblems(value: unknown): string[] {
  return schemaProblems(SCHEMAS.capabilities, value);
}
