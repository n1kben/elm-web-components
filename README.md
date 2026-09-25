# Elm web components

Write custom elements in Elm, then use them in HTML or another Elm application. The host passes values through attributes and listens for events. Each component manages its own interaction state. You can compile the host application and its components into one JavaScript file, with one Elm runtime.

The Elm package `n1kben/elm-web-components` provides `Component.define`. The Node 22 CLI `@n1kben/elm-web-components` reads files and runs `elm make`. An Elm generator parses the component modules and writes their codecs, custom element adapters, and typed host API. The npm package includes compiled JavaScript for both the CLI and Elm generator because Node 22 does not strip types inside `node_modules`.

## Define a component

Put each component in a namespaced Elm module. The module name also sets the HTML tag: `Ui.DatePicker` becomes `<ui-date-picker>`.

```elm
module Ui.DatePicker exposing (Input, Output(..), component)

import Component exposing (Component)
import Html exposing (Html)
import Platform.Sub as Sub

type alias Input =
    { startMonth : String
    , value : Maybe String
    }

type Output
    = DateRequested { value : String }

component : Component Input State Msg Output
component =
    Component.define
        { init = init
        , receive = Just << Received
        , update = update
        , view = view
        , subscriptions = always Sub.none
        }
```

`init` receives the initial attributes. When an attribute changes, `receive` gets the new input and can send a message to `update`. The update returns a triple: the next private state, a `Cmd Msg`, and a list of events for the host. Use `Cmd.none` and `[]` when there is no work to do. `view` renders the private state.

The [date picker example](examples/components/src/Ui/DatePicker.elm) uses `startMonth` only to set its initial visible month. Later changes to `value` update the selected date without moving that month. When someone clicks a day, the component sends `date-requested`. The host decides whether to set `value`.

`Input` must be a record alias, and each `Output` constructor must take a record. Boundary fields can use `String`, `Bool`, `Int`, `Float`, `Maybe`, `List`, `Result`, tuples, records, and public aliases or unions from project modules or installed Elm packages. Recursive and generic types work when the boundary supplies concrete type arguments, such as `Tree String`. Functions, extensible records, and opaque types cannot be encoded. The build reports an error when it encounters one.

Field names become kebab-case HTML attributes. A plain `String` stays a string, and a `Bool` is true when its attribute is present. A missing `Maybe` attribute becomes `Nothing`. Other values are JSON encoded into attributes. Elm hosts use generated codecs; plain HTML callers write that JSON themselves. `Maybe` values inside JSON use `{ "type": "nothing", "args": [] }` or `{ "type": "just", "args": [value] }`, preserving nested `Maybe` and `Maybe ()`. Unions use the same `type` and `args` shape, for example `{ "type": "leaf", "args": ["hello"] }`. Each `Output` constructor becomes a kebab-case `CustomEvent`; its record fields become keys in `event.detail`. The event bubbles across the shadow boundary.

## Build one application and its components

Install both packages in an Elm application project:

```sh
elm install n1kben/elm-web-components
npm install --save-dev elm @n1kben/elm-web-components
```

Run the CLI from the directory containing `elm.json`:

```sh
npx elm-web-components build \
  --app src/Host.elm \
  --output dist/app.js \
  src/Ui/Disclosure.elm src/Ui/DatePicker.elm
```

Leave out `--app` if you only need the components. Add `--optimize` for an optimized Elm build. The CLI passes every listed component and the optional app to one `elm make` call, so the output contains one Elm runtime. List component files in the command or an npm script; you do not need a manifest or handwritten decoders.

The build writes compiler files to `.elm-web-components/`. It writes Elm host and codec modules under the first source directory listed in `elm.json`, at `WebComponents/<component module>.elm` and `WebComponents/Codecs/`. Add both generated paths to `.gitignore`. Your editor can see the host modules after the first build. On each build, the CLI removes its old generated modules and generates only those for the components you listed. It will not overwrite handwritten modules at either path.

## Use the generated Elm API

For `Ui.DatePicker`, the build generates `WebComponents.Ui.DatePicker.view` with a fixed props record:

```elm
import WebComponents.Ui.DatePicker as DatePicker

DatePicker.view
    { startMonth = "2026-09"
    , value = Just model.selected
    , onDateRequested = Just (DateRequested << .value)
    }
    []
```

The generated `view` writes the attributes and handles the component's events. Use `Nothing` to leave out an optional attribute or event callback. Elm checks that you supply every field in the record. The full [host example](examples/components/src/Host.elm) uses this API.

You can use the same component in plain HTML:

```html
<script src="dist/app.js" defer></script>
<ui-date-picker start-month="2026-09" value="2026-09-23"></ui-date-picker>
<script>
  document.querySelector("ui-date-picker").addEventListener("date-requested", (event) => {
    event.currentTarget.setAttribute("value", event.detail.value);
  });
</script>
```

Components render in Shadow DOM. Expose parts for CSS with `::part(...)`, and use `<slot>` for content supplied by the host.

If an element leaves the page and returns, it keeps its private Elm state. Its subscriptions pause while it is detached. Invalid initial attributes show an error inside the shadow root; changing the attributes can let the component initialize later. The date picker shows how state moves between component and host. It is not a complete accessible date picker.

## Try the example and verify a release

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

Serve the repository over HTTP, then open `examples/components/index.html`. [RELEASE.md](RELEASE.md) lists the publication steps.

The CLI needs Node 22 and the Elm compiler. It does not need a bundler. The CLI and TypeScript Elm AST package use Effect for build steps, typed errors, and cleanup. Effect runs only at build time. JavaScript property reflection, form association, overlay and focus helpers, and prebuilt unstyled controls are outside this first version.

## How generation works

The CLI gives the Elm generator project source modules and installed package docs. The generator uses [elm-syntax](https://github.com/stil4m/elm-syntax) for source ASTs and [elm/project-metadata-utils](https://github.com/elm/project-metadata-utils) for package type metadata. It follows imports to resolve aliases and unions, then generates Elm source and the small JavaScript custom element adapter. `elm make` checks the generated code. The parser and generator run at build time; they add nothing to the browser output.

The published CLI still runs the Elm generator. The new TypeScript Elm AST package can resolve project and package types and print generated codecs. It uses Effect to report project loading errors. The CLI has not switched to that package yet.
