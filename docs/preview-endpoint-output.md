# Preview Endpoint Output (`POST https://api.eeetik.app/api/v2/model/download/tiktok`)

This endpoint is used when user sends a TikTok URL to get preview metadata.
All media URL examples below intentionally use signed CDN links (`cdn.eeetik.app`) rather than direct object-storage endpoints.

## Request

```http
POST https://api.eeetik.app/api/v2/model/download/tiktok
Content-Type: application/json
Origin: https://eeetik.app

{
  "url": "https://www.tiktok.com/@username/video/7350000000000000000"
}
```

## Success envelope

All successful responses use this envelope:

```json
{
  "success": true,
  "data": {}
}
```

`data` always includes:

- `uniqueId`
- `type`
- `title`
- `author` (`nickname`, `avatar`)
- `stats` (`views`, `likes`, `shares`, `comments`)
- `hashtags`
- `availableFormats`

## Example Success (Video Post)

```json
{
  "success": true,
  "data": {
    "uniqueId": "5dbd40bd-5cd3-4f3e-8245-58b3da527529",
    "type": "video",
    "title": "Video caption from TikTok",
    "author": {
      "nickname": "creator_name",
      "avatar": "https://cdn.eeetik.app/media/<signed-avatar-url>?exp=...&sig=..."
    },
    "stats": {
      "views": "297.3K",
      "likes": "26.1K",
      "shares": "1.7K",
      "comments": "93"
    },
    "hashtags": ["#fyp", "#travel"],
    "availableFormats": {
      "video": [
        {
          "id": "hd",
          "label": "HD Video (1080p - No Watermark)"
        },
        {
          "id": "sd",
          "label": "SD Video (720p - No Watermark)"
        }
      ],
      "audio": [
        {
          "id": "audio",
          "label": "Audio Only (MP3)"
        }
      ]
    },
    "thumbnail": "https://cdn.eeetik.app/media/<signed-thumbnail-url>?exp=...&sig=...",
    "duration": 17
  }
}
```

## Example Success (Image Post)

```json
{
  "success": true,
  "data": {
    "uniqueId": "5773b31b-11c0-449c-a355-8f9808f7d446",
    "type": "image",
    "title": "Photo carousel caption",
    "author": {
      "nickname": "creator_name",
      "avatar": "https://cdn.eeetik.app/media/<signed-avatar-url>?exp=...&sig=..."
    },
    "stats": {
      "views": "1.2M",
      "likes": "80.4K",
      "shares": "5.2K",
      "comments": "900"
    },
    "hashtags": ["#photo", "#carousel"],
    "availableFormats": {
      "images": [
        {
          "id": "zip",
          "label": "Download All (ZIP)"
        }
      ],
      "audio": [
        {
          "id": "audio",
          "label": "Background Music (MP3)"
        }
      ]
    },
    "images": [
      "https://cdn.eeetik.app/media/<signed-image-url-1>?exp=...&sig=...",
      "https://cdn.eeetik.app/media/<signed-image-url-2>?exp=...&sig=..."
    ]
  }
}
```

## Example Rejection (Non-TikTok URL)

```json
{
  "statusCode": 400,
  "message": "Only TikTok URLs are supported",
  "error": "Bad Request"
}
```

## Example Rejection (Non-HTTPS URL)

```json
{
  "statusCode": 400,
  "message": "Only HTTPS TikTok URLs are supported",
  "error": "Bad Request"
}
```

## Security Rules Enforced

1. URL must be valid.
2. URL must be `https://`.
3. Host must be `tiktok.com` or subdomain of `.tiktok.com` only.
4. Frontend domain must pass `SITE_DOMAIN_ALLOWLIST` guard.
5. Returned media URLs are short-lived signed CDN URLs (`cdn.eeetik.app`), not direct storage URLs.
