module Host exposing (main)

{-| A regular Elm application consuming a generated custom element.
-}

import Browser
import Html exposing (Html, div, node, p, text)
import Html.Attributes as Attributes
import Html.Events as Events
import Json.Decode as Decode


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
        [ node "ui-date-picker"
            [ Attributes.attribute "start-month" "2026-09"
            , Attributes.attribute "value" model.selected
            , Events.on "date-requested"
                (Decode.at [ "detail", "value" ] Decode.string
                    |> Decode.map DateRequested
                )
            ]
            []
        , p [] [ text ("Elm selected: " ++ model.selected) ]
        ]
