module Ui.Disclosure exposing (Input, Msg, Output(..), State, component)

import Component exposing (Component)
import Html exposing (Html, button, div, node, text)
import Html.Attributes as Attributes
import Html.Events as Events
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
    = Toggled { open : Bool }


component : Component Input State Msg Output
component =
    Component.define
        { init = init
        , receive = Just << Received
        , update = update
        , view = view
        , subscriptions = always Sub.none
        }


init : Input -> ( State, Cmd Msg )
init input =
    ( { input = input, open = False }, Cmd.none )


update : Msg -> State -> ( State, Cmd Msg, List Output )
update msg state =
    case msg of
        Received input ->
            ( { state | input = input, open = state.open && not input.disabled }
            , Cmd.none
            , []
            )

        Toggle ->
            if state.input.disabled then
                ( state, Cmd.none, [] )

            else
                let
                    open =
                        not state.open
                in
                ( { state | open = open }
                , Cmd.none
                , [ Toggled { open = open } ]
                )


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
