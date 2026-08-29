# Fonts

Self-hosted rather than loaded from Google Fonts, for two reasons that both matter here:
the site's Content-Security-Policy forbids every remote origin, and the privacy page
states there is no third-party request on any page — a webfont request carries the
visitor's IP and Referer to a third party like any other.

Latin subset only; the site's text is entirely English.

| File | |
|---|---|
| `Archivo-variable.woff2` | Archivo, variable weight 100–900. Google serves one file for every weight, so there is one here. |
| `IBMPlexMono-400.woff2`, `IBMPlexMono-500.woff2` | IBM Plex Mono, the two weights the design uses. |

Both families are under the SIL Open Font License 1.1 — `Archivo-OFL.txt` and
`IBMPlexMono-OFL.txt`, which the licence requires be distributed with them.

Refresh with the URLs in `https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800&family=IBM+Plex+Mono:wght@400;500`,
requested with a modern browser User-Agent so the woff2 subsets are served.
