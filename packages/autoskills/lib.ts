import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import type { Technology, ComboSkill, FileContentPatternBlock } from "./skills-map.ts";

export {
  SKILLS_MAP,
  COMBO_SKILLS_MAP,
  FRONTEND_PACKAGES,
  FRONTEND_BONUS_SKILLS,
  WEB_FRONTEND_EXTENSIONS,
  AGENT_FOLDER_MAP,
} from "./skills-map.ts";

export type { Technology, ComboSkill, ConfigFileContentBlock } from "./skills-map.ts";

import {
  SKILLS_MAP,
  COMBO_SKILLS_MAP,
  FRONTEND_PACKAGES,
  FRONTEND_BONUS_SKILLS,
  WEB_FRONTEND_EXTENSIONS,
  AGENT_FOLDER_MAP,
} from "./skills-map.ts";

// ── Internal Constants ───────────────────────────────────────

const AGENT_FOLDER_ENTRIES = Object.entries(AGENT_FOLDER_MAP);

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  ".next",
  "dist",
  "build",
  ".output",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".cache",
  "coverage",
  ".turbo",
  ".terraform",
  "var",
  "bin",
  "obj",
  ".vs",
  "target",
  "out",
  "DerivedData",
  "Pods",
  "venv",
  "tox",
  "_build",
  "bower_components",
]);

const GRADLE_BUILD_FILES = ["build.gradle.kts", "build.gradle"];
const GRADLE_SETTINGS_FILES = ["settings.gradle.kts", "settings.gradle"];

const ROOT_BUILD_MANIFESTS = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  ...GRADLE_BUILD_FILES,
  ...GRADLE_SETTINGS_FILES,
  "gradle/libs.versions.toml",
  "pom.xml",
  "Directory.Packages.props",
  "Directory.Build.props",
  "global.json",
  "NuGet.Config",
  "go.work",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "Package.swift",
];

// Manifests whose content declares sibling members
const MEMBER_DECLARING_MANIFESTS = [...GRADLE_SETTINGS_FILES, "pom.xml", "Cargo.toml", "go.work"];

// Manifests indexed for content scanning in every discovered member
const MEMBER_MANIFEST_NAMES = [
  "package.json",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "Cargo.toml",
  "go.mod",
  "Package.swift",
  "Directory.Packages.props",
  "Directory.Build.props",
  "global.json",
  ...GRADLE_SETTINGS_FILES,
  ...GRADLE_BUILD_FILES,
];

// Scans deeper than the extension probes so nested sources are reachable
const SCAN_DEPTH = 6;

const DOTNET_PROJECT_EXTENSIONS = [".csproj", ".fsproj", ".vbproj", ".sln"];
const DOTNET_PROJECT_DEPTH = 2;

// Depth for dirs that carry a build manifest without being declared anywhere
const UNDECLARED_MEMBER_DEPTH = 2;

// ── Gradle Scanning ──────────────────────────────────────────

export function parseSettingsGradleModules(content: string): string[] {
  const modules: string[] = [];
  const includeRe = /include\s*\(?\s*([^)]+)/g;
  let includeMatch;
  while ((includeMatch = includeRe.exec(content)) !== null) {
    const args = includeMatch[1];
    const quotedRe = /['"]([^'"]+)['"]/g;
    let quotedMatch;
    while ((quotedMatch = quotedRe.exec(args)) !== null) {
      modules.push(quotedMatch[1].replace(/^:/, "").replace(/:/g, "/"));
    }
  }
  return modules;
}

// ── Scan Cache ───────────────────────────────────────────────

interface ScanCache {
  read(filePath: string): string | null;
  exists(filePath: string): boolean;
  hasExtension(dir: string, extensions: string[]): boolean;
  hasContentMatch(dir: string, query: FileContentPatternBlock): boolean;
}

