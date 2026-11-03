# AVTube R2 signer

The Worker verifies Firebase ID tokens, derives the owner UID from the verified
token, signs temporary R2 upload/download URLs, validates uploaded file
signatures and sizes, and writes media metadata to Firebase Realtime Database
using a server-only service account. R2 credentials and the service account
must only be configured as Wrangler secrets.

## Required Worker secrets

From this directory, set the secret values interactively. Do not put secret
values in source files or the Expo app:

```sh
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

`FIREBASE_SERVICE_ACCOUNT_JSON` must be the full JSON key for a service account
in the existing `av-tube-6e417` project with the Firebase Realtime Database
Admin role. The Worker checks the project ID before using the credential. The
database URL is a non-secret Worker variable in `wrangler.toml`.

The Expo client needs the safe Worker URL in
`EXPO_PUBLIC_R2_SIGNER_URL`. Never put an R2 key or service-account value in an
`EXPO_PUBLIC_` variable.

## R2 browser CORS and deployment

The app's native iOS/Android requests do not need browser CORS. Expo web uploads
use the bucket policy in `r2-cors.json`. Restrict `origins` to AVTube's actual
web origins before deploying if web access is enabled:

```sh
npx wrangler r2 bucket cors set avtube-media --file r2-cors.json
npx wrangler r2 bucket cors list avtube-media
npx wrangler deploy
```

## Metadata layout

- `mediaReels/{uid}/{id}` stores Reel metadata. Public Reels are also indexed at
  the existing `publicVideos/{id}` path for the current feed and Reel sharing.
- `mediaPosts/{uid}/{id}` stores Post metadata; public Posts are also indexed at
  `publicPosts/{id}`.
- `stories/{uid}/{id}` stores Story metadata; public Stories are also indexed at
  `publicStories/{id}`.

Every record has a distinct `mediaType`; Reels are video-only, Posts are
photo-only, and Stories keep their own `image` or `video` `mediaKind`. Object
keys are generated from the verified UID and content type. Firebase stores
object references and safe metadata, never R2 credentials or temporary URLs.

Profile photos use the authenticated `/v1/r2/profile-photo/upload-url` and
`/confirm` endpoints. The Worker accepts verified JPEG files up to 5 MiB and
stores them at `users/{uid}/profile-photos/{photoId}.jpg`, deriving `{uid}`
from the Firebase ID token. The confirmed URL is a stable Worker URL; it
redirects to a short-lived R2 download URL only while that URL is the user's
current `users/{uid}/profileImage` value. The authenticated `/delete` endpoint
only removes a photo owned by the caller and refuses to delete the currently
referenced photo. Replaced AVTube-hosted profile photos are cleaned up after
the profile update; a cleanup failure can leave an unreferenced R2 object.
Previously stored external profile-photo URLs are not managed by the Worker.

The Worker uses Firebase Authentication for request ownership and the service
account only inside the Worker for metadata reads and writes. RTDB profile
photo rules allow only owner-specific profile-photo Worker URLs (or an
unchanged legacy value).
Follower-only downloads check the existing `follows` data. Close-friends
downloads fail closed unless a trusted server populates
`closeFriends/{ownerUid}/{viewerUid}`; the app currently has no close-friends
membership management flow.

Uploads are limited to 500 MiB per file. The Worker checks both the declared
MIME type and the uploaded object's content signature before publishing
metadata. Upload and download URLs expire after 15 minutes.

## Private Story listing index

The Messages screen requests private Stories through the authenticated
`POST /v1/r2/stories` endpoint. The Worker checks the existing follower or
close-friend authorization before signing any media URL. The
`storyVisibilityIndex` is server-managed; client database rules do not grant
read or write access to it.

Before deploying a Worker version that serves private Story listings, initialize
the index once from this directory. Provide `FIREBASE_DATABASE_URL` with the
existing database URL and `FIREBASE_SERVICE_ACCOUNT_JSON` from an approved
secret manager; do not save credentials in the repository or Expo environment:

```sh
npm run migrate:story-index
```

The migration validates the existing
`https://av-tube-6e417-default-rtdb.asia-southeast1.firebasedatabase.app`
database URL and `av-tube-6e417` service-account project before writing.
The migration reads Stories one owner at a time, writes active private Story
index entries in batches, and marks the index initialized only after all writes
succeed. If the index is not initialized, the listing endpoint fails closed
with a temporary-unavailable response rather than scanning the complete Story
tree during a user request. New private Story uploads add their index entries
through the existing Worker publish flow.

## Reel encoding pipeline (single 480p MP4)

The Worker cannot run FFmpeg. It is the control plane; `workers/video-encoder` (Node + FFmpeg, no npm deps,
see its `Dockerfile`) does the real transcoding in a Cloudflare Container.

Flow: publish (public Reel, `VIDEO_ENCODING_ENABLED="true"`) → `encodingStatus: processing` → the Worker cron
checks the authenticated encoder service and claims one job (the lease uses a Firebase ETag compare-and-set and
attempts are counted at claim) → the Worker forwards the job to its private Container binding → the Container
downloads the original using its signed URL, runs FFmpeg, and uploads
`users/{uid}/reels/{id}/{480p.mp4,poster.jpg}` through presigned PUT URLs (`/v1/encoder/upload-urls`) →
`/v1/encoder/complete` checks the MP4 exists in R2 with the reported size, then sets `encodingStatus: ready`,
`playbackUrl`, `playbackQuality`, `availableQualities`, `width`, `height`, `encodedFileSize`, `originalFileSize`,
`compressionRatio`.
Failures retry up to 3 claims, then `encodingStatus: failed` (the client falls back to the original `videoUrl`).
`GET /v1/r2/playback/{reelId}/{480p.mp4|poster.jpg}` serves the files with Range support (ready, public Reels only).

Encoder settings: H.264 Main, `-preset medium -crf 23 -maxrate 1800k -bufsize 3600k`, AAC 128k stereo, `+faststart`,
short side = min(480, source) (never upscaled, aspect kept, even dimensions), max 30 fps. Small compatible
H.264/AAC MP4 sources (<=480p, <=2.2 Mbps) are remuxed with `+faststart` instead of re-encoded.

The Container service listens only on its internal port 8080 and requires the shared `ENCODER_TOKEN` for health and
job requests. The Worker passes that secret and `ENCODER_API_URL` to the Container at startup. The Container has no
R2 or Firebase credentials; it uses only the existing authenticated Worker endpoints and signed R2 URLs.

Containers require a Cloudflare Workers Paid plan. To prepare a Cloudflare deployment, connect this repository to
Workers Builds for the `avtube-r2-signer` Worker, set the root directory to `workers`, and set the production deploy
command to `npx wrangler deploy --config r2-signer/wrangler.toml`. This keeps the Worker and encoder image in the
same build checkout. Configure
`ENCODER_API_URL` as a non-secret Worker variable containing the HTTPS origin of this Worker. Add `ENCODER_TOKEN`
using Cloudflare Worker secrets (never a Wrangler `[vars]` entry). Keep `VIDEO_ENCODING_ENABLED` false until the
Container has been deployed and verified. Workers Builds performs the Dockerfile build; no local Docker installation
is required. Reels stuck in `processing` for 15 minutes continue to fall back to their original in the client.
