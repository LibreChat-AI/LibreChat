const { Strategy: GitHubStrategy } = require('passport-github2');
const { createOAuthStateStore } = require('@librechat/api');
const socialLogin = require('./socialLogin');

const getProfileDetails = ({ profile }) => ({
  email: profile.emails[0].value,
  id: profile.id,
  avatarUrl: profile.photos[0].value,
  username: profile.username,
  name: profile.displayName,
  emailVerified: profile.emails[0].verified,
});

const githubLogin = socialLogin('github', getProfileDetails);
const githubAdminLogin = socialLogin('github', getProfileDetails, { existingUsersOnly: true });

const getGitHubConfig = (callbackURL) => ({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL,
  proxy: false,
  scope: ['user:email'],
  ...(process.env.GITHUB_ENTERPRISE_BASE_URL && {
    authorizationURL: `${process.env.GITHUB_ENTERPRISE_BASE_URL}/login/oauth/authorize`,
    tokenURL: `${process.env.GITHUB_ENTERPRISE_BASE_URL}/login/oauth/access_token`,
    userProfileURL: `${process.env.GITHUB_ENTERPRISE_BASE_URL}/api/v3/user`,
    userEmailURL: `${process.env.GITHUB_ENTERPRISE_BASE_URL}/api/v3/user/emails`,
    ...(process.env.GITHUB_ENTERPRISE_USER_AGENT && {
      userAgent: process.env.GITHUB_ENTERPRISE_USER_AGENT,
    }),
  }),
});

/** @param {Omit<import('@librechat/api').OAuthStateStoreOptions, 'provider'>} stateOptions */
const githubStrategy = (stateOptions) =>
  new GitHubStrategy(
    {
      ...getGitHubConfig(`${process.env.DOMAIN_SERVER}${process.env.GITHUB_CALLBACK_URL}`),
      store: createOAuthStateStore({ ...stateOptions, provider: 'github' }),
    },
    githubLogin,
  );

const githubAdminStrategy = () =>
  new GitHubStrategy(
    getGitHubConfig(`${process.env.DOMAIN_SERVER}/api/admin/oauth/github/callback`),
    githubAdminLogin,
  );

module.exports = githubStrategy;
module.exports.githubAdminLogin = githubAdminStrategy;
