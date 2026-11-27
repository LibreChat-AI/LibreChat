const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { createOAuthStateStore } = require('@librechat/api');
const socialLogin = require('./socialLogin');

const getProfileDetails = ({ profile }) => ({
  email: profile.emails[0].value,
  id: profile.id,
  avatarUrl: profile.photos[0].value,
  username: profile.name.givenName,
  name: `${profile.name.givenName}${profile.name.familyName ? ` ${profile.name.familyName}` : ''}`,
  emailVerified: profile.emails[0].verified,
});

const googleLogin = socialLogin('google', getProfileDetails);
const googleAdminLogin = socialLogin('google', getProfileDetails, { existingUsersOnly: true });

const getGoogleConfig = (callbackURL) => ({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL,
  proxy: true,
});

/** @param {Omit<import('@librechat/api').OAuthStateStoreOptions, 'provider'>} stateOptions */
const googleStrategy = (stateOptions) =>
  new GoogleStrategy(
    {
      ...getGoogleConfig(`${process.env.DOMAIN_SERVER}${process.env.GOOGLE_CALLBACK_URL}`),
      store: createOAuthStateStore({ ...stateOptions, provider: 'google' }),
    },
    googleLogin,
  );

const googleAdminStrategy = () =>
  new GoogleStrategy(
    getGoogleConfig(`${process.env.DOMAIN_SERVER}/api/admin/oauth/google/callback`),
    googleAdminLogin,
  );

module.exports = googleStrategy;
module.exports.googleAdminLogin = googleAdminStrategy;
