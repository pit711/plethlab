"""Signal analysis for the ~60 Hz plethysmogram of CMS50D+-compatible pulse oximeters.

Provides beat detection with sub-sample timing, time- and frequency-domain HRV,
Poincaré descriptors, a respiration rate estimate plus a derived respiration
waveform, and an ensemble-averaged pulse shape with second-derivative (SDPPG)
indices.

Caveats: the device delivers an already filtered, 7-bit waveform. Motion
artefacts and genuine arrhythmias look alike here. Nothing in this module is a
medical diagnosis.
"""
from collections import deque

import numpy as np
from scipy.interpolate import CubicSpline
from scipy.signal import savgol_filter

FS = 60.0                    # device sample rate (measured: 59.7 Hz)
REFRACTORY = 0.33            # s, ~180 bpm upper limit
LOOK = int(0.30 * FS)        # window for foot/peak around the upstroke
RESP_FS = 4.0                # resampling rate for beat-derived series


def _uniform(ts, vs, fs, t_start=None, t_end=None):
    ts, vs = np.asarray(ts, float), np.asarray(vs, float)
    grid = np.arange(ts[0] if t_start is None else t_start, ts[-1] if t_end is None else t_end, 1 / fs)
    return grid, np.interp(grid, ts, vs)


def _detrend(t, y):
    return y - np.polyval(np.polyfit(t - t[0], y, 1), t - t[0])


def _bandpass(y, fs, lo, hi):
    spec = np.fft.rfft(y)
    f = np.fft.rfftfreq(len(y), 1 / fs)
    spec[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, len(y))


