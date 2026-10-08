const axios = require('axios');
const {
  isEnabled,
  getReferencedQuotes,
  mergeQuotedText,
  getBoundedAskUserAnswerValues,
  serializeAskUserAnswerVariants,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const denyRequest = require('./denyRequest');

async function moderateText(req, res, next) {
  if (!isEnabled(process.env.OPENAI_MODERATION)) {
    return next();
  }
  try {
    const { text } = req.body;

    /**
     * Moderate the typed text, each quoted excerpt, and the merged blockquote+text
     * exactly as the model receives it. Quotes are normalized via
     * `getReferencedQuotes` first (matching `BaseClient`); moderating the merged
     * string also covers content split across a quote and the typed body. The
     * moderation API accepts an array of inputs.
     *
     * `answer` covers the HITL resume payload (POST /agents/chat/resume) for an
     * ask-user question — the user's free-form text — so it's moderated like a typed
     * message. A tool-approval resume carries no user text and is skipped below.
     */
    let safeText = '';
    if (typeof text === 'string') {
      safeText = text;
    } else if (typeof req.body.answer === 'string') {
      safeText = req.body.answer;
    }
    const inputs = [];
    if (safeText.length > 0) {
      inputs.push(safeText);
    }
    if (
      req.body.answers != null &&
      typeof req.body.answers === 'object' &&
      !Array.isArray(req.body.answers)
    ) {
      for (const answer of getBoundedAskUserAnswerValues(req.body.answers)) {
        if (answer.length > 0) {
          inputs.push(answer);
        }
      }
      inputs.push(...serializeAskUserAnswerVariants(req.body.answers));
    }
    const quotes = getReferencedQuotes(req.body.quotes);
    if (quotes != null) {
      inputs.push(...quotes);
      inputs.push(mergeQuotedText(safeText, quotes));
    }
    // A tool-approval resume can carry user-authored text in `decisions[]`: the
    // `respond` substitute result, a `reject` reason, and `edit`ed tool arguments —
    // moderate all of them like typed text (edited args stringified).
    if (Array.isArray(req.body.decisions)) {
      for (const decision of req.body.decisions) {
        if (typeof decision?.responseText === 'string' && decision.responseText.length > 0) {
          inputs.push(decision.responseText);
        }
        if (typeof decision?.reason === 'string' && decision.reason.length > 0) {
          inputs.push(decision.reason);
        }
        if (decision?.editedArguments != null) {
          try {
            const edited = JSON.stringify(decision.editedArguments);
            if (typeof edited === 'string' && edited.length > 0) {
              inputs.push(edited);
            }
          } catch {
            /* ignore unstringifiable edited args */
          }
        }
      }
    }
    // Nothing to moderate (e.g. a tool-approval resume with no `respond` text) —
    // don't post an empty/undefined `input`, which the moderation API rejects and which
    // would otherwise deny the request.
    if (inputs.length === 0) {
      return next();
    }
    const input = inputs.length > 1 ? inputs : inputs[0];

    const response = await axios.post(
      process.env.OPENAI_MODERATION_REVERSE_PROXY || 'https://api.openai.com/v1/moderations',
      {
        input,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_MODERATION_API_KEY}`,
        },
      },
    );

    const results = response.data.results;
    const flagged = results.some((result) => result.flagged);

    if (flagged) {
      const type = ErrorTypes.MODERATION;
      const errorMessage = { type };
      return await denyRequest(req, res, errorMessage);
    }
  } catch (error) {
    logger.error('Error in moderateText:', error);
    const errorMessage = 'error in moderation check';
    return await denyRequest(req, res, errorMessage);
  }
  next();
}

module.exports = moderateText;
