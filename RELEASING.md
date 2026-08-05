# Releasing

Two rules explain everything else here:

1. **npm versions are immutable and can never be reused.** Every publish burns a version
   number forever, so release candidates get unique ones and nothing is ever republished.
2. **`pi install npm:pi-teach` must never resolve to a candidate.** RCs are published
   under the `rc` dist-tag; only a merge to `main` moves `latest`.

## The flow

| Event                                 | What CI does                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| PR opened / pushed                    | Verifies, then publishes `<version>-rc.<pr>.<run>` under the `rc` tag and comments the install command on the PR.                      |
| PR with a stale version               | `version-guard` fails: the version in `package.json` is already on the registry. Bump it.                                              |
| Merge to `main`                       | Publishes `<version>` as `latest`, removes the `rc` dist-tag, deprecates that version's candidates, tags `v<version>`, cuts a release. |
| Merge that did not change the version | Release job skips publishing (README typos and chores do not need a release).                                                          |

So the only manual step is bumping `version` in `package.json` inside the PR — which is
also where the human judgement is (patch, minor, or major).

## Trying a PR

Every PR gets a comment with the exact command. It looks like:

```bash
pi install npm:pi-teach@0.2.0-rc.4.17   # install it
pi -e npm:pi-teach@0.2.0-rc.4.17        # or just for one run, no settings change
```

`pi -e` is usually what you want: it installs to a temp directory for that run only, so
there is nothing to clean up and no risk of leaving a candidate installed.

Because `rc` is a dist-tag, `npm view pi-teach@rc version` tells you the newest candidate
across all open PRs, and `pi install npm:pi-teach` still gets the last real release.

## Verifying before you publish

CI runs `npm run test:pack`, and you can run the same thing locally:

```bash
npm run test:pack           # pack, extract, install as pi would, assert the contents
npm run test:pack -- --keep # ...and keep it, so you can `pi -e <printed path>`
```

This exists because **the tarball is not the repo**. `pi install git:...` clones
everything, so it happily runs code that `files` in `package.json` would have excluded
from the npm package. The script installs the extracted tarball with
`--omit=dev --legacy-peer-deps` — exactly how pi installs an npm source — and fails if a
template, a `docs/` file, or `marked` is missing, or if a host-provided package like
`typebox` got vendored in.

## First publish and credentials

The package must exist on the registry before the automation is useful:

```bash
npm login
npm publish --access public   # from a clean checkout of main
git tag v0.1.0 && git push origin v0.1.0
```

CI then needs an npm **granular access token** with read/write on `pi-teach`, stored as
the repository secret `NPM_TOKEN`. Set the token's expiry deliberately — an expired token
shows up as a failed publish on a PR, not on main.

Both workflows request `id-token: write` and publish with `--provenance`, so releases
carry a signed link back to the commit and workflow that built them.

**Upgrade path worth taking:** once the package exists, configure npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) for this repo's
`rc.yml` and `release.yml` workflows. OIDC replaces the long-lived `NPM_TOKEN`
entirely — delete the secret and the `NODE_AUTH_TOKEN` env lines once it is set up.

## Cleaning up candidates

Deprecation, not deletion: npm only allows unpublishing within 72 hours, and even then it
blocks the version number from being reused. The release job deprecates the candidates
belonging to the version it just shipped. To retire the rest of an abandoned PR's
candidates by hand:

```bash
npm deprecate 'pi-teach@0.2.0-rc.4' 'abandoned candidate'
```

## Forks

`pull_request` runs from forks get no secrets, so the RC job is skipped for them by
design — `ci.yml` still runs the full verification. Publish a candidate for a fork's work
by pushing the branch to this repo.
