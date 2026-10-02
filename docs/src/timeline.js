// Timeline strip under the map: event-count histogram, CUSUM statistic vs threshold, and a playhead the user can
// drag, click, or scroll over. Also exports the helpers that make the mouse wheel / trackpad / keyboard scrub time.

/** Normalised wheel delta in pixels (handles line/page modes) combining both axes. */
export function wheelDelta(e) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  return Math.abs(dx) > Math.abs(dy) ? dx : dy;
}

/**
 * Scrub amount in slider units (0..1000) for one wheel event. ~100 px (one mouse notch) = 8 units (0.8 %);
 * Shift = 5x for coarse jumps, Alt = 0.2x for fine control.
 */
export function wheelToUnits(e) {
  const mult = e.shiftKey ? 5 : e.altKey ? 0.2 : 1;
  return wheelDelta(e) * 0.08 * mult;
}

export function createTimeline({ canvas, getFraction, setFraction }) {
  const ctx = canvas.getContext("2d");
  let state = null;
  let dragging = false;

  const fractionFromEvent = (e) => {
    const r = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; canvas.setPointerCapture(e.pointerId); setFraction(fractionFromEvent(e));
  });
  canvas.addEventListener("pointermove", (e) => { if (dragging) setFraction(fractionFromEvent(e)); });
  const end = (e) => { dragging = false; if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId); };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    setFraction(getFraction() + wheelToUnits(e) / 1000);
  }, { passive: false });

  function draw(next) {
    if (next) state = next;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state || !(state.maxMs > state.minMs)) return;

    const { minMs, maxMs, eventTimes, steps, baselineEndMs, endMs, windowMs } = state;
    const span = maxMs - minMs;
    const xOf = (ms) => ((ms - minMs) / span) * w;
    const split = h * 0.5; // stat curve above, histogram below

    // baseline (training) period
    ctx.fillStyle = "rgba(148,163,184,0.12)";
    ctx.fillRect(0, 0, Math.min(w, xOf(baselineEndMs)), h);

    // observation window
    ctx.fillStyle = "rgba(56,189,248,0.18)";
    ctx.fillRect(xOf(Math.max(minMs, endMs - windowMs)), 0, xOf(endMs) - xOf(Math.max(minMs, endMs - windowMs)), h);

    // event histogram
    const bins = Math.max(10, Math.floor(w / 3));
    const counts = new Float64Array(bins);
    for (const t of eventTimes) counts[Math.min(bins - 1, Math.floor(((t - minMs) / span) * bins))]++;
    const cmax = Math.max(1, ...counts);
    ctx.fillStyle = "rgba(100,116,139,0.85)";
    for (let b = 0; b < bins; b++) {
      const bh = (counts[b] / cmax) * (h - split - 4);
      ctx.fillRect((b / bins) * w, h - bh, Math.max(1, w / bins - 0.5), bh);
    }

    // CUSUM statistic / threshold, clipped at 2x the threshold
    if (steps && steps.tt.length) {
      const top = 4, band = split - 8, ratioY = (r) => top + band * (1 - Math.min(Math.max(r, 0), 2) / 2);
      ctx.strokeStyle = "rgba(248,250,252,0.35)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, ratioY(1)); ctx.lineTo(w, ratioY(1)); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath();
      steps.tt.forEach((t, i) => { const x = xOf(t), y = ratioY(steps.ratio[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "rgba(220,38,38,0.35)";
      steps.tt.forEach((t, i) => {
        if (steps.ratio[i] <= 1) return;
        const x0 = xOf(t), x1 = i + 1 < steps.tt.length ? xOf(steps.tt[i + 1]) : w;
        ctx.fillRect(x0, ratioY(steps.ratio[i]), Math.max(1, x1 - x0), ratioY(1) - ratioY(steps.ratio[i]));
      });
    }

    // playhead
    const px = xOf(endMs);
    ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    ctx.fillStyle = "#f8fafc"; ctx.beginPath(); ctx.arc(px, h / 2, 5, 0, 2 * Math.PI); ctx.fill();
  }

  return { draw };
}
