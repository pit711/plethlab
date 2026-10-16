"""The in-browser analyzer (docs/plethlab-core.js) must match analysis.py on identical input."""
import functools
import http.server
import os
import sys
import threading

import pytest

pw = pytest.importorskip("playwright.sync_api")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from analysis import FS, PulseAnalyzer  # noqa: E402
from server import decode               # noqa: E402
from simulator import SimulatedSerial   # noqa: E402

DOCS = os.path.join(os.path.dirname(__file__), "..", "docs")
T0 = 1_000_000.0


@pytest.fixture(scope="module")
def static_url():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DOCS)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/"
    srv.shutdown()


def python_reference(seconds=330):
    sim = SimulatedSerial(seed=3)
    sim.live = True
    waves = [decode(sim._sample())[1] for _ in range(int(seconds * FS))]
    an = PulseAnalyzer()
    for n, v in enumerate(waves):
        an.feed(v, T0 + n / FS)
    now = T0 + len(waves) / FS
    return waves, now, an.metrics(now), an.hrv_long(now), an.pulse_shape(now), len(an.rr)


def close(a, b, rel=0.03, abs_=0.0):
    assert a is not None and b is not None, (a, b)
    assert abs(a - b) <= max(abs_, rel * abs(b)), (a, b)


def test_js_matches_python(static_url):
    waves, now, m, h, ps, n_rr = python_reference()
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="msedge")
        page = browser.new_page()
        page.goto(static_url + "?nodevice")
        js = page.evaluate("""([waves, t0, fs]) => {
            const an = new PlethLab.Analyzer();
            waves.forEach((v, n) => an.feed(v, t0 + n / fs));
            const now = t0 + waves.length / fs;
            return { m: an.metrics(now), h: an.hrvLong(now), ps: an.pulseShape(now), nrr: an.rr.length,
                     rw: an.respWave(now).length };
        }""", [waves, T0, FS])
        browser.close()
    assert js["nrr"] == n_rr
    for k in ("rmssd", "sdnn", "hr", "pnn50"):
        close(js["m"][k], m[k], rel=0.02, abs_=0.2)
    close(js["m"]["resp"], m["resp"], abs_=0.3)
    for k in ("sd1", "sd2"):
        close(js["h"][k], h[k], rel=0.02)
    for k in ("lf", "hf"):
        close(js["h"][k], h[k], rel=0.05, abs_=2)
    close(js["ps"]["rise_ms"], ps["rise_ms"], abs_=10)
    close(js["ps"]["ratios"]["b/a"], ps["ratios"]["b/a"], abs_=0.1)
    assert js["rw"] > 60
