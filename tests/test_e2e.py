"""End-to-end test: server in simulator mode + dashboard in a headless browser.

Run:  python -m pytest tests/test_e2e.py -s
Needs: pip install playwright && python -m playwright install chromium
"""
import os
import re
import subprocess
import sys
import time
import urllib.request

import pytest

pw = pytest.importorskip("playwright.sync_api")

ROOT = os.path.join(os.path.dirname(__file__), "..")
PORT = 8061
URL = f"http://127.0.0.1:{PORT}/"
ART = os.path.join(os.path.dirname(__file__), "artifacts")


@pytest.fixture(scope="module")
def server():
    proc = subprocess.Popen([sys.executable, "server.py", "--simulate", "--port", str(PORT)], cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(URL + "api/history", timeout=1)
            break
        except OSError:
            time.sleep(0.2)
    yield proc
    proc.terminate()
    proc.wait(10)


def number(text):
    m = re.search(r"-?\d+(?:[.,]\d+)?", text or "")
    return float(m.group(0).replace(",", ".")) if m else None


def test_dashboard_end_to_end(server):
    os.makedirs(ART, exist_ok=True)
    errors = []
    with pw.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception:
            browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 1440, "height": 1300}, locale="en-US")
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL)

        # live numerics from the simulated device
        page.wait_for_function("/^\\d+$/.test(document.getElementById('hr').textContent)", timeout=15000)
        assert 55 <= number(page.text_content("#hr")) <= 80
        assert 94 <= number(page.text_content("#spo2")) <= 99
        assert page.is_visible("#simChip")
        assert "SIM-50+" in page.text_content("#connText")

        # pleth canvas actually draws something
        page.wait_for_timeout(3000)
        lit = page.evaluate("""() => { const c = document.getElementById('pleth');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i + 1] > 150) n++; return n; }""")
        assert lit > 200

        # derived values need ~30-60 s of beats
        page.wait_for_function("/\\d/.test(document.getElementById('resp').textContent)", timeout=90000)
        page.wait_for_function("/\\d/.test(document.getElementById('rmssd').textContent)", timeout=30000)
        assert abs(number(page.text_content("#resp")) - 15) <= 2
        page.wait_for_function("/\\d/.test(document.getElementById('sd1').textContent)", timeout=30000)
        page.wait_for_function("/ms/.test(document.getElementById('rise').textContent)", timeout=30000)
        assert page.text_content("#rhythm") in ("regular",)

        # language switch
        page.click("#langBtn")
        assert "Kein Medizinprodukt" in page.text_content("footer")
        assert page.text_content("#deviceBtn") == "Gerät"
        page.click("#langBtn")
        assert "Not a medical device" in page.text_content("footer")

        # device dialog: storage listing, download, clock
        page.click("#deviceBtn")
        page.click("#loadStorage")
        page.wait_for_selector("#segTable tbody tr button", timeout=15000)
        page.click("#segTable tbody tr button")
        page.wait_for_selector("#recWrap:not([hidden])", timeout=30000)
        stats = page.text_content("#recStats")
        assert "Min SpO₂" in stats and "%" in stats
        assert page.get_attribute("#recCsv", "href").startswith("/api/csv?file=device_")
        page.click("#setClock")
        page.wait_for_selector("#dlgMsg.ok", timeout=15000)
        page.screenshot(path=os.path.join(ART, "e2e_dialog.png"))
        page.click("#dlgClose")

        # live stream resumes after device operations
        before = number(page.text_content("#hr"))
        page.wait_for_timeout(3000)
        assert number(page.text_content("#hr")) is not None and before is not None
        page.screenshot(path=os.path.join(ART, "e2e_monitor.png"), full_page=True)
        browser.close()
    assert not errors, errors
