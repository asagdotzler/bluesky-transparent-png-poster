import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function readProjectFile(name) {
  return fs.readFileSync(path.join(projectRoot, name), 'utf8');
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function makeClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      if (force === undefined) {
        if (values.has(name)) values.delete(name); else values.add(name);
        return values.has(name);
      }
      if (force) values.add(name); else values.delete(name);
      return Boolean(force);
    },
    toString() { return [...values].join(' '); },
  };
}

export function makeElement(id = '') {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    id,
    value: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    innerHTML: '',
    dataset: {},
    style: {},
    isConnected: true,
    classList: makeClassList(),
    children: [],
    childNodes: [],
    focusCount: 0,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    async dispatch(type, event = {}) {
      const actual = {
        preventDefault() {},
        stopPropagation() {},
        currentTarget: element,
        target: element,
        ...event,
      };
      for (const listener of listeners.get(type) || []) {
        await listener(actual);
      }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getClientRects() { return [{}]; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 1, height: 1 }; },
    focus() { element.focusCount += 1; },
    setCustomValidity(message) {
      element.validationMessage = String(message);
      element.validity = { customError: Boolean(message), valid: !message };
    },
    requestSubmit() { return element.dispatch('submit'); },
  };
  return element;
}

export function runScript(source, context = {}, filename = 'script.js') {
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    ArrayBuffer,
    Uint8Array,
    Intl,
    URL,
    Date,
    Promise,
    Object,
    Math,
    JSON,
    Error,
    Number,
    String,
    Boolean,
    RegExp,
    setImmediate,
    clearImmediate,
    setTimeout,
    clearTimeout,
    ...context,
  };
  sandbox.globalThis = sandbox;
  const vmContext = vm.createContext(sandbox);
  vm.runInContext(source, vmContext, { filename });
  return vmContext;
}

export function makeTestI18n(locale = 'en') {
  const messages = JSON.parse(readProjectFile(`_locales/${locale}/messages.json`));

  function getMessage(key, substitutions = []) {
    const entry = messages[key];
    if (!entry) return '';
    const values = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
    return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, placeholderName) => {
      const placeholder = entry.placeholders?.[placeholderName.toLowerCase()];
      if (!placeholder) return match;
      return placeholder.content.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '');
    });
  }

  return {
    t(key, substitutions, fallback = '') { return getMessage(key, substitutions) || fallback || key; },
    plural(baseKey, count, substitutions, fallback = '') {
      const category = new Intl.PluralRules(locale).select(Number(count));
      return getMessage(`${baseKey}_${category}`, substitutions) || getMessage(`${baseKey}_other`, substitutions) || fallback || `${baseKey}_${category}`;
    },
    formatNumber(value, options) { return new Intl.NumberFormat(locale, options).format(value); },
    locale() { return locale; },
    isolateBidiText(value) { return `\u2068${String(value)}\u2069`; },
    localizeDocument() {},
  };
}

export function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}
