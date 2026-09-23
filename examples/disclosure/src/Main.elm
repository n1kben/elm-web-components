port module Main exposing (main)

{-| This application entry point is the code a build tool would generate.
-}

import Browser
import Component
import Disclosure
import Html exposing (Html)
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd as Cmd
import Platform.Sub as Sub


port inputChanged : (Decode.Value -> msg) -> Sub msg


port outputSent : Encode.Value -> Cmd msg


type Model
    = Invalid String
    | Ready Disclosure.State


type Msg
    = UserMsg Disclosure.Msg
    | InputChanged Decode.Value


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , view = view
        , subscriptions = subscriptions
        }


init : Decode.Value -> ( Model, Cmd Msg )
init raw =
    case Decode.decodeValue Disclosure.component.decodeInput raw of
        Ok input ->
            let
                ( state, command ) =
                    Disclosure.component.init input
            in
            ( Ready state, Cmd.map UserMsg command )

        Err error ->
            ( Invalid (Decode.errorToString error), Cmd.none )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case ( msg, model ) of
        ( UserMsg userMsg, Ready state ) ->
            run userMsg state

        ( InputChanged raw, Ready state ) ->
            case Decode.decodeValue Disclosure.component.decodeInput raw of
                Ok input ->
                    case Disclosure.component.receive input of
                        Just userMsg ->
                            run userMsg state

                        Nothing ->
                            ( Ready state, Cmd.none )

                Err error ->
                    ( Invalid (Decode.errorToString error), Cmd.none )

        ( InputChanged raw, Invalid _ ) ->
            init raw

        ( UserMsg _, Invalid _ ) ->
            ( model, Cmd.none )


run : Disclosure.Msg -> Disclosure.State -> ( Model, Cmd Msg )
run userMsg state =
    let
        transition =
            Disclosure.component.update userMsg state

        sendOutput output =
            output
                |> Disclosure.component.encodeOutput
                |> encodeEvent
                |> outputSent
    in
    ( Ready transition.state
    , Cmd.batch
        (Cmd.map UserMsg transition.command
            :: List.map sendOutput transition.outputs
        )
    )


encodeEvent : Component.Event -> Encode.Value
encodeEvent event =
    Encode.object
        [ ( "name", Encode.string event.name )
        , ( "detail", event.detail )
        ]


view : Model -> Html Msg
view model =
    case model of
        Ready state ->
            Html.map UserMsg (Disclosure.component.view state)

        Invalid error ->
            Html.text ("Invalid component attributes: " ++ error)


subscriptions : Model -> Sub Msg
subscriptions model =
    case model of
        Ready state ->
            Sub.batch
                [ inputChanged InputChanged
                , Sub.map UserMsg (Disclosure.component.subscriptions state)
                ]

        Invalid _ ->
            inputChanged InputChanged
