import { expect, test } from '@playwright/test';
import { extname, join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import type { Difference, Gap, Row } from './outside-host.helpers';
import {
  FIXTURES,
  FIXTURE_NAMES,
  IMAGE_PATH,
  IMAGE_PNG_BASE64,
} from '../../../outside-host/fixtures';
import {
  describe,
  collectRows,
  compareRows,
  waitForRows,
  openDisclosures,
} from './outside-host.helpers';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * An app that is not LibreChat draws the same conversations LibreChat does, with
 * `@librechat/chat` alone: the page in `e2e/outside-host` is built with plain Vite and loads the
 * package's compiled stylesheet and shipped strings, with no LibreChat code, server or config.
 * Each fixture is drawn twice, by LibreChat's chat view (its messages served through intercepted
 * routes) and by that page, and the two are compared element by element: the text a reader sees
 * and the styles it is drawn with.
 *
 * What the package cannot draw yet is listed in `GAPS`, each with the change that closes it.
 * Those differences are expected; any other fails the check, and so does a gap that no longer
 * reproduces, so the list is deleted as the package catches up.
 */

const OUT = resolve(repoRoot, 'e2e/specs/.test-results/outside-host');
const DIST = join(OUT, 'dist');
const CHAT = resolve(repoRoot, 'packages/chat');
const ORIGIN = 'http://outside.test';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const IMAGE = Buffer.from(IMAGE_PNG_BASE64, 'base64');

/**
 * Exactly the elements a gap names, missing from or added to the reply of one fixture. A gap
 * accepts nothing else, so an unrelated element that goes missing beside it stays unexplained.
 */
const elements =
  (fixture: string, named: { missing?: string[]; extra?: string[] }) => (difference: Difference) =>
    difference.fixture === fixture &&
    difference.row === 1 &&
    difference.part === 'body' &&
    ((difference.kind === 'missing' && (named.missing ?? []).includes(difference.key)) ||
      (difference.kind === 'extra' && (named.extra ?? []).includes(difference.key)));

/** The key of each fixture's prompt, the one paragraph its bubble holds. */
const promptOf = (fixture: string): string => `p:${String(FIXTURES[fixture]?.messages[0]?.text)}`;

/** Each property of a style difference, as `[property, LibreChat, outside]`. */
const changes = (difference: Difference): Array<[string, string, string]> =>
  (difference.detail ?? '').split('; ').map((change) => {
    const [property, values = ''] = change.split(': ');
    const [before = '', after = ''] = values.split(' -> ');
    return [property, before, after];
  });

/** A style difference that changes only the given properties. */
const restyles = (difference: Difference, properties: string[]): boolean =>
  difference.kind === 'style' &&
  (difference.changed ?? []).length > 0 &&
  (difference.changed ?? []).every((property) => properties.includes(property));

/** What follows a font size: a smaller font gives a smaller line, radius and padding. */
const SIZES = ['font-size', 'line-height', 'border-top-left-radius', 'padding-top', 'padding-left'];

