port module Generator exposing (main)

import Char
import Dict exposing (Dict)
import Elm.Parser
import Elm.Syntax.Declaration as Declaration exposing (Declaration)
import Elm.Syntax.Exposing as Exposing
import Elm.Syntax.Expression as Expression
import Elm.Syntax.File exposing (File)
import Elm.Syntax.Module as Module
import Elm.Syntax.Node as Node exposing (Node)
import Elm.Syntax.Type as Type
import Elm.Syntax.TypeAlias as TypeAlias
import Elm.Syntax.TypeAnnotation as Annotation exposing (TypeAnnotation)
import Elm.Writer
import Json.Decode as Decode
import Json.Encode as Encode
import Platform
import ProjectIndex
import Set exposing (Set)
import TypeGraph


port request : (Decode.Value -> msg) -> Sub msg


port response : Encode.Value -> Cmd msg


type Msg
    = Request Decode.Value


type alias Source =
    { id : Int, path : String, contents : String, modules : List ProjectIndex.Source, packages : List ProjectIndex.Package }


type alias Field =
    { name : String, typeName : String, attribute : String, wire : TypeGraph.Wire }


type alias Output =
    { name : String, fields : List Field, event : String }


type alias Component =
    { path : String
    , moduleName : String
    , tag : String
    , suffix : String
    , inputs : List Field
    , outputs : List Output
    , graph : Dict String TypeGraph.Definition
    }


main : Program () () Msg
main =
    Platform.worker
        { init = \_ -> ( (), Cmd.none )
        , update = \msg model ->
            case msg of
                Request value ->
                    ( model, response (handle value) )
        , subscriptions = \_ -> request Request
        }


handle : Decode.Value -> Encode.Value
handle value =
    case Decode.decodeValue sourceDecoder value of
        Err error ->
            Encode.object [ ( "error", Encode.string (Decode.errorToString error) ) ]

        Ok source ->
            case Elm.Parser.parseToFile source.contents of
                Err errors ->
                    case List.head errors of
                        Just error ->
                            Encode.object [ ( "id", Encode.int source.id ), ( "error", Encode.string (source.path ++ ":" ++ String.fromInt error.row ++ ":" ++ String.fromInt error.col ++ ": Elm syntax error; run elm make for the full compiler message") ) ]

                        Nothing ->
                            Encode.object [ ( "id", Encode.int source.id ), ( "error", Encode.string (source.path ++ ": Elm syntax error") ) ]

                Ok file ->
                    case ProjectIndex.build ({ path = source.path, contents = source.contents } :: source.modules) source.packages of
                        Err error ->
                            Encode.object [ ( "id", Encode.int source.id ), ( "error", Encode.string error ) ]

                        Ok index ->
                            case parseComponent source.path file index of
                                Err error ->
                                    Encode.object [ ( "id", Encode.int source.id ), ( "error", Encode.string error ) ]

                                Ok component ->
                                    Encode.object
                                        [ ( "id", Encode.int source.id )
                                        , ( "component", encodeComponent component )
                                        , ( "elm", Encode.string (generatedElm component) )
                                        , ( "host", Encode.string (generatedHost component) )
                                        , ( "adapter", Encode.string (generatedAdapter component) )
                                        , ( "codec", Encode.string (generatedCodec component) )
                                        ]


sourceDecoder : Decode.Decoder Source
sourceDecoder =
    Decode.map5 Source
        (Decode.field "id" Decode.int)
        (Decode.field "path" Decode.string)
        (Decode.field "contents" Decode.string)
        (Decode.oneOf [ Decode.field "modules" (Decode.list moduleSourceDecoder), Decode.succeed [] ])
        (Decode.oneOf [ Decode.field "packages" (Decode.list packageDecoder), Decode.succeed [] ])


moduleSourceDecoder : Decode.Decoder ProjectIndex.Source
moduleSourceDecoder =
    Decode.map2 ProjectIndex.Source (Decode.field "path" Decode.string) (Decode.field "contents" Decode.string)


packageDecoder : Decode.Decoder ProjectIndex.Package
packageDecoder =
    Decode.map2 ProjectIndex.Package (Decode.field "name" Decode.string) (Decode.field "docs" Decode.string)


