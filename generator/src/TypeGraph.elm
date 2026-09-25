module TypeGraph exposing (Definition(..), Wire(..), collect, decoder, encoder, fromAnnotation, fromPackageType, generate, parseDefinition, render)

import Char
import Dict exposing (Dict)
import Elm.Type
import Elm.Syntax.Declaration as Declaration exposing (Declaration)
import Elm.Syntax.Node as Node exposing (Node)
import Elm.Syntax.TypeAnnotation as Annotation exposing (TypeAnnotation)
import Json.Encode
import Set exposing (Set)


type Wire
    = Primitive String
    | Variable String
    | Optional Wire
    | Sequence Wire
    | Outcome Wire Wire
    | Tuple (List Wire)
    | Record (List ( String, Wire ))
    | Named String (List Wire)


type Definition
    = Alias (List String) Wire
    | Union (List String) (List ( String, List Wire ))


fromAnnotation : (List String -> String -> Result String String) -> Set String -> Node TypeAnnotation -> Result String Wire
fromAnnotation resolve variables node =
    let
        nested =
            fromAnnotation resolve variables
    in
    case Node.value node of
        Annotation.GenericType name ->
            if Set.member name variables then
                Ok (Variable name)

            else
                Err ("unbound type variable " ++ name)

        Annotation.Unit ->
            Ok (Tuple [])

        Annotation.Tupled members ->
            traverse nested members |> Result.map Tuple

        Annotation.Record fields ->
            traverse
                (\field ->
                    let
                        ( name, annotation ) =
                            Node.value field
                    in
                    nested annotation |> Result.map (\wire -> ( Node.value name, wire ))
                )
                fields
                |> Result.map Record

        Annotation.GenericRecord _ _ ->
            Err "extensible records cannot cross a component boundary"

        Annotation.FunctionTypeAnnotation _ _ ->
            Err "functions cannot cross a component boundary"

        Annotation.Typed nameNode args ->
            let
                ( qualifier, name ) =
                    Node.value nameNode

                qualified =
                    String.join "." qualifier
            in
            traverse nested args
                |> Result.andThen
                    (\parameters ->
                        if List.isEmpty qualifier && List.member name [ "String", "Bool", "Int", "Float" ] && List.isEmpty parameters then
                            Ok (Primitive name)

                        else if (List.isEmpty qualifier || qualified == "Maybe") && name == "Maybe" then
                            case parameters of
                                [ item ] ->
                                    Ok (Optional item)

                                _ ->
                                    Err "Maybe needs one type argument"

                        else if (List.isEmpty qualifier || qualified == "List") && name == "List" then
                            case parameters of
                                [ item ] ->
                                    Ok (Sequence item)

                                _ ->
                                    Err "List needs one type argument"

                        else if (List.isEmpty qualifier || qualified == "Result") && name == "Result" then
                            case parameters of
                                [ err, value ] ->
                                    Ok (Outcome err value)

                                _ ->
                                    Err "Result needs two type arguments"

                        else
                            resolve qualifier name |> Result.map (\qualifiedName -> Named qualifiedName parameters)
                    )


collect : (String -> Result String Definition) -> List Wire -> Result String (Dict String Definition)
collect load roots =
    let
        visitWire : Wire -> Dict String Definition -> Result String (Dict String Definition)
        visitWire wire found =
            case wire of
                Named key parameters ->
                    List.foldl (\parameter result -> result |> Result.andThen (visitWire parameter)) (Ok found) parameters
                        |> Result.andThen
                            (\withParameters ->
                                case Dict.get key withParameters of
                                    Just definition ->
                                        if definitionArity definition == List.length parameters then
                                            Ok withParameters

                                        else
                                            Err (key ++ " needs " ++ String.fromInt (definitionArity definition) ++ " type arguments")

                                    Nothing ->
                                        load key
                                            |> Result.andThen
                                                (\definition ->
                                                let
                                                    ( vars, members ) =
                                                        case definition of
                                                            Alias arguments body ->
                                                                ( arguments, [ body ] )

                                                            Union arguments cases ->
                                                                ( arguments, List.concatMap Tuple.second cases )
                                                in
                                                if List.length vars /= List.length parameters then
                                                    Err (key ++ " needs " ++ String.fromInt (List.length vars) ++ " type arguments")

                                                else
                                                    List.foldl
                                                        (\member result -> result |> Result.andThen (visitWire member))
                                                        (Ok (Dict.insert key definition withParameters))
                                                        members
                                                )
                            )

                Optional item ->
                    visitWire item found

                Sequence item ->
                    visitWire item found

                Outcome err value ->
                    visitWire err found |> Result.andThen (visitWire value)

                Tuple members ->
                    List.foldl (\member result -> result |> Result.andThen (visitWire member)) (Ok found) members

                Record fields ->
                    List.foldl (\( _, member ) result -> result |> Result.andThen (visitWire member)) (Ok found) fields

                _ ->
                    Ok found
    in
    List.foldl (\wire result -> result |> Result.andThen (visitWire wire)) (Ok Dict.empty) roots


