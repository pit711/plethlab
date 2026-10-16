/* PlethLab report: a minimal PDF writer (no dependencies) and the session report layout.
 * Text uses the standard Helvetica fonts with WinAnsi encoding; charts are embedded as JPEG.
 */
(function (global) {
  "use strict";
  const W = 595.28, H = 841.89;                     // A4 in points

  const WINANSI = { "–": 0x96, "—": 0x97, "„": 0x84, "“": 0x93, "”": 0x94, "‘": 0x91, "’": 0x92, "…": 0x85, "€": 0x80, "•": 0x95 };
  const REPLACE = { "₂": "2", "≥": ">=", "≤": "<=", "≈": "~", "→": "->", "▲": "", "✓": "", "≙": "=", "²": "²", "−": "-" };
  function encodeText(s) {
    let out = "";
    for (const ch of String(s)) {
      const r = REPLACE[ch];
      const c = r !== undefined ? r : ch;
      for (const cc of c) {
        const code = WINANSI[cc] ?? cc.charCodeAt(0);
        if (code > 255) continue;
        const b = String.fromCharCode(code);
        out += b === "(" || b === ")" || b === "\\" ? "\\" + b : b;
      }
    }
    return out;
  }
  const bytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xFF);
  const num = v => (Math.round(v * 100) / 100).toString();

  class Pdf {
    constructor() { this.pages = []; this.images = []; }
    addPage() { this.cur = { ops: [], imgs: new Set() }; this.pages.push(this.cur); return this; }
    text(x, y, s, size = 10, bold = false, rgb = [0, 0, 0]) {
      this.cur.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb.map(num).join(" ")} rg ${num(x)} ${num(H - y)} Td (${encodeText(s)}) Tj ET`);
      return this;
    }
    width(s, size) { return encodeText(s).length * size * 0.5; }      // rough estimate for wrapping
    wrap(x, y, s, size, maxW, rgb, lead = 1.35) {
      const words = String(s).split(/\s+/); let line = "", yy = y;
      for (const w of words) {
        if (line && this.width(line + " " + w, size) > maxW) { this.text(x, yy, line, size, false, rgb); yy += size * lead; line = w; }
        else line = line ? line + " " + w : w;
      }
      if (line) { this.text(x, yy, line, size, false, rgb); yy += size * lead; }
      return yy;
    }
    rect(x, y, w, h, rgb) { this.cur.ops.push(`${rgb.map(num).join(" ")} rg ${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re f`); return this; }
    line(x1, y1, x2, y2, rgb = [0.8, 0.8, 0.8], lw = 0.5) {
      this.cur.ops.push(`${rgb.map(num).join(" ")} RG ${lw} w ${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S`); return this;
    }
    image(canvas, x, y, w, quality = 0.88) {
      const data = atob(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
      const id = `Im${this.images.length + 1}`;
      this.images.push({ id, data, pw: canvas.width, ph: canvas.height });
      const h = w * canvas.height / canvas.width;
      this.cur.imgs.add(id);
      this.cur.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(H - y - h)} cm /${id} Do Q`);
      return h;
    }
    output() {
      const chunks = [], offsets = [];
      let len = 0;
      const push = b => { const u = typeof b === "string" ? bytes(b) : b; chunks.push(u); len += u.length; };
      const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); for (const b of body) push(b); push("\nendobj\n"); };
      push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
      const nImg = this.images.length, firstImg = 5, firstPage = firstImg + nImg;
      const pageIds = this.pages.map((_, i) => firstPage + i * 2);
      obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
      obj(2, [`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(" ")}] /Count ${this.pages.length} >>`]);
      obj(3, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
      obj(4, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"]);
      this.images.forEach((im, i) => obj(firstImg + i, [
        `<< /Type /XObject /Subtype /Image /Width ${im.pw} /Height ${im.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`,
        bytes(im.data), "\nendstream"]));
      this.pages.forEach((pg, i) => {
        const stream = pg.ops.join("\n");
        const xo = [...pg.imgs].map(id => `/${id} ${firstImg + this.images.findIndex(m => m.id === id)} 0 R`).join(" ");
        obj(pageIds[i], [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Contents ${pageIds[i] + 1} 0 R ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xo} >> >> >>`]);
        const sb = bytes(stream);
        obj(pageIds[i] + 1, [`<< /Length ${sb.length} >>\nstream\n`, sb, "\nendstream"]);
      });
      const total = firstPage + this.pages.length * 2;
      const xref = len;
      push(`xref\n0 ${total}\n0000000000 65535 f \n`);
      for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
      push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
      const out = new Uint8Array(len); let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }
  }

  // stack several canvases (in CSS pixel layout) onto one black canvas
  function compose(rows, gap = 6, scale = 1.5) {
    const width = Math.max(...rows.map(r => r.reduce((s, c) => s + c.clientWidth, 0) + gap * (r.length - 1)));
    const height = rows.reduce((s, r) => s + Math.max(...r.map(c => c.clientHeight)), 0) + gap * (rows.length - 1);
    const cv = document.createElement("canvas");
    cv.width = Math.round(width * scale); cv.height = Math.round(height * scale);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
    let y = 0;
    for (const r of rows) {
      let x = 0;
      for (const c of r) { ctx.drawImage(c, x * scale, y * scale, c.clientWidth * scale, c.clientHeight * scale); x += c.clientWidth + gap; }
      y += Math.max(...r.map(c => c.clientHeight)) + gap;
    }
    return cv;
  }

  /* data: {t, fmt, fmtT, locale, trend, metrics, hl, ps, status, canvases} */
  function buildReport(d) {
    const { t, fmt } = d, pdf = new Pdf().addPage();
    const grey = [0.35, 0.35, 0.35], M = 40;
    const tr = d.trend.filter(p => p[1] != null || p[2] != null);
    const sp = tr.map(p => p[1]).filter(v => v != null), pr = tr.map(p => p[2]).filter(v => v != null);
    const rs = d.trend.map(p => p[3]).filter(v => v != null);
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const t0 = d.trend.length ? d.trend[0][0] : Date.now() / 1000, t1 = d.trend.length ? d.trend[d.trend.length - 1][0] : t0;
    const dur = Math.max(0, Math.round(t1 - t0)), durS = `${Math.floor(dur / 3600)} h ${Math.floor(dur / 60) % 60} min ${dur % 60} s`;
    // desaturation events: drop of >= 3 % below the running 120 s maximum
    let events = 0, inEv = false;
    const spo = d.trend.map(p => p[1]);
    for (let i = 0; i < spo.length; i++) {
      const v = spo[i]; if (v == null) continue;
      let base = 0; for (let k = Math.max(0, i - 120); k <= i; k++) if (spo[k] != null && spo[k] > base) base = spo[k];
      if (!inEv && base - v >= 3) { events++; inEv = true; } else if (inEv && base - v < 1) inEv = false;
    }
    const hours = sp.length / 3600;

    pdf.rect(0, 0, W, 70, [0.02, 0.03, 0.04]);
    pdf.text(M, 34, "PlethLab", 22, true, [1, 1, 1]);
    pdf.text(M + 112, 34, t("reportTitle"), 14, false, [0.6, 0.85, 0.9]);
    pdf.text(M, 54, `${t("reportCreated")} ${new Date().toLocaleString(d.locale)}`, 9, false, [0.75, 0.75, 0.75]);
    let y = 96;
    const kv = (label, value, x = M, w = 250) => { pdf.text(x, y, label, 9, false, grey); pdf.text(x + w * 0.52, y, value, 9.5, true); };
    pdf.text(M, y, t("session"), 12, true); y += 16;
    kv(t("start"), new Date(t0 * 1000).toLocaleString(d.locale)); y += 13;
    kv(t("duration"), durS); y += 13;
    kv(t("deviceTitle"), `${d.status.model || "–"} · ${t("user")} ${d.status.user || "–"}${d.status.simulated ? " (SIM)" : ""}`); y += 22;

    const col2 = M + 270, yTop = y;
    pdf.text(M, y, "SpO2 · " + t("pulse"), 12, true); y += 16;
    kv("SpO2 Ø / min / max", sp.length ? `${fmt(avg(sp), 1)} / ${Math.min(...sp)} / ${Math.max(...sp)} %` : "–"); y += 13;
    kv("SpO2 < 90 %", `${sp.filter(v => v < 90).length} s`); y += 13;
    kv("SpO2 < 95 %", `${sp.filter(v => v < 95).length} s`); y += 13;
    kv(t("desat"), `${events} (${fmt(hours ? events / hours : 0, 1)} ${t("odi")})`); y += 13;
    kv(`${t("pulse")} Ø / min / max`, pr.length ? `${fmt(avg(pr))} / ${Math.min(...pr)} / ${Math.max(...pr)} bpm` : "–"); y += 13;
    kv(t("respShort"), rs.length ? `Ø ${fmt(avg(rs), 1)} /min` : "–");
    const m = d.metrics || {}, h = d.hl || {}, ps = d.ps;
    y = yTop;
    const kv2 = (label, value) => { pdf.text(col2, y, label, 9, false, grey); pdf.text(col2 + 130, y, value, 9.5, true); y += 13; };
    pdf.text(col2, y, t("hrvSection"), 12, true); y += 16;
    kv2("RMSSD / SDNN", m.rmssd != null ? `${fmt(m.rmssd)} / ${fmt(m.sdnn)} ms` : "–");
    kv2("pNN50", m.pnn50 != null ? `${fmt(m.pnn50)} %` : "–");
    kv2("SD1 / SD2", h.sd1 != null ? `${fmt(h.sd1, 1)} / ${fmt(h.sd2, 1)} ms` : "–");
    kv2("LF / HF", h.lf != null ? `${fmt(h.lf)} / ${fmt(h.hf)} ms²` : "–");
    kv2("LF/HF", h.lf_hf != null ? fmt(h.lf_hf, 2) : "–");
    kv2(t("rhythm"), m.irreg != null ? `${fmt(m.irreg)} % ${t("irregular")}` : "–");
    kv2(`${t("rise")} / b/a`, ps ? `${ps.rise_ms} ms / ${ps.ratios ? fmt(ps.ratios["b/a"], 2) : "–"}` : "–");
    y = Math.max(y, yTop + 16 + 6 * 13) + 18;

    pdf.text(M, y, t("trends"), 12, true); y += 8;
    y += pdf.image(compose(d.canvases.strips.map(c => [c])), M, y, W - 2 * M) + 14;
    pdf.wrap(M, H - 46, t("footer"), 7.5, W - 2 * M, grey);

    pdf.addPage();
    y = 40;
    pdf.text(M, y, "Pleth · " + t("respWave"), 12, true); y += 8;
    y += pdf.image(compose([[d.canvases.pleth], [d.canvases.resp], [d.canvases.tacho]]), M, y, W - 2 * M) + 16;
    pdf.text(M, y, `Poincaré · ${t("spectrum")} · ${t("shape")}`, 12, true); y += 8;
    y += pdf.image(compose([[d.canvases.poincare, d.canvases.psd, d.canvases.shape]]), M, y, W - 2 * M) + 12;
    pdf.wrap(M, y, t("shapeNote"), 8, W - 2 * M, grey);
    pdf.wrap(M, H - 46, t("footer"), 7.5, W - 2 * M, grey);
    return pdf.output();
  }

  global.PlethLabReport = { Pdf, buildReport, compose };
})(typeof window !== "undefined" ? window : globalThis);
