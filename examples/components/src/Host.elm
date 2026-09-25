module Host exposing (main)

{-| An Elm app that owns the selected date through the generated date picker API.
-}

import Browser
import Html exposing (Html, div, p, text)
import WebComponents.Ui.DatePicker as DatePicker


type alias Model =
    { selected : String }


type Msg
    = DateRequested String


main : Program () Model Msg
main =
    Browser.element
        { init = \_ -> ( { selected = "2026-09-23" }, Cmd.none )
        , update = \(DateRequested value) model -> ( { model | selected = value }, Cmd.none )
        , subscriptions = always Sub.none
        , view = view
        }


view : Model -> Html Msg
view model =
    div []
        [ DatePicker.view
            { startMonth = "2026-09"
            , value = Just model.selected
            , onDateRequested = Just (DateRequested << .value)
            }
            []
        , p [] [ text ("Elm selected: " ++ model.selected) ]
        ]
