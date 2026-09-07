# PhotoMap

**Turn your travel photos into a map of China.**

![Photo map concept: add travel photos, fill the corresponding regions, and keep growing your map](docs/images/travel-map-growth.png)

*An illustration of a growing photo map, not an app screenshot or export.*

[简体中文](README.md) · **English**

PhotoMap arranges your travel photos by location within the outlines of Chinese provinces and cities, turning your memories into a photo map you can save and share.

Windows 10 / 11 x64 · Offline desktop app · No account required · Photos stay on your computer

The app interface is currently in Chinese.

[Choose how to use PhotoMap](#ways-to-use-photomap) · [Build from source](#build-from-source) · [Create your first photo map](#create-your-first-photo-map) · [User guide](docs/USAGE.en.md)

## What you can do

### Photo wall: turn your travels into a map

Once you confirm or assign a province or city to your photos, PhotoMap automatically arranges and crops them to fit the corresponding outlines. After each trip, add new photos to the same folder and refresh to keep growing your map.

Use the left sidebar to filter by location, folder, or type. The controls above the map switch between province and city views and adjust photo density. Click a region to browse its photos and pin your preferred selection.

![Photo wall: filter photos on the left, view the collage in the center, and adjust the map view and density above](docs/images/photo-wall.png)

### Postcards: revisit photos and write down their stories

Switch to **「批注模式」 (Annotation mode)** to browse your photos as postcards. Beside each photo, edit its capture time, location, and tags, or write about the moment in **「照片记忆」 (Photo memories)**.

Use **「自动滚动」 (Auto-scroll)** above the postcards to keep browsing. Notes and organization records stay on your computer, making it easier to find photos and revisit their stories later.

![Postcard view: the photo appears on the left, its details, tags, and notes on the right, and auto-scroll controls above](docs/images/postcard.png)

### Batch editing: organize several travel photos at once

In Annotation mode, enable **「批量修改」 (Batch editing)** and select photos in the grid. Use the right panel to replace or clear their locations, or add or remove tags together.

For example, filter the photos from a trip to Yunnan, assign Yunnan Province, and add a trip tag in one go. Write each photo's individual story in the postcard view.

![Batch editing: select photos in the center grid and update their locations and tags together in the right panel](docs/images/batch.png)

### Export editor: save a picture of your journeys

In the photo wall, click **「导出分享图」 (Export share image)**. Add a title, adjust the border spacing, move and resize the whole map and text, and choose text colors and weights. Click **「保存图片」 (Save image)** to export a PNG without the app controls.

The screenshot below shows the layout editor before saving. To change a region's photos or the collage density, return to the photo wall, make your changes, and reopen the export editor.

![Export editor: preview the framed map, edit the title and layout, and save a PNG using the button at the bottom right](docs/images/export.png)

*These four screenshots show the app using AI-generated photos and sample notes, with no private photos.*

<details>
<summary>View an example of the saved PNG</summary>

This image was exported by the app: multiple photos fill the 34 main province-level areas, with an off-white border and a My Photo Map title. It shows the saved result, while the screenshot above shows the editor before saving. The two examples use different demo photo selections and collage densities.

![Exported share image: photos form a map of China with an off-white border and a My Photo Map title, without app controls](docs/images/share-card.png)

*Uses project-generated photos and sample locations, without real travel records. See [ASSETS.md](ASSETS.md) for asset sources and capture settings.*

</details>

## Ways to use PhotoMap

PhotoMap offers two ways to use the app: **portable** and **installed**. Both have the same photo map, organization, and export features.

| Version | How to start | Choose this if you want to… |
| --- | --- | --- |
| **Portable (no installation)** | Keep the entire app folder in a writable location and open `PhotoMap.exe` inside it; do not copy just the `.exe` | Choose where the app folder lives and open it directly |
| **Installer (install before use)** | Run `PhotoMap-Setup.exe`, then open PhotoMap after installation | Install the app like a regular Windows program |

Both packages are currently obtained by [building from source](#build-from-source). If you already have a built package, follow the table above; you do not need to install Node.js or run npm commands.

## Before you start

- **Prepare the maps**: Neither package includes map data. Follow the [map data instructions](docs/USAGE.en.md#map-data) to obtain matching province and city files, then import them into the app, which checks compatibility. Without matching files, you can still browse and organize photos, but the photo wall and GPS-to-province/city lookup are unavailable.
- **Choose some photos**: Start with a few JPG / PNG images. Regular photos can be used in photo maps; videos and Live Photos can be browsed and organized. See [supported media](docs/USAGE.en.md#supported-media) for other formats.
- **GPS is optional**: If photos have GPS data, you can confirm the province and city suggestions generated by the app. Otherwise, assign locations manually or in batches. Both workflows require imported map data to use the photo wall.

## Build from source

Install **Node.js 24.19.0 and npm 11.12.1**; building the installer also requires **PowerShell 7.2+**. Open PowerShell in the project directory containing `package.json` and install dependencies:

```powershell
npm ci
```

Then run one of the following commands for your chosen version:

| Version | Build command | What to do after building |
| --- | --- | --- |
| **Portable** | `npm run package` | Copy the entire `out/PhotoMap-portable-win32-x64/` folder to a writable location outside `out/`, then open `PhotoMap.exe` inside it |
| **Installer** | `npm run make` | Run `out/make/squirrel.windows/x64/PhotoMap-Setup.exe` to install the app |

`npm run make` creates both the installer and the portable app. **You do not need to run `npm run package` first.**

Installing dependencies and downloading the runtime for the first time require an internet connection. Once built, photo scanning, organization, and export run locally and offline.

For development, rebuilding, and download troubleshooting, see the [development guide (in Chinese)](docs/DEVELOPMENT.md#运行与打包).

## Create your first photo map

Try a small folder first: for example, add a few regular photos from Beijing, Shanghai, or Yunnan, then follow these four steps.

1. **Import maps**: Click “导入地图数据” (Import map data) in the app and import the province and city files you prepared.
2. **Choose a photo folder**: Click “选择照片文件夹” (Choose photo folder) and select your small folder. The app scans it and its subfolders.
3. **Confirm locations**: Confirm province and city suggestions from GPS, or assign the actual locations manually or in batches. For example, assign “云南省” (Yunnan Province) to a photo from Yunnan to include it in the province view.
4. **View and export**: Switch to “照片墙模式” (Photo wall mode) to see the photos fill their provinces. Adjust the selection and layout, then click “导出分享图” (Export image) to save a PNG.

The saved image contains your photo map without the app controls. Once you are familiar with the process, select your travel photo folder and keep organizing. See the [user guide](docs/USAGE.en.md) for the city view, batch location editing, and other detailed steps.

## Your data and original files

- Photos and app data stay on your computer. There is no cloud sync or telemetry.
- Scanning and adding notes do not change source media. Renaming changes the original filename, and deleting moves the file to the Windows Recycle Bin. Export with a new filename or into a separate folder to avoid overwriting an original photo.
- The portable app keeps your organization data in `PhotoMapData` beside the app; the installed app uses the current Windows user's data directories. See [data locations](docs/USAGE.en.md#data-locations) for exact paths. Back up your original photos separately.
- To share the portable app, use a clean package that has never been run. To back up your own portable app, keep `PhotoMapData`. See [sharing and backups](docs/USAGE.en.md#sharing-and-backing-up-the-portable-app).

## Documentation and contributing

- [User guide](docs/USAGE.en.md): Map imports, media formats, data locations, and privacy
- [Development guide](docs/DEVELOPMENT.md): Setup, packaging, troubleshooting, and tests
- [Contributing](CONTRIBUTING.en.md) · [Changelog](CHANGELOG.md)
- [Security reports](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

The development guide, changelog, project policy documents and asset documentation are currently Chinese only. Chinese is this project's canonical language: where a translation and the Chinese text disagree, the Chinese text prevails.

## License

The source code is licensed under [MIT](LICENSE). For asset and third-party component licenses, see [ASSETS.md](ASSETS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