encodeComponent : Component -> Encode.Value
encodeComponent component =
    Encode.object
        [ ( "path", Encode.string component.path )
        , ( "module", Encode.string component.moduleName )
        , ( "tag", Encode.string component.tag )
        , ( "suffix", Encode.string component.suffix )
        , ( "inputs", Encode.list encodeField component.inputs )
        , ( "outputs", Encode.list encodeOutput component.outputs )
        ]


encodeField : Field -> Encode.Value
encodeField field =
    Encode.object
        [ ( "name", Encode.string field.name )
        , ( "type", Encode.string field.typeName )
        , ( "attribute", Encode.string field.attribute )
        ]


encodeOutput : Output -> Encode.Value
encodeOutput output =
    Encode.object
        [ ( "name", Encode.string output.name )
        , ( "event", Encode.string output.event )
        , ( "fields", Encode.list encodeField output.fields )
        ]


parseComponent : String -> File -> ProjectIndex.Index -> Result String Component
parseComponent path file index =
    let
        moduleName =
            Module.moduleName (Node.value file.moduleDefinition) |> String.join "."

        exposingList =
            Module.exposingList (Node.value file.moduleDefinition)

        declarations =
            List.map Node.value file.declarations

        resolveType qualifier name =
            ProjectIndex.resolve index moduleName qualifier name

        loadType key =
            ProjectIndex.load index key
    in
    if not (String.contains "." moduleName) then
        Err (path ++ ": expected a namespaced module, such as Ui.DatePicker")

    else if not (exposes "Input" "type" exposingList && exposes "Output" "constructors" exposingList && exposes "component" "function" exposingList) then
        Err (path ++ ": expose Input, Output(..), and component")

    else
        case ( findAlias "Input" declarations, findType "Output" declarations, findFunction "component" declarations ) of
            ( Just input, Just output, Just componentFunction ) ->
                case Node.value input.typeAnnotation of
                    Annotation.Record inputFields ->
                        if not (List.isEmpty input.generics) then
                            Err (location path input.name ++ "Input cannot take type parameters")

                        else if not (List.isEmpty output.generics) then
                            Err (location path output.name ++ "Output cannot take type parameters")

                        else if not (validComponentFunction componentFunction) then
                            Err (location path componentFunction.declaration ++ "expected component : Component Input State Msg Output and component = Component.define")

                        else
                            parseFields path resolveType inputFields
                                |> Result.andThen
                                    (\inputs ->
                                        traverse (parseVariant path resolveType) output.constructors
                                            |> Result.andThen
                                                (\outputs ->
                                                    if List.length inputs > 8 then
                                                        Err (location path input.name ++ "at most eight Input fields are supported in v1")

                                                    else if duplicate (List.map .attribute inputs) then
                                                        Err (location path input.name ++ "Input fields map to duplicate attribute names")

                                                    else if duplicate (List.map .event outputs) then
                                                        Err (location path output.name ++ "Output constructors map to duplicate event names")

                                                    else
                                                        let
                                                            tag =
                                                                moduleName |> String.split "." |> List.map kebab |> String.join "-"

                                                            roots =
                                                                List.map .wire inputs ++ List.concatMap (\item -> List.map .wire item.fields) outputs
                                                        in
                                                        TypeGraph.collect loadType roots
                                                            |> Result.andThen
                                                                (\graph ->
                                                                    case Dict.toList graph |> List.filter (\( name, definition ) -> not (ProjectIndex.canEncode index name definition)) |> List.head of
                                                                        Just ( hidden, _ ) ->
                                                                            Err (path ++ ": expose " ++ hidden ++ " (and its constructors if it is a union) for generated codecs")

                                                                        Nothing ->
                                                                            Ok
                                                                                { path = path
                                                                                , moduleName = moduleName
                                                                                , tag = tag
                                                                                , suffix = "Tag" ++ (String.toList tag |> List.map (Char.toCode >> String.fromInt >> String.padLeft 3 '0') |> String.join "")
                                                                                , inputs = inputs
                                                                                , outputs = outputs
                                                                                , graph = graph
                                                                                }
                                                                )
                                                )
                                    )

                    _ ->
                        Err (location path input.typeAnnotation ++ "Input must be a record type alias")

            _ ->
                Err (path ++ ": expected type alias Input, type Output, and component = Component.define")


