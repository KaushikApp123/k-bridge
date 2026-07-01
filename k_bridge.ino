/*
  K-Bridge - Universal Embedded Device Interface
  Kaushik Appalanani

  Passively taps UART and CAN bus traffic from embedded devices,
  decodes frames, and streams JSON to a React dashboard over WebSocket.

  Use cases:
    - Decoding undocumented UART from gym machines (elliptical cadence/resistance/speed)
    - Tapping OBD-II CAN bus to read live ECU data from vehicles

  Wiring:
    UART tap:  Target TX -> GPIO16 (passive RX only, do not connect ESP32 TX)
    MCP2515:   SCK->18, MOSI->23, MISO->19, CS->5, INT->4
    OBD-II:    CANH->MCP2515 CANH, CANL->MCP2515 CANL

  Connect to WiFi AP "K-Bridge" (pw: kbridge123), then open the dashboard.
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <mcp2515.h>

#define AP_SSID  "K-Bridge"
#define AP_PASS  "kbridge123"

#define UART_RX_PIN    16
#define UART_BAUD      9600    // change to match your target device
#define CAN_CS         5
#define CAN_INT        4

WebSocketsServer ws(81);
MCP2515 can(CAN_CS);

struct Frame {
  uint8_t  proto;       // 0=UART 1=CAN
  uint32_t ts;
  uint8_t  data[8];
  uint8_t  len;
  uint32_t can_id;
  char     decoded[128];
};

QueueHandle_t frameQ;

// OBD-II standard PIDs
struct PID { uint8_t id; const char* name; };
static const PID PIDS[] = {
  {0x04,"Engine Load"},{0x05,"Coolant Temp"},{0x0A,"Fuel Pressure"},
  {0x0B,"Intake MAP"}, {0x0C,"RPM"},         {0x0D,"Speed"},
  {0x0F,"Intake Temp"},{0x11,"Throttle"},    {0x2F,"Fuel Level"},
};

static const char* pidName(uint8_t id) {
  for (auto &p : PIDS) if (p.id == id) return p.name;
  return nullptr;
}

void decodeCANFrame(uint32_t id, const uint8_t *d, uint8_t len, char *out) {
  // OBD-II response: 0x7E8, mode byte 0x41, then PID
  if ((id == 0x7E8 || id == 0x7DF) && len >= 3 && d[1] == 0x41) {
    uint8_t pid = d[2];
    if (pid == 0x0C && len >= 5) {
      snprintf(out, 128, "RPM: %u", ((uint16_t)d[3]*256 + d[4]) / 4);
    } else if (pid == 0x0D && len >= 4) {
      snprintf(out, 128, "Speed: %u km/h", d[3]);
    } else if (pid == 0x05 && len >= 4) {
      snprintf(out, 128, "Coolant: %d C", d[3] - 40);
    } else if (pid == 0x04 && len >= 4) {
      snprintf(out, 128, "Engine Load: %u%%", (d[3]*100)/255);
    } else if (pid == 0x11 && len >= 4) {
      snprintf(out, 128, "Throttle: %u%%", (d[3]*100)/255);
    } else {
      const char *n = pidName(pid);
      snprintf(out, 128, n ? "%s [raw %02X %02X]" : "OBD PID 0x%02X [%d bytes]",
               n ? n : (const char*)&pid, n ? d[3] : len, n ? d[4] : 0);
    }
    return;
  }
  snprintf(out, 128, "CAN 0x%03X [%d] %02X %02X %02X %02X",
           id, len, len>0?d[0]:0, len>1?d[1]:0, len>2?d[2]:0, len>3?d[3]:0);
}

void decodeUARTFrame(const uint8_t *d, uint8_t len, char *out) {
  // Check if printable ASCII
  bool ascii = true;
  for (int i = 0; i < len; i++)
    if (d[i] < 0x20 && d[i] != '\r' && d[i] != '\n') { ascii = false; break; }

  if (ascii) {
    snprintf(out, 128, "ASCII: \"%.*s\"", (int)len, (const char*)d);
    return;
  }

  // Elliptical machine binary frame decoder
  // TODO: update sync byte (0xAA) and byte offsets to match your machine
  if (len >= 8 && d[0] == 0xAA) {
    uint16_t cadence    = ((uint16_t)d[2] << 8) | d[3];
    uint16_t resistance = ((uint16_t)d[4] << 8) | d[5];
    uint16_t speed_x100 = ((uint16_t)d[6] << 8) | d[7];
    snprintf(out, 128, "Cadence: %u RPM | Resistance: %u | Speed: %.1f km/h",
             cadence, resistance, speed_x100 / 100.0f);
    return;
  }

  // Unknown binary
  char hex[48] = {};
  for (int i = 0; i < len && i < 8; i++) sprintf(hex + i*3, "%02X ", d[i]);
  snprintf(out, 128, "RAW [%d]: %s", len, hex);
}

void broadcast(const Frame &f) {
  StaticJsonDocument<512> doc;
  doc["proto"]   = f.proto ? "CAN" : "UART";
  doc["ts"]      = f.ts;
  doc["decoded"] = f.decoded;
  doc["len"]     = f.len;
  if (f.proto) doc["can_id"] = f.can_id;

  char hex[25] = {};
  for (int i = 0; i < f.len && i < 8; i++) sprintf(hex+i*2, "%02X", f.data[i]);
  doc["hex"] = hex;

  char buf[512];
  serializeJson(doc, buf);
  ws.broadcastTXT(buf);
}

void wsEvent(uint8_t n, WStype_t t, uint8_t *p, size_t len) {
  if (t == WStype_CONNECTED)
    Serial.printf("WS client %d connected\n", n);
  else if (t == WStype_TEXT) {
    StaticJsonDocument<128> cmd;
    if (!deserializeJson(cmd, p) && cmd["baud"])
      Serial2.updateBaudRate((uint32_t)cmd["baud"]);
  }
}

void taskUART(void*) {
  uint8_t buf[64];
  while (true) {
    int n = 0;
    while (Serial2.available() && n < 64) buf[n++] = Serial2.read();
    if (n > 0) {
      Frame f{};
      f.proto = 0; f.ts = millis(); f.len = min(n, 8);
      memcpy(f.data, buf, f.len);
      decodeUARTFrame(buf, n, f.decoded);
      xQueueSend(frameQ, &f, 0);
    }
    vTaskDelay(2);
  }
}

void taskCAN(void*) {
  struct can_frame cf;
  while (true) {
    if (can.readMessage(&cf) == MCP2515::ERROR_OK) {
      Frame f{};
      f.proto = 1; f.ts = millis();
      f.can_id = cf.can_id & CAN_EFF_MASK;
      f.len = cf.can_dlc;
      memcpy(f.data, cf.data, cf.can_dlc);
      decodeCANFrame(f.can_id, cf.data, cf.can_dlc, f.decoded);
      xQueueSend(frameQ, &f, 0);
    }
    vTaskDelay(1);
  }
}

void taskBroadcast(void*) {
  Frame f;
  while (true) {
    if (xQueueReceive(frameQ, &f, pdMS_TO_TICKS(10))) broadcast(f);
    ws.loop();
    vTaskDelay(1);
  }
}

void setup() {
  Serial.begin(115200);

  Serial2.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, -1);

  can.reset();
  can.setBitrate(CAN_500KBPS, MCP_8MHZ);
  can.setListenOnlyMode();

  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("AP IP: "); Serial.println(WiFi.softAPIP());

  ws.begin();
  ws.onEvent(wsEvent);

  frameQ = xQueueCreate(64, sizeof(Frame));

  xTaskCreatePinnedToCore(taskUART,      "UART", 4096, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(taskCAN,       "CAN",  4096, nullptr, 4, nullptr, 1);
  xTaskCreatePinnedToCore(taskBroadcast, "WS",   8192, nullptr, 3, nullptr, 0);

  Serial.println("K-Bridge ready. Connect to WiFi 'K-Bridge' -> ws://192.168.4.1:81");
}

void loop() { vTaskDelay(1000); }
