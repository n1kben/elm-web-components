# Elm web components

Write custom elements in Elm and use them from HTML or another Elm app. The host sets attributes and listens for events; each component keeps its own interaction state. Build the app and its components together to get one JavaScript file with one Elm runtime.

The Elm package `n1kben/elm-web-components` provides `Component.define`. The Node 22 CLI `@n1kben/elm-web-components` reads component files and runs `elm make`. Its Elm generator writes codecs, custom element adapters, and a typed host API.

## Define a component

Put each component in a namespaced Elm module. The module name determines its HTML tag: `Ui.DatePicker` becomes `<ui-date-picker>`.

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

`init` receives the initial attributes. When an attribute changes, `receive` gets the new input and can send a message to `update`. `update` returns the next private state, a `Cmd Msg`, and a list of events for the host. Use `Cmd.none` and `[]` when there is nothing to send. `view` renders the private state.

The [date picker example](examples/components/src/Ui/DatePicker.elm) uses `startMonth` to choose its initial visible month. Later changes to `value` change the selected date without moving that month. A day click sends `date-requested`; the host decides whether to set `value`.

`Input` must be a record alias, and each `Output` constructor must take a record. Boundary fields can use `String`, `Bool`, `Int`, `Float`, `Maybe`, `List`, `Result`, tuples, records, and public aliases or unions from project modules or installed Elm packages. Recursive and generic types work when the boundary supplies concrete type arguments, such as `Tree String`. Functions, extensible records, and opaque types cannot cross the boundary. The build reports them as errors.

Field names become kebab-case HTML attributes. A plain `String` stays a string, and a `Bool` is true when its attribute is present. A missing `Maybe` attribute becomes `Nothing`. Other values are JSON encoded in attributes. The generated Elm host uses the codecs; an HTML caller writes the JSON itself. `Maybe` values inside JSON use `{ "type": "nothing", "args": [] }` or `{ "type": "just", "args": [value] }`, preserving the difference between `Nothing` and `Just ()` even in nested values. Unions use the same `type` and `args` shape, for example `{ "type": "leaf", "args": ["hello"] }`. Each `Output` constructor becomes a kebab-case `CustomEvent`; its record fields become keys in `event.detail`. The event bubbles across the shadow boundary.

## Build one application and its components

Install the Elm package and npm CLI in an Elm application project:

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

Leave out `--app` if you only need the components. Add `--optimize` for an optimized Elm build. The CLI gives every listed component and the optional app to one `elm make` call. List component files in the command or an npm script; there is no separate manifest or handwritten decoder.

The build writes compiler files to `.elm-web-components/`. It writes Elm host and codec modules under the first source directory listed in `elm.json`, at `WebComponents/<component module>.elm` and `WebComponents/Codecs/`. Add both generated paths to `.gitignore`. Your editor can see the host modules after the first build. Later builds remove old generated modules and recreate only those for the listed components. The CLI refuses to overwrite handwritten host or codec modules.

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

The generated `view` writes the attributes and handles the component's events. Use `Nothing` to leave out an optional attribute or event callback. Elm checks that the record has every required field. The full [host example](examples/components/src/Host.elm) uses this API.

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

An element keeps its private state when it leaves the page and returns; its subscriptions pause while it is detached. Invalid initial attributes show an error in the shadow root. Changing them can let the component initialize later. The date picker demonstrates the boundary between host state and component state. It is not a complete accessible date picker.

## Try the example

```sh
npm ci
npm run build:example
npm test
npm run docs:check
npm run typecheck
npm run build:cli
npm run lint
npm pack --dry-run
```

Serve the repository over HTTP, then open `examples/components/index.html`. [RELEASE.md](RELEASE.md) lists the publication steps.

The CLI needs Node 22 and the Elm compiler; it does not need a bundler. The CLI and TypeScript Elm AST package use Effect for build steps, typed errors, and cleanup. Effect runs only during builds. JavaScript property reflection, form association, overlay and focus helpers, and prebuilt unstyled controls are outside this version.

## How generation works

The CLI gives the Elm generator project source modules and installed package docs. The generator uses [elm-syntax](https://github.com/stil4m/elm-syntax) for source ASTs and [elm/project-metadata-utils](https://github.com/elm/project-metadata-utils) for package type metadata. It follows imports to resolve aliases and unions, then generates Elm source and the small JavaScript custom element adapter. `elm make` checks the generated code. The parser and generator run at build time; they add nothing to the browser output. The npm package ships compiled CLI and generator JavaScript because Node 22 does not strip TypeScript in `node_modules`.

The CLI still uses the Elm generator. The separate [Elm AST for TypeScript](https://github.com/n1kben/elm-ast) package resolves project and package types and prints generated Elm declarations, but the CLI does not use it yet.