exposes : String -> String -> Exposing.Exposing -> Bool
exposes name kind exposingList =
    case exposingList of
        Exposing.All _ ->
            True

        Exposing.Explicit items ->
            List.any
                (\item ->
                    case ( kind, Node.value item ) of
                        ( "type", Exposing.TypeOrAliasExpose itemName ) ->
                            itemName == name

                        ( "constructors", Exposing.TypeExpose exposed ) ->
                            exposed.name == name && exposed.open /= Nothing

                        ( "function", Exposing.FunctionExpose itemName ) ->
                            itemName == name

                        _ ->
                            False
                )
                items


definitionIsExposed : String -> TypeGraph.Definition -> Exposing.Exposing -> Bool
definitionIsExposed name definition exposingList =
    case definition of
        TypeGraph.Union _ _ ->
            exposes name "constructors" exposingList

        TypeGraph.Alias _ _ ->
            exposes name "type" exposingList


findDeclaration : String -> List Declaration -> Maybe Declaration
findDeclaration name declarations =
    List.filter
        (\declaration ->
            case declaration of
                Declaration.AliasDeclaration alias_ ->
                    Node.value alias_.name == name

                Declaration.CustomTypeDeclaration union ->
                    Node.value union.name == name

                _ ->
                    False
        )
        declarations
        |> List.head


findAlias : String -> List Declaration -> Maybe TypeAlias.TypeAlias
findAlias name declarations =
    declarations
        |> List.filterMap
            (\declaration ->
                case declaration of
                    Declaration.AliasDeclaration alias_ ->
                        if Node.value alias_.name == name then
                            Just alias_

                        else
                            Nothing

                    _ ->
                        Nothing
            )
        |> List.head


findType : String -> List Declaration -> Maybe Type.Type
findType name declarations =
    declarations
        |> List.filterMap
            (\declaration ->
                case declaration of
                    Declaration.CustomTypeDeclaration union ->
                        if Node.value union.name == name then
                            Just union

                        else
                            Nothing

                    _ ->
                        Nothing
            )
        |> List.head


findFunction : String -> List Declaration -> Maybe Expression.Function
findFunction name declarations =
    declarations
        |> List.filterMap
            (\declaration ->
                case declaration of
                    Declaration.FunctionDeclaration function ->
                        if Node.value (Node.value function.declaration).name == name then
                            Just function

                        else
                            Nothing

                    _ ->
                        Nothing
            )
        |> List.head


validComponentFunction : Expression.Function -> Bool
validComponentFunction function =
    let
        names =
            function.signature
                |> Maybe.map (Node.value >> .typeAnnotation >> Node.value >> typeNames)
                |> Maybe.withDefault []

        body =
            Node.value (Node.value function.declaration).expression

        validSignature =
            List.length names == 5 && List.head names == Just "Component" && List.head (List.drop 1 names) == Just "Input" && List.head (List.reverse names) == Just "Output"
    in
    validSignature
        && (case body of
                Expression.Application (first :: _) ->
                    case Node.value first of
                        Expression.FunctionOrValue [ "Component" ] "define" ->
                            True

                        _ ->
                            False

                _ ->
                    False
           )


typeNames : TypeAnnotation -> List String
typeNames annotation =
    case annotation of
        Annotation.Typed named args ->
            let
                ( _, name ) =
                    Node.value named
            in
            name :: List.concatMap (Node.value >> typeNames) args

        _ ->
            []


parseVariant : String -> (List String -> String -> Result String String) -> Node Type.ValueConstructor -> Result String Output
parseVariant path resolveType node =
    let
        variant =
            Node.value node

        name =
            Node.value variant.name
    in
    case variant.arguments of
        [ payload ] ->
            case Node.value payload of
                Annotation.Record fields ->
                    parseFields path resolveType fields
                        |> Result.andThen
                            (\parsed ->
                                if List.length parsed > 8 then
                                    Err (location path payload ++ "at most eight Output fields are supported in v1")

                                else if duplicate (List.map .attribute parsed) then
                                    Err (location path payload ++ "Output fields map to duplicate event detail keys")

                                else
                                    Ok { name = name, fields = parsed, event = kebab name }
                            )

                _ ->
                    Err (location path payload ++ "each Output constructor needs one flat record payload")

        _ ->
            Err (location path node ++ "each Output constructor needs one flat record payload")


