const { createRunSettler, subscriptionSubject } = require('@librechat/api');

// Thin wiring over the TypeScript implementation in packages/api: hands how a turn of a
// triggered run ended to the subject that records the run. A schedule's runs are settled
// by the chat route as before.
module.exports = createRunSettler([subscriptionSubject(() => require('./subject'))]);
