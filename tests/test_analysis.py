"""Offline tests of the analysis pipeline against the simulator's known ground truth."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from analysis import FS, PulseAnalyzer          # noqa: E402
from server import decode, frame, split_packets  # noqa: E402
from simulator import SimulatedSerial           # noqa: E402

T0 = 1_000_000.0


def run(seconds, seed=1):
    sim = SimulatedSerial(seed=seed)
    sim.live = True
    an = PulseAnalyzer()
    true_rr = []
    last_start = None
    for n in range(int(seconds * FS)):
        pkt = sim._sample()
        if last_start is not None and sim.beat_start != last_start:
            true_rr.append((sim.beat_start - last_start) * 1000)
        last_start = sim.beat_start
        v = decode(pkt)
        an.feed(v[1], T0 + n / FS)
    return an, true_rr, T0 + seconds


def test_beats_and_rr_match_ground_truth():
    an, true_rr, _ = run(120)
    rr = [ms for _, ms, ok in an.rr]
    assert abs(len(rr) - len(true_rr)) <= 2
    mean_true = sum(true_rr) / len(true_rr)
    mean_est = sum(rr) / len(rr)
    assert abs(mean_est - mean_true) < 5
    assert sum(1 for x in an.rr if not x[2]) <= 2


def test_time_domain_and_respiration():
    an, _, now = run(90)
    m = an.metrics(now)
    assert m["resp"] is not None and abs(m["resp"] - 15.0) <= 1.5
    assert 20 < m["rmssd"] < 120
    assert 55 < m["hr"] < 80
    wave = an.resp_wave(now)
    assert len(wave) > 60 and max(abs(v) for _, v in wave) <= 1.0001


def test_frequency_domain_hf_dominates():
    an, _, now = run(320)
    h = an.hrv_long(now)
    assert h["sd1"] and h["sd2"]
    assert h["hf"] > h["lf"]                     # simulated RSA sits at 0.25 Hz (HF band)
    peak_f = max(h["spectrum"], key=lambda p: p[1])[0]
    assert abs(peak_f - 0.25) < 0.03


def test_pulse_shape():
    an, _, now = run(40)
    ps = an.pulse_shape(now)
    assert ps and ps["n"] >= 8
    assert 60 < ps["rise_ms"] < 250
    assert "a" in ps["sdppg"] and "b" in ps["sdppg"]
    assert ps["ratios"]["b/a"] < 0


def test_protocol_helpers():
    assert frame(0xA1) == bytes([0x7D, 0x81, 0xA1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])
    pk = split_packets(bytes([0x01, 0xE0, 0x86, 0x9E, 0x93, 0xD2, 0xE0, 0xFF, 0xFF]))
    assert decode(pk[0]) == [6, 30, 19, 82, 96, 255, 255]
    try:
        frame(0xAE)
        assert False, "erase command must be blocked"
    except ValueError:
        pass


def test_simulated_storage_roundtrip():
    sim = SimulatedSerial()
    sim.write(frame(0xA6, 0, 0))
    pk = split_packets(sim.read(100000))
    assert pk and all(p[0] == 0x0F for p in pk)
    sim.storing = True
    sim.write(frame(0xA6, 0, 0))
    assert decode(split_packets(sim.read(100))[0])[:2] == [0xA6, 3]
