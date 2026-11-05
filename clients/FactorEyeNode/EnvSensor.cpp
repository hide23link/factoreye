// ENV ユニットの読み取り。使い方は EnvSensor.h。
#include "EnvSensor.h"

#include <M5UnitENV.h>  // M5Unit-ENV ライブラリ（SHT3X・SHT4X・QMP6988・BMP280）
#include <Wire.h>

#include "NodeConfig.h"

static const long I2C_SPEED = 400000;

// ユニットごとに、使う部品だけを作る（使わない部品は I2C に触らない）
static SHT3X sht30;
static SHT4X sht40;
static QMP6988 qmp6988;
static BMP280 bmp280;

static const uint8_t SHT_ADDRESS = 0x44;     // SHT30・SHT40 は同じアドレス
static const uint8_t QMP6988_ADDRESS = 0x70;  // ENV3 の気圧センサー
static const uint8_t BMP280_ADDRESS = 0x76;   // ENV2・ENV4 の気圧センサー

static bool respondsAt(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

// コマンドを送って、6 バイトの応答（シリアル番号）を読み、CRC が合うかを見る
static bool serialNumberIsValid(const uint8_t* command, size_t commandLength) {
  Wire.beginTransmission(SHT_ADDRESS);
  Wire.write(command, commandLength);
  if (Wire.endTransmission() != 0) return false;
  delay(5);
  if (Wire.requestFrom(SHT_ADDRESS, (uint8_t)6) != 6) return false;
  uint8_t bytes[6];
  for (int i = 0; i < 6; i++) bytes[i] = Wire.read();
  return isValidSensirionSerial(bytes);
}

// SHT40 は 1 バイトのコマンド 0x89、SHT30 は 2 バイトのコマンド 0x3780 で、シリアル番号を返す。
// 相手でないほうのコマンドには、まともな応答（CRC が合うデータ）を返さない。たまたま失敗しても 3 回まで試す
static bool isSht4x() {
  const uint8_t command[] = {0x89};
  for (int i = 0; i < 3; i++) if (serialNumberIsValid(command, 1)) return true;
  return false;
}
static bool isSht3x() {
  const uint8_t command[] = {0x37, 0x80};
  for (int i = 0; i < 3; i++) if (serialNumberIsValid(command, 2)) return true;
  return false;
}

static EnvSensor::Kind detectKind(uint8_t sdaPin, uint8_t sclPin) {
  Wire.begin(sdaPin, sclPin, I2C_SPEED);
  bool humidity = respondsAt(SHT_ADDRESS);
  bool qmp = respondsAt(QMP6988_ADDRESS);
  bool bmp = respondsAt(BMP280_ADDRESS);
  Serial.printf("[EnvSensor] I2C の応答: SHT(0x44)=%s QMP6988(0x70)=%s BMP280(0x76)=%s\n", humidity ? "あり" : "なし",
                qmp ? "あり" : "なし", bmp ? "あり" : "なし");
  if (!humidity) return EnvSensor::Kind::None;
  if (qmp) return EnvSensor::Kind::Env3;
  if (!bmp) return EnvSensor::Kind::None;
  if (isSht4x()) return EnvSensor::Kind::Env4;
  if (isSht3x()) return EnvSensor::Kind::Env2;
  // どちらの応答も確かめられなかったとき: SHT40 の応答が一時的に乱れた可能性が高いので、ENV4 とみなす（ENV4 のほうが新しい）
  Serial.println("[EnvSensor] 温湿度センサーの種類を確かめられませんでした。ENV4 とみなします");
  return EnvSensor::Kind::Env4;
}

const char* EnvSensor::kindName() const {
  return kind == Kind::Env2 ? "ENV2" : kind == Kind::Env3 ? "ENV3" : kind == Kind::Env4 ? "ENV4" : "";
}

bool EnvSensor::begin(const String& type, uint8_t sdaPin, uint8_t sclPin) {
  ready = false;
  if (type == "auto") {
    kind = detectKind(sdaPin, sclPin);
    if (kind != Kind::None) Serial.printf("[EnvSensor] 自動判別: %s\n", kindName());
  } else {
    kind = type == "ENV2" ? Kind::Env2 : type == "ENV3" ? Kind::Env3 : type == "ENV4" ? Kind::Env4 : Kind::None;
  }
  if (kind == Kind::None) return false;

  bool climateOk = kind == Kind::Env4 ? sht40.begin(&Wire, SHT40_I2C_ADDR_44, sdaPin, sclPin, I2C_SPEED)
                                      : sht30.begin(&Wire, SHT3X_I2C_ADDR, sdaPin, sclPin, I2C_SPEED);
  bool pressureOk = kind == Kind::Env3 ? qmp6988.begin(&Wire, QMP6988_SLAVE_ADDRESS_L, sdaPin, sclPin, I2C_SPEED)
                                       : bmp280.begin(&Wire, BMP280_I2C_ADDR, sdaPin, sclPin, I2C_SPEED);
  if (climateOk && pressureOk && kind != Kind::Env3) {
    // BMP280 の標準の設定（M5 のサンプルと同じ）
    bmp280.setSampling(BMP280::MODE_NORMAL, BMP280::SAMPLING_X2, BMP280::SAMPLING_X16, BMP280::FILTER_X16,
                       BMP280::STANDBY_MS_500);
  }
  Serial.printf("[EnvSensor] %s 温湿度=%s 気圧=%s\n", kindName(), climateOk ? "OK" : "見つからない", pressureOk ? "OK" : "見つからない");
  ready = climateOk && pressureOk;
  return ready;
}

bool EnvSensor::readClimate(float& celsius, float& humidityPercent) {
  if (kind == Kind::Env4) {
    if (!sht40.update()) return false;
    celsius = sht40.cTemp;
    humidityPercent = sht40.humidity;
    return true;
  }
  if (kind == Kind::None || !sht30.update()) return false;
  celsius = sht30.cTemp;
  humidityPercent = sht30.humidity;
  return true;
}

bool EnvSensor::readPressure(float& hectopascal) {
  if (kind == Kind::Env3) {
    if (!qmp6988.update()) return false;
    hectopascal = qmp6988.pressure / 100.0f;
    return true;
  }
  if (kind == Kind::None || !bmp280.update()) return false;
  hectopascal = bmp280.pressure / 100.0f;
  return true;
}
