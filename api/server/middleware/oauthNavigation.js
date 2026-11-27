const { redirectToAuthFailure } = require('@librechat/api');

/**
 * Flags the request as a top-level browser navigation belonging to the OAuth flow.
 *
 * These routes are reached by the address bar (social button click, IdP redirect, SAML/Apple
 * form post), never by fetch, so any middleware that rejects them with a JSON body renders that
 * body as the page. Rejections must redirect back to the login page instead.
 *
 * @type {import('express').RequestHandler}
 */
const markOAuthNavigation = (req, _res, next) => {
  req.isOAuthNavigation = true;
  next();
};

/**
 * @param {import('express').Request} req
 * @returns {boolean} Whether the request is a top-level browser navigation in the OAuth flow.
 */
const isOAuthNavigation = (req) => req?.isOAuthNavigation === true;

/**
 * Sends the browser back to the login page carrying an error code the client localizes.
 *
 * @param {import('express').Response} res
 * @param {string} authFailedError - An `ErrorTypes` value.
 */
const redirectOAuthFailure = (res, authFailedError) =>
  redirectToAuthFailure(res, { clientDomain: process.env.DOMAIN_CLIENT, authFailedError });

module.exports = {
  markOAuthNavigation,
  isOAuthNavigation,
  redirectOAuthFailure,
};
