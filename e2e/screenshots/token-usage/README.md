# Token-usage panel evidence

Real app captures for PR #16230, taken on 2026-09-23 with Playwright against the
production-built client and the repository's disposable mock E2E app. MongoDB
was ephemeral; conversation data was seeded, not taken from a real user or API.

- Before client: `44703da3c62e5218caf1fb80511c038cd4c1ab85` (`dev` baseline).
- After client: `2d3e4974b70cb57049c95e33a48eb29988c23332`.
- Desktop viewport: 1440 × 1000, matching light/dark themes and seeded data.
- Panel captures: native 288px width, after the expand animation settled.
- Narrow viewport: 390 × 844, after scrolling the cost section into view.

The first response records input 305, output 109, cache read 7100, cache write
7200, cost $0.102. The selected response records input 140, output 86, cache read
14200, cache write 94, cost $0.014. This distinguishes the selected turn from
conversation totals. The snapshot budget is 128000 with 109566 remaining before
86 output tokens. No real provider request is needed for these captures.

Browser assertions checked usage values, theme, settled panel geometry, reload,
and Escape. The narrow-layout cost section remains reachable by scrolling.
These static images do not prove streaming timing or independent visual review.

The five PNGs are retained on the PR branch because GitHub's direct attachment
upload rejected the GitHub App authentication type. The PR description uses
commit-pinned image URLs. They are review evidence, not golden image-test files.
