import fs from 'node:fs';
import path from 'node:path';

/** A passing audit needs no traces: at roughly 45 MB a run they only pay off when a budget fails. */
export function discardLighthouseTraces(directory: string): void {
  for (const file of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    if (file.endsWith('.trace.json')) fs.rmSync(path.join(directory, file));
  }
}

/** Keep measured traces, but never publish their raw network headers or session cookies. */
export function sanitizeLighthouseArtifacts(
  directory: string,
  cookies: { name: string; value: string }[],
): void {
  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const values = [...new Set(cookies.map(({ value }) => value).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const file of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    const filename = path.join(directory, file);
    if (file.endsWith('.devtoolslog.json')) {
      fs.rmSync(filename);
      continue;
    }
    if (!/\.(?:report\.(?:json|html)|trace\.json)$/.test(file)) continue;
    let content = fs.readFileSync(filename, 'utf8');
    if (cookieHeader) content = content.replaceAll(cookieHeader, '[redacted]');
    if (file.endsWith('.trace.json')) {
      // Walk string values so even short cookie values cannot corrupt numeric
      // timestamps, JSON syntax or object keys. Network logs are omitted entirely.
      try {
        content = JSON.stringify(
          JSON.parse(content, (_key, value: unknown) => {
            if (typeof value !== 'string') return value;
            let redacted = value;
            for (const secret of values) redacted = redacted.replaceAll(secret, '[redacted]');
            return redacted;
          }),
        );
      } catch {
        // An interrupted CLI may leave a partial trace. Never upload it raw.
        fs.rmSync(filename);
        continue;
      }
    }
    fs.writeFileSync(filename, content);
  }
}
