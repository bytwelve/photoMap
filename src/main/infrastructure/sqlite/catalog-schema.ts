export const CATALOG_SCHEMA_VERSION = 5;

export const CATALOG_V1_COLUMNS = {
  library_source: [
    'source_id',
    'root_path',
    'canonical_root_key',
    'is_active',
    'availability',
    'last_scan_run_id',
    'created_at',
    'updated_at',
  ],
  photo: [
    'photo_id',
    'source_id',
    'display_path',
    'relative_path',
    'canonical_path_key',
    'file_size',
    'modified_at_ms',
    'content_sha256',
    'image_format',
    'pixel_width',
    'pixel_height',
    'decode_state',
    'lifecycle_state',
    'last_seen_scan_run_id',
    'created_at',
    'updated_at',
  ],
  photo_place: ['photo_id', 'province_gb', 'city_gb', 'assigned_at'],
  photo_type: ['type_id', 'name', 'normalized_name', 'is_builtin', 'created_at', 'updated_at'],
  photo_type_link: ['photo_id', 'type_id', 'assigned_at'],
  scan_run: [
    'run_id',
    'source_id',
    'status',
    'discovered_count',
    'indexed_count',
    'unchanged_count',
    'error_count',
    'started_at',
    'finished_at',
  ],
  metadata: ['key', 'value'],
} as const;

export const CATALOG_REQUIRED_INDEXES = [
  'one_active_library_source',
  'one_current_photo_per_path',
  'photo_by_source_hash',
] as const;

export const CATALOG_V4_COLUMNS = {
  photo: ['media_kind', 'media_format'],
  photo_companion: [
    'photo_id',
    'display_path',
    'relative_path',
    'canonical_path_key',
    'file_size',
    'modified_at_ms',
    'file_created_at_ms',
    'content_sha256',
    'media_format',
    'created_at',
    'updated_at',
  ],
} as const;

export const CATALOG_V5_COLUMNS = {
  photo: ['capture_time_local', 'capture_time_offset_minutes', 'capture_time_source'],
} as const;
