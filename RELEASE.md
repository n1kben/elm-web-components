# Release checklist

The Elm package and npm builder share a version. Both start at `1.0.0`.

1. Run `npm ci`, `npm test`, `npm run build:example`, `npm run build:split-example`,
   `npm run test:compiled`, `npm run docs:check`, and
   `npm pack --dry-run`. Review the rendered example in a browser.
2. Make the GitHub repository public. Elm's package catalog must be able to
   fetch the source and the release tag.
3. Confirm `elm.json` and `package.json` have the same version, commit the
   release, then tag that commit with the exact version (for example `1.0.0`).
4. Push the commit and version tag. Run `elm publish` and follow its checks.
5. Run `npm publish --access public` for the scoped builder package. The npm
   scope must belong to the publishing account.
6. In a fresh application, install both packages and build a component using
   the README steps.

Neither registry publication nor the public repository change is performed by
this checklist.
