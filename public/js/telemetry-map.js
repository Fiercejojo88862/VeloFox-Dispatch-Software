/* Live dispatcher fleet map backed by Leaflet and /api/telemetry. */
(function telemetryMapModule(global) {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function create({ container, endpoint = '/api/telemetry', intervalMs = 12000, onSummary, onState } = {}) {
    const L = global.L;
    if (!container || !L) return { start() {}, stop() {}, refresh() {}, destroy() {} };

    const map = L.map(container, { zoomControl: true }).setView([40.7357, -74.1724], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const markers = new Map();
    let timer = 0;
    let fetching = false;
    let hasFitFleet = false;
    let cleared = false;
    let lastSummary = null;

    function markerIcon(driverId) {
      const suffix = String(driverId || '').split('-').pop().slice(-2) || 'VF';
      return L.divIcon({
        className: '',
        html: `<span class="fleet-marker">${escapeHtml(suffix)}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -15],
      });
    }

    function popup(driver, trip) {
      const location = driver.location || {};
      const speedMph = Number.isFinite(location.speed) ? Math.round(location.speed * 2.23694) : null;
      return [
        `<strong>${escapeHtml(driver.name || driver.driverId)}</strong>`,
        `<div>${escapeHtml(driver.driverId)}</div>`,
        trip ? `<div>${escapeHtml(trip.status)} · ${escapeHtml(trip.pickupLocation)} → ${escapeHtml(trip.dropoffLocation)}</div>` : '<div>No active trip</div>',
        speedMph == null ? '' : `<div>${speedMph} mph</div>`,
        location.recordedAt ? `<small>Updated ${escapeHtml(new Date(location.recordedAt).toLocaleTimeString())}</small>` : '',
      ].filter(Boolean).join('');
    }

    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await global.fetch(endpoint, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Telemetry unavailable (${response.status}).`);
        const data = await response.json();
        const drivers = Array.isArray(data.drivers) ? data.drivers : [];
        const activeTrips = Array.isArray(data.activeTrips) ? data.activeTrips : [];
        const tripsByDriver = new Map(activeTrips.map((trip) => [trip.driverId, trip]));
        const reporting = drivers.filter((driver) => driver.location);
        const activeIds = new Set();

        reporting.forEach((driver) => {
          if (cleared) return;
          const { latitude, longitude } = driver.location;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          activeIds.add(driver.driverId);
          let marker = markers.get(driver.driverId);
          if (!marker) {
            marker = L.marker([latitude, longitude], { icon: markerIcon(driver.driverId) }).addTo(map);
            markers.set(driver.driverId, marker);
          } else {
            marker.setLatLng([latitude, longitude]);
          }
          marker.bindPopup(popup(driver, tripsByDriver.get(driver.driverId)));
        });

        markers.forEach((marker, driverId) => {
          if (!activeIds.has(driverId)) {
            marker.remove();
            markers.delete(driverId);
          }
        });

        if (!hasFitFleet && markers.size > 0) {
          const bounds = L.featureGroup([...markers.values()]).getBounds();
          map.fitBounds(bounds.pad(0.3), { maxZoom: 14 });
          hasFitFleet = true;
        }

        lastSummary = {
          drivers: drivers.length,
          reporting: reporting.length,
          activeTrips: activeTrips.length,
          totalPings: Number(data.totalPings) || 0,
          updatedAt: data.generatedAt ? new Date(data.generatedAt) : new Date(),
        };
        onSummary?.({ ...lastSummary, cleared });
        onState?.({ error: null });
      } catch (error) {
        onState?.({ error: error.message });
      } finally {
        fetching = false;
      }
    }

    function clear() {
      cleared = true;
      markers.forEach((marker) => marker.remove());
      markers.clear();
      hasFitFleet = false;
      if (lastSummary) onSummary?.({ ...lastSummary, cleared: true });
    }

    function resume() {
      cleared = false;
      void refresh();
    }

    function start() {
      map.invalidateSize();
      void refresh();
      timer = global.setInterval(refresh, intervalMs);
    }

    function stop() {
      global.clearInterval(timer);
      timer = 0;
    }

    function destroy() {
      stop();
      map.remove();
    }

    return { start, stop, refresh, clear, resume, destroy };
  }

  global.VeloFoxTelemetryMap = { create };
}(window));
