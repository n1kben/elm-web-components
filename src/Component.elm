module Component exposing (Component, Event, Transition)

{-| A component contract for compiling an Elm module as a custom element.

The package describes behavior in Elm. A separate build tool supplies the
browser adapter: it decodes initial attributes, sends later changes through
`receive`, renders `view`, and dispatches `Event` values as `CustomEvent`s.

This module deliberately has no ports. Elm packages cannot declare them;
the build tool generates an application entry point with ports instead.

@docs Component, Transition, Event

-}

import Html exposing (Html)
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd exposing (Cmd)
import Platform.Sub exposing (Sub)


{-| A component has external input, private state, internal messages, and
public output events. `view` sees only `state`, following Halogen's input and
receive model. Copy any input needed by `view` into state in `init` or through
an action returned by `receive`.

The browser adapter calls `receive` when the decoded attribute snapshot
changes. `Nothing` ignores that change; `Just msg` routes it through `update`.

-}
type alias Component input state msg output =
    { decodeInput : Decode.Decoder input
    , init : input -> ( state, Cmd msg )
    , receive : input -> Maybe msg
    , update : msg -> state -> Transition state msg output
    , view : state -> Html msg
    , subscriptions : state -> Sub msg
    , encodeOutput : output -> Event
    }


{-| The result of one internal message. `outputs` become public custom events;
`command` is for Elm-managed effects.
-}
type alias Transition state msg output =
    { state : state
    , command : Cmd msg
    , outputs : List output
    }


{-| A public custom event. The browser adapter dispatches `name` with `detail`
as its payload.
-}
type alias Event =
    { name : String
    , detail : Encode.Value
    }
