# Privacy Policy — Bluesky Transparent PNG Poster

*Effective date: October 25, 2026*

## Overview

Bluesky Transparent PNG Poster is a Firefox extension that allows users to publish transparent PNG images to Bluesky.

The extension processes images locally and communicates directly with Bluesky for authentication and publication. It does not operate an independent server, collect analytics, track browsing activity, or sell or share user information with advertisers.

## Information the extension processes

### Bluesky account information

To publish posts, the extension requires a Bluesky handle and app password.

When you sign in:

- Your handle and app password are sent over HTTPS to `bsky.social` to authenticate your account.
- Bluesky returns authentication tokens, which the extension stores temporarily using Firefox's `storage.session` API.
- The extension retains your account handle and identifier to display your sign-in status and verify the account used for posting.
The extension does not persistently store your app password. If you choose to save it in Firefox's built-in password manager, Firefox stores it as a separate login for the extension, distinct from any login saved for `bsky.app`.

Your Bluesky website session and extension authentication session are separate.

The extension also checks the active account on `bsky.app` to ensure that posts are published from the intended account. This check uses the account's handle and decentralized identifier (DID), not the website's authentication tokens.

### Images and post content

When you select or paste a PNG image, the extension processes it locally in Firefox.

This includes generating previews, removing unnecessary PNG metadata, and optimizing oversized images while preserving transparency. Some image information, including color profiles, may be retained.

Your attached images, Alt text, and draft post text remain in the browser until you choose to publish. They are not uploaded to an independent service operated by the extension developer.

When you select **Post**, the extension communicates with Bluesky to:

- Resolve account mentions, when necessary.
- Upload the selected PNG images.
- Publish the post text, images, Alt text, and associated post information.

Published content is handled by Bluesky and the AT Protocol network. Bluesky posts are generally public and may be accessed, copied, or retained by other services.

See [Bluesky's Privacy Policy](https://bsky.social/about/support/privacy-policy) for information about its data practices.

## Data storage and retention

The extension stores authentication tokens and limited account information in Firefox session storage. It does not intentionally save authentication tokens to persistent extension storage.

Signing out of the extension removes its stored authentication tokens. It does not revoke your Bluesky app password; you can manage or revoke app passwords in your Bluesky account settings.

Unpublished PNG drafts are maintained in memory. They are not stored on a developer-operated server and are not guaranteed to survive a full page reload, browser shutdown, or tab closure.

Information already transmitted to Bluesky is subject to Bluesky's own retention and deletion practices.

## Browser permissions

The extension uses Firefox permissions to:

- Access `bsky.app` to integrate with its post composer and verify the active account.
- Communicate with `bsky.social` to authenticate and publish posts.
- Use Firefox storage for temporary authentication and extension state.
- Read Firefox theme information to adapt the extension's appearance.

The extension does not request access to unrelated websites or your general browsing history.

## Analytics, advertising, and third parties

The extension does not include analytics, advertising, tracking pixels, or an independent telemetry service.

It does not transmit your information to the developer or to advertising services.

Bluesky is the external service used for the extension's essential authentication and publishing functions.

## Your choices

You control which images and text you prepare and publish.

You can cancel an unpublished draft, sign out of the extension, revoke its Bluesky app password, or uninstall the extension.

Publishing content to Bluesky is an explicit action. Once submitted, that content is subject to Bluesky's services and the public nature of the AT Protocol network.

## Changes to this policy

This policy may be updated when the extension's functionality or data practices change. The current version will be available in the project's [GitHub repository](https://github.com/asagdotzler/bluesky-transparent-png-poster).

## Contact

Privacy questions and concerns can be submitted through the project's [GitHub issue tracker](https://github.com/asagdotzler/bluesky-transparent-png-poster/issues).
