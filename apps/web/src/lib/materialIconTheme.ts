export interface MaterialIconThemeManifest {
  iconDefinitions: Record<string, { iconPath?: string }>;
  file: string;
  folder: string;
  folderExpanded: string;
  rootFolder: string;
  rootFolderExpanded: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  rootFolderNames: Record<string, string>;
  rootFolderNamesExpanded: Record<string, string>;
}

interface ResolveMaterialIconThemeIconFileParams {
  path: string;
  type: "file" | "directory";
  isExpanded?: boolean;
  isRoot?: boolean;
}

let manifestPromise: Promise<MaterialIconThemeManifest | null> | null = null;

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function basename(filePath: string): string {
  const segments = filePath.split("/");
  return segments[segments.length - 1] ?? filePath;
}

function extensionCandidates(fileName: string): string[] {
  const segments = fileName.split(".");
  if (segments.length <= 1) {
    return [];
  }

  const candidates: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    candidates.push(segments.slice(index).join(".").toLowerCase());
  }
  return candidates;
}

function resolvePublicAssetPath(relativePath: string): string {
  const baseUrl = import.meta.env.BASE_URL ?? "/";
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBaseUrl}${relativePath.replace(/^\/+/, "")}`;
}

function resolveIconId(
  manifest: MaterialIconThemeManifest,
  { path, type, isExpanded = false, isRoot = false }: ResolveMaterialIconThemeIconFileParams,
): string | null {
  const normalizedPath = normalizeLookupKey(path);
  const name = normalizeLookupKey(basename(path));

  if (type === "directory") {
    const rootIconMap = isExpanded ? manifest.rootFolderNamesExpanded : manifest.rootFolderNames;
    const folderIconMap = isExpanded ? manifest.folderNamesExpanded : manifest.folderNames;
    const defaultIconId = isRoot
      ? (isExpanded ? manifest.rootFolderExpanded : manifest.rootFolder)
      : (isExpanded ? manifest.folderExpanded : manifest.folder);

    return (isRoot ? rootIconMap[name] : null) ?? folderIconMap[name] ?? defaultIconId;
  }

  const exactFileNameMatch = manifest.fileNames[normalizedPath] ?? manifest.fileNames[name];
  if (exactFileNameMatch) {
    return exactFileNameMatch;
  }

  for (const candidate of extensionCandidates(name)) {
    const extensionMatch = manifest.fileExtensions[candidate];
    if (extensionMatch) {
      return extensionMatch;
    }
  }

  return manifest.file;
}

export function resolveMaterialIconThemeIconFile(
  manifest: MaterialIconThemeManifest,
  params: ResolveMaterialIconThemeIconFileParams,
): string | null {
  const iconId = resolveIconId(manifest, params);
  if (!iconId) {
    return null;
  }

  const iconPath = manifest.iconDefinitions[iconId]?.iconPath;
  if (!iconPath) {
    return null;
  }

  const iconFileName = basename(iconPath);
  return iconFileName.length > 0 ? iconFileName : null;
}

export function resolveMaterialIconThemeIconUrl(
  manifest: MaterialIconThemeManifest,
  params: ResolveMaterialIconThemeIconFileParams,
): string | null {
  const iconFile = resolveMaterialIconThemeIconFile(manifest, params);
  if (!iconFile) {
    return null;
  }

  return resolvePublicAssetPath(`material-icon-theme/icons/${iconFile}`);
}

export function loadMaterialIconThemeManifest(): Promise<MaterialIconThemeManifest | null> {
  if (!manifestPromise) {
    manifestPromise = fetch(resolvePublicAssetPath("material-icon-theme/material-icons.json"))
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }

        return await response.json() as MaterialIconThemeManifest;
      })
      .catch(() => null);
  }

  return manifestPromise;
}

export function resetMaterialIconThemeManifestCacheForTest() {
  manifestPromise = null;
}
