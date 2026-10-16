"""Live monitor for CMS50D+-compatible pulse oximeters (e.g. PULOX PO-250).

Usage:
    python server.py [COMx] [--port 8050] [--simulate] [--host 127.0.0.1]

Then open http://localhost:8050

Serial protocol (115200 8N1, verified on a PO-250 with firmware reporting "50D(A)+"):
    PC -> device   7D 81 <cmd> p1|80 p2|80 80 80 80 80
    device -> PC   <type> <hi> v0..vn   (hi carries bit 7 of v0..vn)
See PROTOCOL.md for the command table.
"""
import csv
import json
import os
import queue
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import serial
from serial.tools import list_ports

from analysis import PulseAnalyzer

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(HERE, "logs")

# Commands that are never sent by this program because they erase device data.
FORBIDDEN = {0xAE, 0xB6, 0x81}
SETTLE_S = 3.0      # seconds ignored by the analysis after the finger is inserted


def frame(cmd, p1=0, p2=0):
    if cmd in FORBIDDEN:
        raise ValueError(f"command {cmd:02X} is blocked (erases or reconfigures device storage)")
    return bytes([0x7D, 0x81, cmd, 0x80 | (p1 & 0x7F), 0x80 | (p2 & 0x7F), 0x80, 0x80, 0x80, 0x80])


def frame_payload(cmd, payload):
    body = list(payload) + [0] * (6 - len(payload))
    return bytes([0x7D, 0x81, cmd] + [0x80 | (b & 0x7F) for b in body])


def decode(pkt):
    hi = pkt[1]
    return [(b & 0x7F) | (((hi >> k) & 1) << 7) for k, b in enumerate(pkt[2:])]


def split_packets(buf):
    """Split a byte stream into packets (type byte < 0x80 followed by bytes >= 0x80)."""
    out, i = [], 0
    while i < len(buf):
        if buf[i] < 0x80:
            j = i + 1
            while j < len(buf) and buf[j] >= 0x80:
                j += 1
            if j - i >= 2:
                out.append(bytes(buf[i:j]))
            i = j
        else:
            i += 1
    return out


def find_port():
    for p in list_ports.comports():
        if p.vid == 0x10C4 and p.pid == 0xEA60:
            return p.device
    return None