parseFields : String -> (List String -> String -> Result String String) -> Annotation.RecordDefinition -> Result String (List Field)
parseFields path resolveType fields =
    if List.isEmpty fields then
        Err (path ++ ": a record needs at least one field")

    else
        traverse
            (\fieldNode ->
                let
                    ( nameNode, typeNode ) =
                        Node.value fieldNode

                    name =
                        Node.value nameNode

                    typeName =
                        Elm.Writer.write (Elm.Writer.writeTypeAnnotation typeNode)
                in
                TypeGraph.fromAnnotation resolveType Set.empty typeNode
                    |> Result.mapError (\message -> location path typeNode ++ "unsupported field " ++ name ++ " : " ++ message)
                    |> Result.map (\wire -> { name = name, typeName = typeName, attribute = kebab name, wire = wire })
            )
            fields


traverse : (a -> Result x b) -> List a -> Result x (List b)
traverse fn items =
    List.foldr (\item result -> Result.map2 (::) (fn item) result) (Ok []) items


duplicate : List String -> Bool
duplicate values =
    List.length values /= List.length (List.foldl (\value found -> if List.member value found then found else value :: found) [] values)


location : String -> Node a -> String
location path node =
    let
        start =
            (Node.range node).start
    in
    path ++ ":" ++ String.fromInt start.row ++ ":" ++ String.fromInt start.column ++ ": "


kebab : String -> String
kebab value =
    value
        |> String.toList
        |> List.indexedMap
            (\index char ->
                if char == '_' then
                    "-"

                else if Char.isUpper char && index > 0 then
                    "-" ++ String.fromChar (Char.toLower char)

                else
                    String.fromChar (Char.toLower char)
            )
        |> String.join ""


quoted : String -> String
quoted =
    Encode.string >> Encode.encode 0


generatedCodec : Component -> String
generatedCodec component =
    "-- Generated by elm-web-components. Do not edit.\nmodule WebComponents.Codecs." ++ component.suffix ++ " exposing (..)\n\n" ++ graphImports component ++ "\nimport Json.Decode as Decode\nimport Json.Encode as Encode\n\nandMap decoder previous =\n    Decode.map2 (<|) previous decoder\n\nencodeMaybe encodeItem value =\n    case value of\n        Nothing -> Encode.null\n        Just item -> encodeItem item\n\ndecodeMaybe decoder =\n    Decode.oneOf [ Decode.null Nothing, Decode.map Just decoder ]\n\nencodeResult encodeError encodeValue result =\n    case result of\n        Err error -> Encode.object [ ( \"type\", Encode.string \"err\" ), ( \"args\", Encode.list identity [ encodeError error ] ) ]\n        Ok value -> Encode.object [ ( \"type\", Encode.string \"ok\" ), ( \"args\", Encode.list identity [ encodeValue value ] ) ]\n\ndecodeResult decodeError decodeValue =\n    Decode.field \"type\" Decode.string |> Decode.andThen (\\tag -> case tag of\n        \"err\" -> Decode.map Err (Decode.at [ \"args\" ] (Decode.index 0 decodeError))\n        \"ok\" -> Decode.map Ok (Decode.at [ \"args\" ] (Decode.index 0 decodeValue))\n        _ -> Decode.fail (\"Unknown Result constructor: \" ++ tag)\n    )\n\n" ++ TypeGraph.generate component.moduleName component.graph ++ "\n"


graphImports : Component -> String
graphImports component =
    let
        modules =
            Dict.keys component.graph
                |> List.map (String.split "." >> List.reverse >> List.drop 1 >> List.reverse >> String.join ".")
    in
    component.moduleName :: modules
        |> List.foldl (\name found -> if List.member name found then found else found ++ [ name ]) []
        |> List.map (\name -> "import " ++ name)
        |> String.join "\n"


mapName : Int -> String
mapName count =
    if count == 1 then
        "Decode.map"

    else
        "Decode.map" ++ String.fromInt count


