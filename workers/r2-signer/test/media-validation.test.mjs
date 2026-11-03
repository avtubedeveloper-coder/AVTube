import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker, {
  isValidSignature,
  isActivePrivateStory,
  isAuthorizedPrivateStory,
  assertStoryVisibilityIndexReady,
  objectKeyFor,
  profilePhotoObjectKey,
  profilePhotoReferenceMatches,
  resolveVisiblePrivateStories,
  validateAsset,
  validateProfilePhotoRequest,
  validatePublishBody,
} from '../src/index.js';

const id = 'local-1782941000000-1';

function asset(overrides = {}) {
  return {
    assetId: `${id}-asset-0`,
    purpose: 'original',
    mediaKind: 'video',
    extension: 'mp4',
    contentType: 'video/mp4',
    size: 1024,
    ...overrides,
  };
}

describe('AVTube content-type validation', () => {
  it('accepts video-only Reels', () => {
    assert.equal(validateAsset('reel', asset()).mediaKind, 'video');
  });

  it('rejects image-only Reel originals', () => {
    assert.throws(
      () => validateAsset('reel', asset({
        mediaKind: 'image',
        extension: 'jpg',
        contentType: 'image/jpeg',
      })),
      /A Reel must contain video/,
    );
  });

  it('accepts photo-only Posts', () => {
    assert.equal(
      validateAsset('post', asset({
        mediaKind: 'image',
        extension: 'webp',
        contentType: 'image/webp',
      })).mediaKind,
      'image',
    );
  });

  it('accepts Post albums with one through ten photos and rejects eleven', () => {
    const postAssets = (count) => Array.from({ length: count }, (_, index) =>
      asset({
        assetId: `${id}-asset-${index}`,
        mediaKind: 'image',
        extension: 'jpg',
        contentType: 'image/jpeg',
      }),
    );
    const publishData = {
      id,
      type: 'post',
      audience: 'public',
      caption: '',
    };

    assert.throws(
      () => validatePublishBody({ ...publishData, assets: postAssets(0) }),
      /selected media does not match this content type/,
    );
    assert.equal(validatePublishBody({ ...publishData, assets: postAssets(1) }).assets.length, 1);
    assert.equal(validatePublishBody({ ...publishData, assets: postAssets(10) }).assets.length, 10);
    assert.throws(
      () => validatePublishBody({ ...publishData, assets: postAssets(11) }),
      /selected media does not match this content type/,
    );
  });

  it('rejects video Post originals', () => {
    assert.throws(() => validateAsset('post', asset()), /A Post must contain photo media/);
  });

  it('enforces client-reported Reel and Story duration limits', () => {
    assert.throws(
      () => validateAsset('reel', asset({ durationMs: 180_001 })),
      /Reels must be 3 minutes or shorter/,
    );
    assert.throws(
      () => validateAsset('story', asset({ durationMs: 60_001 })),
      /Story videos must be 60 seconds or shorter/,
    );
  });

  it('keeps Story photos and videos classified as Story media', () => {
    const storyVideo = validateAsset('story', asset());
    const storyPhoto = validateAsset('story', asset({
      mediaKind: 'image',
      extension: 'png',
      contentType: 'image/png',
    }));
    assert.equal(storyVideo.mediaKind, 'video');
    assert.equal(storyPhoto.mediaKind, 'image');
  });

  it('keeps Story video metadata separate from Reel metadata', () => {
    const story = validatePublishBody({
      id,
      type: 'story',
      assets: [asset()],
      audience: 'public',
      caption: '',
    });
    assert.equal(story.type, 'story');
    assert.equal(story.assets[0].mediaKind, 'video');
  });

  it('rejects an extension/content-type mismatch', () => {
    assert.throws(
      () => validateAsset('story', asset({ extension: 'jpg' })),
      /unsupported or do not match/,
    );
  });

  it('rejects content with mismatched Reel/Post media arrays', () => {
    const publishData = {
      id,
      assets: [asset()],
      audience: 'public',
      caption: '',
    };
    assert.throws(
      () => validatePublishBody({ ...publishData, type: 'post' }),
      /A Post must contain photo media/,
    );
    assert.throws(
      () => validatePublishBody({
        ...publishData,
        type: 'reel',
        assets: [asset({
          mediaKind: 'image',
          extension: 'jpg',
          contentType: 'image/jpeg',
        })],
      }),
      /A Reel must contain video/,
    );
  });
});