definitionArity : Definition -> Int
definitionArity definition =
    case definition of
        Alias arguments _ ->
            List.length arguments

        Union arguments _ ->
            List.length arguments


parseDefinition : (List String -> String -> Result String String) -> Declaration -> Result String Definition
parseDefinition resolve declaration =
    case declaration of
        Declaration.AliasDeclaration alias_ ->
            let
                vars =
                    List.map Node.value alias_.generics
            in
            fromAnnotation resolve (Set.fromList vars) alias_.typeAnnotation |> Result.map (Alias vars)

        Declaration.CustomTypeDeclaration union ->
            let
                vars =
                    List.map Node.value union.generics
            in
            traverse
                (\variantNode ->
                    let
                        variant =
                            Node.value variantNode
                    in
                    traverse (fromAnnotation resolve (Set.fromList vars)) variant.arguments
                        |> Result.map (\arguments -> ( Node.value variant.name, arguments ))
                )
                union.constructors
                |> Result.map (Union vars)

        _ ->
            Err "expected a type declaration"


fromPackageType : Elm.Type.Type -> Result String Wire
fromPackageType packageType =
    case packageType of
        Elm.Type.Var name ->
            Ok (Variable name)

        Elm.Type.Lambda _ _ ->
            Err "functions cannot cross a component boundary"

        Elm.Type.Tuple items ->
            traverse fromPackageType items |> Result.map Tuple

        Elm.Type.Record fields extension ->
            case extension of
                Just _ ->
                    Err "extensible records cannot cross a component boundary"

                Nothing ->
                    traverse (\( name, item ) -> fromPackageType item |> Result.map (\wire -> ( name, wire ))) fields
                        |> Result.map Record

        Elm.Type.Type qualified args ->
            traverse fromPackageType args
                |> Result.andThen
                    (\parameters ->
                        case ( qualified, parameters ) of
                            ( "String.String", [] ) ->
                                Ok (Primitive "String")

                            ( "Basics.Bool", [] ) ->
                                Ok (Primitive "Bool")

                            ( "Basics.Int", [] ) ->
                                Ok (Primitive "Int")

                            ( "Basics.Float", [] ) ->
                                Ok (Primitive "Float")

                            ( "Maybe.Maybe", [ item ] ) ->
                                Ok (Optional item)

                            ( "List.List", [ item ] ) ->
                                Ok (Sequence item)

                            ( "Result.Result", [ err, value ] ) ->
                                Ok (Outcome err value)

                            _ ->
                                Ok (Named qualified parameters)
                    )


encoder : Wire -> String
encoder wire =
    case wire of
        Primitive name ->
            "Encode." ++ String.toLower name

        Variable name ->
            "encode" ++ capitalize name

        Optional item ->
            "(encodeMaybe " ++ encoder item ++ ")"

        Sequence item ->
            "(Encode.list " ++ encoder item ++ ")"

        Outcome err value ->
            "(encodeResult " ++ encoder err ++ " " ++ encoder value ++ ")"

        Tuple [] ->
            "(\\_ -> Encode.null)"

        Tuple members ->
            let
                names =
                    List.indexedMap (\index _ -> "item" ++ String.fromInt index) members
            in
            "(\\(" ++ String.join ", " names ++ ") -> Encode.list identity [ " ++ String.join ", " (List.map2 (\member name -> encoder member ++ " " ++ name) members names) ++ " ])"

        Record fields ->
            "(\\record -> Encode.object [ " ++ String.join ", " (List.map (\( name, member ) -> "( " ++ quoted name ++ ", " ++ encoder member ++ " record." ++ name ++ " )") fields) ++ " ])"

        Named name arguments ->
            "(encode" ++ codecName name ++ " " ++ String.join " " (List.map encoder arguments) ++ ")"


decoder : Wire -> String
decoder wire =
    case wire of
        Primitive name ->
            "Decode." ++ String.toLower name

        Variable name ->
            "decode" ++ capitalize name

        Optional item ->
            "(decodeMaybe " ++ decoder item ++ ")"

        Sequence item ->
            "(Decode.list " ++ decoder item ++ ")"

        Outcome err value ->
            "(decodeResult " ++ decoder err ++ " " ++ decoder value ++ ")"

        Tuple [] ->
            "(Decode.null ())"

        Tuple members ->
            let
                names =
                    List.indexedMap (\index _ -> "item" ++ String.fromInt index) members
            in
            decodeApply ("(\\" ++ String.join " " names ++ " -> ( " ++ String.join ", " names ++ " ))")
                (List.indexedMap (\index member -> "(Decode.index " ++ String.fromInt index ++ " " ++ decoder member ++ ")") members)

        Record fields ->
            let
                names =
                    List.indexedMap (\index _ -> "field" ++ String.fromInt index) fields

                record =
                    "{ " ++ String.join ", " (List.map2 (\( name, _ ) value -> name ++ " = " ++ value) fields names) ++ " }"
            in
            decodeApply ("(\\" ++ String.join " " names ++ " -> " ++ record ++ ")")
                (List.map (\( name, member ) -> "(Decode.field " ++ quoted name ++ " " ++ decoder member ++ ")") fields)

        Named name arguments ->
            "(Decode.lazy (\\_ -> decode" ++ codecName name ++ " " ++ String.join " " (List.map decoder arguments) ++ "))"