generatedElm : Component -> String
generatedElm component =
    let
        record =
            "{ " ++ String.join ", " (List.map (\field -> field.name ++ " = " ++ field.name) component.inputs) ++ " }"

        decode =
            mapName (List.length component.inputs) ++ " (\\" ++ String.join " " (List.map .name component.inputs) ++ " -> " ++ record ++ ")\n" ++ String.join "\n" (List.map (\field -> "        (" ++ inputDecoder field ++ ")") component.inputs)

        cases =
            component.outputs |> List.map (outputCase component.moduleName) |> String.join "\n\n"
    in
    "port module ElmWebComponents.Generated." ++ component.suffix ++ " exposing (main)\n\nimport Component\nimport " ++ component.moduleName ++ "\nimport Json.Decode as Decode\nimport Json.Encode as Encode\nimport Platform.Cmd exposing (Cmd)\nimport Platform.Sub exposing (Sub)\nimport WebComponents.Codecs." ++ component.suffix ++ " exposing (..)\n\nport inputChanged" ++ component.suffix ++ " : (Decode.Value -> msg) -> Sub msg\nport connectionChanged" ++ component.suffix ++ " : (Bool -> msg) -> Sub msg\nport outputSent" ++ component.suffix ++ " : Encode.Value -> Cmd msg\n\ndecodeJsonAttribute key decoder =\n    Decode.field key Decode.string |> Decode.andThen (\\json -> case Decode.decodeString decoder json of\n        Ok value -> Decode.succeed value\n        Err error -> Decode.fail (Decode.errorToString error)\n    )\n\ndecodeOptionalJsonAttribute key decoder =\n    Decode.maybe (Decode.field key Decode.string) |> Decode.andThen (\\raw -> case raw of\n        Nothing -> Decode.succeed Nothing\n        Just json -> Decode.decodeString decoder json |> Result.mapError Decode.errorToString |> Result.map Just |> fromResult\n    )\n\nfromResult result =\n    case result of\n        Ok value -> Decode.succeed value\n        Err error -> Decode.fail error\n\ndecodeInput : Decode.Decoder " ++ component.moduleName ++ ".Input\ndecodeInput =\n    " ++ decode ++ "\n\nencodeOutput : " ++ component.moduleName ++ ".Output -> Component.Event\nencodeOutput output =\n    case output of\n" ++ cases ++ "\n\nmain =\n    Component.program decodeInput encodeOutput\n        { inputChanged = inputChanged" ++ component.suffix ++ "\n        , connectionChanged = connectionChanged" ++ component.suffix ++ "\n        , outputSent = outputSent" ++ component.suffix ++ "\n        }\n        " ++ component.moduleName ++ ".component\n"


inputDecoder : Field -> String
inputDecoder field =
    let
        key =
            quoted field.attribute
    in
    case field.wire of
        TypeGraph.Optional (TypeGraph.Primitive "String") ->
            "Decode.maybe (Decode.field " ++ key ++ " Decode.string)"

        TypeGraph.Primitive "Bool" ->
            "Decode.oneOf [ Decode.field " ++ key ++ " Decode.string |> Decode.map (always True), Decode.succeed False ]"

        TypeGraph.Primitive "String" ->
            "Decode.field " ++ key ++ " Decode.string"

        TypeGraph.Optional item ->
            "decodeOptionalJsonAttribute " ++ key ++ " (" ++ TypeGraph.decoder item ++ ")"

        _ ->
            "decodeJsonAttribute " ++ key ++ " (" ++ TypeGraph.decoder field.wire ++ ")"


outputCase : String -> Output -> String
outputCase moduleName output =
    "        " ++ moduleName ++ "." ++ output.name ++ " detail ->\n            { name = " ++ quoted output.event ++ "\n            , detail = Encode.object\n                [ " ++ String.join "\n                , " (List.map (\field -> "( " ++ quoted field.attribute ++ ", " ++ TypeGraph.encoder field.wire ++ " detail." ++ field.name ++ " )") output.fields) ++ "\n                ]\n            }"


