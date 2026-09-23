module Component exposing (Component, Event, Transition, define, program)

{-| Build an Elm program that can live inside a custom element.

The host page owns public values through attributes. A component owns private
interaction state. When attributes change, `receive` may turn the new input into
an Elm message. An update may emit public outputs, which become `CustomEvent`s.

The disclosure example in this repository shows a complete definition. A build
tool generates the small port application that calls `program`; application
authors do not need to write ports themselves.

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


{-| An Elm component definition. The constructor is private so browser
integration can change without changing component definitions.
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


{-| Define one component. `decodeInput` reads an object whose keys are HTML
attribute names and whose values are strings. An absent attribute has no key.

`init` receives the first decoded snapshot. `receive` receives later snapshots;
return `Nothing` to ignore one, or `Just msg` to handle it through `update`.
Keep any input needed by `view` in private state.

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


{-| The result of handling one message. `state` stays private. `command` runs
Elm effects. Each `output` is dispatched as a public custom event by the host.
-}
type alias Transition state msg output =
    { state : state
    , command : Cmd msg
    , outputs : List output
    }


{-| A public event. Its `name` becomes the DOM event type and its `detail`
becomes `CustomEvent.detail`. The event bubbles and crosses the shadow boundary.
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


{-| Wire a component to the generated ports. This is called by the build
tool's generated application; ordinary component modules use `define`.

The Elm program is retained across DOM disconnects so private state survives
a move or reattachment. Component subscriptions pause while disconnected.

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