function createScanCache(): ScanCache {
  const contentByPath = new Map<string, string | null>();
  const existsByPath = new Map<string, boolean>();
  const extensionByKey = new Map<string, boolean>();
  const contentMatchByKey = new Map<string, boolean>();

  const cache: ScanCache = {
    read(filePath: string): string | null {
      const cachedContent = contentByPath.get(filePath);
      if (cachedContent !== undefined) return cachedContent;
      let fileContent: string | null = null;
      try {
        fileContent = readFileSync(filePath, "utf-8");
      } catch {
        fileContent = null;
      }
      contentByPath.set(filePath, fileContent);
      if (fileContent !== null) existsByPath.set(filePath, true);
      return fileContent;
    },

    exists(filePath: string): boolean {
      const cachedExists = existsByPath.get(filePath);
      if (cachedExists !== undefined) return cachedExists;
      const found = existsSync(filePath);
      existsByPath.set(filePath, found);
      return found;
    },

    hasExtension(dir: string, extensions: string[]): boolean {
      const key = `${dir}\0${extensions.join("\0")}`;
      const cachedScan = extensionByKey.get(key);
      if (cachedScan !== undefined) return cachedScan;
      const found = hasFileWithExtension(dir, extensions, SCAN_DEPTH);
      extensionByKey.set(key, found);
      return found;
    },

    hasContentMatch(dir: string, query: FileContentPatternBlock): boolean {
      const key = `${dir}\0${query.extensions.join("\0")}\0${query.patterns.join("\0")}`;
      const cachedMatch = contentMatchByKey.get(key);
      if (cachedMatch !== undefined) return cachedMatch;
      const found = findFileWithContentMatch({
        dir,
        extensions: query.extensions,
        patterns: query.patterns,
        read: cache.read,
      });
      contentMatchByKey.set(key, found);
      return found;
    },
  };

  return cache;
}

// ── Declared Members ─────────────────────────────────────────

