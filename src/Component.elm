module Component exposing (Component, Event, define, program)

{-| Build custom elements with Elm. A component's `Input` record defines its
attributes, and its `Output` type defines its events.

# Components
@docs Component, define

# Generated bridge
The build tool uses these. Component authors do not call them directly.
@docs Event, program

-}

import Browser
import Html exposing (Html)
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd as Cmd exposing (Cmd)
import Platform.Sub as Sub exposing (Sub)


{-| A custom element definition. Create one with `define`.
-}
type Component input state msg output
    = Component
        { init : input -> ( state, Cmd msg )
        , receive : input -> Maybe msg
        , update : msg -> state -> ( state, Cmd msg, List output )
        , view : state -> Html msg
        , subscriptions : state -> Sub msg
        }


{-| Define a component. `init` receives the initial input. `receive` gets the
complete input after an attribute changes; return `Nothing` to ignore the
change. Keep any input needed by `view` in the component's state.

The list returned by `update` contains events for the host. Return `[]` when
there are none.

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


{-| Used by generated code to send an event to the host. Component authors
emit their `Output` values instead.
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
