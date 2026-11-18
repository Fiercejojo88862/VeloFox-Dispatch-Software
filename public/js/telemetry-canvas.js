/*!
 * VeloFox Telemetry Radar
 * A dependency-free 2D canvas command-center view of live chauffeur telemetry.
 *
 *   const radar = VeloFoxTelemetry.create({ canvas, onSummary, onState });
 *   radar.start();   // polls /api/telemetry and animates
 *   radar.refresh(); // manual ping
 *   radar.stop();
 *
 * Positions are plotted relative to the fleet centroid: the fleet GPS feed is
 * real, but pickup/drop-off addresses are free text, so route arcs are drawn
 * as relative bearings rather than geographic paths.
 */
(function (global) {
  'use strict';

  const GOLD = '197, 160, 89';
  const ACCENT = '#c5a059';
  const ACCENT_BRIGHT = '#d9bd83';
  const MUTED = '#9b968c';
  const ARC_COLORS = {
    assigned: '#b3a1d0',
    en_route: '#d4a15b',
    arrived: '#73b6b0',
    passenger_aboard: '#7fa6d9',
  };

  function hashAngle(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 3600) / 3600 * Math.PI * 2;
  }

  function create(options = {}) {
    const {
      canvas,
      endpoint = '/api/telemetry',
      intervalMs = 12000,
      onSummary,
      onState,
    } = options;

    if (!canvas || typeof canvas.getContext !== 'function') {
      return { start() {}, stop() {}, refresh() {}, destroy() {} };
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return { start() {}, stop() {}, refresh() {}, destroy() {} };

    const reducedMotion = typeof global.matchMedia === 'function'
      && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let drivers = [];
    let activeTrips = [];
    let totalPings = 0;
    let lastUpdated = null;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let running = false;
    let rafId = 0;
    let pollTimer = 0;
    let fetching = false;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reducedMotion) draw(0);
    }

    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await global.fetch(endpoint, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Telemetry unavailable (${response.status}).`);
        const data = await response.json();
        drivers = Array.isArray(data.drivers) ? data.drivers : [];
        activeTrips = Array.isArray(data.activeTrips) ? data.activeTrips : [];
        totalPings = Number(data.totalPings) || 0;
        lastUpdated = data.generatedAt ? new Date(data.generatedAt) : new Date();

        const reporting = drivers.filter((driver) => driver.location).length;
        if (typeof onSummary === 'function') {
          onSummary({
            drivers: drivers.length,
            reporting,
            activeTrips: activeTrips.length,
            totalPings,
            updatedAt: lastUpdated,
          });
        }
        if (typeof onState === 'function') onState({ error: null });

        if (reducedMotion) draw(0);
      } catch (error) {
        if (typeof onState === 'function') onState({ error: error.message });
      } finally {
        fetching = false;
      }
    }

    function projectDrivers(cx, cy, radius) {
      const positions = new Map();
      const fixes = drivers.filter((driver) => driver.location);

      if (fixes.length === 0) {
        drivers.forEach((driver) => {
          const angle = hashAngle(driver.driverId);
          positions.set(driver.driverId, {
            x: cx + Math.cos(angle) * radius * 0.74,
            y: cy + Math.sin(angle) * radius * 0.74,
            hasFix: false,
          });
        });
        return positions;
      }

      const centerLat = fixes.reduce((sum, driver) => sum + driver.location.latitude, 0) / fixes.length;
      const centerLng = fixes.reduce((sum, driver) => sum + driver.location.longitude, 0) / fixes.length;
      const cosLat = Math.cos((centerLat * Math.PI) / 180);

      let maxDistance = 0;
      fixes.forEach((driver) => {
        const dx = (driver.location.longitude - centerLng) * cosLat;
        const dy = driver.location.latitude - centerLat;
        maxDistance = Math.max(maxDistance, Math.hypot(dx, dy));
      });
      if (maxDistance < 1e-7) maxDistance = 1e-7;

      drivers.forEach((driver) => {
        if (!driver.location) {
          const angle = hashAngle(driver.driverId);
          positions.set(driver.driverId, {
            x: cx + Math.cos(angle) * radius * 0.88,
            y: cy + Math.sin(angle) * radius * 0.88,
            hasFix: false,
          });
          return;
        }

        const dx = (driver.location.longitude - centerLng) * cosLat;
        const dy = driver.location.latitude - centerLat;
        const spread = maxDistance > 0.00005 ? radius * 0.6 / maxDistance : 0;
        let x = cx + dx * spread;
        let y = cy - dy * spread;

        // A single stationary fix lands dead center; nudge it onto a visible ring.
        if (spread === 0) {
          const angle = hashAngle(driver.driverId);
          x = cx + Math.cos(angle) * radius * 0.35;
          y = cy + Math.sin(angle) * radius * 0.35;
        }

        positions.set(driver.driverId, { x, y, hasFix: true });
      });

      return positions;
    }

    function drawGrid(cx, cy, radius) {
      const background = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
      background.addColorStop(0, 'rgba(20, 19, 17, 0.95)');
      background.addColorStop(1, 'rgba(8, 8, 8, 0.98)');
      ctx.fillStyle = background;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(${GOLD}, 0.16)`;
      ctx.lineWidth = 1;
      [0.33, 0.66, 1].forEach((scale) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
        ctx.stroke();
      });

      ctx.strokeStyle = `rgba(${GOLD}, 0.09)`;
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy);
      ctx.lineTo(cx + radius, cy);
      ctx.moveTo(cx, cy - radius);
      ctx.lineTo(cx, cy + radius);
      ctx.stroke();

      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        const long = i % 3 === 0;
        const inner = radius * (long ? 0.9 : 0.95);
        ctx.strokeStyle = `rgba(${GOLD}, ${long ? 0.35 : 0.18})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
        ctx.stroke();
      }

      if (!reducedMotion) {
        const angle = ((global.performance ? global.performance.now() : Date.now()) / 6400) * Math.PI * 2;
        for (let i = 0; i < 22; i += 1) {
          const tail = angle - i * 0.028;
          ctx.strokeStyle = `rgba(${GOLD}, ${0.16 * (1 - i / 22)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(tail) * radius, cy + Math.sin(tail) * radius);
          ctx.stroke();
        }
        ctx.strokeStyle = `rgba(${GOLD}, 0.5)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
        ctx.stroke();
      }
    }

    function drawTripArcs(positions, cx, cy, radius, now) {
      activeTrips.forEach((trip) => {
        const origin = positions.get(trip.driverId);
        if (!origin) return;

        const bearing = hashAngle(`${trip.pickupLocation}::${trip.dropoffLocation}`);
        const targetX = cx + Math.cos(bearing) * radius * 0.94;
        const targetY = cy + Math.sin(bearing) * radius * 0.94;
        const midX = (origin.x + targetX) / 2 + Math.cos(bearing + Math.PI / 2) * radius * 0.16;
        const midY = (origin.y + targetY) / 2 + Math.sin(bearing + Math.PI / 2) * radius * 0.16;

        ctx.strokeStyle = ARC_COLORS[trip.status] || ACCENT;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 6]);
        ctx.lineDashOffset = reducedMotion ? 0 : -((now / 55) % 11);
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y);
        ctx.quadraticCurveTo(midX, midY, targetX, targetY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        ctx.fillStyle = ARC_COLORS[trip.status] || ACCENT;
        ctx.beginPath();
        ctx.arc(targetX, targetY, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    function drawDrivers(positions, now) {
      const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420);

      positions.forEach((position, driverId) => {
        const driver = drivers.find((entry) => entry.driverId === driverId);
        if (!driver) return;

        if (!position.hasFix) {
          ctx.strokeStyle = `rgba(${GOLD}, 0.35)`;
          ctx.setLineDash([2, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(position.x, position.y, 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.shadowColor = `rgba(${GOLD}, 0.9)`;
          ctx.shadowBlur = 12;
          ctx.fillStyle = ACCENT;
          ctx.beginPath();
          ctx.arc(position.x, position.y, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;

          ctx.strokeStyle = `rgba(${GOLD}, ${0.42 - pulse * 0.28})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(position.x, position.y, 7 + pulse * 8, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.fillStyle = position.hasFix ? ACCENT_BRIGHT : MUTED;
        ctx.textAlign = 'center';
        ctx.fillText(driver.driverId, position.x, position.y - 12);
      });
    }

    function drawStateLabels(cx, cy, radius) {
      ctx.textAlign = 'center';
      ctx.font = '600 9px "Helvetica Neue", Helvetica, Arial, sans-serif';

      const reporting = drivers.filter((driver) => driver.location).length;
      const statusText = reporting === 0
        ? 'AWAITING GPS TELEMETRY'
        : `${reporting} CHAUFFEUR${reporting === 1 ? '' : 'S'} REPORTING`;

      ctx.fillStyle = reporting === 0 ? MUTED : `rgba(${GOLD}, 0.85)`;
      ctx.fillText(statusText, cx, cy + radius - 26);

      ctx.fillStyle = '#6f6a61';
      ctx.fillText(
        activeTrips.length === 0 ? 'NO ACTIVE TRIPS IN MOTION' : `${activeTrips.length} ACTIVE TRIP${activeTrips.length === 1 ? '' : 'S'}`,
        cx,
        cy + radius - 12
      );
    }

    function draw(now) {
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.max(40, Math.min(width, height) / 2 - 22);

      drawGrid(cx, cy, radius);
      const positions = projectDrivers(cx, cy, radius);
      drawTripArcs(positions, cx, cy, radius, now);
      drawDrivers(positions, now);
      drawStateLabels(cx, cy, radius);
    }

    function frame(now) {
      if (!running) return;
      draw(now);
      rafId = global.requestAnimationFrame(frame);
    }

    function start() {
      if (running) return;
      running = true;
      resize();
      refresh();
      pollTimer = global.setInterval(() => {
        if (!global.document.hidden) refresh();
      }, intervalMs);
      if (!reducedMotion) rafId = global.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      global.cancelAnimationFrame(rafId);
      global.clearInterval(pollTimer);
      pollTimer = 0;
    }

    function destroy() {
      stop();
      if (typeof ResizeObserver === 'function') observer.disconnect();
    }

    let observer = null;
    if (typeof global.ResizeObserver === 'function') {
      observer = new global.ResizeObserver(() => resize());
      observer.observe(canvas);
    } else {
      global.addEventListener('resize', resize);
    }

    if (typeof global.document.addEventListener === 'function') {
      global.document.addEventListener('visibilitychange', () => {
        if (global.document.hidden) {
          running ? (global.cancelAnimationFrame(rafId), (running = false)) : null;
        } else if (pollTimer) {
          running = true;
          if (!reducedMotion) rafId = global.requestAnimationFrame(frame);
        }
      });
    }

    return { start, stop, refresh, destroy };
  }

  global.VeloFoxTelemetry = { create };
})(window);
