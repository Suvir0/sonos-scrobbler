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

## The sign-in link

Each account has a private link that signs a browser back in. It is a bearer
credential in a URL, which is the trade every magic link makes: it exists
because Sonos is the only identity here and cannot tell a returning person from
a new one, so without it a cleared cookie stranded an account holding live
credentials nobody could reach.

What is done about the shape of it: the token is 32 random bytes; only its HMAC
is used for lookup; using it redirects immediately, so the key does not sit in
the address bar; and a link for a *different* account is refused outright when
the browser is already signed in, so it cannot be used to move somebody quietly
onto an attacker's account and collect what they type next. Making a new link
invalidates the old one immediately.

Anyone holding a valid link can sign in as that account. That is what it is for.

## Known and accepted

These are documented rather than undiscovered — see **Known limits** in the
README:

- A user who loses both their session cookie and their sign-in link cannot be
  recovered. Matching on household id would fix it and is worse: a Sonos
  household can have more than one member, so it would hand one person another
  person's Last.fm session key.
- The Sonos request budget is enforced per isolate rather than globally.

## Supported versions

The deployed service is what is supported. There are no maintained release
branches — fixes land on `main` and are deployed from there.
