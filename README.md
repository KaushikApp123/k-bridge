# K-Bridge

An ESP32 tool for listening in on the communication inside embedded devices. It passively taps UART and CAN bus traffic, decodes the frames, and streams them live to a React dashboard over WebSocket. It never transmits on the line it's tapping.

I built it to reverse-engineer the undocumented serial protocol of a commercial gym elliptical. Then I added OBD-II support so it could also read live engine data from a car's CAN bus.

## What it does

- **UART tap:** listens on a device's TX line only. The ESP32's own TX is never connected, so it can't interfere. Handles ASCII text and binary frames once you know the sync byte and byte layout.
- **CAN tap (OBD-II):** an MCP2515 CAN controller in listen-only mode, so it never puts anything on the bus. Decodes standard OBD-II values (RPM, speed, coolant temp, throttle, engine load) and shows raw frames for everything else.
- **Live dashboard:** React + Vite. A live frame stream with decoded values, OBD metric cards that update in real time, and a control to change the UART baud rate without reflashing.

## Architecture

The firmware runs three FreeRTOS tasks connected by a queue, so capturing data is separate from sending it:

```
UART task (core 1) --\
                      +--> frame queue --> WebSocket task (core 0) --> dashboard
CAN task  (core 1) --/
```

- **UART task** reads bytes from the tapped line, decodes them, and puts frames in the queue.
- **CAN task** reads frames from the MCP2515, decodes OBD-II responses, and puts them in the queue.
- **WebSocket task** takes frames from the queue, sends them out as JSON, and handles commands from the dashboard, such as changing the baud rate.

Capture runs on one core and networking on the other, so WiFi traffic doesn't make the tap miss data.

## Reverse-engineering the elliptical

There was no datasheet. I tapped the elliptical's UART line with a logic analyzer, changed resistance and speed on the machine, and watched which bytes changed. That gave me the sync byte and the frame layout, which I then decoded in `decodeUARTFrame()`.

## Hardware

- ESP32 DevKit
- MCP2515 CAN module (SPI)
- OBD-II cable, or a direct CANH/CANL connection

## Wiring

```
UART tap:
  Target device TX -> GPIO16  (RX2, passive only. Do NOT connect ESP32 TX)
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

Arduino IDE with the ESP32 board package. The source is in `firmware/k_bridge.ino`.

Libraries:
- `WebSocketsServer` (Links2004/arduinoWebSockets)
- `ArduinoJson`
- `arduino-mcp2515` (autowp/arduino-mcp2515)

Set `UART_BAUD` to match your target device. The CAN bitrate is 500 kbps, the standard for most vehicles. Change `CAN_500KBPS` if yours is different.

Flash the ESP32. It creates a WiFi network called **K-Bridge**. Connect your laptop or phone to it.

## Dashboard

```bash
cd dashboard
npm install
npm run dev
# opens at http://localhost:3000
```

The dashboard connects to `ws://192.168.4.1:81`.

## Adapting it to a new device

For binary UART frames, find the sync byte and frame structure with a logic analyzer first. Then update `decodeUARTFrame()` in the firmware. The default looks for `0xAA` as the sync byte.

## Next steps

- SPI and I2C tap support
- Saving captured frames to flash for offline analysis
- Uploading custom decoders from the web UI without reflashing
