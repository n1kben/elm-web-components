# Releases

## Published 1.0.4

Version 1.0.4 adds the required `elm/json` install step and accepts the current
Elm npm package. Runtime behavior is unchanged.

## Published 1.0.3

Version 1.0.3 rewrites the README and Elm package documentation around the
public API. Runtime behavior is unchanged. The Elm package and npm CLI come
from Git tag `1.0.3`.

## Published 1.0.2

The Elm package `n1kben/elm-web-components` came from Git tag `1.0.2`. The npm CLI `@n1kben/elm-web-components` came later from commit `f45ea94`, which includes build tool fixes. The exposed `Component` module and `elm.json` did not change between those commits.

## Next release

1. Run `npm ci`, `npm run build:example`, `npm test`, `npm run docs:check`, `npm run typecheck`, `npm run build:cli`, `npm run lint`, and `npm pack --dry-run`.
2. Open the example in a browser and try both components.
3. If the exposed Elm package changed, update `elm.json`, tag the release, and run `elm publish`.
4. If the CLI changed, update `package.json` and the lockfile. Pushing the version tag publishes the npm package through `.github/workflows/publish.yml` and npm Trusted Publishing. The tag must match the version in `package.json`.
5. Install each new package in a fresh project and build a component from the README example.
