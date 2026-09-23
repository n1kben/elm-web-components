# Elm web components

Write custom elements with Elm. Keep interaction state inside a component, accept
new attributes from its host, and report user decisions through DOM events. A
small Node build tool compiles a chosen set of components into one JavaScript
file. The resulting elements work in ordinary HTML and inside Elm applications.

The project has two parts:

- `n1kben/elm-web-components` is the Elm package that defines component behavior.
- `@n1kben/elm-web-components` is the build tool that generates the port app and browser adapter.

The [disclosure](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Disclosure.elm) and
[date picker](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/DatePicker.elm) are complete examples.
The [host app](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Host.elm) shows one of those elements
used inside an ordinary Elm program.

## Model

A component has four distinct things:

| Concept | Ownership | Example |
| --- | --- | --- |
| Input | Host attributes | A date picker's selected `value` |
| State | Component | The month currently visible |
| Message | Component | `Move 1` after clicking Next |
| Output | Host DOM event | `date-requested` with a proposed value |

`init` gets the first input. Every subsequent observed attribute change is
decoded and offered to `receive`. If `receive` returns a message, `update`
handles it. `view` renders from private state. Elm `Cmd` and `Sub` work as usual
for effects. The build tool supplies the ports; component authors do not write
a port module.

The date picker deliberately does not select a day when clicked. It emits
`date-requested`; the host sets `value` to confirm the selection. Its
`start-month` is read during initialization and does not move the visible
month when changed later. This is an API example, not a complete accessible
date picker control.

## Build components

After publishing, install both parts in an Elm application project:

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

See the [full disclosure module](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Disclosure.elm) for
its input decoder, update, view, and output encoder.

Create `elm-web-components.json` beside the application's `elm.json`:

```json
{
  "output": "dist/components.js",
  "components": [
    {
      "tag": "ui-disclosure",
      "module": "Disclosure",
      "attributes": ["label", "disabled"]
    }
  ]
}
```

List every attribute read by `decodeInput`. Elm decoders cannot be inspected
by the builder. Attribute names are lowercase; their JSON values are strings.
An absent attribute has no key. For a boolean attribute, test for its presence.
The module must be in the application's Elm source directories and expose a
`component` value created by `Component.define`. Add more entries to the same
`components` list to register more tags in the output file. **Use one output
for the components your app needs** so Elm's runtime is included only once in
that component bundle. In the example, two separate files total about 60 KB
gzip, while their combined output is about 32 KB gzip (`--optimize`, before
minification).

Set top-level `"optimize": true` to pass Elm's `--optimize` flag. The default
keeps development builds easier to inspect.

Run from the Elm application directory:

```sh
npx elm-web-components build
```

A configuration path can be supplied as the second argument. Paths in the
configuration are resolved relative to the configuration file. The builder
writes generated Elm files and compilation caches to `.elm-web-components/`;
add that directory to the application's `.gitignore`. It writes a classic
browser script to the configured `output`. Elm compilation
requires an `elm` binary, found in the project or its parent directories, on
`PATH`, or at `ELM_BINARY`.

For components that must be loaded separately, omit the top-level `output` and
give each component its own `output` path. Each separate file includes its own
Elm runtime. See the [split example configuration](https://github.com/n1kben/elm-web-components/blob/main/examples/components/elm-web-components.split.json).

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

Outputs are bubbling, composed `CustomEvent`s. Style shadow content through
CSS parts such as `ui-disclosure::part(trigger)`; the disclosure example also
shows a default slot for host content.

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

The [host example](https://github.com/n1kben/elm-web-components/blob/main/examples/components/src/Host.elm) includes the complete
program. Run `npm install`, `npm run build:example`, then serve this repository
with a local HTTP server and open `examples/components/index.html`.

## Current boundaries

- Browser output uses Shadow DOM and CSS parts. Component views may use slots.
- The browser keeps an Elm instance when an element disconnects so it can
  reconnect without losing state. Component subscriptions pause while detached.
  Elm does not expose a way to destroy an instance; commands already running
  may still finish.
- Invalid attributes render an error inside the shadow root. A bad later
  snapshot keeps private state and resumes it after a valid snapshot. A bad
  initial snapshot initializes when valid attributes arrive.
- A bundled output includes one Elm runtime for all its component definitions.
  Each mounted element still has its own Elm state and render loop. A separate
  Elm host app compiled into another file brings its own runtime too. The
  builder does not minify output; `optimize` uses Elm's compiler flag only.
- V1 supports attribute input and DOM event output. JS properties, form
  association, focus/overlay helpers, and prebuilt unstyled controls are future
  work.

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

Elm package publication also requires a public GitHub repository, a matching
version tag, and `elm publish`. Publish the npm build tool separately. This
repository is currently private; neither package has been published yet.

The package API follows Elm's [design guidelines](https://package.elm-lang.org/help/design-guidelines)
by starting from the disclosure and controlled date picker cases, keeping the
public Elm API small, and documenting the complete use path. Module comments
follow the [documentation format](https://package.elm-lang.org/help/documentation-format).
