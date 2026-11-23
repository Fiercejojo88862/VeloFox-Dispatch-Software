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

  // Known hubs so the common airport runs never need a geocoding round-trip.
  const KNOWN_PLACES = [
    { match: /(newark|ewr|liberty international)/i, lat: 40.6895, lng: -74.1745 },
    { match: /(jfk|kennedy international)/i, lat: 40.6413, lng: -73.7781 },
    { match: /(lga|laguardia)/i, lat: 40.7769, lng: -73.8740 },
    { match: /(teterboro|teb)/i, lat: 40.8501, lng: -74.0608 },
    { match: /(westchester|hpn)/i, lat: 41.0675, lng: -73.7086 },
    { match: /(philadelphia international|phl)/i, lat: 39.8744, lng: -75.2424 },
    { match: /(manhattan|midtown|hudson yards|the plaza|noMad|SoHo|wall street)/i, lat: 40.7549, lng: -73.9840 },
    { match: /(brooklyn|brooklyn heights)/i, lat: 40.6959, lng: -73.9935 },
    { match: /(hoboken)/i, lat: 40.7437, lng: -74.0324 },
    { match: /(jersey city)/i, lat: 40.7178, lng: -74.0431 },
    { match: /(greenwich, ct|greenwich ct)/i, lat: 41.0337, lng: -73.6193 },
    { match: /(princeton)/i, lat: 40.3573, lng: -74.6672 },
    { match: /(madison, nj)/i, lat: 40.7626, lng: -74.4090 },
    { match: /(scarsdale)/i, lat: 40.9895, lng: -73.7779 },
    { match: /(metlife stadium)/i, lat: 40.8135, lng: -74.0745 },
  ];

  const geocodeCache = new Map();
  let geocodeChain = Promise.resolve();

  function knownPlace(address) {
    const text = String(address || '');
    return KNOWN_PLACES.find((entry) => entry.match.test(text)) || null;
  }

  function geocode(address) {
    const key = String(address || '').trim().toLowerCase();
    if (!key) return Promise.resolve(null);
    if (geocodeCache.has(key)) return Promise.resolve(geocodeCache.get(key));
    const known = knownPlace(address);
    if (known) {
      const point = [known.lat, known.lng];
      geocodeCache.set(key, point);
      return Promise.resolve(point);
    }
    // Nominatim asks for at most one request per second; serialise lookups.
    geocodeChain = geocodeChain.then(async () => {
      if (geocodeCache.has(key)) return geocodeCache.get(key);
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
        const response = await global.fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) return null;
        const rows = await response.json();
        const hit = Array.isArray(rows) && rows[0];
        const point = hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))
          ? [Number(hit.lat), Number(hit.lon)]
          : null;
        geocodeCache.set(key, point);
        return point;
      } catch {
        geocodeCache.set(key, null);
        return null;
      }
    });
    return geocodeChain;
  }

  function trafficColor(speedMetersPerSecond) {
    if (!Number.isFinite(speedMetersPerSecond)) return '#c5a059';
    const mph = speedMetersPerSecond * 2.23694;
    if (mph < 10) return '#d4674f';      // stopped / heavy congestion
    if (mph < 28) return '#d9a741';      // slow
    return '#6ea96f';                    // free flowing
  }

  function create({ container, endpoint = '/api/telemetry', intervalMs = 12000, onSummary, onState } = {}) {
    const L = global.L;
    if (!container || !L) {
      return { start() {}, stop() {}, refresh() {}, clear() {}, resume() {}, setTrafficMode() {}, destroy() {} };
    }

    const map = L.map(container, { zoomControl: true }).setView([40.7357, -74.1724], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const markers = new Map();
    const routeLines = new Map();
    let timer = 0;
    let fetching = false;
    let hasFitFleet = false;
    let cleared = false;
    let trafficMode = false;
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
        speedMph == null ? '' : `<div>${speedMph} mph${trafficMode ? ' · fleet traffic view' : ''}</div>`,
        location.recordedAt ? `<small>Updated ${escapeHtml(new Date(location.recordedAt).toLocaleTimeString())}</small>` : '',
      ].filter(Boolean).join('');
    }

    async function drawRoutes(drivers, activeTrips) {
      const activeIds = new Set();
      for (const trip of activeTrips) {
        const driver = drivers.find((entry) => entry.driverId === trip.driverId && entry.location);
        if (!driver || !driver.location) continue;
        const origin = [driver.location.latitude, driver.location.longitude];
        if (!origin.every(Number.isFinite)) continue;

        const [pickup, dropoff] = await Promise.all([
          geocode(trip.pickupLocation),
          geocode(trip.dropoffLocation),
        ]);
        if (cleared) return;
        activeIds.add(trip.driverId);

        const points = [origin];
        if (pickup) points.push(pickup);
        if (dropoff) points.push(dropoff);
        if (points.length < 2) return;

        const color = trafficMode ? trafficColor(driver.location.speed) : '#c5a059';
        const existing = routeLines.get(trip.driverId);
        const options = {
          color,
          weight: trafficMode ? 5 : 3,
          opacity: trafficMode ? 0.85 : 0.6,
          dashArray: trafficMode ? null : '6 7',
        };
        if (existing) {
          existing.setLatLngs(points);
          existing.setStyle(options);
        } else {
          const line = L.polyline(points, options).addTo(map);
          line.bindPopup(
            `<strong>${escapeHtml(driver.name || driver.driverId)}</strong>` +
            `<div>${escapeHtml(trip.status)}</div>` +
            `<div>${escapeHtml(trip.pickupLocation)} → ${escapeHtml(trip.dropoffLocation)}</div>` +
            (pickup && dropoff ? '' : '<div><small>Partial route — address could not be located.</small></div>')
          );
          routeLines.set(trip.driverId, line);
        }
      }
      routeLines.forEach((line, driverId) => {
        if (!activeIds.has(driverId)) {
          line.remove();
          routeLines.delete(driverId);
        }
      });
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

        await drawRoutes(drivers, activeTrips);

        lastSummary = {
          drivers: drivers.length,
          reporting: reporting.length,
          activeTrips: activeTrips.length,
          totalPings: Number(data.totalPings) || 0,
          updatedAt: data.generatedAt ? new Date(data.generatedAt) : new Date(),
        };
        onSummary?.({ ...lastSummary, cleared, routes: routeLines.size, trafficMode });
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
      routeLines.forEach((line) => line.remove());
      routeLines.clear();
      hasFitFleet = false;
      if (lastSummary) onSummary?.({ ...lastSummary, cleared: true, routes: 0, trafficMode });
    }

    function resume() {
      cleared = false;
      void refresh();
    }

    function setTrafficMode(enabled) {
      trafficMode = Boolean(enabled);
      routeLines.forEach((line) => {
        line.setStyle({
          color: trafficMode ? '#d9a741' : '#c5a059',
          weight: trafficMode ? 5 : 3,
          opacity: trafficMode ? 0.85 : 0.6,
          dashArray: trafficMode ? null : '6 7',
        });
      });
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

    return { start, stop, refresh, clear, resume, setTrafficMode, destroy };
  }

  global.VeloFoxTelemetryMap = { create };
}(window));