/** What the package cannot draw today. Delete an entry when the change it names lands. */
const GAPS: Gap[] = [
  {
    id: 'text-only-body',
    why: 'A message with no content parts, which is every user prompt, is drawn by the messages host slot `renderMessageBody`. The package has no default for it, so an outside app shows an empty bubble. Closed by a default body in the package.',
    matches: (difference) =>
      difference.row === 0 &&
      difference.part === 'body' &&
      difference.kind === 'missing' &&
      difference.key === promptOf(difference.fixture),
  },
  {
    id: 'message-icon',
    why: "The author line's icon is the messages host slot `renderMessageIcon`, which draws nothing by default. Closed by a default icon from the endpoint and model.",
    matches: (difference) =>
      difference.row === 1 &&
      difference.part === 'header' &&
      difference.key === 'icon' &&
      difference.kind === 'missing',
  },
  {
    id: 'inherited-text-color',
    why: "Text that names no color of its own inherits it from the page. LibreChat's page sets the primary text color; `.librechat` does not, so a tool row, a reasoning header or a status line is black on an outside page. Closed by giving `.librechat` the text color in `standalone.css`, or by the README telling the app to.",
    matches: (difference) =>
      restyles(difference, ['color', 'border-top-color']) &&
      changes(difference).every(
        ([, before, after]) => before === 'rgb(33, 33, 33)' && after === 'rgb(0, 0, 0)',
      ),
  },
  {
    id: 'reply-code-and-math-size',
    why: "A reply's code block and display math are sized by rules in `client/src/style.css` (`.message-content pre`, `.message-content pre code`) that no package ships, so outside LibreChat they set at 14px where LibreChat sets 16px. Closed by moving those rules into `@librechat/client`'s prose stylesheet.",
    matches: (difference) =>
      difference.fixture === 'prose' &&
      (difference.scope === 'code' || difference.scope === 'math') &&
      restyles(difference, SIZES) &&
      changes(difference).every(([, before, after]) => parseFloat(after) < parseFloat(before)),
  },
  {
    id: 'reply-link-style',
    why: "A link in a reply is weight 700 and rgb(0, 102, 204) in LibreChat, weight 500 and rgb(37, 99, 235) outside: `standalone.css` compiles the typography plugin's own link rule, which LibreChat's stylesheet overrides. Closed by shipping LibreChat's link rule with the prose stylesheet.",
    matches: (difference) =>
      difference.fixture === 'prose' &&
      difference.scope === 'link' &&
      restyles(difference, ['font-weight', 'color']),
  },
  {
    id: 'run-code',
    why: 'A code block runs code only through the parts host slot `renderCodeBlock`. LibreChat supplies the run button and its output; without it the block copies and downloads. A capability of the host, listed so the check notices if the default changes.',
    matches: elements('prose', {
      missing: [
        'button:Run Code',
        'span:Run Code',
        'span:Running...',
        'span:Complete!',
        'span:Failed',
      ],
    }),
  },
  {
    id: 'parallel-column-header',
    why: "Agents that ran side by side get a column header (the agent's name and a branch button) only from the `renderColumnHeader` slot. Closed by a default header in the package.",
    matches: elements('parallel', {
      missing: [
        'span:agent_lane_one',
        'span:agent_lane_two',
        'button:Create branch from this response',
      ],
    }),
  },
  {
    id: 'subagent-card',
    why: 'A subagent call is drawn by LibreChat\'s adapter over the package card; outside it is a generic tool card ("Ran subagent"). Closed by the subagent card defaulting from the parts host.',
    matches: elements('subagent', {
      missing: ['button:Ran agent', 'span:Ran agent'],
      /** The generic tool card drawn in its place, and what it shows when opened. */
      extra: [
        'span:Ran subagent',
        'button:',
        'pre:The logs show two restarts.',
        'button:Copy',
        'span:Parameters',
        'span:description',
        'span:Summarize the logs',
        'span:subagent_type',
        'span:researcher',
      ],
    }),
  },
  {
    id: 'error-part',
    why: "An error part draws nothing outside LibreChat: its card and the error-code registry are the app's. Closed by moving the error card into the package.",
    matches: elements('error', {
      missing: [
        'div[alert]:',
        'div:Mock Provider A could not complete this request.',
        'div:The provider rejected the request.',
      ],
    }),
  },
  {
    id: 'approval-controls',
    why: 'A tool call paused for review shows LibreChat\'s approval controls (the reason, Approve, Reject); outside it reads "Cancelled". Closed by moving the approval and question cards into the package.',
    matches: elements('approval', {
      missing: ['p:Deletes two records', 'button:Approve', 'button:Reject', 'button:Submit'],
    }),
  },
];

async function buildOutsideHost(): Promise<void> {
  /** The stylesheet and the strings an outside app imports are written by their own build steps,
   *  which LibreChat's own build does not run. */
  for (const [file, script] of [
    ['dist/standalone.css', 'build:css'],
    ['dist/locales/en.json', 'build:locales'],
  ] as const) {
    if (!existsSync(join(CHAT, file))) {
      const result = run('npm', ['run', script, '--prefix', CHAT]);
      expect(result.status, `${script} failed:\n${result.output}`).toBe(0);
    }
  }
  const result = run(process.execPath, [resolve(repoRoot, 'e2e/outside-host/build.mjs'), DIST]);
  expect(result.status, `the outside host did not build:\n${result.output}`).toBe(0);
}

