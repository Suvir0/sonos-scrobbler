# Contributing

```bash
npm install
npm test          # 216 tests, real Durable Objects and D1 via vitest-pool-workers
npm run type-check
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars` and fill it in first; several tests and
all of `wrangler dev` need those values.

## What this codebase asks of a change

**Tests run against the real thing.** `@cloudflare/vitest-pool-workers` gives
tests the actual Durable Object and D1 implementations, not mocks. Keep it that
way — three production bugs got through a suite that fed the code inputs
invented from the documentation.

**Sparse events are the hard case.** Sonos sends nothing while a track plays
normally, so a four-minute song can produce two events total. A test that feeds
the session a tidy stream of updates proves nothing about the code that matters.
Use the replay harness in `src/testing/replay.ts`, which drives the real Durable
Object on a virtual clock and fires its own scheduled alarms.

**The zero-retention invariant is structural.** There is no `scrobbles`,
`history` or `plays` table and there must not be one. `src/lib/log.ts` drops any
field named `artist`, `track` or `album` as a backstop; do not work around it.
This is what the privacy page promises and what Sonos's developer terms §3(a)
requires.

**The Sonos quota is shared.** 1,000 requests per minute for the whole
application, across every user. Any new call path needs to explain what bounds
it. `src/sonos/budget.ts` refuses locally before a request goes out.

**Comments explain why, not what.** The existing ones record the incident or the
constraint that produced the code. Match that.

## Before opening a pull request

`npm test` and `npm run type-check` both clean. If the change touches the front
end, say which viewports and colour schemes you looked at — the CSS is
mobile-first and both themes ship.
