import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readAppFile(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
}

describe('release map-data packaging contract', () => {
  it('uses only repository-local runtime assets', () => {
    const forgeConfig = readAppFile('forge.config.ts');

    expect(forgeConfig).toContain("const runtimeMap = path.resolve(__dirname, 'resources/map');");
    expect(forgeConfig).toMatch(/extraResource:\s*\[runtimeMap, runtimeLicenses\]/u);
  });

  it('pins all four runtime map assets by exact SHA-256', () => {
    const expected = {
      'terrain-expanded-uniform-r16.png': 'aa76fa763b2a9c2375580efec94b975f9b385e0bf03f1ec5c9646110d80f7fbc',
      'terrain-coast-repair-uniform-r16.png': '190f83fa67bda13ed5a0b7b601fabd615547d54a0cf270e8e92de89e409039bc',
      'province-lines-uniform-r16.png': '8ca854be5a9ed74987b2d30f65f278ed40ebaaf6d56cfefcf5c93b90f57b455f',
      'national-outline-uniform-r16.png': '3d77d12a965b25ad574797afca61a3319bb5c355f5ede536e09c49619ba8f9b1',
    } as const;

    for (const [fileName, sha256] of Object.entries(expected)) {
      const bytes = readFileSync(new URL(`../../resources/map/${fileName}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    }
  });

  it('connects directory, portable ZIP and installer package validation to the release flow', () => {
    const publishRelease = readAppFile('scripts/release/assemble-release.ps1');

    expect(publishRelease).toContain("Assert-ArtifactDirectoryClean $portableSource 'Portable source'");
    expect(publishRelease).toContain("Assert-ArtifactArchiveClean $zipPath 'Portable ZIP'");
    expect(publishRelease).toContain("Assert-ArtifactArchiveClean $nupkgSource 'Installer package'");
  });

  it('keeps runtime map imports out of Git outputs and rejects exact private blobs from public tags', () => {
    const repositoryIgnore = readAppFile('.gitignore');
    const publishRelease = readAppFile('scripts/release/assemble-release.ps1');
    const prepareGitHubRelease = readAppFile('scripts/release/prepare-github-release.ps1');

    expect(repositoryIgnore).toMatch(/^PhotoMapData\/$/m);
    expect(repositoryIgnore).toMatch(/^releases\/$/m);
    expect(publishRelease).toContain("$releaseRoot = Join-Path $appRoot 'releases'");
    expect(prepareGitHubRelease).toContain("$releaseRoot = Join-Path $appRoot 'releases'");
    expect(prepareGitHubRelease).toContain("'5d3aacc1f6ebc929303f4abcc015225b22e68399'");
    expect(prepareGitHubRelease).toContain("'985f4d8e736850db3ed046eb2d4e38fa9e32885f'");
    expect(prepareGitHubRelease).toContain("'ls-tree', '-r', '--full-tree', $tagCommit");
    expect(prepareGitHubRelease).toContain('Test-ForbiddenArtifactPath -Path $entryPath -Source');
    expect(prepareGitHubRelease).toContain("Assert-ArtifactArchiveClean $portableItem.FullName 'Public portable archive'");
    expect(prepareGitHubRelease).toContain('Create the public tag from a sanitized tree.');
  });
});
