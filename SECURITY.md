# Reporting a vulnerability

This service holds other people's OAuth credentials — a Sonos refresh token, a
Last.fm session key that never expires, a ListenBrainz token. Please report
anything that could expose them privately rather than in a public issue.

**Email:** hello@suvir.net

Include what you did, what happened, and the commit or deployed URL you were
looking at. A proof of concept helps; testing against your own account only,
please, and no denial of service — the Sonos API quota is shared by every user
of this application, so load-testing it takes the service down for everybody.

Expect an acknowledgement within a few days. This is a personal project with no
bug bounty and no formal SLA; what is offered is that a real report gets a real
fix and public credit if you want it.

## What is worth reporting

Anything that would let one person reach another person's account or
credentials, anything that gets a credential into a log or an error page,
anything that defeats the webhook signature check or the OAuth state, and
anything that lets a request from another origin change an account.

## Known and accepted

These are documented rather than undiscovered — see **Known limits** in the
README:

- A signed-out reconnect creates a second account and strands the first. It is
  the open item before public signups, not a finding.
- The Sonos request budget is enforced per isolate rather than globally.
- Two members of one Sonos household cannot both use the service; the second to
  link takes over the first's subscriptions.

## Supported versions

The deployed service is what is supported. There are no maintained release
branches — fixes land on `main` and are deployed from there.
