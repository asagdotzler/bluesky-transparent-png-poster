# Bluesky Transparent PNG Poster 1.0

**Initial public release**

Bluesky Transparent PNG Poster is a Firefox extension for publishing transparent PNG images on Bluesky. Bluesky's normal image-upload processing can replace transparent areas with an opaque background. This extension preserves transparency by publishing PNGs through Bluesky's AT Protocol.

The extension integrates directly with Bluesky's New post composer and also provides a Firefox toolbar button for starting new posts.

## Features

- Publish up to four transparent PNG images per post.
- Add images through paste, file selection, or drag and drop.
- Preview, remove, replace, and reorder attached images.
- Provide required Alt text for every image.
- Automatically remove unnecessary PNG metadata and optimize oversized images while preserving transparency.
- Write post text, including supported links, mentions, and hashtags.
- Move or minimize the PNG composer without discarding the draft.
- Sign in to the extension separately using a Bluesky app password.
- Verify that the Bluesky website and extension are using the same account before publishing.
- Use keyboard-accessible controls and screen-reader-friendly editing workflows.

## Accessibility and internationalization

The extension has been developed and tested with particular attention to Firefox, keyboard navigation, NVDA, zoom, and Windows contrast themes.

The interface is internationalization-ready, with English as the only supported language in this release.

## Requirements

- Firefox desktop 150 or later.
- A Bluesky account.
- A Bluesky app password for extension authentication.

## Limitations

Version 1.0 supports standalone posts. Replies, quote posts, multi-post threads, and restricted-interaction posts are not supported.

Drafts are maintained in memory and are not guaranteed to survive a full page reload or tab closure.

## Privacy and source code

The extension processes images locally and communicates directly with Bluesky for authentication and publication. It does not use an intermediary publishing service or analytics service.

Bluesky Transparent PNG Poster is open source under the Mozilla Public License 2.0.
