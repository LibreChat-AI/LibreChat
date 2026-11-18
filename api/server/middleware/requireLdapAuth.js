const passport = require('passport');
const { createRequireLdapAuth } = require('@librechat/api');

module.exports = createRequireLdapAuth({ authenticate: passport.authenticate.bind(passport) });