describe('uploaded media signatures', () => {
  it('checks image and video content signatures', () => {
    const jpeg = validateAsset('post', asset({
      mediaKind: 'image',
      extension: 'jpg',
      contentType: 'image/jpeg',
    }));
    const image = validateAsset('post', asset({
      mediaKind: 'image',
      extension: 'png',
      contentType: 'image/png',
    }));
    const video = validateAsset('reel', asset());
    assert.equal(
      isValidSignature(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        image,
      ),
      true,
    );
    assert.equal(
      isValidSignature(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        jpeg,
      ),
      true,
    );
    assert.equal(
      isValidSignature(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        jpeg,
      ),
      false,
    );
    assert.equal(isValidSignature(new TextEncoder().encode('xxxxftypxxxx'), video), true);
    assert.equal(isValidSignature(new TextEncoder().encode('not a video'), video), false);
  });
});

describe('R2 object key isolation', () => {
  it('uses the verified UID and distinct content folders', () => {
    const video = objectKeyFor('firebase-uid', 'reel', id, asset());
    const photo = objectKeyFor('firebase-uid', 'post', id, asset({
      mediaKind: 'image',
      extension: 'jpg',
      contentType: 'image/jpeg',
    }));
    const story = objectKeyFor('firebase-uid', 'story', id, asset());
    assert.match(video, /^users\/firebase-uid\/reels\//);
    assert.match(photo, /^users\/firebase-uid\/posts\//);
    assert.match(story, /^users\/firebase-uid\/stories\//);
  });

  it('isolates profile photo objects by the authenticated owner', () => {
    const photoId = 'profile-photo-1234';
    assert.equal(
      profilePhotoObjectKey('firebase-uid', photoId),
      `users/firebase-uid/profile-photos/${photoId}.jpg`,
    );
    assert.throws(() => profilePhotoObjectKey('firebase-uid', 'bad/id'), /Invalid profile photo ID/);
  });
});

describe('profile photo upload validation', () => {
  const photoId = 'profile-photo-1234';

  it('accepts a bounded image and rejects oversized or invalid photo requests', () => {
    assert.deepEqual(
      validateProfilePhotoRequest({ photoId, size: 5 * 1024 * 1024 }),
      { photoId, size: 5 * 1024 * 1024 },
    );
    assert.throws(
      () => validateProfilePhotoRequest({ photoId, size: 5 * 1024 * 1024 + 1 }),
      /5 MB or smaller/,
    );
    assert.throws(
      () => validateProfilePhotoRequest({ photoId, size: 0 }),
      /size is missing or invalid/,
    );
  });

  it('recognizes only the matching HTTPS owner and photo URL', () => {
    const photoUrl = `https://media.example/v1/r2/profile-photo/firebase-uid/${photoId}`;
    assert.equal(profilePhotoReferenceMatches(photoUrl, 'firebase-uid', photoId), true);
    assert.equal(profilePhotoReferenceMatches(photoUrl, 'another-user', photoId), false);
    assert.equal(
      profilePhotoReferenceMatches(
        `http://media.example/v1/r2/profile-photo/firebase-uid/${photoId}`,
        'firebase-uid',
        photoId,
      ),
      false,
    );
  });
});

describe('authorized private Story listing', () => {
  const now = 1_800_000_000_000;
  const record = (ownerUid, storyId, visibility, createdAt) => ({
    id: storyId,
    ownerUid,
    mediaType: 'story',
    mediaKind: 'image',
    status: 'published',
    visibility,
    createdAt,
    caption: 'Story caption',
    creatorName: ownerUid,
    creatorUsername: ownerUid,
    assets: [{
      assetId: `${storyId}-asset`,
      purpose: 'original',
      objectKey: `users/${ownerUid}/stories/${storyId}/original.jpg`,
    }],
  });

  it('only returns active private Stories authorized for the current viewer', async () => {
    const records = {
      'follower-owner_followed-story': record(
        'follower-owner',
        'followed-story',
        'followers',
        now - 1_000,
      ),
      'friend-owner_friend-story': record(
        'friend-owner',
        'friend-story',
        'close-friends',
        now - 2_000,
      ),
      'other-owner_private-story': record(
        'other-owner',
        'private-story',
        'followers',
        now - 3_000,
      ),
      'expired-owner_old-story': record(
        'expired-owner',
        'old-story',
        'followers',
        now - 86_400_001,
      ),
    };
    const index = Object.fromEntries(Object.entries(records).map(([key, story]) => [
      key,
      { ownerUid: story.ownerUid, storyId: story.id, createdAt: story.createdAt },
    ]));
    const authorized = await resolveVisiblePrivateStories(
      index,
      'viewer',
      now,
      async (ownerUid, storyId) => records[`${ownerUid}_${storyId}`],
      async (story) =>
        story.ownerUid === 'follower-owner' || story.ownerUid === 'friend-owner',
      async (asset) => `https://signed.example/${asset.objectKey}`,
    );

    assert.deepEqual(authorized.map((story) => story.id), ['followed-story', 'friend-story']);
    assert.ok(authorized.every((story) => story.mediaUrl.startsWith('https://signed.example/')));
    assert.equal(isActivePrivateStory(records['expired-owner_old-story'], 'expired-owner', 'old-story', now), false);
    assert.equal(isActivePrivateStory(
      { ...records['friend-owner_friend-story'], expiresAt: now },
      'friend-owner',
      'friend-story',
      now,
    ), false);
  });

  it('enforces the existing follower and close-friend visibility checks', () => {
    const followerStory = record('creator', 'follower-story', 'followers', now - 1_000);
    const closeFriendStory = record('creator', 'friend-story', 'close-friends', now - 1_000);
    assert.equal(isAuthorizedPrivateStory(followerStory, 'viewer', true, false), true);
    assert.equal(isAuthorizedPrivateStory(followerStory, 'viewer', false, true), false);
    assert.equal(isAuthorizedPrivateStory(closeFriendStory, 'viewer', false, true), true);
    assert.equal(isAuthorizedPrivateStory(closeFriendStory, 'viewer', true, false), false);
    assert.equal(isAuthorizedPrivateStory(closeFriendStory, 'creator', false, false), true);
  });

  it('fails closed until the private Story visibility index is initialized', () => {
    assert.doesNotThrow(() => assertStoryVisibilityIndexReady(1));
    assert.throws(
      () => assertStoryVisibilityIndexReady(null),
      /temporarily unavailable while secure access is prepared/,
    );
  });
});

describe('Worker request guards', () => {
  it('rejects upload URL requests without Firebase authentication', async () => {
    const response = await worker.fetch(new Request(
      'https://worker.example/v1/r2/upload-url',
      { method: 'POST', body: JSON.stringify({}) },
    ), {}, {});
    assert.equal(response.status, 401);
    assert.equal((await response.json()).ok, false);
  });

  it('rejects profile photo upload, confirm, and delete requests without Firebase authentication', async () => {
    for (const path of [
      '/v1/r2/profile-photo/upload-url',
      '/v1/r2/profile-photo/confirm',
      '/v1/r2/profile-photo/delete',
    ]) {
      const response = await worker.fetch(new Request(
        `https://worker.example${path}`,
        { method: 'POST', body: '{}' },
      ), {}, {});
      assert.equal(response.status, 401, path);
    }
  });

  it('rejects private Story listing requests without Firebase authentication', async () => {
    const response = await worker.fetch(new Request(
      'https://worker.example/v1/r2/stories',
      { method: 'POST', body: '{}' },
    ), {}, {});
    assert.equal(response.status, 401);
    assert.equal((await response.json()).ok, false);
  });

  it('answers CORS preflight without credentials', async () => {
    const response = await worker.fetch(new Request(
      'https://worker.example/v1/r2/upload-url',
      { method: 'OPTIONS' },
    ), {}, {});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  });
});
