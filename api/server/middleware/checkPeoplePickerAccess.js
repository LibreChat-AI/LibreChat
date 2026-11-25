const { createPeoplePickerAccess } = require('@librechat/api');
const { getRoleByName } = require('~/models');

const checkPeoplePickerAccess = createPeoplePickerAccess({ getRoleByName });

module.exports = {
  checkPeoplePickerAccess,
};
