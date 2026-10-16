/* PlethLab core: in-browser engine for CMS50D+-compatible pulse oximeters.
 *
 * - Analyzer: JavaScript port of analysis.py (beats, HRV, respiration, pulse shape)
 * - Protocol helpers and a Device engine that talks to the oximeter over a transport
 * - Transports: Web Serial (Chrome/Edge desktop) and a protocol-level simulator
 *
 * The engine emits the same message format as server.py's /stream endpoint, so the
 * dashboard renders both modes with the same code.
 */
(function (global) {
  "use strict";

  // ======================================================================
  // numeric helpers
  // ======================================================================
  const FS = 60.0, REFRACTORY = 0.33, LOOK = Math.trunc(0.30 * FS), RESP_FS = 4.0, SETTLE_S = 3.0;
  const sum = a => { let s = 0; for (const v of a) s += v; return s; };
  const mean = a => sum(a) / a.length;
  const std = (a, ddof = 0) => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / (a.length - ddof)); };
  const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const ptp = a => Math.max(...a) - Math.min(...a);
  const round = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };

  function interp(x, xp, fp) {
    const out = new Float64Array(x.length);
    let j = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v <= xp[0]) { out[i] = fp[0]; continue; }
      if (v >= xp[xp.length - 1]) { out[i] = fp[fp.length - 1]; continue; }
      while (j < xp.length - 2 && xp[j + 1] < v) j++;
      while (j > 0 && xp[j] > v) j--;
      const t = (v - xp[j]) / (xp[j + 1] - xp[j]);
      out[i] = fp[j] + t * (fp[j + 1] - fp[j]);
    }
    return out;
  }
  function uniform(ts, vs, fs) {
    const start = ts[0], n = Math.max(0, Math.ceil((ts[ts.length - 1] - start) * fs));
    const grid = new Float64Array(n);
    for (let i = 0; i < n; i++) grid[i] = start + i / fs;
    return [grid, interp(grid, ts, vs)];
  }
  function detrend(t, y) {
    const n = y.length, t0 = t[0];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const x = t[i] - t0; sx += x; sy += y[i]; sxx += x * x; sxy += x * y[i]; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), a = (sy - b * sx) / n;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i] - (a + b * (t[i] - t0));
    return out;
  }
  const hanning = n => Float64Array.from({ length: n }, (_, i) => n === 1 ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));

  // radix-2 FFT of a real signal zero-padded to n (power of two); returns power |X_k|^2 for k = 0..n/2
  function rfftPower(y, n) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < Math.min(n, y.length); i++) re[i] = y[i];
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    const out = new Float64Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
    return out;
  }
  const rfftFreq = (n, fs) => Float64Array.from({ length: n / 2 + 1 }, (_, k) => k * fs / n);

  // FFT band-pass for short signals of arbitrary length (direct DFT, n <= a few hundred)
  function bandpass(y, fs, lo, hi) {
    const n = y.length, out = new Float64Array(n);
    for (let k = 0; k <= Math.floor(n / 2); k++) {
      const f = k * fs / n;
      if (f < lo || f > hi) continue;
      let re = 0, im = 0;
      for (let t = 0; t < n; t++) { const a = -2 * Math.PI * k * t / n; re += y[t] * Math.cos(a); im += y[t] * Math.sin(a); }
      const w = (k === 0 || (n % 2 === 0 && k === n / 2)) ? 1 : 2;
      for (let t = 0; t < n; t++) { const a = 2 * Math.PI * k * t / n; out[t] += w * (re * Math.cos(a) - im * Math.sin(a)) / n; }
    }
    return out;
  }

  // natural cubic spline through (0..n-1 offset by x0, y)
  function cubicSpline(x0, y) {
    const n = y.length, m = new Float64Array(n), c = new Float64Array(n), d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) { c[i] = 1 / (4 - (i > 1 ? c[i - 1] : 0)); }
    for (let i = 1; i < n - 1; i++) {
      const r = 6 * (y[i + 1] - 2 * y[i] + y[i - 1]);
      d[i] = (r - (i > 1 ? d[i - 1] : 0)) * c[i];
    }
    for (let i = n - 2; i >= 1; i--) m[i] = d[i] - c[i] * (i < n - 2 ? m[i + 1] : 0);
    return x => {
      let u = x - x0, i = Math.min(n - 2, Math.max(0, Math.floor(u)));
      const t = u - i, a = 1 - t;
      return a * y[i] + t * y[i + 1] + ((a ** 3 - a) * m[i] + (t ** 3 - t) * m[i + 1]) / 6;
    };
  }

  // Savitzky-Golay filter equivalent to scipy.signal.savgol_filter(mode="interp")
  const sgCache = new Map();
  function sgWeights(window, order, deriv) {
    const key = `${window}:${order}:${deriv}`;
    if (sgCache.has(key)) return sgCache.get(key);
    const rows = [];
    for (let j = 0; j < window; j++) {          // evaluation offset inside the window
      const p = order + 1, ata = Array.from({ length: p }, () => new Float64Array(p));
      const A = [];
      for (let k = 0; k < window; k++) { const r = []; for (let e = 0; e < p; e++) r.push((k - j) ** e); A.push(r); }
      for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) for (let k = 0; k < window; k++) ata[a][b] += A[k][a] * A[k][b];
      const inv = invert(ata);
      const fact = deriv === 0 ? 1 : deriv === 1 ? 1 : 2;
      rows.push(Float64Array.from({ length: window }, (_, k) => { let s = 0; for (let e = 0; e < p; e++) s += inv[deriv][e] * A[k][e]; return s * fact; }));
    }
    sgCache.set(key, rows);
    return rows;
  }
  function invert(M) {
    const n = M.length, a = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      const v = a[c][c]; for (let k = 0; k < 2 * n; k++) a[c][k] /= v;
      for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k]; }
    }
    return a.map(r => r.slice(n));
  }
  function savgol(x, window, order, deriv = 0, delta = 1) {
    const W = sgWeights(window, order, deriv), n = x.length, half = (window - 1) / 2, out = new Float64Array(n);
    const scale = deriv === 0 ? 1 : 1 / delta ** deriv;
    for (let i = 0; i < n; i++) {
      const s = Math.min(Math.max(i - half, 0), n - window), w = W[i - s];
      let v = 0; for (let k = 0; k < window; k++) v += w[k] * x[s + k];
      out[i] = v * scale;
    }
    return out;
  }

  // ======================================================================
  // Analyzer (port of analysis.py)
  // ======================================================================
  class Analyzer {
    constructor() {
      this.n = 0; this.t0Wall = null;
      this.raw = []; this.smooth = [];
      this.dPrev2 = this.dPrev = this.sPrev = null;
      this.dmax = 0; this.decay = 0.5 ** (1 / (3 * FS));
      this.lastBeatN = null; this.pending = [];
      this.beats = []; this.rr = []; this.newRR = []; this.prevBeatT = null;
      this.ampRef = []; this.respSeries = 0;
    }
    feed(v, wall) {
      if (this.t0Wall === null) this.t0Wall = wall - this.n / FS;
      if (v === null || v === undefined) { this.gap(); this.n++; return; }
      this.raw.push([this.n, v]); if (this.raw.length > FS * 40) this.raw.shift();
      this.smooth.push(v); if (this.smooth.length > 3) this.smooth.shift();
      const s = sum(this.smooth) / this.smooth.length;
      if (this.sPrev !== null) {
        const d = s - this.sPrev;
        this.dmax = Math.max(this.dmax * this.decay, d);
        if (this.dPrev !== null && this.dPrev2 !== null && this.dPrev > this.dPrev2 && this.dPrev >= d)
          this.candidate(this.n - 1, this.dPrev2, this.dPrev, d);
        this.dPrev2 = this.dPrev; this.dPrev = d;
      }
      this.sPrev = s;
      this.finishPending();
      this.n++;
    }
    gap() {
      this.raw = []; this.smooth = []; this.sPrev = this.dPrev = this.dPrev2 = null;
      this.pending = []; this.prevBeatT = null; this.lastBeatN = null;
    }
    candidate(k, dm, d0, dp) {
      if (d0 < Math.max(0.35 * this.dmax, 0.6)) return;
      if (this.lastBeatN !== null && (k - this.lastBeatN) < REFRACTORY * FS) return;
      const den = dm - 2 * d0 + dp, frac = den !== 0 ? 0.5 * (dm - dp) / den : 0;
      this.lastBeatN = k;
      this.pending.push(k + Math.max(-0.5, Math.min(0.5, frac)));
    }
    finishPending() {
      while (this.pending.length && this.n >= this.pending[0] + LOOK) {
        const kf = this.pending.shift(), k = Math.round(kf);
        const before = [], after = [];
        for (const [i, v] of this.raw) { if (i >= k - LOOK && i <= k) before.push(v); if (i >= k && i <= k + LOOK) after.push(v); }
        if (!before.length || !after.length) continue;
        const foot = Math.min(...before), peak = Math.max(...after), tDev = kf / FS, wall = this.t0Wall + tDev;
        this.beats.push([wall, tDev, peak - foot, foot, kf]); if (this.beats.length > 4000) this.beats.shift();
        this.ampRef.push(peak - foot); if (this.ampRef.length > 300) this.ampRef.shift();
        if (this.prevBeatT !== null) this.addRR(wall, (tDev - this.prevBeatT) * 1000);
        this.prevBeatT = tDev;
      }
    }
    addRR(wall, ms) {
      let ok = ms >= 300 && ms <= 2000;
      const recent = this.rr.slice(-9).filter(r => r[2]).map(r => r[1]);
      if (ok && recent.length >= 5) { const med = median(recent); ok = Math.abs(ms - med) / med < 0.30; }
      const item = [round(wall, 3), round(ms, 1), ok];
      this.rr.push(item); if (this.rr.length > 6000) this.rr.shift();
      this.newRR.push(item);
    }
    popNewRR() { const o = this.newRR; this.newRR = []; return o; }
    recentRR(now, seconds = 900) { return this.rr.filter(x => x[0] >= now - seconds); }

    metrics(now, window = 60) {
      const rr = this.rr.filter(x => x[0] >= now - window), beats = this.beats.filter(b => b[0] >= now - window);
      const out = { n_beats: beats.length, window, rmssd: null, sdnn: null, pnn50: null, hr: null, resp: null, resp_q: null, amp: null, amp_rel: null, irreg: null };
      if (rr.length) out.irreg = round(100 * rr.filter(x => !x[2]).length / rr.length, 1);
      const good = rr.filter(x => x[2]).map(x => x[1]);
      if (good.length >= 20) {
        const diffs = [];
        for (let i = 1; i < rr.length; i++) if (rr[i][2] && rr[i - 1][2]) diffs.push(rr[i][1] - rr[i - 1][1]);
        out.sdnn = round(std(good, 1), 1);
        out.hr = round(60000 / mean(good), 1);
        if (diffs.length >= 10) {
          out.rmssd = round(Math.sqrt(mean(diffs.map(d => d * d))), 1);
          out.pnn50 = round(100 * diffs.filter(d => Math.abs(d) > 50).length / diffs.length, 1);
        }
      }
      if (beats.length) {
        out.amp = round(median(beats.slice(-10).map(b => b[2])), 1);
        if (this.ampRef.length >= 30) out.amp_rel = Math.round(100 * out.amp / median(this.ampRef));
      }
      [out.resp, out.resp_q] = this.respiration(now, window);
      return out;
    }
    respInputs(now, window) {
      const rr = this.rr.filter(x => x[2] && x[0] >= now - window), beats = this.beats.filter(b => b[0] >= now - window);
      if (rr.length < 25 || beats.length < 25 || beats[beats.length - 1][0] - beats[0][0] < 30) return null;
      return [
        [rr.map(x => x[0]), rr.map(x => x[1])],
        [beats.map(b => b[0]), beats.map(b => b[2])],
        [beats.map(b => b[0]), beats.map(b => b[3])],
      ];
    }
    respiration(now, window) {
      const series = this.respInputs(now, window);
      if (!series) return [null, null];
      const est = [];
      series.forEach(([ts, vs], idx) => {
        if (ptp(vs) === 0) return;
        const [grid, y0] = uniform(ts, vs, RESP_FS);
        if (grid.length < 60) return;
        const win = hanning(grid.length), y = detrend(grid, y0).map((v, i) => v * win[i]);
        const spec = rfftPower(y, 2048), f = rfftFreq(2048, RESP_FS);
        let tot = 0, bi = -1;
        for (let k = 0; k < f.length; k++) if (f[k] >= 0.1 && f[k] <= 0.6) { tot += spec[k]; if (bi < 0 || spec[k] > spec[bi]) bi = k; }
        if (tot === 0) return;
        let near = 0;
        for (let k = 0; k < f.length; k++) if (f[k] >= 0.1 && f[k] <= 0.6 && Math.abs(f[k] - f[bi]) <= 0.03) near += spec[k];
        est.push([f[bi] * 60, near / tot, idx]);
      });
      if (!est.length) return [null, null];
      const best = est.reduce((a, b) => b[1] > a[1] ? b : a);
      this.respSeries = best[2];
      const agree = est.filter(e => e[1] >= 0.25 && Math.abs(e[0] - best[0]) <= 2);
      let val, q;
      if (agree.length >= 2) {
        val = sum(agree.map(e => e[0] * e[1])) / sum(agree.map(e => e[1]));
        q = Math.min(1, sum(agree.map(e => e[1])) / agree.length + 0.15 * (agree.length - 1));
      } else if (best[1] >= 0.4) { [val, q] = best; }
      else return [null, round(best[1], 2)];
      return [round(val, 1), round(q, 2)];
    }
    respWave(now, seconds = 30) {
      const series = this.respInputs(now, 60);
      if (!series) return [];
      const [ts, vs] = series[this.respSeries];
      if (ptp(vs) === 0) return [];
      const [grid, y0] = uniform(ts, vs, RESP_FS);
      let y = bandpass(detrend(grid, y0), RESP_FS, 0.1, 0.6);
      if (this.respSeries === 0) y = y.map(v => -v);
      const t0 = grid[grid.length - 1] - seconds, keep = [];
      for (let i = 0; i < grid.length; i++) if (grid[i] >= t0) keep.push(i);
      const mx = Math.max(...keep.map(i => Math.abs(y[i]))) || 1;
      return keep.map(i => [round(grid[i], 2), round(y[i] / mx, 3)]);
    }
    hrvLong(now, window = 300) {
      const rr = this.rr.filter(x => x[2] && x[0] >= now - window);
      const out = { window, sd1: null, sd2: null, lf: null, hf: null, lf_hf: null, lf_nu: null, hf_nu: null, spectrum: null, span: 0 };
      if (rr.length < 30) return out;
      const pairs = [];
      for (let i = 1; i < this.rr.length; i++) {
        const a = this.rr[i - 1], b = this.rr[i];
        if (b[0] >= now - window && a[2] && b[2]) pairs.push([a[1], b[1]]);
      }
      if (pairs.length >= 20) {
        out.sd1 = round(std(pairs.map(([x, y]) => (y - x) / Math.SQRT2), 1), 1);
        out.sd2 = round(std(pairs.map(([x, y]) => (y + x) / Math.SQRT2), 1), 1);
      }
      const span = rr[rr.length - 1][0] - rr[0][0];
      out.span = Math.round(span);
      if (span < 120 || rr.length < 100) return out;
      const [grid, y0] = uniform(rr.map(x => x[0]), rr.map(x => x[1]), RESP_FS);
      const y = detrend(grid, y0), win = hanning(y.length), nfft = 4096;
      const wsum = sum(Array.from(win, w => w * w));
      const pw = rfftPower(y.map((v, i) => v * win[i]), nfft), f = rfftFreq(nfft, RESP_FS), df = f[1] - f[0];
      const psd = pw.map(p => p / (RESP_FS * wsum) * 2);
      let lf = 0, hf = 0;
      for (let k = 0; k < f.length; k++) { if (f[k] >= 0.04 && f[k] < 0.15) lf += psd[k]; if (f[k] >= 0.15 && f[k] < 0.40) hf += psd[k]; }
      lf *= df; hf *= df;
      Object.assign(out, { lf: Math.round(lf), hf: Math.round(hf), lf_hf: hf > 0 ? round(lf / hf, 2) : null,
        lf_nu: lf + hf > 0 ? round(100 * lf / (lf + hf), 1) : null, hf_nu: lf + hf > 0 ? round(100 * hf / (lf + hf), 1) : null });
      const sel = []; for (let k = 0; k < f.length; k++) if (f[k] <= 0.5) sel.push(k);
      const step = Math.max(1, Math.floor(sel.length / 128));
      out.spectrum = sel.filter((_, i) => i % step === 0).map(k => [round(f[k], 4), round(psd[k], 1)]);
      return out;
    }
    pulseShape(now, window = 20) {
      const okW = new Set(this.rr.filter(x => x[2]).map(x => round(x[0], 3)));
      const beats = this.beats.filter(b => b[0] >= now - window && okW.has(round(b[0], 3)));
      if (beats.length < 8 || !this.raw.length) return null;
      const idx0 = this.raw[0][0];
      for (let i = 1; i < this.raw.length; i++) if (this.raw[i][0] !== this.raw[i - 1][0] + 1) return null;
      const spline = cubicSpline(idx0, this.raw.map(r => r[1])), idxEnd = this.raw[this.raw.length - 1][0];
      const hiFs = 200, rel = [];
      for (let i = 0; -0.30 + i / hiFs < 0.85 - 1e-9; i++) rel.push(-0.30 + i / hiFs);
      const stack = [];
      for (const b of beats) {
        const pos = rel.map(r => b[4] + r * FS);
        if (pos[0] < idx0 || pos[pos.length - 1] > idxEnd) continue;
        const seg = pos.map(spline), lo = Math.min(...seg), rng = Math.max(...seg) - lo;
        if (rng <= 0) continue;
        stack.push(seg.map(v => (v - lo) / rng));
      }
      if (stack.length < 8) return null;
      const avg0 = rel.map((_, i) => mean(stack.map(s => s[i])));
      const avg = savgol(avg0, 21, 3), d1 = savgol(avg, 21, 3, 1, 1 / hiFs), d2 = savgol(avg, 31, 3, 2, 1 / hiFs);
      const argmin = (a, s, e) => { let b = s; for (let i = s; i < e; i++) if (a[i] < a[b]) b = i; return b; };
      const argmax = (a, s, e) => { let b = s; for (let i = s; i < e; i++) if (a[i] > a[b]) b = i; return b; };
      const footI = argmin(avg, Math.trunc(0.1 * hiFs), Math.trunc(0.35 * hiFs));
      const peakI = argmax(avg, footI, Math.min(avg.length, footI + Math.trunc(0.45 * hiFs)));
      const d2max = Math.max(...d2.map(Math.abs)) || 1;
      const res = { n: stack.length, t: rel.filter((_, i) => i % 2 === 0).map(v => round(v, 3)),
        wave: avg.filter((_, i) => i % 2 === 0).map(v => round(v, 4)),
        d2: Array.from(d2).filter((_, i) => i % 2 === 0).map(v => round(v / d2max, 4)),
        rise_ms: Math.round(1000 * (peakI - footI) / hiFs), foot_t: round(rel[footI], 3), peak_t: round(rel[peakI], 3) };
      const aI = argmax(d2, Math.max(0, footI - 10), peakI + 1);
      const bEnd = Math.min(d2.length - 1, peakI + Math.trunc(0.12 * hiFs));
      const bI = argmin(d2, aI, bEnd + 1);
      const seq = [aI, bI], end = Math.min(d2.length - 2, peakI + Math.trunc(0.45 * hiFs));
      let i = bI;
      for (const kind of ["max", "min", "max"]) {
        let j = i + 1;
        while (j < end) {
          if (kind === "max" && d2[j] > d2[j - 1] && d2[j] >= d2[j + 1]) break;
          if (kind === "min" && d2[j] < d2[j - 1] && d2[j] <= d2[j + 1]) break;
          j++;
        }
        if (j >= end) break;
        seq.push(j); i = j;
      }
      const names = "abcde";
      res.sdppg = Object.fromEntries(seq.map((j, k) => [names[k], round(rel[j], 3)]));
      if (seq.length >= 2 && d2[seq[0]] > 0) {
        const a = d2[seq[0]];
        res.ratios = Object.fromEntries(seq.slice(1).map((j, k) => [`${names[k + 1]}/a`, round(d2[j] / a, 3)]));
        if (seq.length === 5) { const [b, c, d, e] = seq.slice(1).map(j => d2[j]); res.aging_index = round((b - c - d - e) / a, 3); }
      }
      const d1max = Math.max(...d1);
      for (let j = peakI + Math.trunc(0.08 * hiFs); j < Math.min(d1.length - 1, peakI + Math.trunc(0.45 * hiFs)); j++) {
        if (d1[j] > d1[j - 1] && d1[j] >= d1[j + 1] && d1[j] > -0.2 * d1max) {
          res.notch_t = round(rel[j], 3); res.notch_rel = round(avg[j], 3); res.peak_to_notch_ms = Math.round(1000 * (j - peakI) / hiFs);
          break;
        }
      }
      return res;
    }
  }

  // ======================================================================
  // protocol
  // ======================================================================
  const FORBIDDEN = new Set([0xAE, 0xB6, 0x81]);
  function frame(cmd, p1 = 0, p2 = 0) {
    if (FORBIDDEN.has(cmd)) throw new Error(`command ${cmd.toString(16)} is blocked`);
    return Uint8Array.of(0x7D, 0x81, cmd, 0x80 | (p1 & 0x7F), 0x80 | (p2 & 0x7F), 0x80, 0x80, 0x80, 0x80);
  }
  function framePayload(cmd, payload) {
    const body = [...payload, ...Array(6 - payload.length).fill(0)];
    return Uint8Array.of(0x7D, 0x81, cmd, ...body.map(b => 0x80 | (b & 0x7F)));
  }
  function decode(p) { const hi = p[1], out = []; for (let k = 2; k < p.length; k++) out.push((p[k] & 0x7F) | (((hi >> (k - 2)) & 1) << 7)); return out; }
  function encode(type, values) {
    let hi = 0x80; const body = values.map((v, k) => { if (v & 0x80) hi |= 1 << k; return 0x80 | (v & 0x7F); });
    return Uint8Array.of(type, hi, ...body);
  }

  // splits the byte stream into packets; flushes a trailing packet after a short idle time
  class Splitter {
    constructor(onPacket) { this.cur = []; this.onPacket = onPacket; this.timer = null; }
    push(bytes) {
      for (const b of bytes) {
        if (b < 0x80) { this.flush(); this.cur = [b]; }
        else if (this.cur.length) { this.cur.push(b); if (this.cur[0] === 0x01 && this.cur.length === 9) this.flush(); }
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 30);
    }
    flush() { if (this.cur.length >= 2) this.onPacket(Uint8Array.from(this.cur)); this.cur = []; }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const csvLine = a => a.map(v => v === null || v === undefined ? "" : v).join(",") + "\n";
  const iso = (t, ms) => { const d = new Date(t * 1000), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` + (ms ? "." + String(d.getMilliseconds()).padStart(3, "0") : ""); };

  // ======================================================================
  // Device engine: same message format as server.py /stream
  // ======================================================================
  class Device {
    constructor(transport, onMsg, label) {
      this.tr = transport; this.onMsg = onMsg;
      this.splitter = new Splitter(p => this.onPacket(p));
      this.tr.ondata = bytes => this.splitter.push(bytes);
      this.tr.onclose = () => this.handleClose();
      this.wave = []; this.beat = false; this.waiters = []; this.busy = false;
      this.status = { connected: false, finger: false, spo2: null, pr: null, signal: 0, bar: 0, pi: null, user: null, model: null, port: label, simulated: !!transport.simulated };
      this.fingerSince = null;
      this.reset();
      this.lastData = Date.now();
    }
    reset() {
      this.an = new Analyzer();
      this.trend = []; this.metrics = {}; this.long = {}; this.shape = null; this.rw = [];
      this.session = iso(Date.now() / 1000).replace(/[:]/g, "").replace("T", "_");
      this.csv = ["time,spo2,pulse,signal,finger,resp_rate,rmssd_ms,sdnn_ms,pnn50_pct,amplitude,irregular_pct,lf_ms2,hf_ms2,lf_hf\n"];
      this.rrCsv = ["time,rr_ms,valid\n"];
    }
    async start() {
      this.status.connected = true;
      await this.tr.write(frame(0xA2)); await sleep(300);
      for (const [cmd, key] of [[0xAA, "user"], [0xA8, "model"]]) {
        await this.tr.write(frame(cmd));
        const pk = await this.waitFor(new Set([0x04, 0x02]), 1000);
        if (pk) this.status[key] = Device.text(pk, cmd === 0xA8);
      }
      await this.tr.write(frame(0xA1));
      this.lastKeep = Date.now(); this.lastData = Date.now();
      this.tick = 0; this.nextTick = Date.now() + 1000;
      this.timer = setInterval(() => this.broadcast(), 50);
    }
    static text(packets, model) {
      let s = "";
      for (const p of packets) { let v = decode(p); if (model && p[0] === 0x02) v = v.slice(1); for (const c of v) if (c >= 0x20 && c < 0x7F) s += String.fromCharCode(c); }
      return s.trim() || null;
    }
    onPacket(p) {
      this.lastData = Date.now();
      if (p[0] === 0x01 && p.length === 9) {
        if (this.busy) return;
        this.live(decode(p));
        // keep-alive driven by incoming data: timers are throttled in background tabs
        if (this.lastData - this.lastKeep > 4000) { this.lastKeep = this.lastData; this.tr.write(frame(0xA1)).catch(() => {}); }
        return;
      }
      for (const w of this.waiters) if (w.types.has(p[0])) w.got.push(p);
      for (const w of this.waiters) if (w.all) w.all.push(p);
    }
    waitFor(types, timeout) {
      return new Promise(resolve => {
        const w = { types, got: [] };
        this.waiters.push(w);
        const end = Date.now() + timeout;
        let extended = false;
        const poll = setInterval(() => {
          if (w.got.length && !extended) { extended = true; w.end = Date.now() + 250; }
          if (Date.now() >= (w.end || end)) {
            clearInterval(poll); this.waiters = this.waiters.filter(x => x !== w);
            resolve(w.got.length ? w.got : null);
          }
        }, 20);
      });
    }
    live(v) {
      const finger = !(v[0] & 0x80), now = Date.now() / 1000;
      const spo2 = finger && v[4] > 0 && v[4] <= 100 ? v[4] : null, pr = finger && v[3] > 0 && v[3] < 255 ? v[3] : null;
      const piRaw = (v[6] << 8) | v[5], pi = finger && !(v[5] === 255 && v[6] === 255) && piRaw <= 2200 ? piRaw : null;
      // the device adjusts its gain for a few seconds after the finger goes in: skip that phase
      if (!finger) this.fingerSince = null; else if (this.fingerSince == null) this.fingerSince = now;
      const settled = finger && now - this.fingerSince >= SETTLE_S;
      this.an.feed(settled ? v[1] : null, now);
      this.wave.push(finger ? v[1] : null);
      this.beat = this.beat || !!(v[0] & 0x40);
      Object.assign(this.status, { finger, spo2, pr, signal: v[0] & 0x0F, bar: v[2] & 0x0F, pi });
    }
    broadcast() {
      const nowMs = Date.now(), now = nowMs / 1000;
      if (!this.busy) {
        if (nowMs - this.lastKeep > 4000) { this.tr.write(frame(0xA1)).catch(() => {}); this.lastKeep = nowMs; }
        if (nowMs - this.lastData > 6000 && this.status.connected) { this.status.connected = false; this.status.finger = false; this.status.spo2 = this.status.pr = null; }
        else if (nowMs - this.lastData < 1000) this.status.connected = true;
      }
      const msg = { w: this.wave, beat: this.beat, s: { ...this.status }, rr: this.an.popNewRR() };
      this.wave = []; this.beat = false;
      for (const [w, ms, ok] of msg.rr) this.rrCsv.push(csvLine([iso(w, true), ms, ok ? 1 : 0]));
      if (nowMs >= this.nextTick) {
        this.nextTick += 1000;
        this.metrics = this.an.metrics(now); this.rw = this.an.respWave(now);
        if (this.tick % 5 === 0) { this.long = this.an.hrvLong(now); this.shape = this.an.pulseShape(now); msg.hl = this.long; msg.ps = this.shape; }
        this.tick++;
        const st = msg.s, m = this.metrics, lg = this.long;
        msg.a = m; msg.rw = this.rw;
        const point = [round(now, 1), st.spo2, st.pr, m.resp, m.rmssd, m.amp_rel];
        this.trend.push(point); msg.t = point;
        if (st.connected) this.csv.push(csvLine([iso(now), st.spo2, st.pr, st.signal, st.finger ? 1 : 0, m.resp, m.rmssd, m.sdnn, m.pnn50, m.amp, m.irreg, lg.lf, lg.hf, lg.lf_hf]));
      }
      this.onMsg(msg);
    }
    async runOp(fn) {
      if (!this.status.connected) return { ok: false, error: "device not connected" };
      while (this.busy) await sleep(50);
      this.busy = true;
      try {
        await this.tr.write(frame(0xA2)); await sleep(300);
        return await fn();
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
      finally {
        await this.tr.write(frame(0xA1)).catch(() => {});
        this.an.gap(); this.lastKeep = Date.now(); this.lastData = Date.now(); this.busy = false;
      }
    }
    storage() {
      return this.runOp(async () => {
        await this.tr.write(frame(0xAD)); const st = await this.waitFor(new Set([0x10]), 1000);
        const storing = st ? !!decode(st[0])[0] : null;
        await this.tr.write(frame(0xAB, 0)); const name = await this.waitFor(new Set([0x05]), 1000);
        await this.tr.write(frame(0xA3, 0)); const info = await this.waitFor(new Set([0x0A]), 1000);
        const count = info ? decode(info[0])[1] : 0, segments = [];
        for (let seg = 0; seg < count; seg++) {
          await this.tr.write(frame(0xA4, 0, seg)); const ln = await this.waitFor(new Set([0x08]), 1000);
          await this.tr.write(frame(0xA5, 0, seg)); const stt = (await this.waitFor(new Set([0x07, 0x12]), 1000)) || [];
          let length = null;
          if (ln) { const v = decode(ln[0]); length = v[2] | (v[3] << 8) | (v[4] << 16) | (v[5] << 24); }
          const date = stt.find(p => p[0] === 0x07), tm = stt.find(p => p[0] === 0x12);
          let start = null;
          if (date && tm) {
            const d = decode(date), t = decode(tm), y = d[2] * 100 + d[3], p = n => String(n).padStart(2, "0");
            if (y > 2000) start = `${y}-${p(d[4])}-${p(d[5])}T${p(t[2])}:${p(t[3])}:${p(t[4])}`;
          }
          segments.push({ user: 0, segment: seg, length, samples: length ? Math.floor(length / 2) : null, start });
        }
        const user = name ? decode(name[0]).slice(1).filter(c => c >= 0x20 && c < 0x7F).map(c => String.fromCharCode(c)).join("").trim() : null;
        return { ok: true, storing, user, segments };
      });
    }
    download(user, seg) {
      return this.runOp(async () => {
        await this.tr.write(frame(0xA7)); await this.waitFor(new Set([0x0C]), 500);
        await this.tr.write(frame(0xA2)); await sleep(200);
        const coll = { types: new Set([0x0F, 0x0B]), got: [] };
        this.waiters.push(coll);
        await this.tr.write(frame(0xA6, user, seg));
        const t0 = Date.now(); let lastN = -1, lastChange = Date.now();
        while (Date.now() - lastChange < 2500 && Date.now() - t0 < 300000) {
          await sleep(100);
          if (coll.got.length !== lastN) { lastN = coll.got.length; lastChange = Date.now(); }
        }
        this.waiters = this.waiters.filter(x => x !== coll);
        if (coll.got.some(p => p[0] === 0x0B && decode(p)[0] === 0xA6 && decode(p)[1] === 3))
          return { ok: false, error: "storing", message: "The device is still recording." };
        const samples = [];
        for (const p of coll.got) if (p[0] === 0x0F) {
          const v = decode(p);
          for (let k = 0; k < 6; k += 2) samples.push([v[k] > 0 && v[k] <= 100 ? v[k] : null, v[k + 1] > 0 && v[k + 1] < 255 ? v[k + 1] : null]);
        }
        if (!samples.length) return { ok: false, error: "no data", message: "The device did not send any stored data." };
        const csv = "second,spo2,pulse\n" + samples.map((s, i) => csvLine([i, s[0], s[1]])).join("");
        return { ok: true, samples, file: `device_u${user}_s${seg}_${this.session}.csv`, csv };
      });
    }
    setClock() {
      return this.runOp(async () => {
        const d = new Date(), acks = [];
        await this.tr.write(framePayload(0xB2, [Math.floor(d.getFullYear() / 100), d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getDay()]));
        acks.push(...((await this.waitFor(new Set([0x0B]), 1000)) || []));
        await this.tr.write(framePayload(0xB1, [d.getHours(), d.getMinutes(), d.getSeconds()]));
        acks.push(...((await this.waitFor(new Set([0x0B]), 1000)) || []));
        const codes = acks.map(p => decode(p).slice(0, 2));
        return { ok: codes.length > 0 && codes.every(c => c[1] === 5), set_to: iso(d.getTime() / 1000), acks: codes.map(c => `${c[0].toString(16).toUpperCase()}:${c[1]}`) };
      });
    }
    handleClose() { this.status.connected = false; this.status.finger = false; this.status.spo2 = this.status.pr = null; }
    async stop() { clearInterval(this.timer); try { await this.tr.write(frame(0xA2)); } catch (e) {} await this.tr.close(); this.handleClose(); }
  }

  // ======================================================================
  // transports
  // ======================================================================
  class WebSerialTransport {
    constructor(port) { this.port = port; this.ondata = () => {}; this.onclose = () => {}; }
    async open() {
      await this.port.open({ baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, bufferSize: 65536 });
      this.writer = this.port.writable.getWriter();
      this.closed = false;
      this.loop();
    }
    async loop() {
      while (!this.closed && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try { for (;;) { const { value, done } = await this.reader.read(); if (done) break; if (value) this.ondata(value); } }
        catch (e) { /* device unplugged or read error */ }
        finally { this.reader.releaseLock(); }
        if (!this.closed) break;
      }
      this.onclose();
    }
    write(bytes) { return this.writer.write(bytes); }
    async close() {
      this.closed = true;
      try { await this.reader?.cancel(); } catch (e) {}
      try { this.writer.releaseLock(); } catch (e) {}
      try { await this.port.close(); } catch (e) {}
    }
  }

  // protocol-level simulator (port of simulator.py)
  class SimTransport {
    constructor(seed = 1) {
      this.simulated = true; this.ondata = () => {}; this.onclose = () => {};
      let s = seed >>> 0;
      this.rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      this.gauss = (sd) => sd * Math.sqrt(-2 * Math.log(1 - this.rand())) * Math.cos(2 * Math.PI * this.rand());
      this.live = false; this.t = 0; this.last = performance.now(); this.beatStart = 0; this.rr = 0.9;
      this.rrHist = Array(8).fill(0.9); this.flag = false; this.storing = false; this.clock = null;
      this.stored = Array.from({ length: 3600 }, (_, i) => [96 + Math.round(2 * Math.sin(i / 300)) - (i > 1800 && i < 1900 ? 4 : 0), 64 + Math.round(6 * Math.sin(i / 200))]);
    }
    async open() { this.timer = setInterval(() => this.advance(), 20); }
    async close() { clearInterval(this.timer); }
    emit(bytes) { setTimeout(() => this.ondata(bytes), 5); }
    async write(d) {
      if (d.length < 5 || d[0] !== 0x7D) return;
      const cmd = d[2], p1 = d[3] & 0x7F, p2 = d[4] & 0x7F, chr = s => [...s].map(c => c.charCodeAt(0));
      let r = null;
      switch (cmd) {
        case 0xA1: this.live = true; this.last = performance.now(); break;
        case 0xA2: this.live = false; break;
        case 0xA7: r = encode(0x0C, [0]); break;
        case 0xA8: r = Uint8Array.of(...encode(0x02, [0, ...chr("SIM-50")]), ...encode(0x02, [0xFF, ...chr("+     ")])); break;
        case 0xA9: r = encode(0x03, chr("Sim    ")); break;
        case 0xAA: r = encode(0x04, chr("demo   ")); break;
        case 0xAB: r = encode(0x05, [p1, ...chr("demo  ")]); break;
        case 0xA3: r = encode(0x0A, [p1, 1]); break;
        case 0xA4: { const n = this.stored.length * 2; r = encode(0x08, [p1, p2, n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, 0]); break; }
        case 0xA5: { const c = this.clock || [2026, 1, 1, 22, 0, 0]; r = Uint8Array.of(...encode(0x07, [p1, p2, Math.floor(c[0] / 100), c[0] % 100, c[1], c[2]]), ...encode(0x12, [p1, p2, c[3], c[4], c[5], 0])); break; }
        case 0xAD: r = encode(0x10, [this.storing ? 1 : 0]); break;
        case 0xA6:
          if (this.storing) r = encode(0x0B, [0xA6, 3]);
          else { const parts = []; for (let i = 0; i + 2 < this.stored.length; i += 3) parts.push(...encode(0x0F, [...this.stored[i], ...this.stored[i + 1], ...this.stored[i + 2], 0])); r = Uint8Array.from(parts); }
          break;
        case 0xB1: case 0xB2: { const n = new Date(); this.clock = [n.getFullYear(), n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds()]; r = encode(0x0B, [cmd, 5]); break; }
        case 0xB8: r = encode(0x0B, [0xB8, 5]); break;
        case 0xB0: r = encode(0x11, [1, 1, 0, 0, 0, 0, 0]); break;
      }
      if (r) this.emit(r);
    }
    advance() {
      const now = performance.now();
      if (!this.live) { this.last = now; return; }
      const n = Math.floor((now - this.last) / 1000 * FS);
      if (n <= 0) return;
      this.last += n * 1000 / FS;
      const out = [];
      for (let i = 0; i < Math.min(n, 600); i++) out.push(...this.sample());
      this.ondata(Uint8Array.from(out));
    }
    sample() {
      const dt = 1 / FS; this.t += dt;
      let ph = this.t - this.beatStart;
      if (ph >= this.rr) {
        this.beatStart += this.rr; ph = this.t - this.beatStart;
        const resp = Math.sin(2 * Math.PI * 0.25 * this.beatStart);
        this.rr = 0.9 - 0.06 * resp + this.gauss(0.012);
        this.rrHist = [...this.rrHist.slice(1), this.rr]; this.flag = true;
      }
      const resp = Math.sin(2 * Math.PI * 0.25 * this.t), x = ph / this.rr;
      const shape = Math.exp(-(((x - 0.20) / 0.075) ** 2)) + 0.38 * Math.exp(-(((x - 0.48) / 0.10) ** 2));
      const wave = Math.max(0, Math.min(127, Math.round(30 + 6 * resp + 48 * (1 + 0.08 * resp) * shape + this.gauss(0.4))));
      let beat = 0; if (this.flag && x > 0.08) { beat = 0x40; this.flag = false; }
      const pr = Math.round(60 / mean(this.rrHist)), spo2 = 97 + Math.round(Math.sin(this.t / 40));
      return encode(0x01, [0x06 | beat, wave, 0x05, pr, spo2, 0xFF, 0xFF]);
    }
  }

  global.PlethLab = { Analyzer, Device, WebSerialTransport, SimTransport, frame, decode, encode, savgol, cubicSpline, FS };
})(typeof window !== "undefined" ? window : globalThis);
