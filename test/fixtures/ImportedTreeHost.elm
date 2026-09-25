module ImportedTreeHost exposing (main)

import Browser
import Data.Tree exposing (Tree(..))
import Html exposing (Html)
import WebComponents.Ui.ImportedTree


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
    WebComponents.Ui.ImportedTree.view
        { tree = tree
        , onSelected = Just Selected
        }
        []
