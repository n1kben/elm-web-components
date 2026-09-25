module Component exposing (Component, Event, define, program)

{-| Build custom elements with Elm.

The host sets attributes and listens for events. Each component keeps its
interaction state and renders its own view. When an attribute changes,
`receive` can send a message to `update`, which can send an event back to
the host.

The build tool reads the component's `Input` and `Output` types. It generates
attribute handling, events, and the browser connection. See the disclosure
example for a complete component.

# Define a component
@docs Component, define, Event

# Browser integration
@docs program

-}

import Browser
import Html exposing (Html)
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd as Cmd exposing (Cmd)
import Platform.Sub as Sub exposing (Sub)


{-| A component's private state, view, and events. Create one with `define`.
-}
type Component input state msg output
    = Component
        { init : input -> ( state, Cmd msg )
        , receive : input -> Maybe msg
        , update : msg -> state -> ( state, Cmd msg, List output )
        , view : state -> Html msg
        , subscriptions : state -> Sub msg
        }


{-| Define a component. `init` receives the initial input. When an attribute
changes, `receive` gets the new input. Return `Nothing` to ignore the change,
or `Just msg` to handle it through `update`. Keep any input that `view` needs in
the component's state.

The build tool reads the component module's `Input` record alias and `Output`
union. It generates the attribute and event handling; you do not write a
decoder or encoder.

`update` returns the next state, a command for component messages, and a list
of events for the host. Return `[]` when there are no events.

    component =
        Component.define
            { init = init
            , receive = Just << Received
            , update = update
            , view = view
            , subscriptions = always Sub.none
            }

-}
define :
    { init : input -> ( state, Cmd msg )
    , receive : input -> Maybe msg
    , update : msg -> state -> ( state, Cmd msg, List output )
    , view : state -> Html msg
    , subscriptions : state -> Sub msg
    }
    -> Component input state msg output
define =
    Component


{-| An event sent to the host. `name` becomes the DOM event type. `detail`
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


{-| Connect a component to generated ports and codecs. The build tool calls
this from a generated Elm entry point; component modules use `define`.

An element keeps its state when it leaves the page and returns. Its
subscriptions pause while it is detached.

-}
program :
    Decode.Decoder input
    -> (output -> Event)
    -> { inputChanged : (Decode.Value -> Msg msg) -> Sub (Msg msg)
    , connectionChanged : (Bool -> Msg msg) -> Sub (Msg msg)
    , outputSent : Encode.Value -> Cmd (Msg msg)
    }
    -> Component input state msg output
    -> Program Decode.Value (Model state) (Msg msg)
program decodeInput encodeOutput ports (Component definition) =
    Browser.element
        { init = init decodeInput definition
        , update = update decodeInput encodeOutput ports definition
        , view = view definition
        , subscriptions = subscriptions ports definition
        }


init decodeInput definition raw =
    case Decode.decodeValue decodeInput raw of
        Ok input ->
            let
                ( state, command ) =
                    definition.init input
            in
            ( Ready True state Nothing, Cmd.map UserMsg command )

        Err error ->
            ( Invalid (Decode.errorToString error), Cmd.none )


update decodeInput encodeOutput ports definition msg model =
    case ( msg, model ) of
        ( UserMsg userMsg, Ready connected state error ) ->
            let
                ( nextState, command, outputs ) =
                    definition.update userMsg state

                sendOutputs =
                    case outputs of
                        [] ->
                            Cmd.none

                        _ ->
                            outputs
                                |> Encode.list (encodeOutput >> encodeEvent)
                                |> ports.outputSent
            in
            ( Ready connected nextState error
            , Cmd.batch [ Cmd.map UserMsg command, sendOutputs ]
            )

        ( InputChanged raw, Ready connected state _ ) ->
            case Decode.decodeValue decodeInput raw of
                Ok input ->
                    case definition.receive input of
                        Just userMsg ->
                            update decodeInput encodeOutput ports definition (UserMsg userMsg) (Ready connected state Nothing)

                        Nothing ->
                            ( Ready connected state Nothing, Cmd.none )

                Err error ->
                    ( Ready connected state (Just (Decode.errorToString error)), Cmd.none )

        ( InputChanged raw, Invalid _ ) ->
            init decodeInput definition raw

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
