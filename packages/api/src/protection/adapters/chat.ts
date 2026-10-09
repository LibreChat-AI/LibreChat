import type { ContentFieldMap, ContentSource, TextContentFragment } from '../types';
import type { ModelParameterContentInput } from './submissions';
import {
  extractModelParameterContent,
  extractToolArgumentContent,
  visitBoundedSubmittedArray,
} from './submissions';
import {
  ContentTraversalLimitError,
  getContentTraversalFragments,
  getContentTraversalScopes,
} from './nested';
import { getReferencedQuoteEntries, mergeQuotedText } from '../../utils/quotes';

export interface ChatSubmissionDecision {
  readonly responseText?: string;
  readonly reason?: string;
  readonly editedArguments?: unknown;
}

export interface ChatSubmissionBody extends ModelParameterContentInput {
  readonly input?: string;
  readonly text?: string;
  readonly quotes?: unknown;
  readonly answer?: string;
  readonly promptPrefix?: string | null;
  readonly system?: string;
  readonly context?: string | null;
  readonly instructions?: string | null;
  readonly additional_instructions?: string | null;
  readonly greeting?: string;
  readonly artifacts?: string;
  readonly manualSkills?: readonly unknown[];
  readonly examples?: readonly (
    | {
        readonly input?: string | { readonly content?: string };
        readonly output?: string | { readonly content?: string };
      }
    | null
    | undefined
  )[];
  readonly ephemeralAgent?: {
    readonly artifacts?: string;
  } | null;
  readonly addedConvo?: {
    readonly promptPrefix?: string | null;
    readonly additional_instructions?: string | null;
    readonly artifacts?: string;
    readonly ephemeralAgent?: {
      readonly artifacts?: string;
    } | null;
  } | null;
  readonly editedContent?: {
    readonly text?: string;
  } | null;
  readonly decisions?: readonly (ChatSubmissionDecision | null | undefined)[];
}

function createFragment<Source extends ContentSource>(
  id: string,
  path: TextContentFragment['path'],
  text: string,
  source: Source,
  field: ContentFieldMap[Source],
  format: TextContentFragment['format'] = 'plain',
  treatment: TextContentFragment['treatment'] = 'replaceable',
): Extract<TextContentFragment, { source: Source }> {
  return {
    id,
    path,
    text,
    source,
    field,
    format,
    treatment,
    provenance: 'user',
  } as Extract<TextContentFragment, { source: Source }>;
}

function remapEditedArgumentFragments(
  fragments: readonly TextContentFragment[],
  decisionIndex: number,
): readonly TextContentFragment[] {
  const sourcePath = '/arguments';
  const targetPath = `/decisions/${decisionIndex}/editedArguments`;
  return fragments.map((fragment) => ({
    ...fragment,
    id: fragment.id.replace('tool-argument.arguments', `chat.decision.${decisionIndex}.arguments`),
    path: `${targetPath}${
      fragment.path.startsWith(sourcePath) ? fragment.path.slice(sourcePath.length) : ''
    }` as TextContentFragment['path'],
  }));
}