class Oximeter:
    def __init__(self, port, simulate=False):
        self.port = port
        self.simulate = simulate
        self.lock = threading.Lock()
        self.clients = []
        self.ops = queue.Queue()        # device operations run in the reader thread
        self.wave, self.beat = [], False
        self.status = {"connected": False, "finger": False, "spo2": None, "pr": None, "signal": 0,
                       "bar": 0, "pi": None, "user": None, "model": None, "port": port,
                       "simulated": simulate}
        self.finger_since = None
        os.makedirs(LOG_DIR, exist_ok=True)
        self.reset()

    def reset(self):
        """Start a new session: clears trends and analysis, opens new CSV files."""
        for f in ("csv", "rr_csv"):
            if hasattr(self, f):
                getattr(self, f).close()
        self.trend = []                 # [t, spo2, pr, resp, rmssd, amp_rel] per second
        self.an = PulseAnalyzer()
        self.metrics, self.long, self.shape, self.resp_wave = {}, {}, None, []
        self.session = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        self.csv_path = os.path.join(LOG_DIR, f"session_{self.session}.csv")
        self.csv = open(self.csv_path, "w", newline="", encoding="utf-8")
        self.writer = csv.writer(self.csv)
        self.writer.writerow(["time", "spo2", "pulse", "signal", "finger", "resp_rate", "rmssd_ms",
                              "sdnn_ms", "pnn50_pct", "amplitude", "irregular_pct", "lf_ms2", "hf_ms2", "lf_hf"])
        self.rr_csv = open(os.path.join(LOG_DIR, f"rr_{self.session}.csv"), "w", newline="", encoding="utf-8")
        self.rr_writer = csv.writer(self.rr_csv)
        self.rr_writer.writerow(["time", "rr_ms", "valid"])

    # ---------- serial side ----------
    def open_port(self):
        if self.simulate:
            from simulator import SimulatedSerial
            return SimulatedSerial(), "simulator"
        port = self.port or find_port()
        if not port:
            raise serial.SerialException("no CP210x adapter found")
        return serial.Serial(port, 115200, timeout=0.1), port

    def reader(self):
        while True:
            try:
                s, name = self.open_port()
                with s:
                    self.status.update(connected=True, port=name)
                    s.write(frame(0xA2))
                    time.sleep(0.3)
                    s.reset_input_buffer()
                    for cmd, key in ((0xAA, "user"), (0xA8, "model")):
                        s.write(frame(cmd))
                        pk = self.wait_for(s, {0x04: None, 0x02: None}, 1.0)
                        if pk:
                            self.status[key] = self.text(pk, model=cmd == 0xA8)
                    s.write(frame(0xA1))
                    self.loop(s)
            except (serial.SerialException, OSError) as e:
                self.status.update(connected=False, finger=False, spo2=None, pr=None)
                print("connection:", e)
                time.sleep(2)

    @staticmethod
    def text(packets, model=False):
        chars = []
        for p in packets:
            v = decode(p)
            if model and p[0] == 0x02:
                v = v[1:]               # first value is a fragment index
            chars += [c for c in v if 0x20 <= c < 0x7F]
        return "".join(map(chr, chars)).strip() or None

    def wait_for(self, s, types, timeout):
        """Read until a packet of one of `types` arrives, then keep collecting briefly."""
        buf, end, got = bytearray(), time.time() + timeout, False
        while time.time() < end:
            chunk = s.read(512)
            if chunk:
                buf += chunk
                if not got and any(p[0] in types for p in split_packets(buf)):
                    got, end = True, time.time() + 0.25
        pk = [p for p in split_packets(buf) if p[0] in types]
        return pk or None

    def loop(self, s):
        buf = bytearray()
        last_keep = last_data = time.time()
        while True:
            try:
                op, args, done = self.ops.get_nowait()
            except queue.Empty:
                op = None
            if op:
                s.write(frame(0xA2))
                time.sleep(0.3)
                s.reset_input_buffer()
                try:
                    done["result"] = op(s, *args)
                except Exception as e:      # report to the browser, keep the connection
                    done["result"] = {"ok": False, "error": str(e)}
                done["event"].set()
                buf.clear()
                s.write(frame(0xA1))
                last_keep = last_data = time.time()
            chunk = s.read(512)
            now = time.time()
            if chunk:
                last_data = now
                buf += chunk
                self.parse(buf)
            if now - last_keep > 4:
                s.write(frame(0xA1))        # keeps the live stream running
                last_keep = now
            if now - last_data > 6:
                raise serial.SerialException("no data from device")

    def parse(self, buf):
        while True:
            while buf and buf[0] >= 0x80:
                del buf[0]
            if len(buf) < 9:
                return
            if any(b < 0x80 for b in buf[1:9]):
                del buf[0]
                continue
            pkt = bytes(buf[:9])
            del buf[:9]
            if pkt[0] == 0x01:
                self.live(decode(pkt))

    def live(self, v):
        finger = not (v[0] & 0x80)
        spo2 = v[4] if finger and 0 < v[4] <= 100 else None
        pr = v[3] if finger and 0 < v[3] < 255 else None
        pi = (v[6] << 8 | v[5]) if finger and (v[5], v[6]) != (255, 255) and (v[6] << 8 | v[5]) <= 2200 else None
        now = time.time()
        # the device adjusts its gain for a few seconds after the finger goes in: skip that phase
        if not finger:
            self.finger_since = None
        elif self.finger_since is None:
            self.finger_since = now
        settled = finger and now - self.finger_since >= SETTLE_S
        with self.lock:
            self.an.feed(v[1] if settled else None, now)
            self.wave.append(v[1] if finger else None)
            self.beat = self.beat or bool(v[0] & 0x40)
            self.status.update(finger=finger, spo2=spo2, pr=pr, signal=v[0] & 0x0F, bar=v[2] & 0x0F, pi=pi)

    def run_op(self, op, *args, timeout=60):
        if not self.status["connected"]:
            return {"ok": False, "error": "device not connected"}
        done = {"event": threading.Event()}
        self.ops.put((op, args, done))
        if not done["event"].wait(timeout):
            return {"ok": False, "error": "timeout"}
        return done["result"]

    # ---------- device operations (executed in the reader thread) ----------
    def op_storage(self, s):
        s.write(frame(0xAD))
        st = self.wait_for(s, {0x10}, 1.0)
        storing = bool(decode(st[0])[0]) if st else None
        s.write(frame(0xAB, 0))
        name = self.wait_for(s, {0x05}, 1.0)
        s.write(frame(0xA3, 0))
        info = self.wait_for(s, {0x0A}, 1.0)
        segments = decode(info[0])[1] if info else 0
        segs = []
        for seg in range(segments):
            s.write(frame(0xA4, 0, seg))
            ln = self.wait_for(s, {0x08}, 1.0)
            s.write(frame(0xA5, 0, seg))
            st_t = self.wait_for(s, {0x07, 0x12}, 1.0) or []
            length = None
            if ln:
                v = decode(ln[0])
                length = v[2] | v[3] << 8 | v[4] << 16 | v[5] << 24
            start = None
            date = next((decode(p) for p in st_t if p[0] == 0x07), None)
            tm = next((decode(p) for p in st_t if p[0] == 0x12), None)
            if date and tm and date[2] * 100 + date[3] > 2000:
                start = f"{date[2] * 100 + date[3]:04d}-{date[4]:02d}-{date[5]:02d}T{tm[2]:02d}:{tm[3]:02d}:{tm[4]:02d}"
            segs.append({"user": 0, "segment": seg, "length": length,
                         "samples": length // 2 if length else None, "start": start})
        user = None
        if name:
            v = decode(name[0])[1:]
            user = "".join(chr(c) for c in v if 0x20 <= c < 0x7F).strip()
        return {"ok": True, "storing": storing, "user": user, "segments": segs}

    def op_download(self, s, user, seg):
        s.write(frame(0xA7))
        self.wait_for(s, {0x0C}, 0.5)
        s.write(frame(0xA2))
        time.sleep(0.2)
        s.reset_input_buffer()
        s.write(frame(0xA6, user, seg))
        buf, last, t0 = bytearray(), time.time(), time.time()
        while time.time() - last < 2.5 and time.time() - t0 < 300:
            chunk = s.read(4096)
            if chunk:
                buf += chunk
                last = time.time()
        packets = split_packets(buf)
        for p in packets:
            if p[0] == 0x0B and decode(p)[:2] == [0xA6, 3]:
                return {"ok": False, "error": "storing",
                        "message": "The device is still recording. Stop the recording on the device first."}
        samples = []
        for p in packets:
            if p[0] == 0x0F:
                v = decode(p)
                for k in range(0, 6, 2):
                    spo2, pr = v[k], v[k + 1]
                    samples.append([spo2 if 0 < spo2 <= 100 else None, pr if 0 < pr < 255 else None])
        if not samples:
            return {"ok": False, "error": "no data", "message": "The device did not send any stored data."}
        path = os.path.join(LOG_DIR, f"device_u{user}_s{seg}_{datetime.now():%Y-%m-%d_%H%M%S}.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["second", "spo2", "pulse"])
            for i, (a, b) in enumerate(samples):
                w.writerow([i, "" if a is None else a, "" if b is None else b])
        return {"ok": True, "samples": samples, "file": os.path.basename(path)}

    def op_set_clock(self, s):
        now = datetime.now()
        acks = []
        s.write(frame_payload(0xB2, [now.year // 100, now.year % 100, now.month, now.day, now.isoweekday() % 7]))
        acks += self.wait_for(s, {0x0B}, 1.0) or []
        s.write(frame_payload(0xB1, [now.hour, now.minute, now.second]))
        acks += self.wait_for(s, {0x0B}, 1.0) or []
        codes = [decode(p)[:2] for p in acks]
        ok = bool(codes) and all(c[1] == 5 for c in codes)
        return {"ok": ok, "set_to": now.isoformat(timespec="seconds"),
                "acks": [f"{c[0]:02X}:{c[1]}" for c in codes]}

    # ---------- distribution to browsers ----------
    def broadcaster(self):
        next_tick = time.time() + 1
        tick = 0
        while True:
            time.sleep(0.05)
            now = time.time()
            with self.lock:
                msg = {"w": self.wave, "beat": self.beat, "s": dict(self.status), "rr": self.an.pop_new_rr()}
                self.wave, self.beat = [], False
                if now >= next_tick:
                    self.metrics = self.an.metrics(now)
                    self.resp_wave = self.an.resp_wave(now)
                    if tick % 5 == 0:
                        self.long = self.an.hrv_long(now)
                        self.shape = self.an.pulse_shape(now)
            for w, ms, ok in msg["rr"]:
                self.rr_writer.writerow([datetime.fromtimestamp(w).isoformat(timespec="milliseconds"), ms, int(ok)])
            if now >= next_tick:
                next_tick += 1
                tick += 1
                st, m, lg = msg["s"], self.metrics, self.long
                msg.update(a=m, rw=self.resp_wave)
                if tick % 5 == 1:
                    msg.update(hl=lg, ps=self.shape)
                point = [round(now, 1), st["spo2"], st["pr"], m.get("resp"), m.get("rmssd"), m.get("amp_rel")]
                self.trend.append(point)
                msg["t"] = point
                if st["connected"]:
                    o = lambda x: "" if x is None else x
                    self.writer.writerow([datetime.fromtimestamp(now).isoformat(timespec="seconds"),
                                          o(st["spo2"]), o(st["pr"]), st["signal"], int(st["finger"]),
                                          o(m.get("resp")), o(m.get("rmssd")), o(m.get("sdnn")), o(m.get("pnn50")),
                                          o(m.get("amp")), o(m.get("irreg")), o(lg.get("lf")), o(lg.get("hf")),
                                          o(lg.get("lf_hf"))])
                    self.csv.flush()
                    self.rr_csv.flush()
            data = ("data: " + json.dumps(msg) + "\n\n").encode()
            for q in list(self.clients):
                try:
                    q.put_nowait(data)
                except queue.Full:
                    pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def json(self, obj, code=200):
        self.send(code, json.dumps(obj).encode(), "application/json")

    def do_POST(self):
        ox = self.server.ox
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/api/device/storage":
            self.json(ox.run_op(ox.op_storage))
        elif url.path == "/api/device/download":
            user, seg = int(q.get("user", ["0"])[0]), int(q.get("segment", ["0"])[0])
            self.json(ox.run_op(ox.op_download, user, seg, timeout=330))
        elif url.path == "/api/device/clock":
            self.json(ox.run_op(ox.op_set_clock))
        elif url.path == "/api/reset":
            with ox.lock:
                ox.reset()
            self.json({"ok": True, "session": ox.session})
        else:
            self.send(404, b"not found", "text/plain")

    def do_GET(self):
        ox = self.server.ox
        url = urlparse(self.path)
        if url.path in ("/", "/index.html", "/plethlab-core.js", "/report.js"):
            name = url.path.lstrip("/") if url.path.endswith(".js") else "index.html"
            ctype = "text/javascript; charset=utf-8" if name.endswith(".js") else "text/html; charset=utf-8"
            with open(os.path.join(HERE, "docs", name), "rb") as f:
                body = f.read()
            if name == "index.html":
                body = body.replace(b'name="plethlab-mode" content="browser"', b'name="plethlab-mode" content="server"')
            self.send(200, body, ctype)
        elif url.path == "/api/history":
            with ox.lock:
                rr = ox.an.recent_rr(time.time())
            self.json({"trend": ox.trend, "session": ox.session, "rr": rr, "a": ox.metrics,
                       "hl": ox.long, "ps": ox.shape, "rw": ox.resp_wave})
        elif url.path == "/api/csv":
            name = parse_qs(url.query).get("file", [os.path.basename(ox.csv_path)])[0]
            path = os.path.join(LOG_DIR, os.path.basename(name))
            if not os.path.isfile(path):
                return self.send(404, b"not found", "text/plain")
            with open(path, "rb") as f:
                body = f.read()
            self.send(200, body, "text/csv; charset=utf-8",
                      {"Content-Disposition": f'attachment; filename="{os.path.basename(path)}"'})
        elif url.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q = queue.Queue(maxsize=200)
            ox.clients.append(q)
            try:
                while True:
                    self.wfile.write(q.get())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                ox.clients.remove(q)
        else:
            self.send(404, b"not found", "text/plain")


def main():
    args = sys.argv[1:]
    opts = {"--port": "8050", "--host": "127.0.0.1"}
    for key in list(opts):
        if key in args:
            i = args.index(key)
            opts[key] = args[i + 1]
            del args[i:i + 2]
    simulate = "--simulate" in args
    args = [a for a in args if a != "--simulate"]
    ox = Oximeter(args[0] if args else None, simulate=simulate)
    threading.Thread(target=ox.reader, daemon=True).start()
    threading.Thread(target=ox.broadcaster, daemon=True).start()
    srv = ThreadingHTTPServer((opts["--host"], int(opts["--port"])), Handler)
    srv.daemon_threads = True
    srv.ox = ox
    print(f"Dashboard: http://localhost:{opts['--port']}{'  (simulated device)' if simulate else ''}")
    print(f"Log: {ox.csv_path}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
