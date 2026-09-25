module Ui.ImportedTree exposing (Input, Msg(..), Output(..), State, component)

import Component exposing (Component)
import Data.Tree exposing (Tree)
import Html exposing (text)
import Platform.Cmd as Cmd
import Platform.Sub as Sub


type alias Input =
    { tree : Tree String }


type Output
    = Selected { tree : Tree String }


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
                    ( input, Cmd.none, [ Selected { tree = state.tree } ] )
        , view = \_ -> text "tree"
        , subscriptions = always Sub.none
        }