generate : String -> Dict String Definition -> String
generate _ definitions =
    if Dict.isEmpty definitions then
        ""

    else
        String.join "\n\n" (List.map (\( name, definition ) -> generateDefinition name definition) (Dict.toList definitions))


generateDefinition : String -> Definition -> String
generateDefinition key definition =
    let
        parts =
            String.split "." key

        name =
            List.reverse parts |> List.head |> Maybe.withDefault key

        moduleName =
            List.reverse parts |> List.drop 1 |> List.reverse |> String.join "."

        codec =
            codecName key
    in
    case definition of
        Alias vars body ->
            "encode" ++ codec ++ " " ++ String.join " " (List.map (\variable -> "encode" ++ capitalize variable) vars) ++ " value =\n    " ++ encoder body ++ " value\n\ndecode" ++ codec ++ " " ++ String.join " " (List.map (\variable -> "decode" ++ capitalize variable) vars) ++ " =\n    " ++ decoder body

        Union vars cases ->
            let
                encodeCase ( variant, args ) =
                    let
                        names =
                            List.indexedMap (\index _ -> "arg" ++ String.fromInt index) args
                    in
                    "        " ++ moduleName ++ "." ++ variant ++ " " ++ String.join " " names ++ " ->\n            Encode.object [ ( \"type\", Encode.string " ++ quoted (kebab variant) ++ " ), ( \"args\", Encode.list identity [ " ++ String.join ", " (List.map2 (\arg value -> encoder arg ++ " " ++ value) args names) ++ " ] ) ]"

                decodeCase ( variant, args ) =
                    "                " ++ quoted (kebab variant) ++ " ->\n                    " ++ decodeApply (moduleName ++ "." ++ variant) (List.indexedMap (\index arg -> "(Decode.at [ \"args\" ] (Decode.index " ++ String.fromInt index ++ " " ++ decoder arg ++ "))") args)
            in
            "encode" ++ codec ++ " " ++ String.join " " (List.map (\variable -> "encode" ++ capitalize variable) vars) ++ " value =\n    case value of\n" ++ String.join "\n\n" (List.map encodeCase cases) ++ "\n\ndecode" ++ codec ++ " " ++ String.join " " (List.map (\variable -> "decode" ++ capitalize variable) vars) ++ " =\n    Decode.lazy (\\_ -> Decode.field \"type\" Decode.string |> Decode.andThen (\\tag -> case tag of\n" ++ String.join "\n\n" (List.map decodeCase cases) ++ "\n\n                _ ->\n                    Decode.fail (\"Unknown " ++ name ++ " constructor: \" ++ tag)\n    ))"


render : String -> Wire -> String
render moduleName wire =
    case wire of
        Primitive name ->
            name

        Variable name ->
            name

        Optional item ->
            "Maybe " ++ nestedType moduleName item

        Sequence item ->
            "List " ++ nestedType moduleName item

        Outcome err value ->
            "Result " ++ nestedType moduleName err ++ " " ++ nestedType moduleName value

        Tuple [] ->
            "()"

        Tuple items ->
            "( " ++ String.join ", " (List.map (render moduleName) items) ++ " )"

        Record fields ->
            "{ " ++ String.join ", " (List.map (\( name, item ) -> name ++ " : " ++ render moduleName item) fields) ++ " }"

        Named name args ->
            name ++ (if List.isEmpty args then "" else " " ++ String.join " " (List.map (nestedType moduleName) args))


nestedType : String -> Wire -> String
nestedType moduleName wire =
    case wire of
        Optional _ ->
            "(" ++ render moduleName wire ++ ")"

        Sequence _ ->
            "(" ++ render moduleName wire ++ ")"

        Outcome _ _ ->
            "(" ++ render moduleName wire ++ ")"

        Named _ (_ :: _) ->
            "(" ++ render moduleName wire ++ ")"

        _ ->
            render moduleName wire


decodeApply : String -> List String -> String
decodeApply constructor arguments =
    List.foldl (\argument result -> "(" ++ result ++ " |> andMap " ++ argument ++ ")") ("Decode.succeed " ++ constructor) arguments


traverse : (a -> Result x b) -> List a -> Result x (List b)
traverse fn items =
    List.foldr (\item result -> Result.map2 (::) (fn item) result) (Ok []) items


capitalize : String -> String
capitalize string =
    case String.uncons string of
        Nothing ->
            string

        Just ( first, rest ) ->
            String.fromChar (Char.toUpper first) ++ rest


kebab : String -> String
kebab value =
    value
        |> String.toList
        |> List.indexedMap (\index char -> if Char.isUpper char && index > 0 then "-" ++ String.fromChar (Char.toLower char) else String.fromChar (Char.toLower char))
        |> String.join ""


quoted : String -> String
quoted =
    Json.Encode.string >> Json.Encode.encode 0


codecName : String -> String
codecName =
    String.replace "." "_"
