import type { SchemaDefinitionProperty } from 'mongoose';
interface AgentFadingContextDefinition {
  fading: SchemaDefinitionProperty;
  fadingTiers: SchemaDefinitionProperty;
}

/** Mongoose definition of one persisted context-fading tier (`IAgentFadingTier`). */
const agentFadingTierDefinition = {
  v: { type: Number, enum: [1, 2], required: true },
  budgetTokens: { type: Number, min: 1, required: true },
  masked: { type: Boolean, required: true },
};

/**
 * Mongoose definition of the fading fields inside a persisted `contextMeta`: the
 * default agent's tier and the per-agent entries. Shared by the message and
 * conversation schemas so both persist exactly the same compact shape.
 */
export const agentFadingContextDefinition: AgentFadingContextDefinition = {
  fading: {
    type: agentFadingTierDefinition,
    _id: false,
    default: undefined,
  },
  fadingTiers: {
    type: [
      {
        agentId: { type: String, required: true },
        ...agentFadingTierDefinition,
        _id: false,
      },
    ],
    default: undefined,
  },
};
