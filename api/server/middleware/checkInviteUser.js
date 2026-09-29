const { getInvite: getInviteFn } = require('@librechat/api');
const { createToken, findToken } = require('~/models');

const getInvite = (encodedToken, email) =>
  getInviteFn(encodedToken, email, { createToken, findToken });

async function checkInviteUser(req, res, next) {
  const token = req.body.token;

  if (!token || token === 'undefined') {
    next();
    return;
  }

  try {
    const invite = await getInvite(token, req.body.email);

    if (!invite || invite.error === true) {
      return res.status(400).json({ message: 'Invalid invite token' });
    }

    /** The invite is deliberately left in place here. Everything that can still
     * reject this registration — the schema, the allowed-domain check, an email
     * already in use — runs after this middleware, and consuming the invite first
     * meant a mistyped password confirmation destroyed it. `registrationController`
     * deletes it once an account actually exists. */
    req.invite = invite;
    next();
  } catch (error) {
    return res.status(429).json({ message: error.message });
  }
}

module.exports = checkInviteUser;
