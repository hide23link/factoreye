// ENV ユニット（ENV2・ENV3・ENV4）から、温度・湿度・気圧を読む。
//
//   ユニット  温湿度センサー  気圧センサー
//   ENV2     SHT30          BMP280
//   ENV3     SHT30          QMP6988
//   ENV4     SHT40          BMP280
//
// 使い方: begin("auto", Grove の SDA, SCL) → 間隔ごとに readClimate()・readPressure()。
// "auto" のときは、I2C の応答から ENV2・ENV3・ENV4 を自動で見分ける:
//   気圧センサーが 0x70（QMP6988）なら ENV3 / 0x76（BMP280）なら ENV2 か ENV4。
//   ENV2 と ENV4 は、温湿度センサー（SHT30 と SHT40）が同じアドレス 0x44 なので、シリアル番号の読み出し（CRC つき）で見分ける。
// 読めなかった値は送らない（false を返す）。気圧は hPa に直して返す（ライブラリは Pa で返す）。
#pragma once
#include <Arduino.h>

class EnvSensor {
 public:
  enum class Kind { None, Env2, Env3, Env4 };

  // type: "auto"（自動で見分ける）/ "ENV2" / "ENV3" / "ENV4"。センサーが見つからないとき false
  bool begin(const String& type, uint8_t sdaPin, uint8_t sclPin);
  const char* kindName() const;  // 見分けた結果（"ENV3" など。見つからないときは ""）
  bool readClimate(float& celsius, float& humidityPercent);
  bool readPressure(float& hectopascal);
  bool isReady() const { return ready; }

 private:
  Kind kind = Kind::None;
  bool ready = false;
};
