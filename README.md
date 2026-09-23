# Elm web components

Write custom elements in Elm and use them in HTML or an Elm app. The host passes
values through attributes and listens for DOM events. Each component manages its
own interaction state and view.

The Elm package, `n1kben/elm-web-components`, defines the component API. The
Node build tool, `@n1kben/elm-web-components`, compiles the components you
choose into a browser script and handles the ports and custom element setup.

The examples include a [disclosure](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Disclosure.elm), a
[date picker](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/DatePicker.elm), and an
[Elm app that hosts them](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Host.elm).

## How state moves

The host owns values it needs for application logic. The component keeps
interaction details in its private state:

| Concept | Ownership | Example |
| --- | --- | --- |
| Input | Host attributes | A date picker's selected `value` |
| State | Component | The month currently visible |
| Message | Component | `Move 1` after clicking Next |
| Output | Host DOM event | `date-requested` with a proposed value |

`init` receives the first set of attributes. When an observed attribute
changes, `receive` gets the new values and can return a message for `update`.
`view` renders from private state. Use Elm `Cmd` and `Sub` for effects as you
would in an Elm app. The build tool generates the port module.

For the date picker, clicking a day emits `date-requested`. The host sets
`value` to confirm the selection. The component controls which month is
visible. It reads `start-month` only at initialization, so later changes to
that attribute do not move the view. This example demonstrates the API; it is
not a complete accessible date picker.

## Build components

Once the packages are published, install them in your Elm application project:

```sh
elm install n1kben/elm-web-components
npm install --save-dev elm @n1kben/elm-web-components
```

Export a `component` value from an Elm module. For example:

```elm
module Disclosure exposing (component)

import Component

component =
    Component.define
        { decodeInput = inputDecoder
        , init = init
        , receive = Just << Received
        , update = update
        , view = view
        , subscriptions = always Sub.none
        , encodeOutput = encodeOutput
        }
```

The [disclosure example](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Disclosure.elm) includes its
input decoder, update, view, and output encoder.

Create `elm-web-components.json` beside the application's `elm.json`:

```json
{
  "output": "dist/components.js",
  "components": [
    {
      "tag": "ui-disclosure",
      "module": "Disclosure",
      "attributes": ["label", "disabled"]
    },
    {
      "tag": "ui-date-picker",
      "module": "DatePicker",
      "attributes": ["value", "start-month"]
    }
  ]
}
```

List every attribute that `decodeInput` reads; the builder cannot inspect Elm
decoders. Attribute names are lowercase, and their values are strings. An
absent attribute has no key, so test for presence when decoding a boolean
attribute. Each module must be in the application's Elm source directories
and expose a `component` value created by `Component.define`.

Put the components your app uses in one output file. This includes the Elm
runtime once for the component bundle. In the example, two optimized separate
files total about 60 KB gzip, while the combined file is about 32 KB gzip,
before minification.

Set top-level `"optimize": true` to pass Elm's `--optimize` flag. The default
keeps development builds easier to inspect.

Run from the Elm application directory:

```sh
npx elm-web-components build
```

Pass a configuration path as the second argument if you do not use the default
`elm-web-components.json`. Paths inside it are relative to the configuration
file. The builder writes generated Elm files and compilation caches to
`.elm-web-components/`; add that directory to your `.gitignore`. It writes a
classic browser script to `output`. The build needs an `elm` binary in the
project, a parent directory, `PATH`, or `ELM_BINARY`.

If components need to load separately, omit the top-level `output` and give
each component its own `output` path. Each file then includes an Elm runtime.
See the [split example configuration](https://github.com/n1kben/elm-web-components/blob/main/examples/components/elm-web-components.split.json).

## Use the result

In HTML:

```html
<script src="dist/components.js" defer></script>
<ui-disclosure label="Details">More information</ui-disclosure>
<script>
  document.querySelector("ui-disclosure").addEventListener("toggle", (event) => {
    console.log(event.detail.open);
  });
</script>
```

Outputs are bubbling, composed `CustomEvent`s. Style content inside the shadow
root through CSS parts such as `ui-disclosure::part(trigger)`. The disclosure
also has a default slot for host content.

In an Elm app, use `Html.node` and decode the event detail:

```elm
node "ui-date-picker"
    [ Attributes.attribute "start-month" "2026-09"
    , Attributes.attribute "value" model.selected
    , Events.on "date-requested"
        (Decode.at [ "detail", "value" ] Decode.string
            |> Decode.map DateRequested
        )
    ]
    []
```

The [host example](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Host.elm) has the complete
program. To try it locally, run `npm install` and `npm run build:example`, then
serve this repository over HTTP and open `examples/components/index.html`.

## Current scope

- Components render in Shadow DOM. Their views can use slots, and hosts can
  style exposed CSS parts.
- Disconnecting an element keeps its Elm instance and private state for later
  reattachment. Subscriptions pause while it is detached. Commands already
  running may still finish; Elm does not expose a way to destroy an instance.
- Invalid attributes show an error in the shadow root. A later invalid update
  keeps private state until valid attributes arrive. If the first attributes
  are invalid, the component initializes when it receives valid ones.
- A bundle has one Elm runtime for its component definitions. Each mounted
  element has its own state and render loop. A separately compiled Elm host app
  has another runtime. The builder does not minify; `optimize` passes Elm's
  `--optimize` flag.
- V1 accepts attributes and emits DOM events. JavaScript properties, form
  association, focus and overlay helpers, and prebuilt unstyled controls are
  future work.

## Development and release

```sh
npm ci
npm test
npm run build:example
npm run build:split-example
npm run test:compiled
npm run docs:check
npm pack --dry-run
```

The repository is currently private, and neither package has been published.
See [RELEASE.md](RELEASE.md) for the release steps. For API changes, refer to
Elm's [package design guidelines](https://package.elm-lang.org/help/design-guidelines)
and [documentation format](https://package.elm-lang.org/help/documentation-format).
