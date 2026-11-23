import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export function unsafeSymlinks(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const links = new Map();
  // Read Git modes and blobs, including on checkouts with core.symlinks=false.
  for (const entry of git('ls-files', '--stage', '-z').split('\0')) {
    if (!entry.startsWith('120000 ')) continue;
    const tab = entry.indexOf('\t');
    const [, hash] = entry.slice(0, tab).split(' ');
    links.set(entry.slice(tab + 1), git('cat-file', 'blob', hash));
  }

  const unsafe = [];
  for (const link of links.keys()) {
    const pending = link.split('/');
    const resolved = [];
    let followed = 0;
    while (pending.length > 0) {
      const component = pending.shift();
      if (component === '' || component === '.') continue;
      if (component === '..') {
        if (resolved.length === 0) {
          unsafe.push(link);
          break;
        }
        resolved.pop();
        continue;
      }
      resolved.push(component);
      const target = links.get(resolved.join('/'));
      if (target === undefined) continue;
      if (posix.isAbsolute(target) || target === '' || ++followed > 40) {
        unsafe.push(link);
        break;
      }
      resolved.pop();
      pending.unshift(...target.split('/'));
    }
  }
  return unsafe;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const unsafe = unsafeSymlinks();
  for (const path of unsafe) {
    console.error(
      `Unsafe tracked symlink: ${JSON.stringify(path)}. Use a repository-relative, in-bounds target without cycles.`,
    );
  }
  if (unsafe.length > 0) process.exitCode = 1;
  else console.log('All tracked symlinks stay within the repository.');
}
