"""End-to-end tests of the dashboard in a headless browser.

1. server mode: server.py --simulate, dashboard served by the server
2. browser mode: static docs/ (as on GitHub Pages) with the in-browser demo device

Run:  python -m pytest tests/test_e2e.py -s
Needs: pip install playwright && python -m playwright install chromium
"""
import functools
import http.server
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

import pytest

pw = pytest.importorskip("playwright.sync_api")

ROOT = os.path.join(os.path.dirname(__file__), "..")
PORT = 8061
ART = os.path.join(os.path.dirname(__file__), "artifacts")


@pytest.fixture(scope="module")
def server_url():
    proc = subprocess.Popen([sys.executable, "server.py", "--simulate", "--port", str(PORT)], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{PORT}/"
    for _ in range(50):
        try:
            urllib.request.urlopen(url + "api/history", timeout=1)
            break
        except OSError:
            time.sleep(0.2)
    yield url
    proc.terminate()
    proc.wait(10)


@pytest.fixture(scope="module")
def static_url():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, "docs"))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/"
    srv.shutdown()


def number(text):
    m = re.search(r"-?\d+(?:[.,]\d+)?", text or "")
    return float(m.group(0).replace(",", ".")) if m else None


def exercise(url, tag):
    os.makedirs(ART, exist_ok=True)
    errors = []
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 1440, "height": 1300}, locale="en-US", accept_downloads=True)
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)

        # live numerics from the simulated device
        page.wait_for_function("/^\\d+$/.test(document.getElementById('hr').textContent)", timeout=15000)
        assert 55 <= number(page.text_content("#hr")) <= 80
        assert 94 <= number(page.text_content("#spo2")) <= 99
        assert page.is_visible("#simChip")
        assert "SIM-50+" in page.text_content("#connText")

        page.wait_for_timeout(3000)
        lit = page.evaluate("""() => { const c = document.getElementById('pleth');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i + 1] > 150) n++; return n; }""")
        assert lit > 200

        page.wait_for_function("/\\d/.test(document.getElementById('resp').textContent)", timeout=90000)
        page.wait_for_function("/\\d/.test(document.getElementById('rmssd').textContent)", timeout=30000)
        assert abs(number(page.text_content("#resp")) - 15) <= 2
        page.wait_for_function("/\\d/.test(document.getElementById('sd1').textContent)", timeout=30000)
        page.wait_for_function("/ms/.test(document.getElementById('rise').textContent)", timeout=30000)
        assert page.text_content("#rhythm") == "regular"

        page.click("#langBtn")
        assert "Kein Medizinprodukt" in page.text_content("footer")
        assert page.text_content("#deviceBtn") == "Gerät"
        page.click("#langBtn")
        assert "Not a medical device" in page.text_content("footer")

        page.click("#deviceBtn")
        page.click("#loadStorage")
        page.wait_for_selector("#segTable tbody tr button", timeout=15000)
        page.click("#segTable tbody tr button")
        page.wait_for_selector("#recWrap:not([hidden])", timeout=30000)
        stats = page.text_content("#recStats")
        assert "Min SpO₂" in stats and "%" in stats
        page.click("#setClock")
        page.wait_for_selector("#dlgMsg.ok", timeout=15000)
        page.screenshot(path=os.path.join(ART, f"e2e_{tag}_dialog.png"))
        page.click("#dlgClose")

        page.wait_for_timeout(3000)
        assert number(page.text_content("#hr")) is not None
        page.screenshot(path=os.path.join(ART, f"e2e_{tag}_monitor.png"), full_page=True)
        if tag == "browser":
            with page.expect_download() as dl:
                page.click("#csvBtn")
            assert dl.value.suggested_filename.startswith("session_")

        # PDF report
        with page.expect_download() as dl:
            page.click("#pdfBtn")
        pdf_path = os.path.join(ART, f"report_{tag}.pdf")
        dl.value.save_as(pdf_path)
        data = open(pdf_path, "rb").read()
        assert data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF") and len(data) > 20000
        assert data.count(b"/Type /Page ") == 2

        # reset clears trends and analysis
        page.once("dialog", lambda d: d.accept())
        page.click("#resetBtn")
        page.wait_for_timeout(500)
        assert page.evaluate("trend.length") <= 1
        assert page.text_content("#rmssd") == "–"
        page.wait_for_function("/^\\d+$/.test(document.getElementById('hr').textContent)", timeout=15000)
        browser.close()
    assert not errors, errors


def test_server_mode(server_url):
    exercise(server_url, "server")


def test_browser_mode_demo(static_url):
    exercise(static_url + "?demo", "browser")
