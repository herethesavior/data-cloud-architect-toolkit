/** Salesforce ids and API names are alphanumeric with underscores; namespaces may use dots. */
const TRANSFORM_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.~-]{0,127}$/;
const TRANSFORM_ID_MAX_LENGTH = 128;

/** Platform-neutral guard used before a transform id enters a REST path or relay request. */
export function isValidTransformId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= TRANSFORM_ID_MAX_LENGTH
    && TRANSFORM_ID_PATTERN.test(id)
    && !id.includes('..');
}
