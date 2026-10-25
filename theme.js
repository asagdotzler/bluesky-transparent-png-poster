(() => {
  const root = document.documentElement;

  function cssColor(value) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (
      Array.isArray(value) &&
      (value.length === 3 || value.length === 4) &&
      value.every((part) => Number.isFinite(Number(part)))
    ) {
      const [red, green, blue, alpha] = value.map(Number);
      return alpha === undefined
        ? `rgb(${red} ${green} ${blue})`
        : `rgb(${red} ${green} ${blue} / ${alpha})`;
    }

    return null;
  }

  function firstColor(...values) {
    for (const value of values) {
      const color = cssColor(value);
      if (color) {
        return color;
      }
    }
    return null;
  }

  function setVariable(name, value) {
    if (value) {
      root.style.setProperty(name, value);
    } else {
      root.style.removeProperty(name);
    }
  }

  function applyColorScheme(theme) {
    const scheme = theme?.properties?.color_scheme;

    if (scheme === "light" || scheme === "dark") {
      root.style.colorScheme = scheme;
      return;
    }

    root.style.removeProperty("color-scheme");
  }

  // Firefox themes don't always provide popup-specific colors. Prefer
  // those when available, then use related colors as fallbacks. This
  // doesn't guarantee an exact match with native Firefox panels.
  function applyTheme(theme = {}) {
    const colors = theme.colors || {};

    const surface = firstColor(
      colors.popup,
      colors.toolbar,
      colors.sidebar,
      colors.frame,
    );
    const text = firstColor(
      colors.popup_text,
      colors.toolbar_text,
      colors.sidebar_text,
      colors.tab_text,
      colors.tab_background_text,
    );
    const fieldSurface = firstColor(
      colors.toolbar_field,
      colors.popup,
      colors.toolbar,
      colors.sidebar,
    );
    const fieldText = firstColor(
      colors.toolbar_field_text,
      colors.popup_text,
      colors.toolbar_text,
      colors.sidebar_text,
    );
    const border = firstColor(
      colors.popup_border,
      colors.toolbar_field_border,
      colors.sidebar_border,
      colors.toolbar_bottom_separator,
    );
    const hover = firstColor(colors.button_background_hover);
    const active = firstColor(colors.button_background_active);

    setVariable("--nova-surface", surface);
    setVariable("--nova-text", text);
    setVariable("--nova-field-surface", fieldSurface);
    setVariable("--nova-field-text", fieldText);
    setVariable("--nova-border", border);
    setVariable("--nova-button-hover", hover);
    setVariable("--nova-button-active", active);

    applyColorScheme(theme);
    root.dataset.firefoxTheme = theme.colors ? "current" : "ash-fallback";
  }

  async function refreshTheme() {
    try {
      applyTheme(await browser.theme.getCurrent());
    } catch {
      applyTheme({});
    }
  }

  refreshTheme();

  if (browser.theme?.onUpdated) {
    browser.theme.onUpdated.addListener(({ theme }) => {
      applyTheme(theme || {});
    });
  }
})();
