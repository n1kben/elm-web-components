# Release checklist

The Elm package and npm CLI share a version. Release `1.0.2` from the same commit for both.

1. Run the checks, then open the example in a browser and try both components:

   ```sh
   npm ci
   npm run build:example
   npm test
   npm run test:compiled
   npm run docs:check
   npm run typecheck
   npm run build:cli
   npm run lint
   npm pack --dry-run
   ```

2. Make the repository public if it is still private. Elm's package catalog needs to read the source and release tag.
3. Check that `elm.json` and `package.json` both say `1.0.2`. Commit the release, tag that commit `1.0.2`, and push the commit and tag.
4. Run `elm publish` and complete its checks.
5. Run `npm publish --access public` from an account that owns the npm scope.
6. Install both packages in a fresh Elm application and build a component using the README instructions.
