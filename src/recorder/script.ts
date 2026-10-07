/** Binding the page calls with each recorded user action (JSON payload). */
export const RECORD_BINDING = '__nexusRecord';

/**
 * Attribute that tags each recorded element for about a second, so the DOM
 * snapshot NEXUS requests the moment the action is reported can identify it.
 * Holds space-separated marks, since one element can have several pending.
 */
export const RECORDING_ATTRIBUTE = 'data-nexus-recording';

/**
 * Runs in every document and frame while recording. Listens in the capture
 * phase (before page handlers) for trusted user input and reports *intent*:
 *
 *   click            on buttons/links/other clickables (not on form fields)
 *   fill             a text field's final value, on change or before Enter/Escape
 *   press            Enter in a single-line field, Escape anywhere
 *   check / uncheck  checkbox and radio changes (however they were toggled)
 *   select           <select> changes, by option label
 *   upload           file input changes (file names only; paths are private)
 *   expectVisible    Alt/Option-click: records an assertion instead of clicking
 *
 * Each reported element is tagged with a unique mark (see RECORDING_ATTRIBUTE)
 * and NEXUS immediately snapshots the DOM and finds it there: one round trip,
 * which the browser answers before it can commit a navigation the action
 * started. NEXUS then generates the target with the same matchers that
 * replay it.
 *
 * A click that navigates can destroy its element quickly, so `pointerdown`
 * sends a 'prepare' message first: inspection starts while the button is
 * still down, and the click then refers to that capture.
 */
export const RECORDER_SCRIPT = `(() => {
  if (window.__nexusRecorderInstalled) return;
  window.__nexusRecorderInstalled = true;

  const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'password', 'tel', 'url', 'number']);
  const CLICKABLE = 'button, a[href], summary, [role=button], [role=link], [role=tab], [role=menuitem], ' +
    '[role=option], [role=switch], input[type=submit], input[type=button], input[type=reset], input[type=image]';
  const lastFilled = new WeakMap();
  // Marks must be unique across frames, which each run their own copy of this script.
  const prefix = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  const mark = (el) => {
    const id = prefix + '-' + counter++;
    const add = (el.getAttribute('${RECORDING_ATTRIBUTE}') || '') + ' ' + id;
    el.setAttribute('${RECORDING_ATTRIBUTE}', add.trim());
    setTimeout(() => {
      const rest = (el.getAttribute('${RECORDING_ATTRIBUTE}') || '').split(' ').filter((m) => m && m !== id);
      if (rest.length > 0) el.setAttribute('${RECORDING_ATTRIBUTE}', rest.join(' '));
      else el.removeAttribute('${RECORDING_ATTRIBUTE}');
    }, 1000);
    return id;
  };

  const isText = (el) =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type));
  const isToggleOrFile = (el) =>
    el instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(el.type);

  const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();

  // Rendered text, matching NEXUS's snapshot rules (text in elements that have a layout box).
  const visibleText = (el) => {
    let text = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && parent.checkVisibility({ visibilityProperty: true })) text += node.data;
    }
    return normalize(text);
  };

  // The element as it is *now*, before page handlers run: a fallback if it is gone by the
  // time NEXUS inspects it, and the "before" name/text if the action changes them (toggles).
  const fingerprint = (el) => {
    const text = visibleText(el).slice(0, 80) || undefined;
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\\s+/)
      .map((id) => document.getElementById(id)).filter(Boolean).map((node) => node.textContent).join(' ');
    const name = normalize(labelledBy) || normalize(el.getAttribute('aria-label')) || text;
    const role = el.getAttribute('role') ||
      (el.matches('a[href]') ? 'link' : el.matches('button, input[type=submit], input[type=button], input[type=reset]') ? 'button' : undefined);
    return { tag: el.tagName.toLowerCase(), id: el.id || undefined, text, role, name };
  };

  const send = (kind, el, extra) => {
    try {
      window.${RECORD_BINDING}(JSON.stringify({ kind, mark: mark(el), fingerprint: fingerprint(el), ...extra }));
    } catch {}
  };

  // The real target, even inside shadow DOM (event.target is retargeted to the host).
  const origin = (event) => {
    let el = event.composedPath()[0];
    while (el && !(el instanceof Element)) el = el.parentNode;
    return el;
  };

  // The element a click on \`el\` should be recorded against.
  const clickTarget = (el) => {
    if (!el) return undefined;
    const label = el.closest('label');
    const control = label ? label.control : el;
    // Form fields are recorded by what changes, not by the clicks that focus or toggle them.
    if (control && (isText(control) || isToggleOrFile(control) ||
        control instanceof HTMLSelectElement || control instanceof HTMLOptionElement)) return undefined;
    return el.closest(CLICKABLE) || el;
  };
  let prepared;

  addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || event.altKey) return;
    const target = clickTarget(origin(event));
    if (!target) return;
    prepared = { target, mark: mark(target) };
    try {
      window.${RECORD_BINDING}(JSON.stringify({ kind: 'prepare', mark: prepared.mark, fingerprint: fingerprint(target) }));
    } catch {}
  }, true);

  const flushFill = (el) => {
    if (!isText(el) || lastFilled.get(el) === el.value) return;
    lastFilled.set(el, el.value);
    send('fill', el, { value: el.value });
  };

  addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const el = origin(event);
    if (!el) return;
    if (event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send('expectVisible', el);
      return;
    }
    const target = clickTarget(el);
    if (!target) return;
    if (prepared && prepared.target === target) {
      const { mark: preparedMark } = prepared;
      prepared = undefined;
      try {
        window.${RECORD_BINDING}(JSON.stringify({ kind: 'click', mark: preparedMark, fingerprint: fingerprint(target) }));
      } catch {}
      return;
    }
    send('click', target);
  }, true);

  addEventListener('change', (event) => {
    const el = origin(event);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (event.isTrusted) send(el.checked ? 'check' : 'uncheck', el);
    } else if (el instanceof HTMLSelectElement) {
      // NEXUS's own selectOption dispatches untrusted events, so this one is not filtered.
      send('select', el, { options: Array.from(el.selectedOptions, (option) => option.label) });
    } else if (el instanceof HTMLInputElement && el.type === 'file') {
      if (event.isTrusted) send('upload', el, { files: Array.from(el.files || [], (file) => file.name) });
    } else if (event.isTrusted) {
      flushFill(el);
    }
  }, true);

  addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    const el = origin(event);
    if (!el) return;
    if (event.key === 'Enter' && isText(el) && !(el instanceof HTMLTextAreaElement)) {
      flushFill(el);
      send('press', el, { key: 'Enter' });
    } else if (event.key === 'Escape') {
      flushFill(el);
      send('press', el, { key: 'Escape' });
    }
  }, true);
})();`;
