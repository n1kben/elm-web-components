module Ui.TreeComponent exposing (Input, Msg(..), Output(..), State, Tree(..), component)

import Component exposing (Component)
import Html exposing (Html, text)
import Platform.Cmd as Cmd
import Platform.Sub as Sub


type Tree a
    = Leaf a
    | Branch (Tree a) (Tree a)


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
