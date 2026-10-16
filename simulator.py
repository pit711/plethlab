"""Simulated CMS50D+ for demos and tests (no hardware needed).

Implements the subset of the serial protocol used by the server: live stream (A1/A2),
identity queries, storage listing (A3/A4/A5/AB/AD), playback (A6), clock (B1/B2)
and acknowledgements. The pulse wave is synthetic: a two-peak beat template with
respiratory sinus arrhythmia, amplitude and baseline modulation at 15 breaths/min.
"""
import math
import random
import threading
import time

FS = 60.0
RESP_HZ = 0.25           # 15 breaths/min
BASE_RR = 0.90           # s


def encode(ptype, values):
    hi = 0x80
    body = []
    for k, v in enumerate(values):
        if v & 0x80:
            hi |= 1 << k
        body.append(0x80 | (v & 0x7F))
    return bytes([ptype, hi] + body)


class SimulatedSerial:
    def __init__(self, seed=1):
        self.rng = random.Random(seed)
        self.out = bytearray()
        self.lock = threading.Lock()
        self.live = False
        self.t = 0.0                 # simulated signal time
        self.last = time.time()
        self.beat_start, self.rr = 0.0, BASE_RR
        self.rr_hist = [BASE_RR] * 8
        self.flag_pending = False
        self.storing = False
        self.clock = None
        self.stored = [(96 + int(2 * math.sin(i / 300)) - (4 if 1800 < i < 1900 else 0),
                        64 + int(6 * math.sin(i / 200))) for i in range(3600)]

    # pyserial-like API
    @property
    def in_waiting(self):
        self._advance()
        return len(self.out)

    def read(self, size=1):
        self._advance()
        if not self.out:
            time.sleep(0.02)
            self._advance()
        with self.lock:
            chunk, self.out = bytes(self.out[:size]), self.out[size:]
        return chunk

    def reset_input_buffer(self):
        with self.lock:
            self.out.clear()

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def write(self, data):
        if len(data) < 5 or data[0] != 0x7D:
            return len(data)
        cmd, p1, p2 = data[2], data[3] & 0x7F, data[4] & 0x7F
        reply = b""
        if cmd == 0xA1:
            self.live = True
            self.last = time.time()
        elif cmd == 0xA2:
            self.live = False
        elif cmd == 0xA7:
            reply = encode(0x0C, [0])
        elif cmd == 0xA8:
            # like the real device: two packets, first value is a fragment index (0, then 0xFF)
            reply = encode(0x02, [0] + [ord(c) for c in "SIM-50"]) + encode(0x02, [0xFF] + [ord(c) for c in "+     "])
        elif cmd == 0xA9:
            reply = encode(0x03, [ord(c) for c in "Sim    "])
        elif cmd == 0xAA:
            reply = encode(0x04, [ord(c) for c in "demo   "])
        elif cmd == 0xAB:
            reply = encode(0x05, [p1] + [ord(c) for c in "demo  "])
        elif cmd == 0xA3:
            reply = encode(0x0A, [p1, 1])
        elif cmd == 0xA4:
            n = len(self.stored) * 2
            reply = encode(0x08, [p1, p2, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, 0])
        elif cmd == 0xA5:
            c = self.clock or (2026, 1, 1, 22, 0, 0)
            reply = encode(0x07, [p1, p2, c[0] // 100, c[0] % 100, c[1], c[2]]) + encode(0x12, [p1, p2, c[3], c[4], c[5], 0])
        elif cmd == 0xAD:
            reply = encode(0x10, [1 if self.storing else 0])
        elif cmd == 0xA6:
            if self.storing:
                reply = encode(0x0B, [0xA6, 3])
            else:
                reply = b"".join(encode(0x0F, [s1, p1_, s2, p2_, s3, p3, 0])
                                 for (s1, p1_), (s2, p2_), (s3, p3) in zip(*[iter(self.stored)] * 3))
        elif cmd in (0xB1, 0xB2):
            now = time.localtime()
            self.clock = (now.tm_year, now.tm_mon, now.tm_mday, now.tm_hour, now.tm_min, now.tm_sec)
            reply = encode(0x0B, [cmd, 5])
        elif cmd == 0xB8:
            reply = encode(0x0B, [0xB8, 5])
        elif cmd == 0xB0:
            reply = encode(0x11, [1, 1, 0, 0, 0, 0, 0])
        with self.lock:
            self.out += reply
        return len(data)

    # ---------- synthetic signal ----------
    def _advance(self):
        now = time.time()
        if not self.live:
            self.last = now
            return
        n = int((now - self.last) * FS)
        if n <= 0:
            return
        self.last += n / FS
        pkts = bytearray()
        for _ in range(min(n, 600)):
            pkts += self._sample()
        with self.lock:
            self.out += pkts

    def _sample(self):
        dt = 1 / FS
        self.t += dt
        phase_t = self.t - self.beat_start
        if phase_t >= self.rr:
            self.beat_start += self.rr
            phase_t = self.t - self.beat_start
            resp = math.sin(2 * math.pi * RESP_HZ * self.beat_start)
            self.rr = BASE_RR - 0.06 * resp + self.rng.gauss(0, 0.012)
            self.rr_hist = self.rr_hist[1:] + [self.rr]
            self.flag_pending = True
        resp = math.sin(2 * math.pi * RESP_HZ * self.t)
        x = phase_t / self.rr
        shape = (math.exp(-((x - 0.20) / 0.075) ** 2) + 0.38 * math.exp(-((x - 0.48) / 0.10) ** 2))
        wave = 30 + 6 * resp + 48 * (1 + 0.08 * resp) * shape + self.rng.gauss(0, 0.4)
        wave = max(0, min(127, int(round(wave))))
        beat = 0
        if self.flag_pending and x > 0.08:
            beat, self.flag_pending = 0x40, False
        pr = int(round(60 / (sum(self.rr_hist) / len(self.rr_hist))))
        spo2 = 97 + int(round(math.sin(self.t / 40)))
        return encode(0x01, [0x06 | beat, wave, 0x05, pr, spo2, 0xFF, 0xFF])
