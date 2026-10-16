# Serial protocol of CMS50D+-compatible pulse oximeters

This document describes the USB/serial protocol as used by PlethLab. It was worked out
for interoperability by observing the traffic of a PULOX PO-250 (which reports its model
as `50D(A)+`) and by analysing how the manufacturer's PC software talks to the device.
No manufacturer code is included in this repository.

Other devices of the same family may behave differently. Reports are welcome.

## Physical layer

- USB cable with a Silicon Labs CP2102 USB-to-UART bridge (VID `10C4`, PID `EA60`)
- 115200 baud, 8 data bits, no parity, 1 stop bit

## Framing

All bytes after the first one of a frame have bit 7 set. The second byte collects the
original bit 7 of every following byte (bit 0 → first payload byte, bit 1 → second, …).

```
PC → device   7D 81 <cmd> p1|80 p2|80 80 80 80 80        (9 bytes)
device → PC   <type> <hi> v0|80 v1|80 …                  (type < 0x80)
```

Decoding a device packet: `v[k] = (byte[2+k] & 0x7F) | (((hi >> k) & 1) << 7)`.

## Commands

| Cmd | Parameters | Purpose | Reply type |
|-----|------------|---------|------------|
| `A1` | – | start live stream (resend every few seconds to keep it running) | `01` |
| `A2` | – | stop live stream | – |
| `A3` | user | number of recordings of a user | `0A` `[user, count]` |
| `A4` | user, rec | recording length (little-endian 32 bit in v2..v5) | `08` |
| `A5` | user, rec | recording start date and time | `07` date, `12` time |
| `A6` | user, rec | play back a recording | `0F` packets, or `0B [A6, 3]` while the device is recording |
| `A7` | – | sent before playback by the vendor software | `0C` |
| `A8` | – | model name, sent as two fragments | `02` |
| `A9` | – | manufacturer string | `03` |
| `AA` | – | device/user ID | `04` |
| `AB` | user | user name | `05` |
| `AD` | – | storage status (1 = recording in progress) | `10` |
| `AF` | – | keep-alive | – |
| `B0` | – | capability info | `11` |
| `B1` | h, m, s (payload) | set time | `0B [B1, code]` |
| `B2` | yy/100, yy%100, month, day, weekday | set date | `0B [B2, code]` |
| `B8` | – | queried on connect | `0B [B8, code]` |

Acknowledgements use type `0B` with `[command, code]`. Code `5` means success.

**Commands PlethLab never sends:** `AE` deletes recordings, and changing the storage mode
erases stored data. `B6` and `81` are unclear. All of them are blocked in `server.py`.

## Live packet (type `01`, ~60 per second)

| Value | Meaning |
|-------|---------|
| v0 | bits 0–3 signal strength, bit 4 probe status, bit 6 heartbeat marker, bit 7 finger out |
| v1 | plethysmogram sample (0–127) |
| v2 | bits 0–3 bar graph, bit 4 probe error |
| v3 | pulse rate (bpm, device-averaged) |
| v4 | SpO2 (%) |
| v5, v6 | perfusion index = v6·256 + v5 in 0.01 %, valid up to 2200; `FF FF` = not supported |

The PO-250 does not provide a perfusion index. Red and infrared raw signals are not part
of this protocol.

## Playback packet (type `0F`)

Three samples per packet, one sample per second: `[SpO2, pulse, SpO2, pulse, SpO2, pulse, pad]`.
