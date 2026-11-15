// Codex structured output requires all object properties in `required`.
// Represent optional fields as required-but-nullable on the wire, then restore
// omission before validating the application schema.
export function codexSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(codexSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result: any = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, codexSchema(value)]),
  );
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    for (const key of Object.keys(schema.properties))
      if (!required.has(key))
        result.properties[key] = { anyOf: [result.properties[key], { type: 'null' }] };
    result.required = Object.keys(schema.properties);
  }
  return result;
}
export function restoreOptionalFields(value: any, schema: any): any {
  if (Array.isArray(value)) return value.map((item) => restoreOptionalFields(item, schema?.items));
  if (!value || typeof value !== 'object') return value;
  const required = new Set(schema?.required ?? []);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, v]) => !(v === null && schema?.properties?.[key] && !required.has(key)))
      .map(([key, v]) => [key, restoreOptionalFields(v, schema?.properties?.[key])]),
  );
}
