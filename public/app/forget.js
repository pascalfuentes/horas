/**
 * Empties the copy of a person's time data that the time screens keep in the
 * tab (see `copy` in horas.js) when that person is no longer the one using it:
 * on any page shown to someone who is not signed in, and at the moment they
 * sign out. Loaded by the signed-in layout and by the sign-in one.
 */
(function () {
  'use strict';

  /** Every name the time screens keep in the tab starts with this. */
  const PREFIX = 'clockfolio.copy:';

  /**
   * Removes every kept answer from this tab.
   * @returns {void}
   */
  function forget() {
    try {
      const store = window.sessionStorage;
      const gone = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && key.indexOf(PREFIX) === 0) gone.push(key);
      }
      gone.forEach(function (key) { store.removeItem(key); });
    } catch (e) { /* storage blocked: nothing was kept */ }
  }

  // The signed-in layout says who the person is; a page without it is shown to nobody in particular.
  if (!document.querySelector('[data-person]')) forget();

  document.addEventListener('submit', function (ev) {
    const form = /** @type {HTMLFormElement|null} */ (ev.target);
    if (form && form.getAttribute && form.getAttribute('action') === '/api/logout') forget();
  });
})();
