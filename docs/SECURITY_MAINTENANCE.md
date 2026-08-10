# Security maintenance backlog

Last reviewed: 2026-08-10

## PostCSS and Sharp advisories

The production dependency tree currently contains:

- `next@15.5.23`, which pins `postcss@8.4.31` exactly. PostCSS versions through
  `8.5.22` are affected by the current source-map file-disclosure advisories.
- `next@15.5.23`, which permits `sharp@^0.34.3`; the installed version is
  `sharp@0.34.5`. Sharp versions before `0.35.0` are affected by the current
  inherited libvips advisories.

`npm audit --omit=dev` reports three high-severity dependency-tree findings and
no critical findings. Its supported automatic remediation is `next@16.3.0`, a
major framework upgrade.

Do not use a production-only package override as an emergency fix. PostCSS is an
exact internal Next.js dependency, and Sharp 0.35 is outside Next.js's declared
compatible range. Although overrides may install, they would be unsupported and
could destabilize CSS compilation or image processing.

Handle these findings on a controlled dependency-upgrade branch. The branch must:

1. Upgrade Next.js and its supported React/tooling dependencies.
2. Confirm PostCSS is newer than 8.5.22 and Sharp is at least 0.35.0.
3. Run lint, type checking, unit tests, and a production build.
4. Smoke-test authentication, portal/admin authorization, CSS rendering, image
   optimization/uploads, background worker processing, and scheduled sync.
5. Re-run `npm audit --omit=dev` and deploy through staging before production.

Reassess sooner if the application begins processing untrusted CSS/source maps or
untrusted images through these packages, because that would increase exposure.
