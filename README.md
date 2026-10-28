# Elm web components

Write custom elements in Elm and use them from HTML or another Elm app, without
ports, decoders, or JavaScript glue.

## Install

This package requires Node 22 or newer and Elm 0.19.

```sh
elm install n1kben/elm-web-components
elm install elm/json
npm install --save-dev elm @n1kben/elm-web-components
```

## Define a component

Each component is a namespaced Elm module with an `Input` record, an `Output`
custom type, and a `component` value:

```elm
module Ui.Disclosure exposing (Input, Output(..), component)

import Component exposing (Component)
import Platform.Sub as Sub


type alias Input =
    { label : String
    , disabled : Bool
    }


type Output
    = Toggled { open : Bool }


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

`init` receives the initial `Input`. `receive` gets the complete `Input` after an
attribute changes; return `Nothing` to ignore the change. Values in the
`List Output` returned by `update` become events.

The example above creates this browser API:

| Elm | Browser |
| --- | --- |
| `Ui.Disclosure` | `<ui-disclosure>` |
| `label : String` | `label="Details"` |
| `disabled : Bool` | presence or absence of `disabled` |
| `Toggled { open : Bool }` | a `toggled` event with `{ open }` in `event.detail` |

Names become kebab-case at the browser boundary, so `startMonth` becomes
`start-month`.

See the complete [disclosure component](examples/components/src/Ui/Disclosure.elm).

## Build

Run the CLI from the directory containing your application's `elm.json`:

```sh
npx elm-web-components build \
  --app src/Host.elm \
  --output dist/app.js \
  src/Ui/Disclosure.elm src/Ui/DatePicker.elm
```

Pass each component file to `build`. `--app` is optional; omit it when the output
only needs to define custom elements. The default output is
`dist/components.js`. Add `--optimize` for an optimized build.

The app and components are built into one browser-ready JavaScript file with one
Elm runtime. No bundler is required.

For a project whose first source directory is `src`, add these generated paths
to `.gitignore`:

```gitignore
.elm-web-components/
src/WebComponents/
```

## Use a component from Elm

After the first build, use `Ui.Disclosure` through
`WebComponents.Ui.Disclosure`:

```elm
import Html exposing (Html, text)
import WebComponents.Ui.Disclosure as Disclosure


type Msg
    = DisclosureToggled Bool


view : Html Msg
view =
    Disclosure.view
        { label = "Details"
        , disabled = False
        , onToggled = Just (DisclosureToggled << .open)
        }
        [ text "Content supplied by the host" ]
```

Each output has an optional callback. Use `Nothing` to ignore it.

## Use a component from HTML

```html
<script src="dist/components.js" defer></script>

<ui-disclosure label="Details">
  Content supplied by the host
</ui-disclosure>

<script>
  const disclosure = document.querySelector("ui-disclosure");

  disclosure.addEventListener("toggled", (event) => {
    console.log(event.detail.open);
  });
</script>
```

Events bubble and cross the shadow boundary.

## Inputs and outputs

`Input` must be a record alias. Each `Output` variant must contain one record,
such as `Toggled { open : Bool }`.

`Input` and `Output` fields may use `String`, `Bool`, `Int`, `Float`, `Maybe`,
`List`, `Result`, tuples, records, and public aliases or custom types from the
project or its Elm dependencies. Recursive and generic types are supported when
the boundary provides concrete type arguments. Functions, extensible records,
and opaque types cannot cross the boundary.

In HTML, strings use plain attribute values, booleans use attribute presence,
and a top-level `Maybe` uses attribute presence or absence. Other values use
JSON. Custom types use a `type` and `args` shape:

```json
{ "type": "leaf", "args": ["hello"] }
```

Output record fields are available on `event.detail`.

## Slots and styling

Components render into Shadow DOM. Use `<slot>` in the component for content
provided by the host. Expose style hooks with `part`:

```elm
button [ Attributes.attribute "part" "trigger" ] [ text "Toggle" ]
```

```css
ui-disclosure::part(trigger) {
  font: inherit;
}
```

See the [example app](examples/components/) for multiple components hosted by
Elm and used from HTML.
