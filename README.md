# Elm component platform

An experiment in building individual web components with Elm-style component
logic. Each component has external input, private state, messages, a pure HTML
view, and public output events.

The Elm package in `src/` defines the component contract. The disclosure
example shows the application entry point and JavaScript adapter that a build
tool would generate for each component. Elm packages cannot declare ports, so
that entry point belongs to an application.

The intended browser API is ordinary custom elements:

```html
<script src="disclosure.js" defer></script>
<ui-disclosure label="More details">Slotted content</ui-disclosure>
```

Run `npm install` and `npm run build:example`, then open
`examples/disclosure/index.html` through a local HTTP server. The adapter
builds a classic script, observes attributes, and dispatches custom events.

This is a prototype. The example adapter does not yet dispose of the Elm
program when its element is removed from the page. The build command is
specific to the example; a general component CLI is future work.