function parseMavenModules(content: string): string[] {
  const modulesBlock = content.match(/<modules>([\s\S]*?)<\/modules>/);
  if (!modulesBlock) return [];
  return [...modulesBlock[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map(
    (match) => match[1],
  );
}

function parseGoWorkspaceUses(content: string): string[] {
  const uses: string[] = [];

  for (const useBlock of content.matchAll(/use\s*\(([^)]*)\)/g)) {
    for (const token of useBlock[1].split(/\s+/)) {
      const usePath = token.replace(/^"|"$/g, "");
      if (usePath) uses.push(usePath);
    }
  }

  for (const useLine of content.matchAll(/^\s*use\s+"?([^"\s(][^\s"]*)"?\s*$/gm)) {
    uses.push(useLine[1]);
  }

  return uses;
}

function parseCargoWorkspaceMembers(content: string): string[] {
  const workspaceBlock = content.match(/\[workspace\]([\s\S]*?)(?:\n\s*\[|$)/);
  const membersList = workspaceBlock?.[1].match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersList) return [];
  return membersList[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

const MEMBER_DECLARING_PARSERS: Record<string, (content: string) => string[]> = {
  "settings.gradle": parseSettingsGradleModules,
  "settings.gradle.kts": parseSettingsGradleModules,
  "pom.xml": parseMavenModules,
  "go.work": parseGoWorkspaceUses,
  "Cargo.toml": parseCargoWorkspaceMembers,
};

function resolveDeclaredMembers(projectDir: string, cache: ScanCache): string[] {
  const rootDir = resolve(projectDir);
  const members: string[] = [];
  const seen = new Set<string>();

  for (const name of MEMBER_DECLARING_MANIFESTS) {
    const content = cache.read(join(projectDir, name));
    if (content === null) continue;
    for (const declaredPath of MEMBER_DECLARING_PARSERS[name](content)) {
      const memberDir = resolve(projectDir, declaredPath);
      if (memberDir === rootDir || seen.has(memberDir)) continue;
      seen.add(memberDir);
      members.push(memberDir);
    }
  }

  return members;
}

// Finds dirs holding a build manifest that no workspace file declared
function discoverUndeclaredMembers(projectDir: string, cache: ScanCache): string[] {
  const members: string[] = [];

  function scan(dir: string, depth: number): void {
    for (const entry of readDirEntries(dir)) {
      if (!isScannableDir(entry)) continue;
      const entryPath = join(dir, entry.name);
      const holdsManifest = MEMBER_MANIFEST_NAMES.some((name) =>
        cache.exists(join(entryPath, name)),
      );
      if (holdsManifest) members.push(entryPath);
      else if (depth < UNDECLARED_MEMBER_DEPTH) scan(entryPath, depth + 1);
    }
  }

  scan(projectDir, 0);
  return members;
}

// ── Manifest Discovery ───────────────────────────────────────

function readDirEntries(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isScannableDir(entry: import("node:fs").Dirent): boolean {
  return entry.isDirectory() && !entry.name.startsWith(".") && !SCAN_SKIP_DIRS.has(entry.name);
}

interface ManifestCandidateInput {
  memberDirs: Set<string>;
}

function buildManifestCandidatePaths(
  projectDir: string,
  { memberDirs }: ManifestCandidateInput,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (filePath: string): void => {
    if (!seen.has(filePath)) {
      candidates.push(filePath);
      seen.add(filePath);
    }
  };

  const addMemberManifests = (dir: string): void => {
    for (const name of MEMBER_MANIFEST_NAMES) {
      add(join(dir, name));
    }
  };

  const addDotNetProjectFiles = (dir: string, depth: number): void => {
    for (const entry of readDirEntries(dir)) {
      const entryPath = join(dir, entry.name);
      if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        if (DOTNET_PROJECT_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
          add(entryPath);
        }
      } else if (isScannableDir(entry) && depth < DOTNET_PROJECT_DEPTH) {
        addDotNetProjectFiles(entryPath, depth + 1);
      }
    }
  };

  for (const name of ROOT_BUILD_MANIFESTS) {
    add(join(projectDir, name));
  }

  addDotNetProjectFiles(projectDir, 0);

  for (const entry of readDirEntries(projectDir)) {
    if (isScannableDir(entry)) addMemberManifests(join(projectDir, entry.name));
  }

  for (const memberDir of memberDirs) {
    addMemberManifests(memberDir);
  }

  return candidates;
}

// ── Project File Scanning ────────────────────────────────────

function hasFileWithExtension(
  projectDir: string,
  extensions: string[],
  maxDepth: number = 4,
): boolean {
  const normalized = new Set(
    extensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()),
  );
  const normalizedExtensions = [...normalized];

  function scan(dir: string, depth: number): boolean {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        if (normalizedExtensions.some((ext) => lowerName.endsWith(ext))) return true;
      } else if (entry.isDirectory() && depth < maxDepth) {
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (scan(join(dir, entry.name), depth + 1)) return true;
      }
    }

    return false;
  }

  return scan(projectDir, 0);
}

interface ContentMatchScan {
  dir: string;
  extensions: string[];
  patterns: string[];
  read: (filePath: string) => string | null;
}

function findFileWithContentMatch(scan: ContentMatchScan, depth: number = 0): boolean {
  const extensions = new Set(
    scan.extensions.map((extension) =>
      (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase(),
    ),
  );
  const patterns = scan.patterns.map((pattern) => pattern.toLowerCase());

  for (const entry of readDirEntries(scan.dir)) {
    const entryPath = join(scan.dir, entry.name);
    if (entry.isFile()) {
      const lowerName = entry.name.toLowerCase();
      const extensionMatched = [...extensions].some((extension) => lowerName.endsWith(extension));
      if (!extensionMatched) continue;
      const fileContent = scan.read(entryPath);
      if (fileContent === null) continue;
      const lowerContent = fileContent.toLowerCase();
      if (patterns.some((pattern) => lowerContent.includes(pattern))) return true;
    } else if (isScannableDir(entry) && depth < SCAN_DEPTH) {
      if (findFileWithContentMatch({ ...scan, dir: entryPath }, depth + 1)) return true;
    }
  }

  return false;
}

// ── Frontend File Scanning ───────────────────────────────────

export function hasWebFrontendFiles(projectDir: string, maxDepth: number = SCAN_DEPTH): boolean {
  function scan(dir: string, depth: number): boolean {
    const entries = readDirEntries(dir);

    for (const entry of entries) {
      if (entry.isFile()) {
        const name = entry.name;
        if (name.endsWith(".blade.php")) return true;

        const dot = name.lastIndexOf(".");
        if (dot !== -1 && WEB_FRONTEND_EXTENSIONS.has(name.slice(dot))) return true;
      } else if (entry.isDirectory() && depth < maxDepth) {
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (scan(join(dir, entry.name), depth + 1)) return true;
      }
    }

    return false;
  }

  return scan(projectDir, 0);
}

// ── Workspace Resolution ──────────────────────────────────────

function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split("\n");
  const patterns: string[] = [];
  let inPackages = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "packages:" || line === "packages :") {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (line.startsWith("- ")) {
        patterns.push(
          line
            .slice(2)
            .trim()
            .replace(/^['"]|['"]$/g, ""),
        );
      } else if (line !== "" && !line.startsWith("#")) {
        break;
      }
    }
  }

  return patterns;
}

function expandWorkspacePatterns(projectDir: string, patterns: string[]): string[] {
  const dirs: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const parent = join(projectDir, pattern.replace(/\/?\*.*$/, ""));
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))
          continue;
        const wsDir = join(parent, entry.name);
        if (
          existsSync(join(wsDir, "package.json")) ||
          existsSync(join(wsDir, "deno.json")) ||
          existsSync(join(wsDir, "deno.jsonc"))
        ) {
          dirs.push(wsDir);
        }
      }
    } else {
      const wsDir = join(projectDir, pattern);
      if (
        existsSync(join(wsDir, "package.json")) ||
        existsSync(join(wsDir, "deno.json")) ||
        existsSync(join(wsDir, "deno.jsonc"))
      ) {
        dirs.push(wsDir);
      }
    }
  }

  return dirs;
}

