# Bluesky Transparent PNG Poster

Post transparent PNG images to Bluesky without losing their transparency.

**Bluesky Transparent PNG Poster** is a Firefox extension that lets you attach and publish transparent PNG images directly from the Bluesky web interface. Bluesky's normal image-upload processing can remove transparency, replacing transparent areas with an opaque background. This extension bypasses that processing and publishes PNGs through Bluesky's AT Protocol, preserving transparency.

The extension adds a **PNG button** to Bluesky's New post composer. It also provides a Firefox toolbar button for starting a new post and signing in or out of the extension.

## Features

- **Preserve transparency.** Publish transparent PNG images through Bluesky's AT Protocol.
- **Attach up to four PNGs.** Paste images, choose files, or drag and drop them into the PNG composer. Four images per post is a Bluesky limit.
- **Manage attachments.** Preview, remove, replace, and reorder images before posting.
- **Write accessible posts.** Provide required Alt text for each image, with character counts and keyboard-accessible editing controls.
- **Optimize PNGs and reduce metadata.** Remove unnecessary metadata, including embedded text and EXIF information, and automatically optimize oversized PNGs to meet Bluesky's upload limits while preserving transparency. Color profiles may be retained, and resizing can affect color information.
- **Compose without losing your place.** Write post text, move the PNG composer to a convenient position, or minimize it to read and interact with Bluesky. Restore the composer to continue your draft.
- **Keep accounts aligned.** Verify that the Bluesky website and PNG composer are signed into the same account before allowing publication.

## Getting started

1. Install the extension in Firefox. (AMO installation link will be added when published.)
2. Sign in to Bluesky at `bsky.app`.
3. Open the Bluesky New post composer and select the PNG button, or start a new post using the Firefox extension toolbar button.
4. Sign in to the PNG composer using a [Bluesky app password](https://bsky.app/settings/app-passwords). This authenticates the extension's separate connection to Bluesky's API, which it uses to upload images and publish posts.
5. Attach your PNG images, provide Alt text, optionally write post text, and select **Post**.

Your Bluesky website session and extension session are separate. Both must use the same Bluesky account to publish.

You can also sign in or out of the extension using its Firefox toolbar button.

## Accessibility

The extension is designed for keyboard and screen-reader use, with native HTML controls wherever practical, visible focus indicators, required Alt text, and support for zoom and Windows contrast themes.

Development and testing have focused on Firefox for Windows with NVDA.

### Known Firefox accessibility issues

Two Firefox behaviors can affect the extension when using Windows contrast themes:

- **Password autofill contrast.** Firefox's password manager can display autofilled credentials with insufficient text contrast in the extension's toolbar popup. This is related to [Firefox bug 2002609](https://bugzilla.mozilla.org/show_bug.cgi?id=2002609).
- **Toolbar icon contrast.** The extension's Firefox toolbar icon can be difficult to see in some Windows contrast themes. This appears related to [Firefox bug 1805640](https://bugzilla.mozilla.org/show_bug.cgi?id=1805640).

These issues have been left to Firefox rather than introducing workarounds that could interfere with native browser behavior.

## Internationalization and localization

The extension is designed to support localization. Interface strings are maintained in Firefox-compatible translation catalogs, with support for locale-aware number formatting, pluralization, bidirectional text, and translated interface labels. The extension's integration with Bluesky does not depend on English-language interface labels.

**Version 1.0 ships with an English-language interface only.**

An experimental Romanian localization was used during development to test internationalization behavior and language-independent integration with Bluesky. It is not included in the public release and will not be offered as a supported language.


## Privacy and security

The extension communicates directly with Bluesky to authenticate and publish posts. It does not use an intermediate publishing service, analytics service, or tracking server.

Images are processed locally before upload. Authentication tokens are maintained temporarily using Firefox's session storage rather than persistent extension storage. Firefox may separately offer to save your app password in its password manager.

See [PRIVACY.md](PRIVACY.md) for details.

## Current limitations

- Supports standalone posts, not replies, quote posts, or multi-post threads.
- Does not support publishing through composers with restricted interaction settings.
- Does not transfer Bluesky's external-link preview cards into PNG posts.
- Does not preserve unsent PNG drafts across full page reloads or tab closure.

## Source code and licensing

Bluesky Transparent PNG Poster is open-source software licensed under the **Mozilla Public License 2.0 (MPL-2.0)**; see [LICENSE](LICENSE).

Source code, issue reporting, and development instructions are available in the project's [GitHub repository](https://github.com/asagdotzler/bluesky-transparent-png-poster).
