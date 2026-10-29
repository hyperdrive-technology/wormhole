/**
 * Version of the importer *API* (the contract in this package), as opposed to the npm
 * version of `@wormhole/sdk`. Importer manifests declare a semver range against it in their
 * `sdk` field, and `ImporterHost.register` refuses importers whose range excludes it.
 *
 * Versioning policy: v1 is additive-only. New optional fields, new optional context
 * members and new diagnostics codes bump the minor version; nothing in v1 is removed or
 * changes meaning. A breaking change would be API 2.0.0 and a `wormhole.importer.v2`
 * manifest.
 */
export const WORMHOLE_SDK_API_VERSION = '1.0.0';