interface PreloadedManifests {
  pkg?: Record<string, unknown> | null;
  denoJson?: Record<string, unknown> | null;
}

export function resolveWorkspaces(projectDir: string, preloaded?: PreloadedManifests): string[] {
  const pnpmPath = join(projectDir, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const content = readFileSync(pnpmPath, "utf-8");
      const patterns = parsePnpmWorkspaceYaml(content);
      if (patterns.length > 0) {
        return expandWorkspacePatterns(projectDir, patterns).filter(
          (d) => resolve(d) !== resolve(projectDir),
        );
      }
    } catch {}
  }

  const pkg = preloaded?.pkg !== undefined ? preloaded.pkg : readPackageJson(projectDir);
  if (pkg) {
    const ws = (pkg as Record<string, unknown>).workspaces;
    const patterns = Array.isArray(ws)
      ? (ws as string[])
      : Array.isArray((ws as Record<string, unknown>)?.packages)
        ? (ws as Record<string, string[]>).packages
        : null;
    if (patterns && patterns.length > 0) {
      return expandWorkspacePatterns(projectDir, patterns).filter(
        (d) => resolve(d) !== resolve(projectDir),
      );
    }
  }

  const denoJson =
    preloaded?.denoJson !== undefined ? preloaded.denoJson : readDenoJson(projectDir);
  if (denoJson?.workspace) {
    const members = Array.isArray(denoJson.workspace) ? (denoJson.workspace as string[]) : [];
    if (members.length > 0) {
      return expandWorkspacePatterns(projectDir, members).filter(
        (d) => resolve(d) !== resolve(projectDir),
      );
    }
  }

  return [];
}

// ── Detection ─────────────────────────────────────────────────

export function readGemfile(dir: string): string[] {
  const gemfilePath = join(dir, "Gemfile");
  if (!existsSync(gemfilePath)) return [];

  try {
    const content = readFileSync(gemfilePath, "utf-8");
    const gems: string[] = [];
    const gemRegex = /^\s*gem\s+['"]([^'"]+)['"]/gm;
    let match;
    while ((match = gemRegex.exec(content)) !== null) {
      gems.push(match[1]);
    }
    return gems;
  } catch {
    return [];
  }
}

export function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  } catch {
    return null;
  }
}

export function readDenoJson(dir: string): Record<string, unknown> | null {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf-8"));
    } catch {
      continue;
    }
  }
  return null;
}

