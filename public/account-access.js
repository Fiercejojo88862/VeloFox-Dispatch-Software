'use strict';

const role = document.body.dataset.role;
const destination = role === 'dispatcher' ? '/dashboard.html' : '/client.html';
const tabs = document.querySelectorAll('[data-tab]');
const views = document.querySelectorAll('[data-view]');

function setView(name) {
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  views.forEach((view) => { view.hidden = view.dataset.view !== name; });
  const firstInput = document.querySelector(`[data-view="${name}"] input`);
  if (firstInput) firstInput.focus();
}

async function request(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const details = data && Array.isArray(data.details) ? ` ${data.details.join(' ')}` : '';
    throw new Error(`${(data && data.error) || 'Unable to complete this request.'}${details}`);
  }
  return data;
}

function formPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitForm(form, mode) {
  const message = form.querySelector('.form-message');
  const button = form.querySelector('.submit');
  message.textContent = '';
  message.classList.remove('is-success');
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';

  try {
    const payload = { ...formPayload(form), role };
    await request(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) });
    message.textContent = 'Access confirmed. Opening your portal…';
    message.classList.add('is-success');
    window.location.assign(destination);
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

tabs.forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.tab)));
document.querySelector('[data-view="login"] form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, 'login');
});
document.querySelector('[data-view="register"] form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitForm(event.currentTarget, 'register');
});

fetch('/api/auth/session')
  .then((response) => response.ok ? response.json() : null)
  .then((data) => {
    if (data && data.user && data.user.role === role) window.location.replace(destination);
  })
  .catch(() => {});