export function extractChatContent(
  body: ChatSubmissionBody | null | undefined,
): readonly TextContentFragment[] {
  const fragments: TextContentFragment[] = [];
  const traversalErrors: ContentTraversalLimitError[] = [];
  const submittedArrayBudget = { visitedNodes: 0 };
  const text = typeof body?.text === 'string' ? body.text : '';

  if (text.length > 0) {
    fragments.push(createFragment('chat.text', '/text', text, 'message', 'text'));
  }

  if (typeof body?.input === 'string' && body.input.length > 0) {
    fragments.push(createFragment('chat.input', '/input', body.input, 'message', 'text'));
  }

  const quoteEntries = getReferencedQuoteEntries(body?.quotes);
  if (quoteEntries != null) {
    const quotes: string[] = [];
    for (const quote of quoteEntries) {
      quotes.push(quote.text);
      fragments.push(
        createFragment(
          `chat.quote.${quote.sourceIndex}`,
          `/quotes/${quote.sourceIndex}`,
          quote.text,
          'message',
          'quote',
        ),
      );
    }
    fragments.push(
      createFragment(
        'chat.assembled.quote-text',
        '/$assembled/quote-text',
        mergeQuotedText(text, quotes),
        'assembled_context',
        'assembled_context',
        'markdown',
        'inspect_only',
      ),
    );
  }

  if (typeof body?.answer === 'string' && body.answer.length > 0) {
    fragments.push(createFragment('chat.answer', '/answer', body.answer, 'message', 'answer'));
  }

  if (typeof body?.promptPrefix === 'string' && body.promptPrefix.length > 0) {
    fragments.push(
      createFragment(
        'chat.prompt-prefix',
        '/promptPrefix',
        body.promptPrefix,
        'agent_instruction',
        'instructions',
      ),
      createFragment(
        'chat.prompt-prefix.preset',
        '/promptPrefix',
        body.promptPrefix,
        'prompt',
        'preset_text',
      ),
    );
  }
  if (typeof body?.instructions === 'string' && body.instructions.length > 0) {
    fragments.push(
      createFragment(
        'chat.instructions',
        '/instructions',
        body.instructions,
        'agent_instruction',
        'instructions',
      ),
    );
  }
  if (
    typeof body?.additional_instructions === 'string' &&
    body.additional_instructions.length > 0
  ) {
    fragments.push(
      createFragment(
        'chat.additional-instructions',
        '/additional_instructions',
        body.additional_instructions,
        'agent_instruction',
        'additional_instructions',
      ),
    );
  }
  if (typeof body?.artifacts === 'string' && body.artifacts.length > 0) {
    fragments.push(
      createFragment(
        'chat.artifacts',
        '/artifacts',
        body.artifacts,
        'agent_instruction',
        'artifacts',
      ),
    );
  }
  if (
    typeof body?.ephemeralAgent?.artifacts === 'string' &&
    body.ephemeralAgent.artifacts.length > 0
  ) {
    fragments.push(
      createFragment(
        'chat.ephemeral-agent.artifacts',
        '/ephemeralAgent/artifacts',
        body.ephemeralAgent.artifacts,
        'agent_instruction',
        'artifacts',
      ),
    );
  }
  if (typeof body?.system === 'string' && body.system.length > 0) {
    fragments.push(createFragment('chat.system', '/system', body.system, 'prompt', 'system'));
  }
  if (typeof body?.context === 'string' && body.context.length > 0) {
    fragments.push(createFragment('chat.context', '/context', body.context, 'prompt', 'context'));
  }
  if (typeof body?.greeting === 'string' && body.greeting.length > 0) {
    fragments.push(
      createFragment('chat.greeting', '/greeting', body.greeting, 'prompt', 'greeting'),
    );
  }
  const examplesComplete = visitBoundedSubmittedArray<
    NonNullable<ChatSubmissionBody['examples']>[number]
  >(body?.examples, submittedArrayBudget, (example, index) => {
    const exampleInput =
      typeof example?.input === 'string' ? example.input : example?.input?.content;
    const exampleOutput =
      typeof example?.output === 'string' ? example.output : example?.output?.content;
    if (typeof exampleInput === 'string' && exampleInput.length > 0) {
      fragments.push(
        createFragment(
          `chat.example.${index}.input`,
          `/examples/${index}/input`,
          exampleInput,
          'prompt',
          'example_input',
        ),
      );
    }
    if (typeof exampleOutput === 'string' && exampleOutput.length > 0) {
      fragments.push(
        createFragment(
          `chat.example.${index}.output`,
          `/examples/${index}/output`,
          exampleOutput,
          'prompt',
          'example_output',
        ),
      );
    }
  });
  if (!examplesComplete) {
    traversalErrors.push(
      new ContentTraversalLimitError(
        [],
        [{ source: 'prompt', fields: ['example_input', 'example_output'] }],
      ),
    );
  }
  if (
    typeof body?.addedConvo?.promptPrefix === 'string' &&
    body.addedConvo.promptPrefix.length > 0
  ) {
    fragments.push(
      createFragment(
        'chat.added-conversation.prompt-prefix',
        '/addedConvo/promptPrefix',
        body.addedConvo.promptPrefix,
        'agent_instruction',
        'instructions',
      ),
      createFragment(
        'chat.added-conversation.prompt-prefix.preset',
        '/addedConvo/promptPrefix',
        body.addedConvo.promptPrefix,
        'prompt',
        'preset_text',
      ),
    );
  }
  if (
    typeof body?.addedConvo?.additional_instructions === 'string' &&
    body.addedConvo.additional_instructions.length > 0
  ) {
    fragments.push(
      createFragment(
        'chat.added-conversation.additional-instructions',
        '/addedConvo/additional_instructions',
        body.addedConvo.additional_instructions,
        'agent_instruction',
        'additional_instructions',
      ),
    );
  }
  if (typeof body?.addedConvo?.artifacts === 'string' && body.addedConvo.artifacts.length > 0) {
    fragments.push(
      createFragment(
        'chat.added-conversation.artifacts',
        '/addedConvo/artifacts',
        body.addedConvo.artifacts,
        'agent_instruction',
        'artifacts',
      ),
    );
  }
  if (
    typeof body?.addedConvo?.ephemeralAgent?.artifacts === 'string' &&
    body.addedConvo.ephemeralAgent.artifacts.length > 0
  ) {
    fragments.push(
      createFragment(
        'chat.added-conversation.ephemeral-agent.artifacts',
        '/addedConvo/ephemeralAgent/artifacts',
        body.addedConvo.ephemeralAgent.artifacts,
        'agent_instruction',
        'artifacts',
      ),
    );
  }
  if (typeof body?.editedContent?.text === 'string' && body.editedContent.text.length > 0) {
    fragments.push(
      createFragment(
        'chat.edited-content.text',
        '/editedContent/text',
        body.editedContent.text,
        'message',
        'content_part',
      ),
    );
  }
  const manualSkillsComplete = visitBoundedSubmittedArray<unknown>(
    body?.manualSkills,
    submittedArrayBudget,
    (skillName, index) => {
      if (typeof skillName !== 'string' || skillName.length === 0) {
        return;
      }
      fragments.push(
        createFragment(
          `chat.manual-skill.${index}`,
          `/manualSkills/${index}`,
          skillName,
          'skill',
          'name',
        ),
      );
    },
  );
  if (!manualSkillsComplete) {
    traversalErrors.push(
      new ContentTraversalLimitError([], [{ source: 'skill', fields: ['name'] }]),
    );
  }
  const decisionsComplete = visitBoundedSubmittedArray<ChatSubmissionDecision>(
    body?.decisions,
    submittedArrayBudget,
    (decision, index) => {
      if (typeof decision?.responseText === 'string' && decision.responseText.length > 0) {
        fragments.push(
          createFragment(
            `chat.decision.${index}.response`,
            `/decisions/${index}/responseText`,
            decision.responseText,
            'message',
            'decision_response',
          ),
        );
      }
      if (typeof decision?.reason === 'string' && decision.reason.length > 0) {
        fragments.push(
          createFragment(
            `chat.decision.${index}.reason`,
            `/decisions/${index}/reason`,
            decision.reason,
            'message',
            'decision_reason',
          ),
        );
      }
      if (decision?.editedArguments == null) {
        return;
      }
      try {
        fragments.push(
          ...remapEditedArgumentFragments(
            extractToolArgumentContent(
              { arguments: decision.editedArguments },
              submittedArrayBudget,
            ),
            index,
          ),
        );
      } catch (error) {
        if (!(error instanceof ContentTraversalLimitError)) {
          throw error;
        }
        fragments.push(...remapEditedArgumentFragments(getContentTraversalFragments(error), index));
        traversalErrors.push(error);
      }
    },
  );
  if (!decisionsComplete) {
    traversalErrors.push(
      new ContentTraversalLimitError(
        [],
        [
          { source: 'message', fields: ['decision_response', 'decision_reason'] },
          { source: 'tool_argument', fields: ['arguments'] },
        ],
      ),
    );
  }

  try {
    fragments.push(...extractModelParameterContent(body));
  } catch (error) {
    if (!(error instanceof ContentTraversalLimitError)) {
      throw error;
    }
    fragments.push(...getContentTraversalFragments(error));
    traversalErrors.push(error);
  }

  if (traversalErrors.length > 0) {
    const scopes = traversalErrors.flatMap((error) => getContentTraversalScopes(error));
    if (scopes.length === 0) {
      scopes.push({ source: 'tool_argument', fields: ['arguments'] });
    }
    throw new ContentTraversalLimitError(fragments, scopes);
  }

  return fragments;
}
