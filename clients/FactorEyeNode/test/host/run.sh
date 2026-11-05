#!/bin/sh
# FactorEyeNode の設定の決まりを PC 上でテストする（実機・Arduino 不要。C++17 のコンパイラだけ使う）。
# 機種ごとに、コンパイルし直して実行する
set -e
cd "$(dirname "$0")"
mkdir -p build
for board in ARDUINO_M5STACK_ATOM ARDUINO_M5STACK_ATOMS3 ARDUINO_M5STACK_NANOC6 ARDUINO_M5STACK_STICKC ARDUINO_M5STACK_STICKC_PLUS ARDUINO_M5STACK_STICKC_PLUS2 ARDUINO_M5STACK_CORE; do
  echo "== $board"
  c++ -std=c++17 -Wall -Wextra -g -D$board=1 \
    -I fakes -I ../.. \
    test_nodeconfig.cpp -o build/nodeconfig_test
  build/nodeconfig_test
done

echo "== パルスを数える部分・稼働の判定"
c++ -std=c++17 -Wall -Wextra -g -I ../.. test_pulse.cpp -o build/pulse_test
build/pulse_test
