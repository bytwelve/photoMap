# User guide

[简体中文](USAGE.md) · **English**

[Back to PhotoMap](../README.en.md) · [Development guide (in Chinese)](DEVELOPMENT.md)

Chinese is this project's canonical language: where this translation and [the Chinese guide](USAGE.md) disagree, the Chinese text prevails.

The app currently has a Chinese interface and supports Windows x64, one active media folder, and province / city maps of China. The steps below include the Chinese labels you will see. After adding, moving, or deleting media outside the app, refresh the folder or restart the app to update the index.

## First use

1. **Import map data.** In photo wall mode (照片墙模式), click Import map data (导入地图数据) and import the two validated GeoJSON files for provinces and cities (see [Map data](#map-data)). Both files are required for GPS-to-province/city matching and the photo wall.
2. **Choose a media folder.** Click Choose photo folder (选择照片文件夹) and select a local folder. The app builds a basic media index recursively and displays results as the scan progresses.
3. **Review metadata suggestions.** The scan reads image metadata locally. You can ignore the suggested GPS locations and capture times, apply the suggestions and overwrite existing locations, or fill in missing information only (仅为缺少信息的照片补充). Scans never overwrite capture times you have edited manually.
4. **Organize your memories.** In annotation mode (批注模式), use the postcard view (明信片) or batch editing (批量修改) to edit locations, tags, capture times, and notes. Filter by folder, media type, location, or keyword.
5. **Create a photo wall.** Switch between province and city levels, then adjust density, the visible map area, place names, and the photos pinned to each region. Province view requires province labels; city view also requires city labels.
6. **Export an image to share.** Open Export image (导出分享图) from the photo wall, check the layout, and save a PNG. The exported image excludes the app's controls.

You can also start in annotation mode to browse photos, add notes, or label locations manually, then import the maps later.

> [!NOTE]
> Without map data, the app still checks EXIF, GPS, and capture times locally to produce scan counts and save capture times you confirm. It cannot convert raw GPS coordinates into province/city suggestions. Parsed coordinates are not written to SQLite, settings, caches, or diagnostic logs, and are not passed to the interface as data fields. Original images retain their metadata, and previews may read original files containing that metadata.

## Supported media

| Category | Extensions | Current behavior |
| --- | --- | --- |
| Standard images | `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.avif` | Can be annotated; standard photos that decode successfully and have location labels can appear in the photo wall |
| Standard videos | `.mp4`, `.mov`, `.m4v` | Grid covers use the Windows thumbnail provider; postcards play videos on a muted loop by default, with pause, seeking, and sound controls |
| Apple Live Photo | Matching JPG / HEIC + MOV | Combined into one logical item; only the active postcard loads the motion content; deletion and renaming may affect both source files |
| Android Motion Photo | JPG / HEIC / AVIF with valid XMP and an actual embedded video payload at the end of the file | Treated as a single-file motion photo; leftover XMP without a video payload is not treated as one |
| Exported images | `.png` | The export interface supports PNG only |

- HEIC / HEIF, AVIF, and video thumbnail decoding depend on the media capabilities available to Windows / Electron on your system. If decoding fails, the media remains in the index with an error placeholder.
- The metadata reader attempts all supported image formats, but existing regression coverage mainly covers JPEG / PNG. Compatibility with every HEIC / AVIF variant is not guaranteed.
- RAW, GIF, WebP, standalone audio, and other unlisted formats are not supported.

## Map data

The installer and portable package **do not include** the two GeoJSON files needed for province and city geometry. The map data download action opens the [Tianditu Cloud Center administrative division download page](https://cloudcenter.tianditu.gov.cn/administrativeDivision) in your system browser, where you obtain the upstream files separately.

**Availability status: as of September 10, 2026, obtaining compatible files again from the official source has not been verified.** The project cannot currently guarantee that a new user can download the exact versions accepted by the app. Confirm that both files import successfully before investing time in organizing photos. See the source and verification record in [ASSETS.md (in Chinese)](../ASSETS.md#上游依据与核验状态).

The supported files are pinned in [map-data-manifest.json](../src/shared/map-data-manifest.json). This is the project's compatibility manifest, not an upstream version name. Import validation uses the exact file bytes, not the filename:

| Type | Filename used by the app | Size | SHA-256 |
| --- | --- | ---: | --- |
| Provinces | `china-provinces.geojson` | 1,698,398 bytes | `3af8294f9ad61cc2bf84c1bb7e4bbf86a6336c68d754b699a0e6ddc33ef81486` |
| Cities | `china-city-view.geojson` | 4,265,699 bytes | `d7a6f05b7e58cf758d74bd71ed0ea2ce981ef99436e4881e9a68098c3cd80b3b` |

### Download and import

1. Open the official page above, review its terms, and obtain the province and city GeoJSON files. The app accepts only the exact versions listed above; newer upstream files may not match. Verify the files before importing.
2. Preserve the downloaded bytes. Do not reformat, change the encoding, or resave the files in an editor. You do not need to rename them to the filenames used by the app in the table above.
3. Import directly and let the app validate the files, or check them in PowerShell with `Get-Item -LiteralPath 'path-to-file' | Select-Object Length` and `Get-FileHash -LiteralPath 'path-to-file' -Algorithm SHA256`. Compare the results with the table above.
4. Click Import map data (导入地图数据) and select the province and city files together or in separate imports. Once both imports succeed, choose your media folder, let it scan, and confirm the location suggestions. If you scanned a folder earlier, follow the prompt after import to review the new scan results.

If you cannot obtain matching files, you can still browse photos, edit notes, and label locations manually. The photo wall and GPS-to-province/city matching will remain unavailable. Open an issue with the app version, official source page, file sizes, and SHA-256 hashes to request verification of a new version. You do not need to upload the map files or private photos. Renaming a file cannot fix a hash mismatch, and a newer download may also be incompatible.

Before supporting updated upstream files, maintainers must verify their source terms, region codes, and map behavior, then update the compatibility manifest and administrative region catalog. Arbitrary GeoJSON files are not currently supported. See [ASSETS.md (in Chinese)](../ASSETS.md) for the source record.

### Validation rules

- Province and city files can be imported separately. Both must pass validation to fully enable the photo wall and GPS-to-province/city matching.
- Invalid, truncated, unreadable, or hash-mismatched files are not copied. Even a semantically equivalent upstream update is rejected if its bytes differ.
- The lightweight administrative region catalog shipped with the app is used only for filtering, display, and manual annotation. It contains no map geometry. Maintainers can find its generation and verification instructions in the [development guide (in Chinese)](DEVELOPMENT.md).

## Data, privacy, and source files

### Network behavior at runtime

- Scanning, metadata reading, indexing, filtering, thumbnail generation, and export all run locally. There are no accounts, cloud sync, or telemetry.
- The packaged app's renderer blocks HTTP(S) / WebSocket requests and rejects permission requests, pop-ups, and navigation to other pages.
- Clicking the map data download action explicitly opens the system browser from the main process. This is the only external webpage action designed into the app at runtime.

### What is saved locally

The app saves the media root and relative paths; file hashes, sizes, and timestamps; media types and status; your tags and notes; capture times; derived provinces and cities you confirm; settings; thumbnail caches; and limited diagnostic counts.

- Parsed GPS coordinates are not written to app data or passed to the interface as data fields. Original images retain their metadata, and previews may read original files containing it.
- Diagnostic logs do not include full paths, tag contents, raw EXIF / GPS data, or coordinates.
- There is no app-level data encryption. Anyone with access to the corresponding Windows account's data folders may be able to read this data.
- Indexes, thumbnails, and sidecar files are not written to your selected media folder.

### Data locations

| Package type | App state | Imported map data |
| --- | --- | --- |
| Squirrel installer | `%LOCALAPPDATA%\PhotoMap\` | `%LOCALAPPDATA%\PhotoMapData\data\map-data\v1\` |
| Explicit portable mode | `<EXE directory>\PhotoMapData\` | `<EXE directory>\PhotoMapData\data\map-data\v1\` |

Portable mode is enabled only when a regular file named `photomap.portable` exists alongside `PhotoMap.exe`. It redirects Electron's `userData`, `sessionData`, `logs`, `temp`, and `crashDumps` to the portable data folder. If that folder is not writable, the app refuses to start instead of silently falling back to the C: drive.

### Sharing and backing up the portable app

To share the software, use a clean portable package that has never been run and contains no `PhotoMapData` folder. Keep the whole application folder together. After use, `PhotoMapData` may contain personal paths, tags, notes, thumbnails, and maps you imported; it should not be shared with the software.

To back up your own organization records, close the app first, then back up the entire portable folder, including `PhotoMapData`. Back up source media separately: the app only indexes your selected folder and does not automatically copy source photos into the portable package.

### Which actions change source files?

| Action | Changes source files? | Details |
| --- | --- | --- |
| Scanning, annotation, filtering, thumbnail generation | No | Source media is read only; organization records and caches are written to the app's data folder |
| Export | **Depends on the save path** | Writes to the path you choose. Selecting an existing source PNG and confirming overwrite replaces the original image. Use a new filename or a separate export folder |
| Rename | **Yes** | Renaming is limited to the original folder and must preserve the extension. If a multi-file Live Photo rename fails and rollback also fails, the app explicitly reports partial completion |
| Confirmed deletion | **Yes** | Moves files to the Windows Recycle Bin without permanently deleting them or emptying the bin. For Apple Live Photos, the app attempts to move both the still image and its companion MOV |

Before deletion, the app checks that source files still match the scan records. If a file has changed outside the app, refresh the folder before confirming. The two files of a Live Photo cannot be guaranteed to move successfully together: if the video moves to the Recycle Bin but the image does not, the interface reports partial completion and leaves the remaining image in the list. You can release any file lock and retry. The video can be restored from the Windows Recycle Bin; to restore the Live Photo pair, restore the original files and refresh the media folder.
