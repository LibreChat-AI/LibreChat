const mongoose = require('mongoose');

const originalExec = mongoose.Query.prototype.exec;
mongoose.Query.prototype.exec = async function serialUserReads(...args) {
  if (this.model.collection.name === 'messages' && this.op === 'find') {
    for (let i = 0; i < 16; i++) {
      await mongoose.model('User').findById(this.getFilter().user).lean().exec();
    }
  }
  return originalExec.apply(this, args);
};