async function serveImage(page: Page): Promise<void> {
  await page.route(`**${IMAGE_PATH}*`, (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: IMAGE }),
  );
}

/** LibreChat's chat view, with the fixture's conversation and messages served by intercepted routes. */
async function drawInLibreChat(page: Page, name: string): Promise<Row[]> {
  const fixture = FIXTURES[name];
  const id = String(fixture.conversation.conversationId);
  await page.route(new RegExp(`/api/convos/${id}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixture.conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${id}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fixture.messages),
    }),
  );
  await serveImage(page);
  await page.goto(`/c/${id}`, { timeout: 30_000 });
  await waitForRows(page, fixture.messages.length);
  await page.screenshot({ path: join(OUT, `librechat-${name}.png`), fullPage: true });
  return page.evaluate(collectRows);
}

/** The outside host, served from its build under a host name of its own. */
async function drawOutside(page: Page, name: string): Promise<Row[]> {
  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith(IMAGE_PATH)) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: IMAGE });
      return;
    }
    const path = pathname === '/' ? '/index.html' : pathname;
    try {
      const body = readFileSync(join(DIST, path));
      await route.fulfill({ body, contentType: CONTENT_TYPES[extname(path)] ?? 'text/plain' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${ORIGIN}/?fixture=${name}`);
  await page.waitForSelector('body[data-host-ready]', { state: 'attached', timeout: 30_000 });
  await waitForRows(page, FIXTURES[name].messages.length);
  expect(errors, `the outside host threw drawing ${name}`).toEqual([]);
  await page.screenshot({ path: join(OUT, `outside-${name}.png`), fullPage: true });
  return page.evaluate(collectRows);
}

test.describe('an app outside LibreChat', () => {
  test('draws LibreChat conversations with the package alone @scenario:outside-host-draws-like-librechat', async ({
    page,
    browser,
  }) => {
    inOneProject();
    test.setTimeout(600_000);
    await test.step('build the outside host', buildOutsideHost);

    const outsidePage = await browser.newPage({ viewport: page.viewportSize() ?? undefined });
    const differences: Difference[] = [];
    try {
      for (const name of FIXTURE_NAMES) {
        await test.step(`${name}: ${FIXTURES[name].covers}`, async () => {
          const count = FIXTURES[name].messages.length;
          const libre = await drawInLibreChat(page, name);
          const outside = await drawOutside(outsidePage, name);
          expect(libre.length, `LibreChat drew every message of ${name}`).toBe(count);
          differences.push(...compareRows(name, false, libre, outside));

          /** What a reader sees after opening every tool, group, phase and thought. */
          await openDisclosures(page, count);
          await openDisclosures(outsidePage, count);
          await page.screenshot({
            path: join(OUT, `librechat-${name}-opened.png`),
            fullPage: true,
          });
          await outsidePage.screenshot({
            path: join(OUT, `outside-${name}-opened.png`),
            fullPage: true,
          });
          differences.push(
            ...compareRows(
              name,
              true,
              await page.evaluate(collectRows),
              await outsidePage.evaluate(collectRows),
            ),
          );
        });
      }
    } finally {
      await outsidePage.close();
    }

    const explained = new Map<string, Difference[]>(GAPS.map((gap) => [gap.id, []]));
    const unexplained: Difference[] = [];
    for (const difference of differences) {
      const gap = GAPS.find((candidate) => candidate.matches(difference));
      if (gap == null) {
        unexplained.push(difference);
      } else {
        explained.get(gap.id)?.push(difference);
      }
    }
    const report = {
      gaps: GAPS.map((gap) => ({
        id: gap.id,
        why: gap.why,
        differences: (explained.get(gap.id) ?? []).map(describe),
      })),
      unexplained: unexplained.map(describe),
    };
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    await test.info().attach('outside-host-report', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    expect(unexplained.map(describe), 'differences no known gap explains').toEqual([]);
    const closed = GAPS.filter((gap) => (explained.get(gap.id)?.length ?? 0) === 0).map(
      (gap) => gap.id,
    );
    expect(closed, 'gaps that no longer reproduce: delete them from GAPS').toEqual([]);
  });
});
