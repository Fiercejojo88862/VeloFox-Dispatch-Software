/*!
 * VeloFox Dispatch Command Console
 * A deterministic, typed-first command parser for dispatchers. Runs entirely
 * in the browser — a grammar that understands plain English phrasing and maps
 * it to dashboard actions.
 *
 *   const console = VeloFoxCommands.create({ onIntent, context });
 *   console.submit('show me all pending rides');
 *
 * Intents:
 *   { type: 'set_status', rideRef, status }
 *   { type: 'assign', rideRef, driverId }
 *   { type: 'filter', status }                 // null clears the filter
 *   { type: 'reason_filter', reason }
 *   { type: 'count', status, reason }
 *   { type: 'send_text', rideRef, kind, target }
 *   { type: 'ping_fleet' }
 *   { type: 'traffic', enabled }               // null toggles
 *   { type: 'clear_map' }
 *   { type: 'new_booking' }
 *   { type: 'show_alerts' }
 *   { type: 'roster', filter }
 *   { type: 'refresh' }
 *   { type: 'help' }
 *   { type: 'stop' }
 *   { type: 'unknown', text }
 */
(function (global) {
  'use strict';

  const STATUS_PATTERNS = [
    ['passenger_aboard', /\b(?:p\s?o\s?b|passenger (?:aboard|on\s?board)|on\s?board)\b/],
    ['en_route', /\b(?:en|on)\s?route\b|\bon the way\b|\bheading (?:there|over)\b/],
    ['arrived', /\barriv(?:ed|ing|e)\b|\bon location\b|\bon site\b/],
    ['dropped_off', /\bdrop(?:ped)?[ -]?off\b/],
    ['completed', /\bcomplete(?:d)?\b|\bfinished\b|\bdone\b/],
    ['cancelled', /\bcancel(?:led|ed|ling|s)?\b/],
    ['assigned', /\bassign(?:ed)?\b/],
    ['confirmed', /\bconfirm(?:ed)?\b/],
    ['pending', /\bpending\b|\bwaiting\b|\bunconfirmed\b/],
  ];

  const REASON_PATTERNS = [
    ['test_demo', /\b(?:test|demo|testing|sample)\b/],
    ['client_cancelled', /\bclient[- ]?cancel(?:led|lation)?s?\b|\bcustomer cancell\w*\b/],
    ['no_show', /\bno[ -]?shows?\b|\bdidn.t show\b|\bnever showed\b/],
  ];

  const STATUS_LABELS = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    assigned: 'Assigned',
    en_route: 'On Route',
    arrived: 'On Location',
    passenger_aboard: 'POB',
    dropped_off: 'Dropped Off',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };

  const FILLER = /\b(?:please|kindly|the|a|an|status|to|as|for|now|me|all|of|can you|could you|would you|i need|i want)\b/g;

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[.,!?;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectStatus(text) {
    for (const [status, pattern] of STATUS_PATTERNS) {
      if (pattern.test(text)) return status;
    }
    return null;
  }

  function detectReason(text) {
    for (const [reason, pattern] of REASON_PATTERNS) {
      if (pattern.test(text)) return reason;
    }
    return null;
  }

  function rideRefFrom(text, context) {
    const explicit = text.match(/\b(?:ride|trip|booking|#)\s*#?([0-9a-f]{6,8})\b/i);
    if (explicit) return explicit[1].toLowerCase();
    const loose = text.match(/\b([0-9a-f]{6,8})\b/i);
    if (loose) return loose[1].toLowerCase();
    if (context && Array.isArray(context.rides)) {
      const query = text.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
      if (!query) return null;
      const hit = context.rides.find((ride) => {
        const fields = [ride.id, ride.clientName, ride.pickupLocation, ride.dropoffLocation]
          .filter(Boolean).join(' ').toLowerCase();
        return fields.includes(query) || query.split(' ').some((word) => word.length > 3 && fields.includes(word));
      });
      return hit ? String(hit.id).toLowerCase() : null;
    }
    return null;
  }

  function driverRefFrom(text) {
    const match = text.match(/\b(vf[-\s]?\d{3,5})\b/i);
    return match ? match[1].replace(/[\s-]/g, '-').toUpperCase().replace(/^VF(\d)/, 'VF-$1') : null;
  }

  function parseCommand(raw, context) {
    const text = normalize(raw);
    if (!text) return { type: 'unknown', text: '' };

    if (/\b(help|commands|what can (?:i|you) do|options|examples|how does this work)\b/.test(text)) {
      return { type: 'help' };
    }
    if (/^(?:stop|never mind|nevermind|quiet|cancel that|forget it)\b/.test(text)) {
      return { type: 'stop' };
    }

    if (/\b(?:new|create|add|log|make|open)\b.*\b(?:booking|reservation|ride)\b/.test(text)) {
      return { type: 'new_booking' };
    }

    if (/\b(?:ping|notify|contact|message|alert|page)\b.*\b(?:all |the )?(?:drivers|fleet|chauffeurs|team)\b/.test(text)
      || /^(?:ping|ping the fleet|notify all)\b/.test(text)) {
      return { type: 'ping_fleet' };
    }

    if (/\btraffic\b/.test(text)) {
      if (/\b(?:turn off|disable|hide|off|stop)\b/.test(text)) return { type: 'traffic', enabled: false };
      if (/\b(?:turn on|enable|show|on|start)\b/.test(text)) return { type: 'traffic', enabled: true };
      return { type: 'traffic', enabled: null };
    }

    if (/\b(?:clear|hide|reset|remove)\b.*\b(?:map|locations|gps|telemetry|markers)\b/.test(text)) {
      return { type: 'clear_map' };
    }

    if (/\b(?:alerts?|exceptions?|urgent|issues|problems)\b/.test(text)
      && /\b(?:show|what|any|list|open|check)\b/.test(text)) {
      return { type: 'show_alerts' };
    }

    if (/\b(?:roster|fleet status|who(?:'s|\s+is|\s+are)?\s+(?:on|available|working|free)|which drivers)\b/.test(text)) {
      if (/\bon trip\b|\bworking\b/.test(text)) return { type: 'roster', filter: 'on_trip' };
      if (/\bavailable\b|\bfree\b/.test(text)) return { type: 'roster', filter: 'available' };
      return { type: 'roster', filter: null };
    }

    if (/\b(?:text|sms|message|notify|tell|call)\b/.test(text)) {
      const rideRef = rideRefFrom(text, context);
      const kind = /\b(?:pob|picked up|onboard|on board)\b/.test(text) ? 'pob' : 'en_route';
      const target = /\b(?:driver|chauffeur)\b/.test(text) ? 'driver' : 'client';
      return { type: 'send_text', rideRef, kind, target };
    }

    if (/\b(?:refresh|reload|sync|update)\b/.test(text) && text.split(' ').length <= 6) {
      return { type: 'refresh' };
    }

    const countMatch = text.match(/^(?:how many|count|number of|what is the count of)\s+(.+?)(?:\s+(?:are there|do we have))?$/);
    if (countMatch) {
      const reason = detectReason(countMatch[1]);
      if (reason) return { type: 'count', reason };
      const status = detectStatus(countMatch[1]);
      if (status) return { type: 'count', status };
      if (/\bunassigned\b/.test(countMatch[1])) return { type: 'count', status: 'unassigned' };
    }

    const filterMatch = text.match(/^(?:show me|show|filter by|filter for|filter|display|list|give me|i want to see|open|view)\s+(.+)$/);
    if (filterMatch) {
      const rest = filterMatch[1].replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
      if (/\bunassigned\b/.test(rest)) return { type: 'filter', status: 'unassigned' };
      const reason = detectReason(rest);
      if (reason) return { type: 'reason_filter', reason };
      const status = detectStatus(rest);
      if (status) return { type: 'filter', status };
      if (!rest || /^(?:everything|every ride|all rides)\b/.test(rest) || /^clear\b/.test(rest)) {
        return { type: 'filter', status: null };
      }
      return { type: 'unknown', text: raw };
    }

    const questionMatch = text.match(/^(?:are there any|is there a|do we have any|which)\s+(.+?)(?:\s+(?:rides?|trips?|jobs?))?$/);
    if (questionMatch) {
      const rest = questionMatch[1];
      if (/\bunassigned\b/.test(rest)) return { type: 'filter', status: 'unassigned' };
      const reason = detectReason(rest);
      if (reason) return { type: 'reason_filter', reason };
      const status = detectStatus(rest);
      if (status) return { type: 'filter', status };
    }

    const driverId = driverRefFrom(text);
    const rideRef = rideRefFrom(text, context);

    if (/\bassign\b/.test(text)) {
      if (driverId && rideRef) return { type: 'assign', rideRef, driverId };
      return { type: 'unknown', text: raw };
    }

    const status = detectStatus(text);
    if (status && rideRef) return { type: 'set_status', rideRef, status };

    return { type: 'unknown', text: raw };
  }

  function create(options = {}) {
    const { onIntent, context = {} } = options;

    function submit(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return null;
      const intent = parseCommand(trimmed, context);
      if (typeof onIntent === 'function') onIntent(intent, trimmed);
      return intent;
    }

    return { submit };
  }

  global.VeloFoxCommands = {
    create,
    parse: parseCommand,
    STATUS_LABELS,
  };
})(window);