class PulseAnalyzer:
    def __init__(self):
        self.n = 0                       # sample counter (device time base)
        self.t0_wall = None
        self.raw = deque(maxlen=int(FS * 40))
        self.smooth = deque(maxlen=3)
        self.d_prev2 = self.d_prev = None
        self.s_prev = None
        self.dmax = 0.0
        self.decay = 0.5 ** (1 / (3 * FS))
        self.last_beat_n = None
        self.pending = []
        self.beats = deque(maxlen=4000)  # (wall, t_dev, amp, foot, k)
        self.rr = deque(maxlen=6000)     # (wall, ms, ok)
        self.new_rr = []
        self.prev_beat_t = None
        self.amp_ref = deque(maxlen=300)
        self.resp_series = 0             # which modulation gave the best respiration estimate

    # ---------- input ----------
    def feed(self, v, wall):
        if self.t0_wall is None:
            self.t0_wall = wall - self.n / FS
        if v is None:
            self._gap()
            self.n += 1
            return
        self.raw.append((self.n, v))
        self.smooth.append(v)
        s = sum(self.smooth) / len(self.smooth)
        if self.s_prev is not None:
            d = s - self.s_prev
            self.dmax = max(self.dmax * self.decay, d)
            if self.d_prev is not None and self.d_prev2 is not None:
                if self.d_prev > self.d_prev2 and self.d_prev >= d:
                    self._candidate(self.n - 1, self.d_prev2, self.d_prev, d)
            self.d_prev2, self.d_prev = self.d_prev, d
        self.s_prev = s
        self._finish_pending()
        self.n += 1

    def _gap(self):
        self.raw.clear()
        self.smooth.clear()
        self.s_prev = self.d_prev = self.d_prev2 = None
        self.pending.clear()
        self.prev_beat_t = None
        self.last_beat_n = None

    def _candidate(self, k, dm, d0, dp):
        if d0 < max(0.35 * self.dmax, 0.6):
            return
        if self.last_beat_n is not None and (k - self.last_beat_n) < REFRACTORY * FS:
            return
        denom = dm - 2 * d0 + dp
        frac = 0.5 * (dm - dp) / denom if denom != 0 else 0.0
        self.last_beat_n = k
        self.pending.append(k + max(-0.5, min(0.5, frac)))

    def _finish_pending(self):
        while self.pending and self.n >= self.pending[0] + LOOK:
            kf = self.pending.pop(0)
            k = int(round(kf))
            before = [v for (i, v) in self.raw if k - LOOK <= i <= k]
            after = [v for (i, v) in self.raw if k <= i <= k + LOOK]
            if not before or not after:
                continue
            foot, peak = min(before), max(after)
            t_dev = kf / FS
            wall = self.t0_wall + t_dev
            self.beats.append((wall, t_dev, peak - foot, foot, kf))
            self.amp_ref.append(peak - foot)
            if self.prev_beat_t is not None:
                self._add_rr(wall, (t_dev - self.prev_beat_t) * 1000.0)
            self.prev_beat_t = t_dev

    def _add_rr(self, wall, ms):
        ok = 300 <= ms <= 2000
        recent = [r for (_, r, o) in list(self.rr)[-9:] if o]
        if ok and len(recent) >= 5:
            med = float(np.median(recent))
            ok = abs(ms - med) / med < 0.30
        item = (round(wall, 3), round(ms, 1), ok)
        self.rr.append(item)
        self.new_rr.append(item)

    def pop_new_rr(self):
        out, self.new_rr = self.new_rr, []
        return out

    def recent_rr(self, now, seconds=900):
        return [list(x) for x in self.rr if x[0] >= now - seconds]

    # ---------- time domain, respiration, perfusion ----------
    def metrics(self, now, window=60.0):
        rr = [x for x in self.rr if x[0] >= now - window]
        beats = [b for b in self.beats if b[0] >= now - window]
        out = {"n_beats": len(beats), "window": window, "rmssd": None, "sdnn": None, "pnn50": None,
               "hr": None, "resp": None, "resp_q": None, "amp": None, "amp_rel": None, "irreg": None}
        if rr:
            out["irreg"] = round(100.0 * sum(1 for x in rr if not x[2]) / len(rr), 1)
        good = [ms for (_, ms, ok) in rr if ok]
        if len(good) >= 20:
            diffs = [rr[i][1] - rr[i - 1][1] for i in range(1, len(rr)) if rr[i][2] and rr[i - 1][2]]
            out["sdnn"] = round(float(np.std(good, ddof=1)), 1)
            out["hr"] = round(60000.0 / float(np.mean(good)), 1)
            if len(diffs) >= 10:
                dd = np.asarray(diffs)
                out["rmssd"] = round(float(np.sqrt(np.mean(dd ** 2))), 1)
                out["pnn50"] = round(100.0 * float(np.mean(np.abs(dd) > 50)), 1)
        if beats:
            out["amp"] = round(float(np.median([b[2] for b in beats[-10:]])), 1)
            if len(self.amp_ref) >= 30:
                out["amp_rel"] = round(100.0 * out["amp"] / float(np.median(self.amp_ref)))
        out["resp"], out["resp_q"] = self._respiration(now, window)
        return out

    def _resp_inputs(self, now, window):
        rr = [(w, ms) for (w, ms, ok) in self.rr if ok and w >= now - window]
        beats = [b for b in self.beats if b[0] >= now - window]
        if len(rr) < 25 or len(beats) < 25 or beats[-1][0] - beats[0][0] < 30:
            return None
        return [
            ([w for w, _ in rr], [ms for _, ms in rr]),         # rate modulation (RIFV)
            ([b[0] for b in beats], [b[2] for b in beats]),     # amplitude modulation (RIAV)
            ([b[0] for b in beats], [b[3] for b in beats]),     # baseline modulation (RIIV)
        ]

    def _respiration(self, now, window):
        series = self._resp_inputs(now, window)
        if series is None:
            return None, None
        estimates = []
        for idx, (ts, vs) in enumerate(series):
            if np.ptp(vs) == 0:
                continue
            grid, y = _uniform(ts, vs, RESP_FS)
            if len(grid) < 60:
                continue
            y = _detrend(grid, y) * np.hanning(len(grid))
            spec = np.abs(np.fft.rfft(y, 2048)) ** 2
            f = np.fft.rfftfreq(2048, 1 / RESP_FS)
            band = (f >= 0.1) & (f <= 0.6)           # 6-36 breaths/min
            if spec[band].sum() == 0:
                continue
            i = int(np.argmax(np.where(band, spec, 0)))
            q = float(spec[band & (np.abs(f - f[i]) <= 0.03)].sum() / spec[band].sum())
            estimates.append((float(f[i] * 60.0), q, idx))
        if not estimates:
            return None, None
        best = max(estimates, key=lambda e: e[1])
        self.resp_series = best[2]
        agree = [e for e in estimates if e[1] >= 0.25 and abs(e[0] - best[0]) <= 2.0]
        if len(agree) >= 2:
            val = sum(e[0] * e[1] for e in agree) / sum(e[1] for e in agree)
            q = min(1.0, sum(e[1] for e in agree) / len(agree) + 0.15 * (len(agree) - 1))
        elif best[1] >= 0.4:
            val, q = best[0], best[1]
        else:
            return None, round(best[1], 2)
        return round(val, 1), round(q, 2)

    def resp_wave(self, now, seconds=30.0):
        """Derived respiration waveform (band-passed beat modulation), normalised to -1..1."""
        series = self._resp_inputs(now, 60.0)
        if series is None:
            return []
        ts, vs = series[self.resp_series]
        if np.ptp(vs) == 0:
            return []
        grid, y = _uniform(ts, vs, RESP_FS)
        y = _bandpass(_detrend(grid, y), RESP_FS, 0.1, 0.6)
        if self.resp_series == 0:
            y = -y                                  # shorter intervals during inspiration
        keep = grid >= grid[-1] - seconds
        y = y[keep] / (np.max(np.abs(y[keep])) or 1)
        return [[round(float(t), 2), round(float(v), 3)] for t, v in zip(grid[keep], y)]

    # ---------- frequency domain & Poincaré ----------
    def hrv_long(self, now, window=300.0):
        rr = [(w, ms) for (w, ms, ok) in self.rr if ok and w >= now - window]
        out = {"window": window, "sd1": None, "sd2": None, "lf": None, "hf": None, "lf_hf": None,
               "lf_nu": None, "hf_nu": None, "spectrum": None, "span": 0}
        if len(rr) < 30:
            return out
        all_rr = list(self.rr)
        pairs = [(all_rr[i - 1][1], all_rr[i][1]) for i in range(1, len(all_rr))
                 if all_rr[i][0] >= now - window and all_rr[i][2] and all_rr[i - 1][2]]
        if len(pairs) >= 20:
            x, y = np.asarray(pairs).T
            out["sd1"] = round(float(np.std((y - x) / np.sqrt(2), ddof=1)), 1)
            out["sd2"] = round(float(np.std((y + x) / np.sqrt(2), ddof=1)), 1)
        span = rr[-1][0] - rr[0][0]
        out["span"] = round(span)
        if span < 120 or len(rr) < 100:
            return out
        grid, y = _uniform([w for w, _ in rr], [ms for _, ms in rr], RESP_FS)
        y = _detrend(grid, y)
        win = np.hanning(len(y))
        nfft = 4096
        psd = (np.abs(np.fft.rfft(y * win, nfft)) ** 2) / (RESP_FS * (win ** 2).sum()) * 2
        f = np.fft.rfftfreq(nfft, 1 / RESP_FS)
        df = f[1] - f[0]
        lf = float(psd[(f >= 0.04) & (f < 0.15)].sum() * df)
        hf = float(psd[(f >= 0.15) & (f < 0.40)].sum() * df)
        out.update(lf=round(lf), hf=round(hf), lf_hf=round(lf / hf, 2) if hf > 0 else None,
                   lf_nu=round(100 * lf / (lf + hf), 1) if lf + hf > 0 else None,
                   hf_nu=round(100 * hf / (lf + hf), 1) if lf + hf > 0 else None)
        sel = f <= 0.5
        step = max(1, int(sel.sum() / 128))
        out["spectrum"] = [[round(float(a), 4), round(float(b), 1)] for a, b in zip(f[sel][::step], psd[sel][::step])]
        return out

    # ---------- ensemble-averaged pulse shape ----------
    def pulse_shape(self, now, window=20.0):
        rr_ok = {round(w, 3) for (w, _, ok) in self.rr if ok}
        beats = [b for b in self.beats if b[0] >= now - window and round(b[0], 3) in rr_ok]
        if len(beats) < 8 or not self.raw:
            return None
        idx = np.array([i for i, _ in self.raw], float)
        val = np.array([v for _, v in self.raw], float)
        if np.any(np.diff(idx) != 1):
            return None
        spline = CubicSpline(idx, val)
        hi_fs = 200.0
        rel = np.arange(-0.30, 0.85, 1 / hi_fs)      # seconds around the upstroke
        stack = []
        for b in beats:
            pos = b[4] + rel * FS
            if pos[0] < idx[0] or pos[-1] > idx[-1]:
                continue
            seg = spline(pos)
            rng = np.ptp(seg)
            if rng <= 0:
                continue
            stack.append((seg - seg.min()) / rng)
        if len(stack) < 8:
            return None
        avg = savgol_filter(np.mean(stack, axis=0), 21, 3)
        d1 = savgol_filter(avg, 21, 3, deriv=1, delta=1 / hi_fs)
        d2 = savgol_filter(avg, 31, 3, deriv=2, delta=1 / hi_fs)
        foot_i = int(np.argmin(avg[int(0.1 * hi_fs): int(0.35 * hi_fs)])) + int(0.1 * hi_fs)
        peak_i = foot_i + int(np.argmax(avg[foot_i: foot_i + int(0.45 * hi_fs)]))
        res = {"n": len(stack), "t": [round(float(x), 3) for x in rel[::2]],
               "wave": [round(float(x), 4) for x in avg[::2]],
               "d2": [round(float(x), 4) for x in (d2 / (np.max(np.abs(d2)) or 1))[::2]],
               "rise_ms": round(1000 * (peak_i - foot_i) / hi_fs),
               "foot_t": round(float(rel[foot_i]), 3), "peak_t": round(float(rel[peak_i]), 3)}
        # SDPPG waves: a = max of d2 during the upstroke, b = following min,
        # then c (max), d (min), e (max) as successive local extrema
        a_i = max(0, foot_i - 10) + int(np.argmax(d2[max(0, foot_i - 10): peak_i + 1]))
        b_end = min(len(d2) - 1, peak_i + int(0.12 * hi_fs))
        b_i = a_i + int(np.argmin(d2[a_i: b_end + 1]))
        seq = [a_i, b_i]
        end = min(len(d2) - 2, peak_i + int(0.45 * hi_fs))
        i = b_i
        for kind in ("max", "min", "max"):
            j = i + 1
            while j < end:
                if kind == "max" and d2[j] > d2[j - 1] and d2[j] >= d2[j + 1]:
                    break
                if kind == "min" and d2[j] < d2[j - 1] and d2[j] <= d2[j + 1]:
                    break
                j += 1
            if j >= end:
                break
            seq.append(j)
            i = j
        names = "abcde"
        res["sdppg"] = {names[k]: round(float(rel[j]), 3) for k, j in enumerate(seq)}
        if len(seq) >= 2 and d2[seq[0]] > 0:
            a = d2[seq[0]]
            ratios = {f"{names[k]}/a": round(float(d2[j] / a), 3) for k, j in enumerate(seq[1:], start=1)}
            res["ratios"] = ratios
            if len(seq) == 5:
                b, c, d, e = (d2[j] for j in seq[1:])
                res["aging_index"] = round(float((b - c - d - e) / a), 3)
        # dicrotic notch: first local minimum of the first derivative's rise after the peak
        notch = None
        for j in range(peak_i + int(0.08 * hi_fs), min(len(d1) - 1, peak_i + int(0.45 * hi_fs))):
            if d1[j] > d1[j - 1] and d1[j] >= d1[j + 1] and d1[j] > -0.2 * np.max(d1):
                notch = j
                break
        if notch is not None:
            res["notch_t"] = round(float(rel[notch]), 3)
            res["notch_rel"] = round(float(avg[notch]), 3)
            res["peak_to_notch_ms"] = round(1000 * (notch - peak_i) / hi_fs)
        return res
