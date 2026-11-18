/*!
 * VeloFox Voice Command
 * Experimental dispatcher voice control built on the Web Speech API, with a
 * deterministic command grammar and a typed fallback for browsers without
 * speech recognition (Firefox).
 *
 *   const controller = VeloFoxVoice.create({ onIntent, onTranscript, onStateChange });
 *   controller.toggle();
 *   controller.submit('show pending');
 *
 * Intents:
 *   { type: 'set_status', rideRef, status }
 *   { type: 'assign', rideRef, driverId }
 *   { type: 'filter', status }          // null clears the filter
 *   { type: 'count', status }
 *   { type: 'refresh' }
 *   { type: 'help' }
 *   { type: 'stop' }
 *   { type: 'unknown', text }
 */
(function (global) {
  'use strict';

  const STATUS_PATTERNS = [
    ['passenger_aboard', /\bpassenger (?:aboard|on\s?board)\b|\bon\s?board\b/],
    ['en_route', /\ben\s?route\b|\bon the way\b/],
    ['arrived', /\barriv(?:ed|ing)\b|\bon location\b|\bon site\b/],
    ['completed', /\bcomplete(?:d)?\b|\bfinished\b|\bdone\b/],
    ['cancelled', /\bcancel(?:led|ed)?\b/],
    ['assigned', /\bassign(?:ed)?\b/],
    ['confirmed', /\bconfirm(?:ed)?\b/],
    ['pending', /\bpending\b|\bwaiting\b/],
  ];

  const STATUS_LABELS = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    assigned: 'Assigned',
    en_route: 'En Route',
    arrived: 'On Location',
    passenger_aboard: 'Passenger Aboard',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };

  const FILLER = /\b(?:please|kindly|the|a|an|ride|trip|booking|status|to|as|for|now|can you|could you)\b/g;

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

  function rideRefFrom(text) {
    // Prefer an explicit "ride 1a2b3c4d" or "#1a2b3c4d", then any 6-8 char hex token.
    const explicit = text.match(/\b(?:ride|trip|booking|#)\s*#?([0-9a-f]{6,8})\b/i);
    if (explicit) return explicit[1].toLowerCase();
    const loose = text.match(/\b([0-9a-f]{6,8})\b/i);
    return loose ? loose[1].toLowerCase() : null;
  }

  function driverRefFrom(text) {
    const match = text.match(/\b(vf[-\s]?\d{3,5})\b/i);
    return match ? match[1].replace(/[\s-]/g, '-').toUpperCase().replace(/^VF(\d)/, 'VF-$1') : null;
  }

  function parseCommand(raw) {
    const text = normalize(raw);
    if (!text) return { type: 'unknown', text: '' };

    if (/^(?:help|commands|what can i say|options)\b/.test(text)) return { type: 'help' };
    if (/^(?:stop|stop listening|cancel|never mind|nevermind|quiet)\b/.test(text)) return { type: 'stop' };
    if (/\b(refresh|sync|reload|update)\b/.test(text) && text.split(' ').length <= 3) return { type: 'refresh' };

    const countMatch = text.match(/^(?:how many|count|number of)\s+(.+)$/);
    if (countMatch) {
      const status = detectStatus(countMatch[1]);
      if (status) return { type: 'count', status };
    }

    const filterMatch = text.match(/^(?:show|filter(?: by| for)?|display|list)\s+(.+)$/);
    if (filterMatch) {
      const rest = filterMatch[1].replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
      if (/^(?:all|everything|every ride)\b/.test(rest)) return { type: 'filter', status: null };
      if (/\bunassigned\b/.test(rest)) return { type: 'filter', status: 'unassigned' };
      const status = detectStatus(rest);
      if (status) return { type: 'filter', status };
      return { type: 'unknown', text: raw };
    }

    const driverId = driverRefFrom(text);
    const rideRef = rideRefFrom(text);

    if (/^assign\b/.test(text)) {
      if (driverId && rideRef) return { type: 'assign', rideRef, driverId };
      return { type: 'unknown', text: raw };
    }

    const status = detectStatus(text);
    if (status && rideRef) return { type: 'set_status', rideRef, status };
    if (status && /\b(?:ride|trip|booking)\b/.test(text)) return { type: 'unknown', text: raw };

    return { type: 'unknown', text: raw };
  }

  function speak(text) {
    if (!('speechSynthesis' in global) || !text) return;
    try {
      const utterance = new global.SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.03;
      utterance.pitch = 0.95;
      utterance.volume = 1;
      global.speechSynthesis.cancel();
      global.speechSynthesis.speak(utterance);
    } catch {
      /* speech is decorative; never block the dispatch action */
    }
  }

  function create(options = {}) {
    const { onIntent, onTranscript, onStateChange } = options;
    const RecognitionCtor = global.SpeechRecognition || global.webkitSpeechRecognition;
    const supported = Boolean(RecognitionCtor);

    let recognition = null;
    let listening = false;
    let lastError = null;

    function emit(extra = {}) {
      if (typeof onStateChange === 'function') {
        onStateChange({ supported, listening, error: lastError, ...extra });
      }
    }

    function buildRecognition() {
      const instance = new RecognitionCtor();
      instance.lang = 'en-US';
      instance.continuous = false;
      instance.interimResults = true;
      instance.maxAlternatives = 1;

      instance.onstart = () => {
        listening = true;
        lastError = null;
        emit();
      };

      instance.onresult = (event) => {
        let interim = '';
        let finalText = '';

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          if (result.isFinal) finalText += result[0].transcript;
          else interim += result[0].transcript;
        }

        if (typeof onTranscript === 'function') onTranscript((finalText || interim).trim());

        if (finalText.trim() && typeof onIntent === 'function') {
          onIntent(parseCommand(finalText), finalText.trim());
        }
      };

      instance.onerror = (event) => {
        lastError = event.error || 'recognition-error';
        listening = false;
        emit();
      };

      instance.onend = () => {
        listening = false;
        emit();
      };

      return instance;
    }

    function start() {
      if (!supported || listening) return false;
      try {
        if (!recognition) recognition = buildRecognition();
        recognition.start();
        return true;
      } catch (error) {
        lastError = error && error.message ? error.message : 'start-failed';
        listening = false;
        emit();
        return false;
      }
    }

    function stop() {
      if (!recognition || !listening) return;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
      listening = false;
      emit();
    }

    function toggle() {
      return listening ? (stop(), false) : start();
    }

    function submit(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return null;
      const intent = parseCommand(trimmed);
      if (typeof onTranscript === 'function') onTranscript(trimmed);
      if (typeof onIntent === 'function') onIntent(intent, trimmed);
      return intent;
    }

    return {
      supported,
      start,
      stop,
      toggle,
      submit,
      isListening: () => listening,
    };
  }

  global.VeloFoxVoice = {
    create,
    parseCommand,
    speak,
    STATUS_LABELS,
    isSupported: () => Boolean(global.SpeechRecognition || global.webkitSpeechRecognition),
    isSpeechSupported: () => 'speechSynthesis' in global,
  };
})(window);
