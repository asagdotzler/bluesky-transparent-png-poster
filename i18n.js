(() => {
  function normalizeSubstitutions(substitutions) {
    if (substitutions === undefined || substitutions === null) {
      return undefined;
    }

    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return values.map((value) => String(value));
  }

  function rawMessage(key, substitutions) {
    return browser.i18n.getMessage(key, normalizeSubstitutions(substitutions)) || "";
  }

  function t(key, substitutions, fallback = "") {
    return rawMessage(key, substitutions) || fallback || key;
  }

  function locale() {
    const uiLocale = rawMessage("@@ui_locale") || browser.i18n.getUILanguage?.() || "en";
    return uiLocale.replace(/_/g, "-");
  }

  function plural(baseKey, count, substitutions, fallback = "") {
    let category = "other";
    try {
      category = new Intl.PluralRules(locale()).select(Number(count));
    } catch (_) {}

    return (
      rawMessage(`${baseKey}_${category}`, substitutions) ||
      rawMessage(`${baseKey}_other`, substitutions) ||
      fallback ||
      `${baseKey}_${category}`
    );
  }

  function formatNumber(value, options) {
    try {
      return new Intl.NumberFormat(locale(), options).format(value);
    } catch (_) {
      return String(value);
    }
  }

  function isolateBidiText(value) {
    return `\u2068${String(value)}\u2069`;
  }

  function localizeDocument(root = document) {
    const documentElement = root.documentElement || document.documentElement;
    if (documentElement) {
      documentElement.lang = locale();
      documentElement.dir = t("textDirection", undefined, "ltr") === "rtl" ? "rtl" : "ltr";
    }

    root.querySelectorAll?.("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      const message = rawMessage(key);
      if (message) {
        element.textContent = message;
      }
    });

    for (const attribute of ["title", "placeholder", "aria-label"]) {
      root.querySelectorAll?.(`[data-i18n-${attribute}]`).forEach((element) => {
        const key = element.getAttribute(`data-i18n-${attribute}`);
        const message = rawMessage(key);
        if (message) {
          element.setAttribute(attribute, message);
        }
      });
    }

    // Keep the actual <a> element, including its destination and native
    // keyboard semantics, while allowing translators to move it in the sentence.
    root.querySelectorAll?.("[data-i18n-link]").forEach((element) => {
      const link = element.querySelector("a");
      if (!link) return;

      const marker = "\uE000TPNG_LINK\uE001";
      const translated = rawMessage(element.getAttribute("data-i18n-link"), [marker]);
      const parts = translated.split(marker);
      // A malformed/missing translation must not erase the fallback help link.
      if (parts.length !== 2) return;

      const ownerDocument = element.ownerDocument || document;
      element.replaceChildren(
        ownerDocument.createTextNode(parts[0]),
        link,
        ownerDocument.createTextNode(parts[1])
      );
    });
  }

  globalThis.TpngI18n = Object.freeze({
    t,
    plural,
    formatNumber,
    locale,
    isolateBidiText,
    localizeDocument,
  });
})();
