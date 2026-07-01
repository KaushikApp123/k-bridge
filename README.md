# K-Bridge

ESP32-based passive serial tap that decodes UART and CAN bus traffic from embedded devices without modifying or interrupting them. Streams decoded frames to a React dashboard over WebSocket.

Built it originally to reverse-engineer the communication protocol on a commercial gym elliptical machine. Ended up being useful enough that I added OBD-II CAN support for tapping vehicle ECU data too.

## What it can do

**UART tap:** Connect to any device's TX line (no TX from the ESP32 — purely passive listen). Supports ASCII framing and binary frame decoding once you know the sync byte and byte layout.

**CAN tap (OBD-II):** MCP2515 in listen-only mode, so it never puts anything on the bus. Decodes standard OBD-II PIDs (RPM, speed, coolant temp, throttle, load) and shows raw frames for everything else.

The React dashboard shows a live frame stream with decoded values, lets you switch UART baud rate on the fly, and shows OBD metric cards that update in real time.

## Hardware

- ESP32 DevKit
- MCP2515 CAN module (SPI)
- OBD-II cable or direct CANH/CANL connection

## Wiring

```
UART tap:
  Target device TX -> GPIO16  (RX2, passive only — do NOT connect ESP32 TX)
  GND              -> GND

MCP2515 (CAN):
  SCK  -> GPIO18
  MOSI -> GPIO23
  MISO -> GPIO19
  CS   -> GPIO5
  INT  -> GPIO4

OBD-II connector:
  Pin 4  (GND)      -> ESP32 GND
  Pin 6  (CAN High) -> MCP2515 CANH
  Pin 14 (CAN Low)  -> MCP2515 CANL
  Pin 16 (12V)      -> 5V regulator -> ESP32 VIN
```

## Firmware

Arduino IDE, ESP32 board package.

**Libraries:**
- `WebSocketsServer` (Links2004/arduinoWebSockets)
- `ArduinoJson`
- `arduino-mcp2515` (autowp/arduino-mcp2515)

Set `UART_BAUD` in `k_bridge.ino` to match your target device. The CAN bitrate is hardcoded to 500kbps (standard for most vehicles) — change `CAN_500KBPS` if yours is different.

Flash the ESP32. It creates a WiFi AP called **K-Bridge** (password: `kbridge123`). Connect your laptop to that network.

## Dashboard

```bash
cd dashboard
npm install
npm run dev
# opens at http://localhost:3000
```

The dashboard connects directly to `ws://192.168.4.1:81`. You can also open it from a phone connected to the K-Bridge AP.

## Adapting for a new device

For binary UART frames, use a logic analyzer to find the sync byte and frame structure first, then update `decodeUARTFrame()` in the firmware. The current placeholder looks for `0xAA` as the sync byte — change that and the byte offsets to match your device.

For the elliptical machine specifically, I tapped the UART line with a logic analyzer and found the frame format by looking at what changed when I adjusted resistance and speed on the machine. Then reverse-engineered the byte layout from there.

## TODO

- Add SPI and I2C tap support
- Save captured frames to SPIFFS for offline analysis
- Web UI for uploading custom decoders without reflashing
