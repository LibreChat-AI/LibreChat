const operation = process.argv[2];
if (operation === 'stall') {
  // A synchronous parser stall must be interruptible without blocking API timers.
  for (;;) {
    /* deliberate child-only stall */
  }
}
if (operation === 'crash') throw new Error('PRIVATE-PARSER-DETAIL /private/upload.xlsx');
if (operation === 'exit') process.exit(0);
if (operation === 'allocate') {
  // At most 192 MiB if the ceiling regresses; the correct child aborts earlier.
  const retained = [];
  for (let i = 0; i < 6; i++) retained.push(new Array(4 * 1024 * 1024).fill(i));
  process.send({ ok: true, text: String(retained.length) }, () => process.disconnect());
} else {
  const text =
    operation === 'heap'
      ? String(require('node:v8').getHeapStatistics().heap_size_limit / 1024 / 1024)
      : 'recovered';
  process.send({ ok: true, text }, () => process.disconnect());
}
