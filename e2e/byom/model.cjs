/** Deterministic model only: every tool still runs through the production host. */
module.exports = (run, context) => {
  const user = [...context.messages].reverse().find((message) => message.getType() === 'human');
  const text = typeof user?.content === 'string' ? user.content : '';
  const match = /^BYOM_ACCEPTANCE:(\w+)$/.exec(text);
  const operation = match?.[1];
  const calls = {
    create: [
      'create_file',
      { path: 'workspace/proof.txt', content: 'native-original', overwrite: false },
    ],
    edit: [
      'edit_file',
      { path: 'workspace/proof.txt', old_text: 'native-original', new_text: 'native-edited' },
    ],
    read: ['read_file', { path: 'workspace/proof.txt' }],
    fullCreate: [
      'create_file',
      { path: 'workspace/unattended.txt', content: 'native-unattended', overwrite: false },
    ],
    reject: [
      'create_file',
      { path: 'workspace/rejected.txt', content: 'must-not-exist', overwrite: false },
    ],
    offline: [
      'create_file',
      { path: 'workspace/offline.txt', content: 'must-not-fallback', overwrite: false },
    ],
    command: ['bash_tool', { command: 'printf native-command-ok' }],
  };
  const call = calls[operation];
  if (!call) {
    run.Graph.overrideTestModel(['Acceptance model ready.'], 5);
    return;
  }
  run.Graph.overrideTestModel(['', 'Acceptance tool invocation finished.'], 5, [
    {
      id: `call_native_${operation}_${user.id}`,
      name: call[0],
      args: call[1],
      type: 'tool_call',
    },
  ]);
};
