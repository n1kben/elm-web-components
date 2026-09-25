module ProjectIndex exposing (Index, Package, Source, build, canEncode, load, resolve)

import Dict exposing (Dict)
import Elm.Docs
import Elm.Parser
import Elm.Syntax.Declaration as Declaration exposing (Declaration)
import Elm.Syntax.Exposing as Exposing
import Elm.Syntax.File exposing (File)
import Elm.Syntax.Module as Module
import Elm.Syntax.Node as Node
import Json.Decode as Decode
import TypeGraph


type alias Source =
    { path : String, contents : String }


type alias IndexedModule =
    { path : String, file : File }


type alias Package =
    { name : String, docs : String }


type alias Index =
    { project : Dict String IndexedModule
    , packages : Dict String Elm.Docs.Module
    }


build : List Source -> List Package -> Result String Index
build sources packages =
    List.foldl
        (\source result ->
            result
                |> Result.andThen
                    (\index ->
                        Elm.Parser.parseToFile source.contents
                            |> Result.mapError (\_ -> source.path ++ ": Elm syntax error; run elm make for the full compiler message")
                            |> Result.map
                                (\file ->
                                    Dict.insert
                                        (Module.moduleName (Node.value file.moduleDefinition) |> String.join ".")
                                        { path = source.path, file = file }
                                        index
                                )
                    )
        )
        (Ok Dict.empty)
        sources
        |> Result.andThen
            (\project ->
                List.foldl
                    (\package result ->
                        result
                            |> Result.andThen
                                (\docs ->
                                    Decode.decodeString (Decode.list Elm.Docs.decoder) package.docs
                                        |> Result.mapError (\error -> package.name ++ ": invalid docs.json: " ++ Decode.errorToString error)
                                        |> Result.map
                                            (\modules ->
                                                List.foldl (\item index -> Dict.insert item.name item index) docs modules
                                            )
                                )
                    )
                    (Ok Dict.empty)
                    packages
                    |> Result.map (\docs -> { project = project, packages = docs })
            )


resolve : Index -> String -> List String -> String -> Result String String
resolve index currentModule qualifier name =
    case Dict.get currentModule index.project of
        Nothing ->
            Err ("unknown module " ++ currentModule)

        Just current ->
            let
                imports =
                    List.map Node.value current.file.imports

                candidates =
                    if List.isEmpty qualifier then
                        if hasDeclaration name current.file then
                            [ currentModule ]

                        else
                            List.filterMap
                                (\item ->
                                    case item.exposingList of
                                        Just exposure ->
                                            if exposesType name (Node.value exposure) then
                                                Just (Node.value item.moduleName |> String.join ".")

                                            else
                                                Nothing

                                        Nothing ->
                                            Nothing
                                )
                                imports

                    else if String.join "." qualifier == currentModule then
                        [ currentModule ]

                    else
                        List.filterMap
                            (\item ->
                                let
                                    moduleName =
                                        Node.value item.moduleName |> String.join "."

                                    aliasName =
                                        Maybe.map (Node.value >> String.join ".") item.moduleAlias
                                in
                                if String.join "." qualifier == moduleName || aliasName == Just (String.join "." qualifier) then
                                    Just moduleName

                                else
                                    Nothing
                            )
                            imports

                valid =
                    List.filter
                        (\moduleName ->
                            case Dict.get moduleName index.project of
                                Just target ->
                                    hasDeclaration name target.file
                                        && (moduleName == currentModule || exposesType name (Module.exposingList (Node.value target.file.moduleDefinition)))

                                Nothing ->
                                    case Dict.get moduleName index.packages of
                                        Just target ->
                                            hasPackageDeclaration name target

                                        Nothing ->
                                            False
                        )
                        candidates
            in
            case valid of
                [ moduleName ] ->
                    Ok (moduleName ++ "." ++ name)

                [] ->
                    Err ("cannot resolve type " ++ String.join "." (qualifier ++ [ name ]))

                _ ->
                    Err ("ambiguous type " ++ name ++ " from " ++ String.join ", " valid)


