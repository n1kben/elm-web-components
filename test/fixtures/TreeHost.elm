module TreeHost exposing (main)

import Browser
import Html exposing (Html)
import Ui.TreeComponent exposing (Tree(..))
import WebComponents.Ui.TreeComponent


type Msg
    = Selected { tree : Tree String }


main : Program () (Tree String) Msg
main =
    Browser.sandbox
        { init = Branch (Leaf "A") (Leaf "B")
        , update = \(Selected output) _ -> output.tree
        , view = view
        }


view : Tree String -> Html Msg
view tree =
    WebComponents.Ui.TreeComponent.view
        { tree = tree
        , onSelected = Just Selected
        }
        []
