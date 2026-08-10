export function photoMediaUrl(photoId: string): `photomap-media://photo/${string}` {
  return `photomap-media://photo/${encodeURIComponent(photoId)}`;
}

export function photoThumbnailUrl(photoId: string): `photomap-media://photo/${string}?size=thumb` {
  return `photomap-media://photo/${encodeURIComponent(photoId)}?size=thumb`;
}