export function getDenoImportNames(denoJson: Record<string, unknown> | null): string[] {
  if (!denoJson?.imports) return [];
  return Object.values(denoJson.imports as Record<string, string>)
    .filter((s) => typeof s === "string" && (s.startsWith("npm:") || s.startsWith("jsr:")))
    .map((specifier) => {
      const bare = specifier.replace(/^(?:npm|jsr):/, "");
      if (bare.startsWith("@")) {
        return bare.replace(/^(@[^/]+\/[^@]+).*$/, "$1");
      }
      return bare.replace(/@.*$/, "");
    });
}

export function getAllPackageNames(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];

  return [
    ...Object.keys((pkg.dependencies as Record<string, string>) || {}),
    ...Object.keys((pkg.devDependencies as Record<string, string>) || {}),
  ];
}

interface DetectInDirOptions {
  cache: ScanCache;
  manifestPaths: string[];
  skipFrontendFiles?: boolean;
  pkg?: Record<string, unknown> | null;
  denoJson?: Record<string, unknown> | null;
}

interface DetectInDirResult {
  detected: Technology[];
  isFrontendByPackages: boolean;
  isFrontendByFiles: boolean;
}

function detectTechnologiesInDir(
  dir: string,
  {
    cache,
    manifestPaths,
    skipFrontendFiles = false,
    pkg: preloadedPkg,
    denoJson: preloadedDeno,
  }: DetectInDirOptions,
): DetectInDirResult {
  const pkg = preloadedPkg !== undefined ? preloadedPkg : readPackageJson(dir);
  const allPackages = getAllPackageNames(pkg);
  const deno = preloadedDeno !== undefined ? preloadedDeno : readDenoJson(dir);
  const denoImports = getDenoImportNames(deno);
  const allDepsSet =
    denoImports.length > 0 ? new Set([...allPackages, ...denoImports]) : new Set(allPackages);
  const allDepsArray = denoImports.length > 0 ? [...allDepsSet] : allPackages;
  let gemNames: string[] | undefined;
  const detected: Technology[] = [];

  for (const tech of SKILLS_MAP) {
    let found = false;

    if (tech.detect.packages) {
      found = tech.detect.packages.some((p) => allDepsSet.has(p));
    }

    if (!found && tech.detect.packagePatterns) {
      found = tech.detect.packagePatterns.some((pattern) =>
        allDepsArray.some((p) => pattern.test(p)),
      );
    }

    if (!found && tech.detect.configFiles) {
      found = tech.detect.configFiles.some((f) => cache.exists(join(dir, f)));
    }

    if (!found && tech.detect.fileExtensions) {
      found = cache.hasExtension(dir, tech.detect.fileExtensions);
    }

    if (!found && tech.detect.fileContentPatterns) {
      found = tech.detect.fileContentPatterns.some((query) => cache.hasContentMatch(dir, query));
    }

    if (!found && tech.detect.gems) {
      if (gemNames === undefined) gemNames = readGemfile(dir);
      found = tech.detect.gems.some((g) => gemNames!.includes(g));
    }

    if (!found && tech.detect.configFileContent) {
      const configs = Array.isArray(tech.detect.configFileContent)
        ? tech.detect.configFileContent
        : [tech.detect.configFileContent];
      for (const cfg of configs) {
        const blockFiles = cfg.files?.map((fileName) => join(dir, fileName)) ?? manifestPaths;
        found = cfg.patterns.some((pattern) =>
          blockFiles.some((filePath) => cache.read(filePath)?.includes(pattern)),
        );
        if (found) break;
      }
    }

    if (found) {
      detected.push(tech);
    }
  }

  const isFrontendByPackages = allDepsArray.some((p) => FRONTEND_PACKAGES.has(p));
  const isFrontendByFiles =
    isFrontendByPackages || skipFrontendFiles ? false : hasWebFrontendFiles(dir);

  return { detected, isFrontendByPackages, isFrontendByFiles };
}

export interface DetectResult {
  detected: Technology[];
  isFrontend: boolean;
  combos: ComboSkill[];
}

