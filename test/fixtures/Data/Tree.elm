module Data.Tree exposing (Tree(..))


type Tree a
    = Leaf a
    | Branch (Tree a) (Tree a)
