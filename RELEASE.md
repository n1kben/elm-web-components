# Release checklist

The Elm package and npm builder share a version. The first release is `1.0.0`.
The repository is private, and neither package has been published yet.

1. Run the checks below and review the example in a browser:

   ```sh
   npm ci
   npm test
   npm run build:example
   npm run build:split-example
   npm run test:compiled
   npm run docs:check
   npm pack --dry-run
   ```

2. Make the GitHub repository public so Elm's package catalog can fetch the
   source and release tag.
3. Check that `elm.json` and `package.json` have the same version. Commit the
   release, tag that commit `1.0.0`, and push the commit and tag.
4. Run `elm publish` and complete its checks.
5. Run `npm publish --access public`. The publishing account must own the npm
   scope.
6. In a fresh Elm application, install both packages and build a component
   using the README steps.