export function detectTechnologies(projectDir: string): DetectResult {
  const cache = createScanCache();
  const pkg = readPackageJson(projectDir);
  const denoJson = readDenoJson(projectDir);

  const memberDirs = new Set([
    ...resolveWorkspaces(projectDir, { pkg, denoJson }),
    ...resolveDeclaredMembers(projectDir, cache),
    ...discoverUndeclaredMembers(projectDir, cache),
  ]);

  const manifestPaths = buildManifestCandidatePaths(projectDir, { memberDirs });
  const root = detectTechnologiesInDir(projectDir, { cache, manifestPaths, pkg, denoJson });
  const seenIds = new Map<string, Technology>(root.detected.map((tech) => [tech.id, tech]));
  let isFrontend = root.isFrontendByPackages || root.isFrontendByFiles;

  for (const memberDir of memberDirs) {
    const member = detectTechnologiesInDir(memberDir, {
      cache,
      manifestPaths,
      skipFrontendFiles: isFrontend,
    });

    for (const tech of member.detected) {
      if (!seenIds.has(tech.id)) {
        seenIds.set(tech.id, tech);
      }
    }

    if (member.isFrontendByPackages || member.isFrontendByFiles) {
      isFrontend = true;
    }
  }

  const detected = [...seenIds.values()];
  const detectedIds = detected.map((tech) => tech.id);
  const combos = detectCombos(detectedIds);

  return { detected, isFrontend, combos };
}

export function detectCombos(detectedIds: string[]): ComboSkill[] {
  const idSet = detectedIds instanceof Set ? detectedIds : new Set(detectedIds);
  return COMBO_SKILLS_MAP.filter((combo) => combo.requires.every((id) => idSet.has(id)));
}

// ── Agent Detection ─────────────────────────────────────────

export function detectAgents(home: string = homedir()): string[] {
  const agents = ["universal"];

  for (const [folder, agentName] of AGENT_FOLDER_ENTRIES) {
    if (existsSync(join(home, folder, "skills"))) {
      agents.push(agentName);
    }
  }

  return agents;
}

// ── Helpers ──────────────────────────────────────────────────

export interface ParsedSkillPath {
  repo: string;
  skillName: string;
  full: string;
}

export function parseSkillPath(skill: string): ParsedSkillPath {
  if (skill.startsWith("http")) {
    return { repo: skill, skillName: "", full: skill };
  }

  const parts = skill.split("/");
  return {
    repo: parts.slice(0, 2).join("/"),
    skillName: parts.slice(2).join("/"),
    full: skill,
  };
}

// ── Installed Skills Detection ───────────────────────────────

export function getInstalledSkillNames(projectDir: string): Set<string> {
  try {
    const lock = JSON.parse(readFileSync(join(projectDir, "skills-lock.json"), "utf-8"));
    if (lock?.skills && typeof lock.skills === "object") {
      return new Set(Object.keys(lock.skills));
    }
  } catch {}

  try {
    const entries = readdirSync(join(projectDir, ".agents", "skills"), { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {}

  return new Set();
}

// ── Skill Collection ─────────────────────────────────────────

export interface SkillEntry {
  skill: string;
  sources: string[];
  installed: boolean;
}

interface CollectSkillsOptions {
  detected: Technology[];
  isFrontend: boolean;
  combos?: ComboSkill[];
  installedNames?: Set<string> | null;
}

export function collectSkills({
  detected,
  isFrontend,
  combos = [],
  installedNames = null,
}: CollectSkillsOptions): SkillEntry[] {
  const skillMap = new Map<string, SkillEntry>();
  const skills: SkillEntry[] = [];

  function addSkill(skill: string, source: string): void {
    const existing = skillMap.get(skill);
    if (!existing) {
      const installed = installedNames
        ? installedNames.has(parseSkillPath(skill).skillName)
        : false;
      const entry: SkillEntry = { skill, sources: [source], installed };
      skillMap.set(skill, entry);
      skills.push(entry);
    } else if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
  }

  for (const tech of detected) {
    for (const skill of tech.skills) {
      addSkill(skill, tech.name);
    }
  }

  for (const combo of combos) {
    for (const skill of combo.skills) {
      addSkill(skill, combo.name);
    }
  }

  if (isFrontend) {
    for (const skill of FRONTEND_BONUS_SKILLS) {
      addSkill(skill, "Frontend");
    }
  }

  return skills;
}
