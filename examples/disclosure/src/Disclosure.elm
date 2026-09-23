module Disclosure exposing (Input, Msg, Output, State, component)

import Component exposing (Component)
import Html exposing (Html, button, div, node, text)
import Html.Attributes as Attributes
import Html.Events as Events
import Json.Decode as Decode
import Json.Encode as Encode
import Platform.Cmd as Cmd
import Platform.Sub as Sub


type alias Input =
    { label : String
    , disabled : Bool
    }


type alias State =
    { input : Input
    , open : Bool
    }


type Msg
    = Received Input
    | Toggle


type Output
    = Toggled Bool


component : Component Input State Msg Output
component =
    { decodeInput =
        Decode.map2 Input
            (Decode.oneOf
                [ Decode.field "label" Decode.string
                , Decode.succeed "Details"
                ]
            )
            (Decode.oneOf
                [ Decode.field "disabled" Decode.string |> Decode.map (always True)
                , Decode.succeed False
                ]
            )
    , init = init
    , receive = Just << Received
    , update = update
    , view = view
    , subscriptions = always Sub.none
    , encodeOutput = encodeOutput
    }


init : Input -> ( State, Cmd Msg )
init input =
    ( { input = input, open = False }, Cmd.none )


update : Msg -> State -> Component.Transition State Msg Output
update msg state =
    case msg of
        Received input ->
            { state = { state | input = input, open = state.open && not input.disabled }
            , command = Cmd.none
            , outputs = []
            }

        Toggle ->
            if state.input.disabled then
                { state = state, command = Cmd.none, outputs = [] }

            else
                let
                    open =
                        not state.open
                in
                { state = { state | open = open }
                , command = Cmd.none
                , outputs = [ Toggled open ]
                }


view : State -> Html Msg
view state =
    div []
        [ button
            [ Attributes.attribute "part" "trigger"
            , Attributes.attribute "aria-expanded" (boolString state.open)
            , Attributes.disabled state.input.disabled
            , Events.onClick Toggle
            ]
            [ text state.input.label ]
        , div
            [ Attributes.attribute "part" "panel"
            , Attributes.hidden (not state.open)
            ]
            [ node "slot" [] [] ]
        ]


boolString : Bool -> String
boolString bool =
    if bool then
        "true"

    else
        "false"


encodeOutput : Output -> Component.Event
encodeOutput output =
    case output of
        Toggled open ->
            { name = "toggle"
            , detail = Encode.object [ ( "open", Encode.bool open ) ]
            }
