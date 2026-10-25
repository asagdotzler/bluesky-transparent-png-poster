const { t, isolateBidiText, localizeDocument } = globalThis.TpngI18n;
localizeDocument();

const accountStatus = document.getElementById("accountStatus");
const signInForm = document.getElementById("signInForm");
const handleInput = document.getElementById("handleInput");
const passwordInput = document.getElementById("passwordInput");
const signInButton = document.getElementById("signInButton");
const openButton = document.getElementById("openButton");
const signOutButton = document.getElementById("signOutButton");
const statusMessage = document.getElementById("statusMessage");

const LOGIN_IDENTIFIER_STORAGE_KEY = "popupLoginIdentifier";

let signedInHere = false;
let signingIn = false;

function setStatus(message, kind = "") {
  statusMessage.textContent = message;
  statusMessage.className = `status${kind ? ` ${kind}` : ""}`;

  // In Firefox toolbar popups, NVDA may not announce the polite live region
  // when a sign-in error follows button activation. Notify from the native
  // sign-in control when supported; retain the live region for older Firefox.
  if (kind === "error" && message && !signInForm.hidden &&
      typeof signInButton.ariaNotify === "function") {
    signInButton.ariaNotify(message);
  }
}

function renderSessionUi(session) {
  const signedIn = Boolean(session);

  const accountLabel = signedIn
    ? t("signedInAs", [isolateBidiText(session.handle)])
    : t("notSignedIn");
  // Avoid rewriting the description while NVDA is reading the newly focused
  // New Post button after a successful sign-in.
  if (accountStatus.textContent !== accountLabel) {
    accountStatus.textContent = accountLabel;
  }
  accountStatus.classList.toggle("success", signedIn && signedInHere);

  signInForm.hidden = signedIn;
  openButton.hidden = !signedIn;
  signOutButton.hidden = !signedIn;

  signInButton.disabled = signingIn;
}

// Retain only the handle during the Firefox session for reopening the popup.
// This does not save the password or persistent authentication tokens.
async function restoreLoginIdentifier() {
  const stored = await browser.storage.session.get(LOGIN_IDENTIFIER_STORAGE_KEY);
  const identifier = stored?.[LOGIN_IDENTIFIER_STORAGE_KEY];

  if (typeof identifier !== "string" || !identifier || handleInput.value) {
    return false;
  }

  handleInput.value = identifier;
  return true;
}

async function refreshSessionUi() {
  const result = await browser.runtime.sendMessage({ type: "getSession" });
  const session = result?.ok ? result.session : null;

  if (!session) {
    signedInHere = false;
  }

  renderSessionUi(session);
  return session;
}

async function signIn() {
  if (signingIn) {
    return;
  }

  const identifier = handleInput.value.trim();
  const password = passwordInput.value;

  if (!identifier || !password) {
    setStatus(t("enterCredentials"), "error");
    return;
  }

  browser.storage.session
    .set({ [LOGIN_IDENTIFIER_STORAGE_KEY]: identifier })
    .catch(() => null);

  signingIn = true;
  signInButton.disabled = true;
  setStatus(t("signingIn"));

  let result;

  try {
    result = await browser.runtime.sendMessage({
      type: "login",
      identifier,
      password,
    });
  } catch (error) {
    result = { ok: false, error: error?.message || t("signInFailed") };
  } finally {
    signingIn = false;
  }

  if (!result?.ok) {
    signInButton.disabled = false;
    setStatus(result?.error || t("signInFailed"), "error");
    return;
  }

  signedInHere = true;
  passwordInput.value = "";

  // EXPERIMENT v2.8.197: expose the already visible account identity through
  // the focused action's native accessible description. Prepare its text before
  // focus so NVDA can read name + description in one focus announcement;
  // keep the established focus-before-form-hide order.
  accountStatus.textContent = t("signedInAs", [isolateBidiText(result.session.handle)]);
  openButton.setAttribute("aria-describedby", "accountStatus");
  openButton.hidden = false;
  openButton.focus();
  renderSessionUi(result.session);
  setStatus("");
}

handleInput.addEventListener("input", () => {
  const identifier = handleInput.value.trim();

  if (identifier) {
    browser.storage.session
      .set({ [LOGIN_IDENTIFIER_STORAGE_KEY]: identifier })
      .catch(() => null);
  } else {
    browser.storage.session.remove(LOGIN_IDENTIFIER_STORAGE_KEY).catch(() => null);
  }
});

signInForm.addEventListener("submit", (event) => {
  event.preventDefault();
  signIn();
});

openButton.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "launchFreshComposerPanel" }).catch(() => null);
  window.close();
});

signOutButton.addEventListener("click", async () => {
  const result = await browser.runtime.sendMessage({ type: "logout" });
  if (!result?.ok) {
    setStatus(result?.error || t("signOutFailed"), "error");
    return;
  }

  signedInHere = false;
  openButton.removeAttribute("aria-describedby");
  setStatus("");

  // The signed-out form replaces this button, so move focus deliberately.
  signInForm.hidden = false;
  handleInput.focus();
  await refreshSessionUi();
});

Promise.all([restoreLoginIdentifier(), refreshSessionUi()]).then(
  ([restoredIdentifier, session]) => {
    if (!session && restoredIdentifier) {
      passwordInput.focus();
    }
  }
);