generatedHost : Component -> String
generatedHost component =
    let
        props =
            List.map (\field -> field.name ++ " : " ++ TypeGraph.render component.moduleName field.wire) component.inputs
                ++ List.map (\output -> "on" ++ output.name ++ " : Maybe ({ " ++ String.join ", " (List.map (\field -> field.name ++ " : " ++ TypeGraph.render component.moduleName field.wire) output.fields) ++ " } -> msg)") component.outputs

        attrs =
            List.map (\field -> "        , " ++ hostAttribute field) component.inputs

        listeners =
            List.map hostListener component.outputs
    in
    "-- Generated by elm-web-components. Do not edit.\nmodule WebComponents." ++ component.moduleName ++ " exposing (Props, view)\n\n" ++ graphImports component ++ "\nimport Html exposing (Html)\nimport Html.Attributes as Attr\nimport Html.Events as Events\nimport Json.Decode as Decode\nimport Json.Encode as Encode\nimport WebComponents.Codecs." ++ component.suffix ++ " exposing (..)\n\ntype alias Props msg =\n    { " ++ String.join "\n    , " props ++ "\n    }\n\nview : Props msg -> List (Html msg) -> Html msg\nview props children =\n    Html.node " ++ quoted component.tag ++ "\n        (List.concat\n            [ []\n" ++ String.join "\n" attrs ++ "\n" ++ String.join "\n" listeners ++ "\n            ]\n        )\n        children\n"


hostAttribute : Field -> String
hostAttribute field =
    let
        key =
            quoted field.attribute
    in
    case field.wire of
        TypeGraph.Primitive "String" ->
            "[ Attr.attribute " ++ key ++ " props." ++ field.name ++ " ]"

        TypeGraph.Primitive "Bool" ->
            "if props." ++ field.name ++ " then [ Attr.attribute " ++ key ++ " \"\" ] else []"

        TypeGraph.Optional (TypeGraph.Primitive "String") ->
            "case props." ++ field.name ++ " of\n                Just value -> [ Attr.attribute " ++ key ++ " value ]\n                Nothing -> []"

        TypeGraph.Optional item ->
            "case props." ++ field.name ++ " of\n                Just value -> [ Attr.attribute " ++ key ++ " (Encode.encode 0 (" ++ TypeGraph.encoder item ++ " value)) ]\n                Nothing -> []"

        _ ->
            "[ Attr.attribute " ++ key ++ " (Encode.encode 0 (" ++ TypeGraph.encoder field.wire ++ " props." ++ field.name ++ ")) ]"


hostListener : Output -> String
hostListener output =
    let
        record =
            "{ " ++ String.join ", " (List.map (\field -> field.name ++ " = " ++ field.name) output.fields) ++ " }"

        decoder =
            mapName (List.length output.fields) ++ " (\\" ++ String.join " " (List.map .name output.fields) ++ " -> " ++ record ++ ")\n" ++ String.join "\n" (List.map (\field -> "                        (Decode.at [ \"detail\", " ++ quoted field.attribute ++ " ] " ++ TypeGraph.decoder field.wire ++ ")") output.fields)
    in
    "        , case props.on" ++ output.name ++ " of\n            Just toMsg ->\n                [ Events.on " ++ quoted output.event ++ " (Decode.map toMsg (" ++ decoder ++ ")) ]\n            Nothing ->\n                []"


generatedAdapter : Component -> String
generatedAdapter component =
    let
        observed =
            Encode.list (Encode.string << .attribute) component.inputs |> Encode.encode 0
    in
    "\n(() => {\n  const program = Elm.ElmWebComponents.Generated." ++ component.suffix ++ ";\n  const observed = " ++ observed ++ ";\n  class ComponentElement extends HTMLElement {\n    static get observedAttributes() { return observed; }\n    connectedCallback() {\n      if (this.app) { this.app.ports.connectionChanged" ++ component.suffix ++ ".send(true); return; }\n      const root = this.attachShadow({ mode: \"open\" });\n      const mount = document.createElement(\"div\");\n      root.append(mount);\n      this.app = program.init({ node: mount, flags: this.attributeSnapshot() });\n      this.app.ports.outputSent" ++ component.suffix ++ ".subscribe((events) => {\n        for (const { name, detail } of events) {\n          this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));\n        }\n      });\n    }\n    disconnectedCallback() {\n      if (this.app) this.app.ports.connectionChanged" ++ component.suffix ++ ".send(false);\n    }\n    attributeChangedCallback() {\n      if (this.app) this.app.ports.inputChanged" ++ component.suffix ++ ".send(this.attributeSnapshot());\n    }\n    attributeSnapshot() {\n      const snapshot = {};\n      for (const name of observed) {\n        if (this.hasAttribute(name)) snapshot[name] = this.getAttribute(name);\n      }\n      return snapshot;\n    }\n  }\n  customElements.define(" ++ quoted component.tag ++ ", ComponentElement);\n})();\n"
