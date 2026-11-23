/*!
 * VeloFox Audio FX
 * Synthesizes short, high-end interface tones with the Web Audio API.
 * No external audio files, no dependencies.
 *
 *   VeloFoxAudio.play('dispatch');
 *   VeloFoxAudio.toggleMute();
 *   VeloFoxAudio.attachMuteToggle(button);
 *
 * Browsers block audio until a user gesture, so the context is created and
 * resumed on the first interaction (and `unlock()` is exported for manual use).
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'velofox.audio.muted';
  const AudioContextCtor = global.AudioContext || global.webkitAudioContext;

  let ctx = null;
  let master = null;
  let muted = readMuted();
  let unlockBound = false;

  function readMuted() {
    try {
      return global.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function persistMuted() {
    try {
      global.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      /* storage can be blocked; muting still works for this page */
    }
  }

  function ensureContext() {
    if (!AudioContextCtor) return null;
    if (!ctx) {
      try {
        ctx = new AudioContextCtor();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
      } catch {
        ctx = null;
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /** One shaped oscillator voice. */
  function voice(audio, { freq, at, duration, type, peak, glideTo, detune }) {
    const start = audio.currentTime + at;
    const stop = start + duration;

    const osc = audio.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, stop);
    if (detune) osc.detune.setValueAtTime(detune, start);

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);

    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(stop + 0.02);
  }

  const PRESETS = {
    // Dispatched: a bright two-part bell that resolves upward.
    dispatch(audio) {
      const notes = [
        { freq: 659.25, at: 0, duration: 0.42, peak: 0.09 },
        { freq: 987.77, at: 0.09, duration: 0.5, peak: 0.085 },
        { freq: 1318.51, at: 0.18, duration: 0.62, peak: 0.06 },
      ];
      notes.forEach((note) => {
        voice(audio, { ...note, type: 'sine' });
        voice(audio, { ...note, type: 'sine', detune: 7, peak: note.peak * 0.35 });
        voice(audio, { ...note, type: 'triangle', detune: -7, peak: note.peak * 0.2 });
      });
    },

    // Job notice — short attention chime when a new job is assigned.
    ping(audio) {
      voice(audio, { freq: 987.77, at: 0, duration: 0.14, type: 'sine', peak: 0.1 });
      voice(audio, { freq: 1318.5, at: 0.16, duration: 0.18, type: 'triangle', peak: 0.1 });
      voice(audio, { freq: 1567.98, at: 0.36, duration: 0.22, type: 'sine', peak: 0.07 });
    },

    // Confirmation click: dry, immediate, low-fatigue.
    confirm(audio) {
      voice(audio, { freq: 1320, at: 0, duration: 0.07, type: 'triangle', peak: 0.07 });
      voice(audio, { freq: 1760, at: 0.035, duration: 0.09, type: 'sine', peak: 0.045 });
    },

    // Ride completed / positive terminal state.
    success(audio) {
      voice(audio, { freq: 523.25, at: 0, duration: 0.28, type: 'sine', peak: 0.075 });
      voice(audio, { freq: 783.99, at: 0.11, duration: 0.42, type: 'sine', peak: 0.07 });
      voice(audio, { freq: 1046.5, at: 0.22, duration: 0.5, type: 'sine', peak: 0.05 });
    },

    // Driver on location: sonar-style ping.
    arrive(audio) {
      voice(audio, { freq: 880, at: 0, duration: 0.5, type: 'sine', peak: 0.075, glideTo: 660 });
      voice(audio, { freq: 440, at: 0.02, duration: 0.55, type: 'sine', peak: 0.035 });
    },

    // Request failed / invalid transition.
    error(audio) {
      voice(audio, { freq: 220, at: 0, duration: 0.16, type: 'square', peak: 0.045 });
      voice(audio, { freq: 174, at: 0.17, duration: 0.22, type: 'square', peak: 0.045 });
    },

    // Voice controller wake / sleep acknowledgement.
    listen(audio) {
      voice(audio, { freq: 1046.5, at: 0, duration: 0.12, type: 'sine', peak: 0.05 });
      voice(audio, { freq: 1567.98, at: 0.08, duration: 0.16, type: 'sine', peak: 0.04 });
    },
  };

  function play(name) {
    if (muted) return;
    const preset = PRESETS[name] || PRESETS.confirm;
    const audio = ensureContext();
    if (!audio) return;
    try {
      preset(audio);
    } catch {
      /* never let decoration break a dispatch action */
    }
  }

  function setMuted(next) {
    muted = Boolean(next);
    persistMuted();
    document.dispatchEvent(new CustomEvent('velofox:audio-muted', { detail: { muted } }));
  }

  function toggleMute() {
    setMuted(!muted);
    if (!muted) play('confirm');
    return muted;
  }

  function attachMuteToggle(button) {
    if (!button) return;
    const sync = () => {
      button.setAttribute('aria-pressed', String(muted));
      button.textContent = muted ? 'Sound off' : 'Sound on';
      button.title = muted ? 'Enable interface sounds' : 'Mute interface sounds';
    };
    button.addEventListener('click', () => {
      toggleMute();
      sync();
    });
    document.addEventListener('velofox:audio-muted', sync);
    sync();
  }

  function unlock() {
    ensureContext();
  }

  function bindFirstGesture() {
    if (unlockBound) return;
    unlockBound = true;
    const handler = () => {
      unlock();
      global.removeEventListener('pointerdown', handler, true);
      global.removeEventListener('keydown', handler, true);
    };
    global.addEventListener('pointerdown', handler, true);
    global.addEventListener('keydown', handler, true);
  }

  // Declarative usage: <button data-audio="confirm">.
  function bindDeclarativeSounds() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest && event.target.closest('[data-audio]');
      if (target) play(target.dataset.audio);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindDeclarativeSounds, { once: true });
  } else {
    bindDeclarativeSounds();
  }
  bindFirstGesture();

  global.VeloFoxAudio = {
    play,
    unlock,
    setMuted,
    toggleMute,
    attachMuteToggle,
    isMuted: () => muted,
    isSupported: () => Boolean(AudioContextCtor),
    presets: Object.keys(PRESETS),
  };
})(window);
