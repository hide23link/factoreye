#!/bin/bash
# シミュレータ（devsim-NN）をすべて止めて消す。
ids=$(docker ps -aq --filter name=devsim-)
[ -n "$ids" ] && docker rm -f $ids > /dev/null
echo "残り: $(docker ps -aq --filter name=devsim- | wc -l | tr -d ' ') 個"
