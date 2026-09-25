module Ui.PackageUrl exposing (Input, Msg(..), Output(..), State, component)

import Component exposing (Component)
import Html exposing (text)
import Platform.Cmd as Cmd
import Platform.Sub as Sub
import Url


type alias Input =
    { url : Url.Url }


type Output
    = Selected { url : Url.Url }


type alias State =
    Input


type Msg
    = Received Input


component : Component Input State Msg Output
component =
    Component.define
        { init = \input -> ( input, Cmd.none )
        , receive = Just << Received
        , update = \msg state ->
            case msg of
                Received input ->
                    ( input, Cmd.none, [ Selected { url = state.url } ] )
        , view = \_ -> text "url"
        , subscriptions = always Sub.none
        }
