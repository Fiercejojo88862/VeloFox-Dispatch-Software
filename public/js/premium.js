(function premiumInteractions() {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;

  function whenReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  whenReady(() => {
    root.classList.add('has-premium');

    const topbar = document.querySelector('.topbar');
    const hero = document.querySelector('.hero-lux');

    /* Thin gold reading-progress line. */
    const progress = document.createElement('div');
    progress.className = 'scroll-progress';
    progress.setAttribute('aria-hidden', 'true');
    const progressFill = document.createElement('span');
    progress.append(progressFill);
    document.body.append(progress);

    let frame = 0;

    function updateOnScroll() {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;

        const max = document.documentElement.scrollHeight - window.innerHeight;
        const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;

        progressFill.style.transform = `scaleX(${ratio})`;
        progress.classList.toggle('is-active', ratio > 0.01);

        if (topbar) topbar.classList.toggle('is-scrolled', window.scrollY > 8);

        if (hero && !reduceMotion.matches) {
          const rect = hero.getBoundingClientRect();
          if (rect.bottom > 0) {
            const shift = Math.max(-36, Math.min(72, -rect.top * 0.16));
            hero.style.setProperty('--hero-shift', `${shift.toFixed(1)}px`);
          }
        }
      });
    }

    window.addEventListener('scroll', updateOnScroll, { passive: true });
    window.addEventListener('resize', updateOnScroll, { passive: true });
    updateOnScroll();

    /* Gentle entrance for sections and cards. */
    const revealables = Array.from(document.querySelectorAll('.reveal'));

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      revealables.forEach((element) => element.classList.add('is-visible'));
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          });
        },
        { threshold: 0.12, rootMargin: '0px 0px -36px 0px' },
      );

      revealables.forEach((element) => observer.observe(element));

      /* Never leave content hidden if the observer is interrupted. */
      window.setTimeout(() => {
        document
          .querySelectorAll('.reveal:not(.is-visible)')
          .forEach((element) => element.classList.add('is-visible'));
      }, 2200);
    }

    /* Cursor spotlight on cards. */
    document.querySelectorAll('[data-spotlight]').forEach((card) => {
      card.addEventListener('pointermove', (event) => {
        if (reduceMotion.matches || event.pointerType === 'touch') return;
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${(event.clientX - rect.left).toFixed(1)}px`);
        card.style.setProperty('--my', `${(event.clientY - rect.top).toFixed(1)}px`);
      });

      card.addEventListener('pointerleave', () => {
        card.style.removeProperty('--mx');
        card.style.removeProperty('--my');
      });
    });

    /* Image tilt inside fleet cards. */
    document.querySelectorAll('[data-tilt]').forEach((card) => {
      const target = card.querySelector('[data-tilt-target]') || card;

      card.addEventListener('pointermove', (event) => {
        if (reduceMotion.matches || event.pointerType === 'touch') return;
        const rect = card.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        target.style.setProperty('--tilt-x', `${(-x * 9).toFixed(2)}px`);
        target.style.setProperty('--tilt-y', `${(-y * 7).toFixed(2)}px`);
      });

      card.addEventListener('pointerleave', () => {
        target.style.removeProperty('--tilt-x');
        target.style.removeProperty('--tilt-y');
      });
    });

    /* Magnetic pull on primary calls to action. */
    document.querySelectorAll('[data-magnetic]').forEach((element) => {
      element.addEventListener('pointermove', (event) => {
        if (reduceMotion.matches || event.pointerType === 'touch') return;
        const rect = element.getBoundingClientRect();
        const x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
        const y = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
        element.style.setProperty('--magnet-x', `${(x * 4).toFixed(2)}px`);
        element.style.setProperty('--magnet-y', `${(y * 3).toFixed(2)}px`);
      });

      element.addEventListener('pointerleave', () => {
        element.style.removeProperty('--magnet-x');
        element.style.removeProperty('--magnet-y');
      });
    });
  });
}());
