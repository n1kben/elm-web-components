# Releases

## Published 1.0.2

The Elm package `n1kben/elm-web-components` came from Git tag `1.0.2`. The npm CLI `@n1kben/elm-web-components` came later from commit `f45ea94`, which includes build tool fixes. The exposed `Component` module and `elm.json` did not change between those commits.

## Next release

1. Run `npm ci`, `npm run build:example`, `npm test`, `npm run docs:check`, `npm run typecheck`, `npm run build:cli`, `npm run lint`, and `npm pack --dry-run`.
2. Open the example in a browser and try both components.
3. If the exposed Elm package changed, update `elm.json`, tag the release, and run `elm publish`.
4. If the CLI changed, update `package.json` and the lockfile. Publish with `npm publish --access public` from the `n1kben` npm account.
5. Install each new package in a fresh project and build a component from the README example.
