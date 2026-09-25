module Ui.DatePicker exposing (Input, Output(..), component)

{-| A date picker whose selected value belongs to the host.

The component owns the visible month. Clicking a day requests a new date;
the host sets `value` if it accepts the request. Changes to `start-month` after
initialization do not move the visible month.
-}

import Component exposing (Component)
import Html exposing (Html, button, div, span, text)
import Html.Attributes as Attributes
import Html.Events as Events
import Platform.Cmd as Cmd
import Platform.Sub as Sub


type alias Month =
    { year : Int, month : Int }


type alias Date =
    { year : Int, month : Int, day : Int }


type alias Input =
    { startMonth : String, value : Maybe String }


type alias State =
    { visible : Month, selected : Maybe Date }


type Msg
    = Received Input
    | Move Int
    | Select Int


type Output
    = DateRequested { value : String }


component : Component Input State Msg Output
component =
    Component.define
        { init = \input ->
            ( { visible = parseMonth input.startMonth |> Maybe.withDefault { year = 2026, month = 1 }
              , selected = Maybe.andThen parseDate input.value
              }
            , Cmd.none
            )
        , receive = Just << Received
        , update = update
        , view = view
        , subscriptions = always Sub.none
        }


update : Msg -> State -> ( State, Cmd Msg, List Output )
update msg state =
    case msg of
        Received input ->
            ( { state | selected = Maybe.andThen parseDate input.value }
            , Cmd.none
            , []
            )

        Move offset ->
            ( { state | visible = moveMonth offset state.visible }
            , Cmd.none
            , []
            )

        Select day ->
            ( state
            , Cmd.none
            , [ DateRequested
                    { value = dateString { year = state.visible.year, month = state.visible.month, day = day } }
              ]
            )


view : State -> Html Msg
view state =
    div [ Attributes.attribute "part" "calendar" ]
        [ div [ Attributes.attribute "part" "month-header" ]
            [ button
                [ Attributes.type_ "button"
                , Attributes.attribute "part" "previous-month"
                , Attributes.attribute "aria-label" "Previous month"
                , Events.onClick (Move -1)
                ]
                [ text "‹" ]
            , span [ Attributes.attribute "part" "month-label" ]
                [ text (monthName state.visible.month ++ " " ++ String.fromInt state.visible.year) ]
            , button
                [ Attributes.type_ "button"
                , Attributes.attribute "part" "next-month"
                , Attributes.attribute "aria-label" "Next month"
                , Events.onClick (Move 1)
                ]
                [ text "›" ]
            ]
        , div [ Attributes.attribute "part" "weekdays" ]
            (List.map (\day -> span [] [ text day ]) [ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" ])
        , div [ Attributes.attribute "part" "days" ]
            (List.repeat (weekday state.visible) (span [] [])
                ++ List.map (viewDay state) (List.range 1 (daysInMonth state.visible))
            )
        ]


viewDay : State -> Int -> Html Msg
viewDay state day =
    let
        selected =
            state.selected
                == Just { year = state.visible.year, month = state.visible.month, day = day }
    in
    button
        [ Attributes.type_ "button"
        , Attributes.attribute "part"
            (if selected then
                "day selected-day"

             else
                "day"
            )
        , Attributes.attribute "aria-pressed"
            (if selected then
                "true"

             else
                "false"
            )
        , Events.onClick (Select day)
        ]
        [ text (String.fromInt day) ]


parseMonth : String -> Maybe Month
parseMonth value =
    case String.split "-" value of
        [ yearText, monthText ] ->
            case ( String.toInt yearText, String.toInt monthText ) of
                ( Just year, Just month ) ->
                    if String.length yearText == 4 && String.length monthText == 2 && year > 0 && month >= 1 && month <= 12 then
                        Just { year = year, month = month }

                    else
                        Nothing

                _ ->
                    Nothing

        _ ->
            Nothing


parseDate : String -> Maybe Date
parseDate value =
    case String.split "-" value of
        [ yearText, monthText, dayText ] ->
            case ( parseMonth (yearText ++ "-" ++ monthText), String.toInt dayText ) of
                ( Just month, Just day ) ->
                    if String.length dayText == 2 && day >= 1 && day <= daysInMonth month then
                        Just { year = month.year, month = month.month, day = day }

                    else
                        Nothing

                _ ->
                    Nothing

        _ ->
            Nothing


dateString : Date -> String
dateString date =
    String.fromInt date.year
        ++ "-"
        ++ String.padLeft 2 '0' (String.fromInt date.month)
        ++ "-"
        ++ String.padLeft 2 '0' (String.fromInt date.day)


moveMonth : Int -> Month -> Month
moveMonth offset visible =
    let
        index =
            visible.year * 12 + visible.month - 1 + offset
    in
    { year = index // 12
    , month = modBy 12 index + 1
    }


daysInMonth : Month -> Int
daysInMonth visible =
    case visible.month of
        2 ->
            if modBy 400 visible.year == 0 || (modBy 4 visible.year == 0 && modBy 100 visible.year /= 0) then
                29

            else
                28

        4 ->
            30

        6 ->
            30

        9 ->
            30

        11 ->
            30

        _ ->
            31


weekday : Month -> Int
weekday visible =
    let
        year =
            if visible.month < 3 then
                visible.year - 1

            else
                visible.year

        monthOffset =
            List.drop (visible.month - 1) [ 0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4 ]
                |> List.head
                |> Maybe.withDefault 0
    in
    modBy 7 (year + year // 4 - year // 100 + year // 400 + monthOffset + 1)


monthName : Int -> String
monthName number =
    List.drop (number - 1)
        [ "January", "February", "March", "April", "May", "June"
        , "July", "August", "September", "October", "November", "December"
        ]
        |> List.head
        |> Maybe.withDefault ""
