const { sendEvent, getTransactionsConfig } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys, RunStatus, isUUID } = require('librechat-data-provider');
const { initializeClient } = require('~/server/services/Endpoints/assistants');
const { checkMessageGaps, recordUsage } = require('~/server/services/Threads');
const { deleteMessages, getConvo } = require('~/models');
const getLogStores = require('~/cache/getLogStores');

const three_minutes = 1000 * 60 * 3;

async function abortRun(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const { abortKey, endpoint } = req.body;
  const [conversationId, latestMessageId] = abortKey.split(':');
  const conversation = await getConvo(req.user.id, conversationId);

  if (conversation?.model) {
    req.body = req.body || {}; // Express 5: ensure req.body exists
    req.body.model = conversation.model;
  }

  if (!isUUID.safeParse(conversationId).success) {
    logger.error('[abortRun] Invalid conversationId', { conversationId });
    return res.status(400).send({ message: 'Invalid conversationId' });
  }

  const cacheKey = `${req.user.id}:${conversationId}`;
  const cache = getLogStores(CacheKeys.ABORT_KEYS);
  const runValues = await cache.get(cacheKey);
  if (!runValues) {
    logger.warn('[abortRun] Run not found in cache', { cacheKey });
    return res.status(204).send({ message: 'Run not found' });
  }
  const [thread_id, run_id] = runValues.split(':');

  if (!run_id) {
    logger.warn("[abortRun] Couldn't find run for cancel request", { thread_id });
    return res.status(204).send({ message: 'Run not found' });
  } else if (run_id === 'cancelled') {
    logger.warn('[abortRun] Run already cancelled', { thread_id });
    return res.status(204).send({ message: 'Run already cancelled' });
  }

  let runMessages = [];
  /** @type {{ openai: OpenAI }} */
  const { openai } = await initializeClient({ req, res });

  try {
    await cache.set(cacheKey, 'cancelled', three_minutes);
    const cancelledRun = await openai.beta.threads.runs.cancel(run_id, { thread_id });
    logger.debug('[abortRun] Cancelled run:', cancelledRun);
  } catch (error) {
    logger.error('[abortRun] Error cancelling run', error);
    if (
      error?.message?.includes(RunStatus.CANCELLED) ||
      error?.message?.includes(RunStatus.CANCELLING)
    ) {
      return res.end();
    }
  }

  try {
    const run = await openai.beta.threads.runs.retrieve(run_id, { thread_id });
    await recordUsage({
      ...run.usage,
      model: run.model,
      user: req.user.id,
      conversationId,
      transactions: getTransactionsConfig(req.config),
    });
  } catch (error) {
    logger.error('[abortRun] Error fetching or processing run', error);
  }

  /* TODO: a reconciling strategy between the existing intermediate message would be more optimal than deleting it */
  await deleteMessages({
    user: req.user.id,
    unfinished: true,
    conversationId,
  });
  runMessages = await checkMessageGaps({
    openai,
    run_id,
    endpoint,
    thread_id,
    conversationId,
    latestMessageId,
  });

  const finalEvent = {
    final: true,
    conversation,
    runMessages,
  };

  if (res.headersSent && finalEvent) {
    return sendEvent(res, finalEvent);
  }

  res.json(finalEvent);
}

module.exports = {
  abortRun,
};
