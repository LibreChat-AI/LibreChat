import { fluxApiSchema, fluxImageIdsSchema, resolveFluxDefinition } from './definitions';

describe('resolveFluxDefinition', () => {
  it('keeps the full BFL contract by default', () => {
    const definition = resolveFluxDefinition(undefined);
    expect(definition.schema.properties?.endpoint).toBeDefined();
    expect(definition.schema.properties?.action?.enum).toContain('list_finetunes');
    expect(definition.description).toContain('list available finetunes');
  });

  it('exposes image editing for the Foundry provider route', () => {
    const definition = resolveFluxDefinition('azure-foundry');
    expect(Object.keys(definition.schema.properties ?? {}).sort()).toEqual([
      'action',
      'height',
      'image_ids',
      'prompt',
      'safety_tolerance',
      'seed',
      'width',
    ]);
    expect(definition.schema.properties?.action?.enum).toEqual(['generate', 'image_edit']);
    expect(definition.schema.properties?.image_ids).toEqual(fluxImageIdsSchema);
    expect(fluxImageIdsSchema.description).toContain('up to 8');
    expect(definition.description).toContain('BFL provider API');
  });

  it('keeps only action and prompt for the Foundry Images API', () => {
    const definition = resolveFluxDefinition('azure-foundry-images');
    expect(Object.keys(definition.schema.properties ?? {}).sort()).toEqual(['action', 'prompt']);
    expect(definition.schema.properties?.action?.enum).toEqual(['generate']);
    expect(definition.schema.properties?.image_ids).toBeUndefined();
    expect(definition.description).toContain('Images API');
  });

  it('preserves the schema envelope so registry and instance validation agree', () => {
    const definition = resolveFluxDefinition('azure-foundry');
    expect(definition.schema.required).toEqual(fluxApiSchema.required);
    expect(definition.schema.type).toEqual(fluxApiSchema.type);
  });
});
