# PlethLab

**A bedside-style monitor and HRV lab for CMS50D+-compatible USB pulse oximeters.**

PlethLab reads the live data stream of an inexpensive fingertip pulse oximeter over USB and
turns it into a browser dashboard: pulse wave on ECG-paper grid, SpO₂ and pulse numerics with
alarms, a respiration rate and waveform derived from the pulse wave, beat-to-beat HRV,
Poincaré plot, HRV spectrum, ensemble-averaged pulse shape, trends, CSV logging and a PDF
report. It can also read recordings stored on the device and set the device clock.

### ▶ [Open PlethLab in your browser](https://pit711.github.io/plethlab/) · [Try the demo](https://pit711.github.io/plethlab/?demo)

No installation: plug in the oximeter, open the page in Chrome or Edge, click **Connect device**.
All processing happens locally in your browser. No measurement data is uploaded anywhere.

![PlethLab dashboard (simulated device)](docs/screenshot.png)

> **Not a medical device.** PlethLab is for curiosity, self-tracking and experiments. It does
> not diagnose anything. All derived values (respiration, HRV, rhythm, pulse shape) are
> estimates from a pre-filtered 60 Hz pulse wave.

## Features

- **Live monitor:** pleth sweep with beat markers, SpO₂, pulse, signal strength, sensor
  messages (no finger, weak signal, disconnected) and alarm limits
- **Respiration:** rate and a derived waveform, fused from rate, amplitude and baseline
  modulation of the pulse wave, with a quality indicator
- **HRV:** beat detection with sub-sample timing (validated against the device's own beat
  markers), RMSSD, SDNN, pNN50, RR tachogram with artefact marking
- **Poincaré plot** with SD1/SD2 ellipse and **HRV spectrum** (LF, HF, LF/HF, 5 min window)
- **Pulse shape:** ensemble average of the last 20 s, second-derivative (SDPPG) a–e waves,
  b/a ratio, rise time and peak-to-notch time
- **Trends** for SpO₂, pulse, respiration and RMSSD with synced crosshair, table view
- **Device storage:** list and download recordings (with min SpO₂, mean pulse and ≥3 %
  desaturation count), set the device clock
- **PDF report** of the session (summary, HRV, charts), generated in the browser
- **CSV logs** per session plus a separate beat-to-beat (RR) log
- **Clean start:** the first seconds after inserting the finger (while the device adjusts its
  gain) are ignored, and a provisional pulse is shown until the device locks on
- **Reset** to start a fresh session at any time
- **English and German** interface
- **Demo mode** for trying it without hardware

## Quick start

### Option 1: in the browser (recommended)

1. Plug in the oximeter's USB cable and switch the device on.
2. Open **<https://pit711.github.io/plethlab/>** in **Chrome, Edge or Opera** on a desktop computer.
3. Click **Connect device** and pick the *CP2102 USB to UART Bridge* entry.
4. Put your finger in. Respiration and HRV appear after 30–60 s of calm measurement,
   the HRV spectrum after 2 min.

The browser remembers the permission and reconnects automatically next time. Firefox, Safari and
mobile browsers do not support Web Serial. Use the demo there, or option 2.

### Option 2: local Python server

For long recordings, logging to disk or browsers without Web Serial:

```bash
pip install -r requirements.txt
python server.py            # auto-detects the CP210x USB cable
# or: python server.py COM5  /  python server.py /dev/ttyUSB0
```

Open <http://localhost:8050>. CSV logs are written to `logs/`.
No device at hand? Run `python server.py --simulate`.

Only one program can use the serial port at a time: close the browser tab or the server (and the
vendor software) before switching.

On Windows the CP210x driver from Silicon Labs may be needed. On Linux, add your user to the
`dialout` group.

## Supported devices

PlethLab speaks the serial protocol of the Contec CMS50D+ family (see [PROTOCOL.md](PROTOCOL.md)).
Devices only work if they come with a **USB data cable / PC software**.

| | Device | Status | Amazon.de (EU) | Amazon.com (US) |
|---|---|---|---|---|
| <img src="https://m.media-amazon.com/images/I/41Wq1YjQkZL._SL160_.jpg" width="72" alt="PULOX PO-250"> | **PULOX PO-250** (reports as CMS50D+) | ✅ tested | [view](https://www.amazon.de/dp/B004ZQ2WWO?tag=5gready-21&linkCode=osi&th=1&psc=1) | [Contec CMS50D+](https://www.amazon.com/s?k=Contec+CMS50D%2B+pulse+oximeter&tag=5gready-20) |
| <img src="https://m.media-amazon.com/images/I/41uavRHPLEL._SL160_.jpg" width="72" alt="PULOX PO-300"> | PULOX PO-300 (with long-term recording software) | ❔ untested | [view](https://www.amazon.de/dp/B0021D4G9A?tag=5gready-21&linkCode=osi&th=1&psc=1) | – |
| <img src="https://m.media-amazon.com/images/I/41EhMSBlM1L._SL160_.jpg" width="72" alt="PULOX PO-400"> | PULOX PO-400 (wrist-worn) | ❔ untested | [view](https://www.amazon.de/dp/B003ITM3WI?tag=5gready-21&linkCode=osi&th=1&psc=1) | – |

Tested a device that is not listed? Please open an issue with the model name the dashboard
shows in the header.

*As an Amazon Associate I earn from qualifying purchases. The links above are affiliate
links. Buying through them costs you nothing extra and supports this project.*

## How it works

```
browser mode:  pulse oximeter ── USB (CP2102, 115200 baud) ── Web Serial ── docs/plethlab-core.js ── docs/index.html

server mode:   pulse oximeter ── USB ── server.py + analysis.py ── Server-Sent Events ── docs/index.html
```

- `docs/index.html`: the dashboard (no build step, no external resources); detects whether it is
  served by `server.py` or runs stand-alone
- `docs/plethlab-core.js`: in-browser engine: analysis (JavaScript port of `analysis.py`),
  protocol, Web Serial transport and demo device
- `docs/report.js`: dependency-free PDF writer for the session report
- `server.py`: serial reader, device commands, HTTP + SSE server, CSV logging
- `analysis.py`: signal analysis (numpy/scipy)
- `simulator.py`: protocol-level device simulator with a synthetic pulse wave

A parity test feeds identical data to the Python and the JavaScript analysis and checks that
both give the same results.

The live stream delivers about 60 samples per second. This is fixed by the device firmware.
The dashboard draws a smooth curve through the samples but does not invent new ones.

## Tests

```bash
pip install -r requirements-dev.txt
python -m playwright install chromium
python -m pytest      # unit tests, JS/Python parity, end-to-end tests of server and browser mode
```

## Safety

PlethLab never sends commands that erase or reconfigure device storage (see PROTOCOL.md).
Writing the device clock is the only write operation and only happens when you click it.

## License and trademarks

MIT, see [LICENSE](LICENSE).

PULOX is a trademark of its owner. Contec and CMS50D+ are trademarks of Contec Medical
Systems. Names are used only to describe compatibility. PlethLab is not affiliated with,
endorsed by or supported by any of these companies.