load : Index -> String -> Result String TypeGraph.Definition
load index key =
    let
        parts =
            String.split "." key

        name =
            List.reverse parts |> List.head |> Maybe.withDefault key

        moduleName =
            List.reverse parts |> List.drop 1 |> List.reverse |> String.join "."
    in
    case Dict.get moduleName index.project of
        Nothing ->
            case Dict.get moduleName index.packages of
                Just docs ->
                    loadPackage key name docs

                Nothing ->
                    Err ("unknown module " ++ moduleName)

        Just target ->
            case findDeclaration name target.file of
                Nothing ->
                    Err (target.path ++ ": unknown type " ++ key)

                Just declaration ->
                    TypeGraph.parseDefinition (resolve index moduleName) declaration
                        |> Result.mapError (\message -> target.path ++ ": " ++ message)


canEncode : Index -> String -> TypeGraph.Definition -> Bool
canEncode index key definition =
    let
        parts =
            String.split "." key

        name =
            List.reverse parts |> List.head |> Maybe.withDefault key

        moduleName =
            List.reverse parts |> List.drop 1 |> List.reverse |> String.join "."
    in
    case Dict.get moduleName index.project of
        Nothing ->
            Dict.get moduleName index.packages
                |> Maybe.map (\docs -> hasPackageDeclaration name docs && packageConstructorsAvailable name definition docs)
                |> Maybe.withDefault False

        Just target ->
            case definition of
                TypeGraph.Alias _ _ ->
                    exposesType name (Module.exposingList (Node.value target.file.moduleDefinition))

                TypeGraph.Union _ _ ->
                    exposesConstructors name (Module.exposingList (Node.value target.file.moduleDefinition))


hasPackageDeclaration : String -> Elm.Docs.Module -> Bool
hasPackageDeclaration name docs =
    List.any (\item -> item.name == name) docs.aliases
        || List.any (\item -> item.name == name) docs.unions


packageConstructorsAvailable : String -> TypeGraph.Definition -> Elm.Docs.Module -> Bool
packageConstructorsAvailable name definition docs =
    case definition of
        TypeGraph.Alias _ _ ->
            True

        TypeGraph.Union _ _ ->
            List.any (\item -> item.name == name && not (List.isEmpty item.tags)) docs.unions


loadPackage : String -> String -> Elm.Docs.Module -> Result String TypeGraph.Definition
loadPackage key name docs =
    case List.filter (\item -> item.name == name) docs.aliases |> List.head of
        Just alias_ ->
            TypeGraph.fromPackageType alias_.tipe
                |> Result.map (TypeGraph.Alias alias_.args)
                |> Result.mapError (\message -> key ++ ": " ++ message)

        Nothing ->
            case List.filter (\item -> item.name == name) docs.unions |> List.head of
                Just union ->
                    if List.isEmpty union.tags then
                        Err (key ++ " is opaque; generated codecs need visible constructors")

                    else
                        union.tags
                            |> traverse
                                (\( tag, arguments ) ->
                                    traverse TypeGraph.fromPackageType arguments
                                        |> Result.map (Tuple.pair tag)
                                )
                            |> Result.map (TypeGraph.Union union.args)
                            |> Result.mapError (\message -> key ++ ": " ++ message)

                Nothing ->
                    Err ("unknown type " ++ key)


traverse : (a -> Result String b) -> List a -> Result String (List b)
traverse parse items =
    List.foldr (\item result -> Result.map2 (::) (parse item) result) (Ok []) items


hasDeclaration : String -> File -> Bool
hasDeclaration name file =
    findDeclaration name file /= Nothing


findDeclaration : String -> File -> Maybe Declaration
findDeclaration name file =
    file.declarations
        |> List.map Node.value
        |> List.filter
            (\declaration ->
                case declaration of
                    Declaration.AliasDeclaration alias_ ->
                        Node.value alias_.name == name

                    Declaration.CustomTypeDeclaration union ->
                        Node.value union.name == name

                    _ ->
                        False
            )
        |> List.head


exposesType : String -> Exposing.Exposing -> Bool
exposesType name exposure =
    case exposure of
        Exposing.All _ ->
            True

        Exposing.Explicit items ->
            List.any
                (\item ->
                    case Node.value item of
                        Exposing.TypeOrAliasExpose itemName ->
                            itemName == name

                        Exposing.TypeExpose exposed ->
                            exposed.name == name

                        _ ->
                            False
                )
                items


exposesConstructors : String -> Exposing.Exposing -> Bool
exposesConstructors name exposure =
    case exposure of
        Exposing.All _ ->
            True

        Exposing.Explicit items ->
            List.any
                (\item ->
                    case Node.value item of
                        Exposing.TypeExpose exposed ->
                            exposed.name == name && exposed.open /= Nothing

                        _ ->
                            False
                )
                items
