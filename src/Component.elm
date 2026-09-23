module Component exposing (Component, Event, Transition, define, program)

{-| Define an Elm component for a custom element.

The host passes values through attributes. The component keeps its interaction
state private and renders its own view. When attributes change, `receive` can
turn the new input into a message. An update can emit a `CustomEvent` for the
host to handle.

The build tool generates the port application that calls `program`. Component
modules only need `define`. See the disclosure example in this repository for
a complete definition.

# Define a component
@docs Component, define, Transition, Event

# Browser integration
@docs program

-}

import Browser
import Html exposing (Html)
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd as Cmd exposing (Cmd)
import Platform.Sub as Sub exposing (Sub)


{-| A component's input decoder, state changes, view, and output events.

Create one with `define`.
-}
type Component input state msg output
    = Component
        { decodeInput : Decode.Decoder input
        , init : input -> ( state, Cmd msg )
        , receive : input -> Maybe msg
        , update : msg -> state -> Transition state msg output
        , view : state -> Html msg
        , subscriptions : state -> Sub msg
        , encodeOutput : output -> Event
        }


{-| Define a component. `decodeInput` reads an object of HTML attributes. Its
keys are attribute names and its values are strings. Absent attributes have no
key.

`init` receives the first decoded input. On later attribute changes, `receive`
gets the new input. Return `Nothing` to ignore a change, or `Just msg` to handle
it through `update`. Store any input that `view` needs in private state.

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

-}
define :
    { decodeInput : Decode.Decoder input
    , init : input -> ( state, Cmd msg )
    , receive : input -> Maybe msg
    , update : msg -> state -> Transition state msg output
    , view : state -> Html msg
    , subscriptions : state -> Sub msg
    , encodeOutput : output -> Event
    }
    -> Component input state msg output
define =
    Component


{-| What happens after handling a message. `state` stays inside the component.
`command` runs Elm effects. Each value in `outputs` becomes a custom event for
the host.
-}
type alias Transition state msg output =
    { state : state
    , command : Cmd msg
    , outputs : List output
    }


{-| An event sent to the host. `name` becomes the DOM event type, and `detail`
becomes `CustomEvent.detail`. The event bubbles across the shadow boundary.
-}
type alias Event =
    { name : String
    , detail : Encode.Value
    }


type Model state
    = Invalid String
    | Ready Bool state (Maybe String)


type Msg msg
    = UserMsg msg
    | InputChanged Decode.Value
    | ConnectionChanged Bool


{-| Connect a component to the generated ports. The build tool calls this from
its generated application. Component modules use `define`.

The browser keeps the Elm program when the element disconnects, so its private
state survives a move or reattachment. Subscriptions pause while disconnected.

-}
program :
    { inputChanged : (Decode.Value -> Msg msg) -> Sub (Msg msg)
    , connectionChanged : (Bool -> Msg msg) -> Sub (Msg msg)
    , outputSent : Encode.Value -> Cmd (Msg msg)
    }
    -> Component input state msg output
    -> Program Decode.Value (Model state) (Msg msg)
program ports (Component definition) =
    Browser.element
        { init = init definition
        , update = update ports definition
        , view = view definition
        , subscriptions = subscriptions ports definition
        }


init definition raw =
    case Decode.decodeValue definition.decodeInput raw of
        Ok input ->
            let
                ( state, command ) =
                    definition.init input
            in
            ( Ready True state Nothing, Cmd.map UserMsg command )

        Err error ->
            ( Invalid (Decode.errorToString error), Cmd.none )


update ports definition msg model =
    case ( msg, model ) of
        ( UserMsg userMsg, Ready connected state error ) ->
            let
                transition =
                    definition.update userMsg state

                sendOutput output =
                    output
                        |> definition.encodeOutput
                        |> encodeEvent
                        |> ports.outputSent
            in
            ( Ready connected transition.state error
            , Cmd.batch
                (Cmd.map UserMsg transition.command
                    :: List.map sendOutput transition.outputs
                )
            )

        ( InputChanged raw, Ready connected state _ ) ->
            case Decode.decodeValue definition.decodeInput raw of
                Ok input ->
                    case definition.receive input of
                        Just userMsg ->
                            update ports definition (UserMsg userMsg) (Ready connected state Nothing)

                        Nothing ->
                            ( Ready connected state Nothing, Cmd.none )

                Err error ->
                    ( Ready connected state (Just (Decode.errorToString error)), Cmd.none )

        ( InputChanged raw, Invalid _ ) ->
            init definition raw

        ( ConnectionChanged connected, Ready _ state error ) ->
            ( Ready connected state error, Cmd.none )

        ( ConnectionChanged _, Invalid _ ) ->
            ( model, Cmd.none )

        ( UserMsg _, Invalid _ ) ->
            ( model, Cmd.none )


encodeEvent event =
    Encode.object
        [ ( "name", Encode.string event.name )
        , ( "detail", event.detail )
        ]


view definition model =
    case model of
        Ready _ state Nothing ->
            Html.map UserMsg (definition.view state)

        Ready _ _ (Just error) ->
            Html.text ("Invalid component attributes: " ++ error)

        Invalid error ->
            Html.text ("Invalid component attributes: " ++ error)


subscriptions ports definition model =
    let
        componentSubscriptions =
            case model of
                Ready True state Nothing ->
                    Sub.map UserMsg (definition.subscriptions state)

                _ ->
                    Sub.none
    in
    Sub.batch
        [ ports.inputChanged InputChanged
        , ports.connectionChanged ConnectionChanged
        , componentSubscriptions
        ]
