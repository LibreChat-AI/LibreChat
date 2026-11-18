const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage, AIMessageChunk } = require('@librechat/agents/langchain/messages');
const { ChatGenerationChunk } = require('@langchain/core/outputs');

/** Deterministic BaseChatModel for repeatable graph/UI checks, not a live provider. */
class ExampleAdvisorModel extends BaseChatModel {
  _llmType() {
    return 'advisor-example';
  }
  bindTools() {
    return this;
  }
  async _generate(messages) {
    const { stage, payload } = JSON.parse(messages.at(-1).content);
    let content;
    if (stage === 'planner') {
      content = JSON.stringify({
        title: 'Investigate the reporting query',
        steps: ['Inspect the query plan', 'Compare a candidate against the baseline'],
        validation: payload.issues.length
          ? ['Compare result correctness and measured latency']
          : [],
      });
    } else if (stage === 'adversarial') {
      content = JSON.stringify({
        issues: payload.plan.validation.length
          ? []
          : [
              {
                severity: 'warning',
                message: 'Add correctness and latency validation before any change.',
              },
            ],
      });
    } else {
      content = `## Reviewed example plan\n\n${payload.plan.title}\n\n${payload.plan.steps.map((step) => `- ${step}`).join('\n')}\n\nValidation: ${payload.plan.validation.join('; ')}\n\nReview status: ${payload.status} (${payload.reviewAttempts} rounds).\n${payload.issues.map((issue) => issue.message).join('\n')}\nNo changes have been executed.`;
    }
    return {
      generations: [
        {
          text: content,
          message: new AIMessage({
            content,
            usage_metadata: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
          }),
        },
      ],
    };
  }
  async *_streamResponseChunks(messages, options) {
    options.signal?.throwIfAborted();
    const { generations } = await this._generate(messages);
    const message = generations[0].message;
    for (let i = 0; i < message.content.length; i += 32) {
      options.signal?.throwIfAborted();
      const content = message.content.slice(i, i + 32);
      yield new ChatGenerationChunk({ text: content, message: new AIMessageChunk({ content }) });
    }
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        usage_metadata: message.usage_metadata,
      }),
    });
  }
}

/** The same BaseChatModel pair boundary used by Schema Advisor's graph dependencies. */
function createAdvisorModels(env = process.env) {
  const provider = env.SDK_ADVISOR_PROVIDER ?? 'fixture';
  if (provider === 'fixture')
    return { chat: new ExampleAdvisorModel({}), fast: new ExampleAdvisorModel({}) };
  const primary = env.SDK_ADVISOR_PRIMARY_MODEL;
  const fast = env.SDK_ADVISOR_FAST_MODEL ?? primary;
  if (!primary) throw new Error('Set SDK_ADVISOR_PRIMARY_MODEL for live execution');
  if (provider === 'bedrock') {
    const { ChatBedrockConverse } = require('@langchain/aws');
    const create = (model) =>
      new ChatBedrockConverse({ model, region: env.AWS_REGION, maxTokens: 2048 });
    return { chat: create(primary), fast: create(fast) };
  }
  if (provider === 'anthropic') {
    const { ChatAnthropic } = require('@langchain/anthropic');
    if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY for live execution');
    const create = (model) =>
      new ChatAnthropic({
        model,
        apiKey: env.ANTHROPIC_API_KEY,
        anthropicApiUrl: env.SDK_ADVISOR_ANTHROPIC_URL,
        maxTokens: 2048,
        invocationKwargs: { top_p: undefined, top_k: undefined },
        clientOptions: { authToken: null },
      });
    return { chat: create(primary), fast: create(fast) };
  }
  throw new Error('SDK_ADVISOR_PROVIDER must be fixture, anthropic, or bedrock');
}

module.exports = { ExampleAdvisorModel, createAdvisorModels };
