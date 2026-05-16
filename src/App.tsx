import {
  ArrowDownToLine,
  Database,
  ExternalLink,
  FileJson,
  Filter,
  Folder,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";

type ProcessStatus = "Not Started" | "Queued" | "In Progress" | "Done" | "Blocked" | "Outsourced";

type ProcessStep = {
  name: string;
  status: ProcessStatus;
};

type ItemKind = "bom" | "production";

type Part = {
  id: string;
  name: string;
  partNumber: string;
  originalPartNumber: string;
  folder: string;
  quantity: number;
  unitPrice: number;
  material: string;
  thickness: string;
  processes: ProcessStep[];
  drawingUrl: string;
  vendor: string;
  location: string;
  notes: string;
  itemKind: ItemKind;
  linkedBomId: string;
};

type FolderRecord = {
  id: string;
  name: string;
  parentId: string;
};

type LegacyPart = Omit<Partial<Part>, "processes"> & {
  profile?: string;
  process?: string;
  processes?: ProcessStep[] | string;
  status?: ProcessStatus;
};

type PartForm = Omit<Part, "id" | "quantity" | "unitPrice"> & {
  quantity: string;
  unitPrice: string;
};

type FolderDropPosition = "before" | "after" | "inside";

type FolderDropIndicator = {
  path: string;
  position: FolderDropPosition;
};

type PartDropIndicator = {
  id: string;
  position: "before" | "after";
};

const WORKSPACE_CACHE_KEY = "parts-tracker.workspaceCache.v1";
const SYNC_INTERVAL_MS = 30000;
const DEFAULT_APPS_SCRIPT_URL = import.meta.env.VITE_APPS_SCRIPT_URL || "";

const processStatuses: ProcessStatus[] = [
  "Not Started",
  "Queued",
  "In Progress",
  "Done",
  "Blocked",
  "Outsourced"
];

const emptyForm: PartForm = {
  name: "",
  partNumber: "",
  originalPartNumber: "",
  folder: "",
  quantity: "1",
  unitPrice: "0",
  material: "",
  thickness: "",
  processes: [],
  drawingUrl: "",
  vendor: "",
  location: "",
  notes: "",
  itemKind: "bom",
  linkedBomId: ""
};

const csvHeaders = [
  "id",
  "name",
  "partNumber",
  "originalPartNumber",
  "folder",
  "quantity",
  "unitPrice",
  "material",
  "thickness",
  "processes",
  "drawingUrl",
  "vendor",
  "location",
  "notes",
  "itemKind",
  "linkedBomId"
] as const;

function normalizePart(part: LegacyPart): Part {
  const legacyMaterial = [part.material, part.profile].filter(Boolean).join(", ");
  const processes =
    typeof part.processes === "string"
      ? parseProcesses(part.processes, part.status)
      : Array.isArray(part.processes) && part.processes.length > 0
        ? part.processes
        : [{ name: part.process || "Unassigned", status: part.status || "Not Started" }];
  const itemKind = part.itemKind === "production" || part.itemKind === "bom"
    ? part.itemKind
    : "bom";

  return {
    id: part.id || crypto.randomUUID(),
    name: part.name || "",
    partNumber: itemKind === "production" ? part.partNumber || "" : "",
    originalPartNumber: itemKind === "production" ? part.originalPartNumber || part.partNumber || "" : "",
    folder: part.folder === "Unfiled" ? "" : String(part.folder || "").trim(),
    quantity: Number(part.quantity) || 0,
    unitPrice: Number(part.unitPrice) || 0,
    material: legacyMaterial || "",
    thickness: part.thickness || "",
    processes: processes.map((process) => ({
      name: process.name || "Unassigned",
      status: processStatuses.includes(process.status) ? process.status : "Not Started"
    })),
    drawingUrl: part.drawingUrl || "",
    vendor: part.vendor || "",
    location: part.location || "",
    notes: part.notes || "",
    itemKind,
    linkedBomId: part.linkedBomId || ""
  };
}

type SheetResult = {
  ok: boolean;
  parts?: LegacyPart[];
  folders?: LegacyFolder[];
  error?: string;
};

type WorkspaceCache = {
  parts: LegacyPart[];
  folders: LegacyFolder[];
  dirty: boolean;
  updatedAt: string;
};

type LegacyFolder = string | Partial<FolderRecord>;

function buildScriptUrl(webAppUrl: string, params: Record<string, string>) {
  const url = new URL(webAppUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function makeFolderId() {
  return `folder-${crypto.randomUUID()}`;
}

function legacyFolderId(path: string) {
  return `legacy-${normalizeFolderPath(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function normalizeFolders(rawFolders: LegacyFolder[], rawParts: LegacyPart[] = []) {
  const records: FolderRecord[] = [];
  const folderById = new Map<string, FolderRecord>();
  const idByPath = new Map<string, string>();

  function addRecord(record: FolderRecord) {
    if (!record.id || folderById.has(record.id)) return record.id;
    const normalizedRecord = {
      id: record.id,
      name: record.name.trim() || "Untitled folder",
      parentId: record.parentId || ""
    };
    folderById.set(normalizedRecord.id, normalizedRecord);
    records.push(normalizedRecord);
    return normalizedRecord.id;
  }

  function ensurePath(path: string) {
    const pieces = splitFolderPath(path);
    let parentId = "";
    let currentPath = "";

    pieces.forEach((piece) => {
      currentPath = currentPath ? `${currentPath} / ${piece}` : piece;
      const existingId = idByPath.get(currentPath);
      if (existingId) {
        parentId = existingId;
        return;
      }

      const id = legacyFolderId(currentPath);
      parentId = addRecord({ id, name: piece, parentId });
      idByPath.set(currentPath, id);
    });

    return parentId;
  }

  rawFolders.forEach((folder) => {
    if (typeof folder === "string") {
      ensurePath(folder);
      return;
    }

    const id = String(folder.id || "").trim();
    const name = String(folder.name || "").trim();
    if (id && name) addRecord({ id, name, parentId: String(folder.parentId || "").trim() });
  });

  rawParts.forEach((part) => {
    const folder = String(part.folder || "").trim();
    if (folder && folder !== "Unfiled" && !folderById.has(folder)) ensurePath(folder);
  });

  records.forEach((folder) => {
    const path = getFolderDisplayPath(folder.id, records);
    if (path) idByPath.set(path, folder.id);
  });

  return { folders: records, idByPath, folderIds: new Set(records.map((folder) => folder.id)) };
}

function migratePartFolder(part: Part, idByPath: Map<string, string>, folderIds: Set<string>) {
  if (!part.folder) return part;
  if (folderIds.has(part.folder)) return part;
  const normalizedPath = normalizeFolderPath(part.folder);
  return { ...part, folder: idByPath.get(normalizedPath) || "" };
}

function loadWorkspaceCache(): { parts: Part[]; folders: FolderRecord[]; dirty: boolean } {
  const saved = localStorage.getItem(WORKSPACE_CACHE_KEY);
  if (!saved) return { parts: [], folders: [], dirty: false };

  try {
    const cache = JSON.parse(saved) as WorkspaceCache;
    const rawParts = Array.isArray(cache.parts) ? cache.parts : [];
    const { folders, idByPath, folderIds } = normalizeFolders(Array.isArray(cache.folders) ? cache.folders : [], rawParts);
    const parts = rawParts.map(normalizePart).map((part) => migratePartFolder(part, idByPath, folderIds));
    return { parts, folders, dirty: Boolean(cache.dirty) };
  } catch {
    return { parts: [], folders: [], dirty: false };
  }
}

function saveWorkspaceCache(parts: Part[], folders: FolderRecord[], dirty: boolean) {
  const cache: WorkspaceCache = {
    parts,
    folders,
    dirty,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(cache));
}

function readWorkspaceFromSheet(webAppUrl: string): Promise<{ parts: Part[]; folders: FolderRecord[] }> {
  return new Promise((resolve, reject) => {
    const callbackName = `partsTracker_${crypto.randomUUID().replace(/-/g, "")}`;
    const script = document.createElement("script");
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while loading the Google Sheet."));
    }, 15000);

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete (window as unknown as Record<string, unknown>)[callbackName];
      script.remove();
    }

    (window as unknown as Record<string, (result: SheetResult) => void>)[callbackName] = (result) => {
      cleanup();
      if (!result.ok) {
        reject(new Error(result.error || "Google Sheet returned an error."));
        return;
      }
      const rawParts = result.parts || [];
      const { folders, idByPath, folderIds } = normalizeFolders(result.folders || [], rawParts);
      resolve({
        parts: rawParts.map(normalizePart).map((part) => migratePartFolder(part, idByPath, folderIds)),
        folders
      });
    };

    script.src = buildScriptUrl(webAppUrl, { action: "list", callback: callbackName });
    script.onerror = () => {
      cleanup();
      reject(new Error("Could not reach the Google Apps Script web app."));
    };
    document.body.appendChild(script);
  });
}

async function writeWorkspaceToSheet(webAppUrl: string, parts: Part[], folders: FolderRecord[]) {
  const session = crypto.randomUUID();
  const payload = encodeBase64Utf8(JSON.stringify({ parts, folders }));
  const chunkSize = 1200;
  const chunks = Array.from({ length: Math.ceil(payload.length / chunkSize) }, (_, index) =>
    payload.slice(index * chunkSize, (index + 1) * chunkSize)
  );

  const beginResult = await callScriptJsonp(webAppUrl, {
    action: "beginSync",
    session,
    total: String(chunks.length)
  });
  if (!beginResult.ok) {
    if (beginResult.error === "Unsupported action.") {
      const legacyResult = await callScriptJsonp(webAppUrl, {
        action: "replaceAll",
        payload: JSON.stringify({ parts, folders })
      });
      if (!legacyResult.ok) throw new Error(legacyResult.error || "Google Sheet returned an error.");
      return;
    }
    throw new Error(beginResult.error || "Google Sheet returned an error.");
  }

  for (const [index, chunk] of chunks.entries()) {
    const appendResult = await callScriptJsonp(webAppUrl, {
      action: "appendSync",
      session,
      index: String(index),
      chunk
    });
    if (!appendResult.ok) throw new Error(appendResult.error || "Google Sheet returned an error.");
  }

  const commitResult = await callScriptJsonp(webAppUrl, {
    action: "commitSync",
    session,
    total: String(chunks.length)
  });
  if (!commitResult.ok) throw new Error(commitResult.error || "Google Sheet returned an error.");
}

function encodeBase64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function callScriptJsonp(webAppUrl: string, params: Record<string, string>): Promise<SheetResult> {
  return new Promise((resolve, reject) => {
    const callbackName = `partsTracker_${crypto.randomUUID().replace(/-/g, "")}`;
    const script = document.createElement("script");
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while contacting the Google Sheet."));
    }, 20000);

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete (window as unknown as Record<string, unknown>)[callbackName];
      script.remove();
    }

    (window as unknown as Record<string, (result: SheetResult) => void>)[callbackName] = (result) => {
      cleanup();
      resolve(result);
    };

    script.src = buildScriptUrl(webAppUrl, { ...params, callback: callbackName });
    script.onerror = () => {
      cleanup();
      reject(new Error("Could not reach the Google Apps Script web app."));
    };
    document.body.appendChild(script);
  });
}

function saveFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeCsv(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function serializeProcesses(processes: ProcessStep[]) {
  return processes.map((process) => `${process.name}:${process.status}`).join("; ");
}

function parseProcesses(value: string, legacyStatus?: string): ProcessStep[] {
  const chunks = value
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (chunks.length === 0) {
    return [{ name: "Unassigned", status: parseProcessStatus(legacyStatus) }];
  }

  return chunks.map((chunk) => {
    const [name, status] = chunk.split(":").map((piece) => piece.trim());
    return {
      name: name || "Unassigned",
      status: parseProcessStatus(status || legacyStatus)
    };
  });
}

function parseProcessStatus(value?: string): ProcessStatus {
  return processStatuses.includes(value as ProcessStatus) ? (value as ProcessStatus) : "Not Started";
}

function generateNextPartNumber(parts: Part[]) {
  const highest = parts.filter((part) => part.itemKind === "production").reduce((max, part) => {
    const match = part.originalPartNumber.match(/(\d+)$/) || part.partNumber.match(/(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return `PT-${String(highest + 1).padStart(4, "0")}`;
}

function getPartNumberValue(partNumber: string) {
  const match = partNumber.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function nextAvailablePartNumber(usedPartNumbers: Set<string>) {
  let highest = 0;
  usedPartNumbers.forEach((partNumber) => {
    highest = Math.max(highest, getPartNumberValue(partNumber));
  });

  let next = highest + 1;
  let candidate = `PT-${String(next).padStart(4, "0")}`;
  while (usedPartNumbers.has(candidate)) {
    next += 1;
    candidate = `PT-${String(next).padStart(4, "0")}`;
  }
  return candidate;
}

function reconcileWorkspaceForSync(
  localParts: Part[],
  remoteParts: Part[],
  localFolders: FolderRecord[],
  remoteFolders: FolderRecord[]
) {
  const remoteById = new Map(remoteParts.map((part) => [part.id, part]));
  const localById = new Map(localParts.map((part) => [part.id, part]));
  const mergedParts = remoteParts.filter((part) => !localById.has(part.id));
  const usedPartNumbers = new Set(
    mergedParts.filter((part) => part.itemKind === "production").map((part) => part.partNumber).filter(Boolean)
  );
  let renumberedCount = 0;

  localParts.forEach((part) => {
    const isNewToSheet = !remoteById.has(part.id);
    const needsProductionNumber = part.itemKind === "production";
    const hasCollision = Boolean(needsProductionNumber && part.partNumber && usedPartNumbers.has(part.partNumber));
    let nextPart = part;

    if (needsProductionNumber && (!part.partNumber || hasCollision)) {
      const nextNumber = nextAvailablePartNumber(usedPartNumbers);
      nextPart = {
        ...part,
        partNumber: nextNumber,
        originalPartNumber: isNewToSheet || !part.originalPartNumber ? nextNumber : part.originalPartNumber
      };
      renumberedCount += 1;
    }

    if (nextPart.itemKind === "production") usedPartNumbers.add(nextPart.partNumber);
    mergedParts.push(nextPart);
  });

  const mergedFolders = uniqueFoldersById([
    ...remoteFolders,
    ...localFolders,
  ]).filter((folder) => mergedParts.some((part) => part.folder === folder.id) || localFolders.some((local) => local.id === folder.id) || remoteFolders.some((remote) => remote.id === folder.id));

  return { parts: mergedParts, folders: mergedFolders, renumberedCount };
}

function uniqueInOrder(values: string[]) {
  const seen = new Set<string>();
  const nextValues: string[] = [];

  values.forEach((value) => {
    const normalized = normalizeFolderPath(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    nextValues.push(normalized);
  });

  return nextValues;
}

function uniqueFoldersById(values: FolderRecord[]) {
  const seen = new Set<string>();
  return values.filter((folder) => {
    if (!folder.id || seen.has(folder.id)) return false;
    seen.add(folder.id);
    return true;
  });
}

type FolderNode = {
  id: string;
  name: string;
  parentId: string;
  path: string;
  count: number;
  totalCount: number;
  children: FolderNode[];
};

function buildFolderTree(folders: FolderRecord[], parts: Part[]) {
  const nodes = new Map<string, FolderNode>();
  const root: FolderNode[] = [];

  folders.forEach((folder) => {
    nodes.set(folder.id, {
      ...folder,
      path: getFolderDisplayPath(folder.id, folders),
      count: parts.filter((part) => part.folder === folder.id).length,
      totalCount: 0,
      children: []
    });
  });

  folders.forEach((folder) => {
    const node = nodes.get(folder.id);
    if (!node) return;
    const parent = folder.parentId ? nodes.get(folder.parentId) : null;
    if (parent) parent.children.push(node);
    else root.push(node);
  });

  function finalize(nodes: FolderNode[]): FolderNode[] {
    return nodes.map((node) => {
      const children = finalize(node.children);
      return {
        ...node,
        children,
        totalCount: node.count + children.reduce((sum, child) => sum + child.totalCount, 0)
      };
    });
  }

  return finalize(root);
}

function splitFolderPath(path: string) {
  return path.split("/").map((piece) => piece.trim()).filter(Boolean);
}

function normalizeFolderPath(path: string) {
  return splitFolderPath(path).join(" / ");
}

function getParentFolder(folderId: string, folders: FolderRecord[]) {
  const folder = folders.find((candidate) => candidate.id === folderId);
  return folder?.parentId || "All";
}

function getDirectChildFolders(currentFolder: string, folders: FolderRecord[]) {
  const parentId = currentFolder === "All" ? "" : currentFolder;
  return folders.filter((folder) => folder.parentId === parentId);
}

function getFolderDescendantIds(folderId: string, folders: FolderRecord[]) {
  const descendants = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    folders.forEach((folder) => {
      if (!descendants.has(folder.id) && (folder.parentId === folderId || descendants.has(folder.parentId))) {
        descendants.add(folder.id);
        changed = true;
      }
    });
  }

  return descendants;
}

function getFolderGroup(folderId: string, folders: FolderRecord[]) {
  const descendants = getFolderDescendantIds(folderId, folders);
  return folders.filter((folder) => folder.id === folderId || descendants.has(folder.id));
}

function getFolderDisplayPath(folderId: string, folders: FolderRecord[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pieces: string[] = [];
  let current = byId.get(folderId);
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    pieces.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return pieces.join(" / ");
}

function partToForm(part: Part): PartForm {
  return {
    ...part,
    quantity: String(part.quantity),
    unitPrice: String(part.unitPrice)
  };
}

function formToPart(form: PartForm, id: string = crypto.randomUUID()): Part {
  return {
    ...form,
    id,
    partNumber: form.partNumber.trim(),
    originalPartNumber: form.originalPartNumber.trim(),
    folder: form.folder,
    quantity: Number(form.quantity) || 0,
    unitPrice: Number(form.unitPrice) || 0,
    processes: form.processes
      .filter((process) => process.name.trim())
      .map((process) => ({ name: process.name.trim(), status: process.status }))
  };
}

export function App() {
  const cachedWorkspace = useMemo(loadWorkspaceCache, []);
  const [parts, setParts] = useState<Part[]>(cachedWorkspace.parts);
  const [folderRecords, setFolderRecords] = useState<FolderRecord[]>(cachedWorkspace.folders);
  const [form, setForm] = useState<PartForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const sheetWebAppUrl = DEFAULT_APPS_SCRIPT_URL;
  const [isSheetLoading, setIsSheetLoading] = useState(false);
  const [hasPendingSync, setHasPendingSync] = useState(cachedWorkspace.dirty);
  const [sheetMessage, setSheetMessage] = useState(
    cachedWorkspace.parts.length
      ? cachedWorkspace.dirty
        ? "Loaded local changes. Sync is pending."
        : "Loaded local cache."
      : sheetWebAppUrl
        ? "Google Sheet connection ready."
        : "Google Sheet sync URL is not configured."
  );
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<ItemKind>("bom");
  const [folderFilter, setFolderFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState<"All" | ProcessStatus>("All");
  const [processFilter, setProcessFilter] = useState("All");
  const [processDraft, setProcessDraft] = useState<ProcessStep>({ name: "", status: "Not Started" });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(["Subsystem", "Material"]));
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null);
  const [draggingPartId, setDraggingPartId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [folderDropIndicator, setFolderDropIndicator] = useState<FolderDropIndicator | null>(null);
  const [partDropIndicator, setPartDropIndicator] = useState<PartDropIndicator | null>(null);
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedPartId, setLastSelectedPartId] = useState<string | null>(null);

  useEffect(() => {
    if (sheetWebAppUrl) {
      if (!hasPendingSync) void refreshFromSheet(sheetWebAppUrl);
    }
  }, [sheetWebAppUrl]);

  useEffect(() => {
    if (!sheetWebAppUrl || !hasPendingSync || isSheetLoading) return;

    const timer = window.setTimeout(() => {
      void syncToSheet();
    }, SYNC_INTERVAL_MS);

    return () => window.clearTimeout(timer);
  }, [folderRecords, hasPendingSync, isSheetLoading, parts, sheetWebAppUrl]);

  async function refreshFromSheet(url = sheetWebAppUrl) {
    if (!url) {
      setSheetMessage("Google Sheet sync URL is not configured.");
      setParts([]);
      return;
    }

    setIsSheetLoading(true);
    setSheetMessage("Loading from Google Sheet...");
    try {
      const workspace = await readWorkspaceFromSheet(url);
      const nextParts = workspace.parts;
      const nextFolders = workspace.folders;
      setParts(nextParts);
      setFolderRecords(nextFolders);
      saveWorkspaceCache(nextParts, nextFolders, false);
      setHasPendingSync(false);
      setSelected(new Set());
      setPreviewPartId((current) => (nextParts.some((part) => part.id === current) ? current : null));
      setSheetMessage(`Loaded ${nextParts.length} parts from the Google Sheet.`);
    } catch (error) {
      setSheetMessage(error instanceof Error ? error.message : "Could not load from Google Sheet.");
    } finally {
      setIsSheetLoading(false);
    }
  }

  function persist(nextParts: Part[], nextFolders = folderRecords) {
    setParts(nextParts);
    setFolderRecords(nextFolders);
    setHasPendingSync(true);
    saveWorkspaceCache(nextParts, nextFolders, true);
    setSheetMessage(sheetWebAppUrl ? "Saved locally. Google Sheet sync pending." : "Saved locally. Sheet sync is not configured.");
    return true;
  }

  async function syncToSheet() {
    if (!sheetWebAppUrl) {
      setSheetMessage("Google Sheet sync URL is not configured.");
      return false;
    }

    setIsSheetLoading(true);
    setSheetMessage("Checking latest Sheet data before syncing...");
    try {
      const remoteWorkspace = await readWorkspaceFromSheet(sheetWebAppUrl);
      const reconciled = reconcileWorkspaceForSync(parts, remoteWorkspace.parts, folderRecords, remoteWorkspace.folders);

      setSheetMessage("Syncing local changes to Google Sheet...");
      await writeWorkspaceToSheet(sheetWebAppUrl, reconciled.parts, reconciled.folders);
      setParts(reconciled.parts);
      setFolderRecords(reconciled.folders);
      saveWorkspaceCache(reconciled.parts, reconciled.folders, false);
      setHasPendingSync(false);
      setSheetMessage(
        reconciled.renumberedCount
          ? `Synced ${reconciled.parts.length} parts. Renumbered ${reconciled.renumberedCount} conflicting part(s).`
          : `Synced ${reconciled.parts.length} parts to the Google Sheet.`
      );
      return true;
    } catch (error) {
      setSheetMessage(error instanceof Error ? error.message : "Could not save to Google Sheet.");
      return false;
    } finally {
      setIsSheetLoading(false);
    }
  }

  const processes = useMemo(
    () => [
      "All",
      ...Array.from(
        new Set(
          parts
            .filter((part) => part.itemKind === "production")
            .flatMap((part) => part.processes.map((process) => process.name))
            .filter(Boolean)
        )
      ).sort()
    ],
    [parts]
  );
  const bomItems = useMemo(() => parts.filter((part) => part.itemKind === "bom"), [parts]);
  const productionItems = useMemo(() => parts.filter((part) => part.itemKind === "production"), [parts]);
  const sectionItems = activeSection === "bom" ? bomItems : productionItems;

  const folders = useMemo(() => uniqueFoldersById(folderRecords), [folderRecords]);
  const folderTree = useMemo(() => buildFolderTree(folders, sectionItems), [folders, sectionItems]);
  const childFolders = useMemo(() => getDirectChildFolders(folderFilter, folders), [folderFilter, folders]);
  const breadcrumbFolders = useMemo(() => {
    if (folderFilter === "All") return [];
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const breadcrumbs: { name: string; id: string }[] = [];
    let current = byId.get(folderFilter);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      breadcrumbs.unshift({ name: current.name, id: current.id });
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return breadcrumbs;
  }, [folderFilter, folders]);

  useEffect(() => {
    if (folderFilter !== "All" && !folders.some((folder) => folder.id === folderFilter)) {
      setFolderFilter("All");
    }
  }, [folderFilter, folders]);

  useEffect(() => {
    setSelected(new Set());
    setLastSelectedPartId(null);
    setPreviewPartId(null);
  }, [activeSection]);

  const filteredParts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return parts.filter((part) => {
      if (part.itemKind !== activeSection) return false;
      const partFolder = part.folder || "";
      const descendantIds = folderFilter === "All" ? new Set<string>() : getFolderDescendantIds(folderFilter, folders);
      const folderMatches = normalizedQuery
        ? folderFilter === "All" || partFolder === folderFilter || descendantIds.has(partFolder)
        : folderFilter === "All"
          ? partFolder === ""
          : partFolder === folderFilter;
      const statusMatches =
        activeSection === "bom" || statusFilter === "All" || part.processes.some((process) => process.status === statusFilter);
      const processMatches =
        activeSection === "bom" || processFilter === "All" || part.processes.some((process) => process.name === processFilter);
      const searchable = {
        ...part,
        folder: part.folder ? getFolderDisplayPath(part.folder, folders) : "Root",
        processes: serializeProcesses(part.processes)
      };
      const queryMatches =
        !normalizedQuery ||
        Object.values(searchable).some((value) => String(value).toLowerCase().includes(normalizedQuery));

      return folderMatches && statusMatches && processMatches && queryMatches;
    });
  }, [activeSection, folderFilter, folders, parts, processFilter, query, statusFilter]);

  const totalValue = bomItems.reduce((sum, part) => sum + part.quantity * part.unitPrice, 0);
  const lowStockCount = bomItems.filter((part) => part.quantity <= 2).length;
  const blockedCount = productionItems.filter((part) => part.processes.some((process) => process.status === "Blocked")).length;
  const previewPart = parts.find((part) => part.id === previewPartId) ?? null;
  const nextPartNumber = useMemo(() => generateNextPartNumber(parts), [parts]);
  const visiblePartNumber = form.partNumber || (!editingId ? nextPartNumber : "");
  const originalPartNumber = form.originalPartNumber || (!editingId ? nextPartNumber : form.partNumber);
  const canRevertPartNumber = Boolean(originalPartNumber && visiblePartNumber !== originalPartNumber);

  function updateForm(field: keyof PartForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function updateProcess(index: number, field: keyof ProcessStep, value: string) {
    setForm((current) => ({
      ...current,
      processes: current.processes.map((process, processIndex) => {
        if (processIndex !== index) return process;
        if (field === "status") return { ...process, status: parseProcessStatus(value) };
        return { ...process, name: value };
      })
    }));
  }

  function addProcess() {
    const name = processDraft.name.trim();
    if (!name) return;

    setForm((current) => ({
      ...current,
      processes: [...current.processes, { name, status: processDraft.status }]
    }));
    setProcessDraft({ name: "", status: "Not Started" });
  }

  async function createFolder(parent = folderFilter) {
    const folderName = window.prompt("Folder name");
    const draft = normalizeFolderPath(folderName || "");
    if (!draft) return;
    const parentId = parent === "All" ? "" : parent;
    let activeParentId = parentId;
    const newFolders = splitFolderPath(draft).map((name) => {
      const folder = { id: makeFolderId(), name, parentId: activeParentId };
      activeParentId = folder.id;
      return folder;
    });
    if (newFolders.length === 0) return;
    const nextFolders = [...folders, ...newFolders];
    const createdFolderId = newFolders[newFolders.length - 1].id;
    setFolderFilter(createdFolderId);
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (parentId) next.add(parentId);
      newFolders.slice(0, -1).forEach((folder) => next.add(folder.id));
      return next;
    });
    persist(parts, nextFolders);
  }

  function toggleFolder(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  async function removeFolder(folderId: string) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) return;
    const parent = getParentFolder(folderId, folders);
    const parentId = parent === "All" ? "" : parent;
    const affectedFolderIds = getFolderDescendantIds(folderId, folders);
    affectedFolderIds.add(folderId);
    const affectedParts = parts.filter((part) => affectedFolderIds.has(part.folder));

    const confirmed = window.confirm(
      `Delete "${folder.name}" and its nested folders? ${affectedParts.length} affected part(s) will move to the parent folder.`
    );
    if (!confirmed) return;

    const nextParts = parts.map((part) => (affectedFolderIds.has(part.folder) ? { ...part, folder: parentId } : part));
    const nextFolders = folders.filter((candidate) => !affectedFolderIds.has(candidate.id));

    const saved = persist(nextParts, nextFolders);
    if (saved && affectedFolderIds.has(folderFilter)) {
      setFolderFilter(parent);
    }
  }

  async function moveFolder(folderId: string, targetParent: string) {
    const parentId = targetParent === "All" ? "" : targetParent;
    const descendantIds = getFolderDescendantIds(folderId, folders);
    if (folderId === parentId || descendantIds.has(parentId)) return;

    const movingGroup = getFolderGroup(folderId, folders);
    const movingSet = new Set(movingGroup.map((folder) => folder.id));
    const foldersWithoutMoved = folders.filter((folder) => !movingSet.has(folder.id));
    const parentGroup = parentId ? getFolderGroup(parentId, foldersWithoutMoved) : [];
    const parentIndex = parentId ? foldersWithoutMoved.findIndex((folder) => folder.id === parentId) : -1;
    const insertIndex = parentId && parentIndex >= 0 ? parentIndex + parentGroup.length : foldersWithoutMoved.length;
    const movedGroup = movingGroup.map((folder, index) => (index === 0 ? { ...folder, parentId } : folder));
    const nextFolders = uniqueFoldersById([
      ...foldersWithoutMoved.slice(0, insertIndex),
      ...movedGroup,
      ...foldersWithoutMoved.slice(insertIndex)
    ]);
    persist(parts, nextFolders);
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (parentId) next.add(parentId);
      next.add(folderId);
      return next;
    });
  }

  async function moveFolderToPosition(folderId: string, targetFolderId: string, position: FolderDropPosition) {
    if (position === "inside") {
      await moveFolder(folderId, targetFolderId);
      return;
    }

    const targetFolder = folders.find((folder) => folder.id === targetFolderId);
    if (!targetFolder) return;
    const descendantIds = getFolderDescendantIds(folderId, folders);
    if (folderId === targetFolderId || descendantIds.has(targetFolderId)) return;

    const movingGroup = getFolderGroup(folderId, folders);
    const movingSet = new Set(movingGroup.map((folder) => folder.id));
    const foldersWithoutMoved = folders.filter((folder) => !movingSet.has(folder.id));
    const targetGroup = getFolderGroup(targetFolderId, foldersWithoutMoved);
    const targetIndex = foldersWithoutMoved.findIndex((folder) => folder.id === targetFolderId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + targetGroup.length;
    if (targetIndex < 0) return;

    const movedGroup = movingGroup.map((folder, index) =>
      index === 0 ? { ...folder, parentId: targetFolder.parentId } : folder
    );
    const nextFolders = uniqueFoldersById([
      ...foldersWithoutMoved.slice(0, insertIndex),
      ...movedGroup,
      ...foldersWithoutMoved.slice(insertIndex)
    ]);
    persist(parts, nextFolders);
  }

  async function movePartToFolder(partId: string, folderId: string) {
    const nextParts = parts.map((part) => (part.id === partId ? { ...part, folder: folderId } : part));
    persist(nextParts, folders);
  }

  async function movePartsToFolder(partIds: string[], folderId: string) {
    const movingIds = new Set(partIds);
    const nextParts = parts.map((part) => (movingIds.has(part.id) ? { ...part, folder: folderId } : part));
    persist(nextParts, folders);
  }

  function movePartToPosition(partId: string, targetPartId: string, position: "before" | "after") {
    movePartsToPosition([partId], targetPartId, position);
  }

  function movePartsToPosition(partIds: string[], targetPartId: string, position: "before" | "after") {
    const movingIds = new Set(partIds);
    if (movingIds.has(targetPartId)) return;

    const targetPart = parts.find((part) => part.id === targetPartId);
    if (!targetPart) return;

    const movingParts = parts.filter((part) => movingIds.has(part.id)).map((part) => ({ ...part, folder: targetPart.folder || "" }));
    if (movingParts.length === 0) return;

    const partsWithoutMovingParts = parts.filter((part) => !movingIds.has(part.id));
    const targetIndex = partsWithoutMovingParts.findIndex((part) => part.id === targetPartId);
    if (targetIndex < 0) return;

    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    const nextParts = [
      ...partsWithoutMovingParts.slice(0, insertIndex),
      ...movingParts,
      ...partsWithoutMovingParts.slice(insertIndex)
    ];
    persist(nextParts, folders);
  }

  async function renameFolder(folderId: string) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) return;
    const nextName = window.prompt("Rename folder", folder.name)?.trim();
    if (!nextName) return;
    if (nextName === folder.name) return;
    const nextFolders = folders.map((candidate) => candidate.id === folderId ? { ...candidate, name: nextName } : candidate);
    persist(parts, nextFolders);
  }

  async function unpackFolder(folderId: string) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) return;
    const parent = getParentFolder(folderId, folders);
    const parentId = parent === "All" ? "" : parent;

    const confirmed = window.confirm(`Unpack "${folder.name}" into its parent folder?`);
    if (!confirmed) return;

    const nextParts = parts.map((part) => (part.folder === folderId ? { ...part, folder: parentId } : part));
    const nextFolders = folders
      .filter((candidate) => candidate.id !== folderId)
      .map((candidate) => candidate.parentId === folderId ? { ...candidate, parentId } : candidate);
    const saved = persist(nextParts, nextFolders);
    if (saved) setFolderFilter(parent);
  }

  function getFolderDropPosition(event: DragEvent<HTMLElement>, allowInsert = true): FolderDropPosition {
    if (!allowInsert) return "inside";
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientY - rect.top;
    const topZone = rect.height * 0.25;
    const bottomZone = rect.height * 0.75;
    if (offset < topZone) return "before";
    if (offset > bottomZone) return "after";
    return "inside";
  }

  function updateFolderDragIndicator(event: DragEvent<HTMLElement>, targetFolder: string, allowInsert = true) {
    event.preventDefault();
    event.stopPropagation();
    if (!draggingFolder) return;
    setDragPosition({ x: event.clientX, y: event.clientY });
    setFolderDropIndicator({
      path: targetFolder,
      position: getFolderDropPosition(event, allowInsert)
    });
  }

  function clearFolderDragState() {
    setDraggingFolder(null);
    setFolderDropIndicator(null);
  }

  function clearPartDragState() {
    setDraggingPartId(null);
    setPartDropIndicator(null);
  }

  function clearDragState() {
    clearFolderDragState();
    clearPartDragState();
  }

  function getPartDropPosition(event: DragEvent<HTMLElement>): "before" | "after" {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY - rect.top < rect.height / 2 ? "before" : "after";
  }

  function updatePartDragIndicator(event: DragEvent<HTMLElement>, targetPartId: string) {
    event.preventDefault();
    event.stopPropagation();
    if (!draggingPartId) return;
    setDragPosition({ x: event.clientX, y: event.clientY });
    setPartDropIndicator({
      id: targetPartId,
      position: getPartDropPosition(event)
    });
  }

  function handleFolderDrop(event: DragEvent<HTMLElement>, targetFolder: string, position?: FolderDropPosition) {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData("application/json");
    if (!raw) {
      clearFolderDragState();
      return;
    }

    try {
      const payload = JSON.parse(raw) as { type: string; id?: string; ids?: string[]; path?: string };
      if (payload.type === "part") {
        const partIds = payload.ids?.length ? payload.ids : payload.id ? [payload.id] : [];
        if (partIds.length) void movePartsToFolder(partIds, targetFolder === "All" ? "" : targetFolder);
      }
      if (payload.type === "folder" && payload.path) {
        const dropPosition = position ?? folderDropIndicator?.position ?? "inside";
        if (targetFolder === "All") {
          void moveFolder(payload.path, "");
        } else {
          void moveFolderToPosition(payload.path, targetFolder, dropPosition);
        }
      }
    } catch {
      setSheetMessage("Could not read dragged item.");
    } finally {
      clearDragState();
    }
  }

  function handlePartDrop(event: DragEvent<HTMLTableRowElement>, targetPartId: string) {
    event.preventDefault();
    event.stopPropagation();
    const raw = event.dataTransfer.getData("application/json");
    if (!raw) {
      clearDragState();
      return;
    }

    try {
      const payload = JSON.parse(raw) as { type: string; id?: string; ids?: string[] };
      if (payload.type === "part") {
        const partIds = payload.ids?.length ? payload.ids : payload.id ? [payload.id] : [];
        movePartsToPosition(partIds, targetPartId, partDropIndicator?.position ?? getPartDropPosition(event));
      }
    } catch {
      setSheetMessage("Could not read dragged part.");
    } finally {
      clearDragState();
    }
  }

  function getFolderDirectCount(folderId: string) {
    return parts.filter((part) => part.itemKind === activeSection && (part.folder || "") === folderId).length;
  }

  function removeProcess(index: number) {
    setForm((current) => ({
      ...current,
      processes: current.processes.filter((_, processIndex) => processIndex !== index)
    }));
  }

  function revertPartNumber() {
    if (!canRevertPartNumber) return;
    const confirmed = window.confirm(`Revert part number to ${originalPartNumber}?`);
    if (confirmed) {
      setForm((current) => ({
        ...current,
        partNumber: originalPartNumber
      }));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextItemKind = editingId ? form.itemKind : activeSection;
    const generatedPartNumber = editingId ? originalPartNumber : nextPartNumber;
    const nextPart = formToPart(
      {
        ...form,
        itemKind: nextItemKind,
        linkedBomId: nextItemKind === "production" ? form.linkedBomId : "",
        partNumber: nextItemKind === "production" ? visiblePartNumber : "",
        originalPartNumber: nextItemKind === "production" ? form.originalPartNumber || generatedPartNumber : "",
        folder: editingId ? form.folder : folderFilter === "All" ? "" : folderFilter
      },
      editingId ?? undefined
    );
    if (nextPart.itemKind === "production" && nextPart.processes.length === 0) {
      nextPart.processes = [{ name: "Unassigned", status: "Not Started" }];
    }
    if (nextPart.itemKind === "bom") {
      nextPart.processes = [];
      nextPart.drawingUrl = "";
      nextPart.linkedBomId = "";
      nextPart.partNumber = "";
      nextPart.originalPartNumber = "";
    }
    const nextParts = editingId
      ? parts.map((part) => (part.id === editingId ? nextPart : part))
      : [nextPart, ...parts];

    const saved = persist(nextParts);
    if (saved) {
      setForm({
        ...emptyForm,
        itemKind: activeSection,
        partNumber: activeSection === "production" ? generateNextPartNumber(nextParts) : "",
        originalPartNumber: activeSection === "production" ? generateNextPartNumber(nextParts) : ""
      });
      setEditingId(null);
    }
  }

  function editPart(part: Part) {
    setPreviewPartId(part.id);
    setEditingId(part.id);
    setActiveSection(part.itemKind);
    setForm(partToForm(part));
    setProcessDraft({ name: "", status: "Not Started" });
  }

  async function deletePart(id: string) {
    persist(parts.filter((part) => part.id !== id));
    if (previewPartId === id) setPreviewPartId(null);
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  async function deleteSelected() {
    persist(parts.filter((part) => !selected.has(part.id)));
    if (previewPartId && selected.has(previewPartId)) setPreviewPartId(null);
    setSelected(new Set());
    setLastSelectedPartId(null);
  }

  function downloadCsv() {
    const csv = [
      csvHeaders.join(","),
      ...parts.map((part) =>
        csvHeaders
          .map((header) => {
            if (header === "processes") return escapeCsv(serializeProcesses(part.processes));
            if (header === "folder") return escapeCsv(part.folder ? getFolderDisplayPath(part.folder, folders) : "");
            return escapeCsv(part[header]);
          })
          .join(",")
      )
    ].join("\n");
    saveFile("parts-tracker.csv", csv, "text/csv;charset=utf-8");
  }

  function downloadJson() {
    saveFile("parts-tracker-backup.json", JSON.stringify(parts, null, 2), "application/json");
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const rows = parseCsv(await file.text());
    const headerRow = rows[0]?.map((header) => header.trim()) ?? [];
    if (headerRow.length === 0) return;

    const importedFolders = [...folders];
    const importedPathToId = new Map(importedFolders.map((folder) => [getFolderDisplayPath(folder.id, importedFolders), folder.id]));
    const ensureImportedFolderPath = (path: string) => {
      const normalizedPath = normalizeFolderPath(path);
      if (!normalizedPath) return "";
      const existingId = importedPathToId.get(normalizedPath);
      if (existingId) return existingId;

      let parentId = "";
      let currentPath = "";
      splitFolderPath(normalizedPath).forEach((name) => {
        currentPath = currentPath ? `${currentPath} / ${name}` : name;
        const currentId = importedPathToId.get(currentPath);
        if (currentId) {
          parentId = currentId;
          return;
        }
        const folder = { id: makeFolderId(), name, parentId };
        importedFolders.push(folder);
        importedPathToId.set(currentPath, folder.id);
        parentId = folder.id;
      });
      return parentId;
    };

    const importedParts = rows.slice(1).map((row) => {
      const record = Object.fromEntries(headerRow.map((header, index) => [header, row[index] ?? ""]));
      const material = [record.material, record.profile].filter(Boolean).join(", ");
      const folderId = ensureImportedFolderPath(record.folder ?? "");

      return formToPart(
        {
          name: record.name ?? "",
          partNumber: record.partNumber ?? "",
          originalPartNumber: record.originalPartNumber || record.partNumber || "",
          folder: record.folder === "Unfiled" ? "" : folderId,
          quantity: record.quantity ?? "0",
          unitPrice: record.unitPrice ?? "0",
          material,
          thickness: record.thickness ?? "",
          processes: parseProcesses(record.processes || record.process || "", record.status),
          drawingUrl: record.drawingUrl ?? "",
          vendor: record.vendor ?? "",
          location: record.location ?? "",
          notes: record.notes ?? "",
          itemKind: record.itemKind === "production" ? "production" : "bom",
          linkedBomId: record.linkedBomId ?? ""
        },
        record.id || undefined
      );
    });

    persist([...importedParts, ...parts], importedFolders);
    event.target.value = "";
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelectedPartId(id);
  }

  function selectPartRange(anchorId: string, targetId: string) {
    const anchorIndex = filteredParts.findIndex((part) => part.id === anchorId);
    const targetIndex = filteredParts.findIndex((part) => part.id === targetId);
    if (anchorIndex < 0 || targetIndex < 0) return [targetId];

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return filteredParts.slice(start, end + 1).map((part) => part.id);
  }

  function selectPartLikeFileManager(id: string, event: MouseEvent) {
    if (event.shiftKey && lastSelectedPartId) {
      const rangeIds = selectPartRange(lastSelectedPartId, id);
      setSelected((current) => {
        const next = new Set(current);
        rangeIds.forEach((partId) => next.add(partId));
        return next;
      });
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      toggleSelected(id);
      return;
    }

    setSelected(new Set([id]));
    setLastSelectedPartId(id);
  }

  function handlePartRowClick(part: Part, event: MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button,a,input,select,textarea")) return;
    selectPartLikeFileManager(part.id, event);
  }

  function toggleAllFiltered() {
    const allSelected = filteredParts.length > 0 && filteredParts.every((part) => selected.has(part.id));
    setSelected((current) => {
      const next = new Set(current);
      filteredParts.forEach((part) => {
        if (allSelected) next.delete(part.id);
        else next.add(part.id);
      });
      return next;
    });
  }

  function renderFolderNode(node: FolderNode, depth = 0) {
    const isExpanded = expandedFolders.has(node.id);
    const hasChildren = node.children.length > 0;
    const dropPosition = folderDropIndicator?.path === node.id ? folderDropIndicator.position : null;

    return (
      <div className="folder-node" key={node.id}>
        <div
          className={[
            "folder-row",
            draggingFolder === node.id ? "dragging" : "",
            dropPosition ? `drop-${dropPosition}` : ""
          ].filter(Boolean).join(" ")}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/json", JSON.stringify({ type: "folder", path: node.id }));
            const dragImage = document.createElement("div");
            dragImage.className = "folder-drag-image";
            document.body.appendChild(dragImage);
            event.dataTransfer.setDragImage(dragImage, 0, 0);
            window.setTimeout(() => dragImage.remove(), 0);
            setDraggingFolder(node.id);
            setDragPosition({ x: event.clientX, y: event.clientY });
          }}
          onDrag={(event) => {
            if (event.clientX || event.clientY) setDragPosition({ x: event.clientX, y: event.clientY });
          }}
          onDragOver={(event) => updateFolderDragIndicator(event, node.id)}
          onDrop={(event) => handleFolderDrop(event, node.id, draggingFolder ? getFolderDropPosition(event) : "inside")}
          onDragEnd={clearDragState}
          style={{ paddingLeft: `${depth * 14}px` }}
        >
          <button
            className="folder-toggle"
            disabled={!hasChildren}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              toggleFolder(node.id);
            }}
            title={hasChildren ? "Expand folder" : "No nested folders"}
          >
            {hasChildren ? (isExpanded ? "v" : ">") : ""}
          </button>
          <button
            className={`folder-button ${folderFilter === node.id ? "active" : ""}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setFolderFilter(node.id);
            }}
          >
            {dropPosition === "inside" && <Folder size={14} />}
            <span>{node.name}</span>
            <strong>{node.totalCount}</strong>
          </button>
          <button
            className="icon-button folder-remove"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void removeFolder(node.id);
            }}
            title="Remove folder"
          >
            <X size={14} />
          </button>
        </div>
        {hasChildren && isExpanded && node.children.map((child) => renderFolderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <main className="app-shell">
      {draggingFolder && (
        <div className="folder-drag-ghost" style={{ left: dragPosition.x + 12, top: dragPosition.y + 12 }}>
          <Folder size={15} />
          <span>{folders.find((folder) => folder.id === draggingFolder)?.name || "Folder"}</span>
        </div>
      )}
      {draggingPartId && (
        <div className="folder-drag-ghost" style={{ left: dragPosition.x + 12, top: dragPosition.y + 12 }}>
          <FileJson size={15} />
          <span>
            {selected.has(draggingPartId) && selected.size > 1
              ? `${selected.size} parts`
              : parts.find((part) => part.id === draggingPartId)?.name || "Part"}
          </span>
        </div>
      )}
      <section className="hero">
        <div>
          <p className="eyebrow">Google Sheet workspace</p>
          <h1>Parts Library</h1>
        </div>
        <div className="hero-actions">
          <button
            className="button secondary"
            disabled={isSheetLoading || !sheetWebAppUrl}
            type="button"
            onClick={() => void refreshFromSheet()}
            title="Reload from Google Sheet"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          <button
            className="button secondary"
            disabled={isSheetLoading || !sheetWebAppUrl || !hasPendingSync}
            type="button"
            onClick={() => void syncToSheet()}
            title="Push local changes to Google Sheet"
          >
            <RefreshCw size={16} />
            Sync Now
          </button>
          <label className="button secondary" title="Import CSV into the Google Sheet">
            <Upload size={16} />
            Import CSV
            <input type="file" accept=".csv,text/csv" onChange={importCsv} />
          </label>
          <button className="button secondary" type="button" onClick={downloadJson} title="Download local backup">
            <FileJson size={16} />
            JSON
          </button>
          <button className="button primary" type="button" onClick={downloadCsv} title="Export for Google Sheets">
            <ArrowDownToLine size={16} />
            Download CSV
          </button>
        </div>
      </section>

      <section className="sheet-panel">
        <div className="sheet-connection">
          <Database size={18} />
          <div>
            <strong>{sheetWebAppUrl ? "Google Sheet sync configured" : "Google Sheet sync missing"}</strong>
            <span>{sheetWebAppUrl ? "Data sync runs through the app." : "Set VITE_APPS_SCRIPT_URL in the app configuration."}</span>
          </div>
        </div>
        <div className="sheet-status">
          <span>{hasPendingSync ? "Unsynced local changes" : "Synced"} - {sheetMessage}</span>
        </div>
      </section>

      <section className="stats-grid">
        <article>
          <span>BOM Items</span>
          <strong>{bomItems.length}</strong>
        </article>
        <article>
          <span>Inventory Value</span>
          <strong>${totalValue.toFixed(2)}</strong>
        </article>
        <article>
          <span>Low Stock</span>
          <strong>{lowStockCount}</strong>
        </article>
        <article>
          <span>Blocked Production</span>
          <strong>{blockedCount}</strong>
        </article>
      </section>

      <section className="section-tabs" aria-label="Workspace section">
        <button
          className={activeSection === "bom" ? "active" : ""}
          type="button"
          onClick={() => {
            setActiveSection("bom");
            setEditingId(null);
            setForm({ ...emptyForm, itemKind: "bom", partNumber: "", originalPartNumber: "" });
          }}
        >
          Bill of Materials
        </button>
        <button
          className={activeSection === "production" ? "active" : ""}
          type="button"
          onClick={() => {
            setActiveSection("production");
            setEditingId(null);
            setForm({ ...emptyForm, itemKind: "production", partNumber: nextPartNumber, originalPartNumber: nextPartNumber });
          }}
        >
          Production Tracker
        </button>
      </section>

      <section className="workspace">
        <form className="editor-panel" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{editingId ? "Editing part" : "New part"}</p>
              <h2>
                {editingId
                  ? form.name || "Untitled Item"
                  : activeSection === "bom"
                    ? "Add BOM Item"
                    : "Add Production Item"}
              </h2>
            </div>
            {editingId && (
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm({
                    ...emptyForm,
                    itemKind: activeSection,
                    partNumber: activeSection === "production" ? nextPartNumber : "",
                    originalPartNumber: activeSection === "production" ? nextPartNumber : ""
                  });
                }}
                title="Cancel editing"
              >
                <X size={17} />
              </button>
            )}
          </div>

          <div className="form-grid">
            <label>
              {activeSection === "bom" ? "BOM item name" : "Production item name"}
              <input required value={form.name} onChange={(event) => updateForm("name", event.target.value)} />
            </label>
            {activeSection === "production" && (
              <label>
                Part number
                <div className="part-number-row">
                  <input
                    value={visiblePartNumber}
                    onChange={(event) => updateForm("partNumber", event.target.value)}
                  />
                  <button
                    className="icon-button"
                    disabled={!canRevertPartNumber}
                    type="button"
                    onClick={revertPartNumber}
                    title="Revert to original part number"
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
              </label>
            )}
            {activeSection === "bom" ? (
              <>
                <label>
                  Quantity
                  <input
                    min="0"
                    type="number"
                    value={form.quantity}
                    onChange={(event) => updateForm("quantity", event.target.value)}
                  />
                </label>
                <label>
                  Unit price
                  <input
                    min="0"
                    step="0.01"
                    type="number"
                    value={form.unitPrice}
                    onChange={(event) => updateForm("unitPrice", event.target.value)}
                  />
                </label>
                <label>
                  Material / profile
                  <input value={form.material} onChange={(event) => updateForm("material", event.target.value)} />
                </label>
                <label>
                  Stock / component type
                  <input value={form.thickness} onChange={(event) => updateForm("thickness", event.target.value)} />
                </label>
                <label>
                  Vendor
                  <input value={form.vendor} onChange={(event) => updateForm("vendor", event.target.value)} />
                </label>
                <label>
                  Location
                  <input value={form.location} onChange={(event) => updateForm("location", event.target.value)} />
                </label>
              </>
            ) : (
              <>
                <label className="span-two">
                  Linked BOM item
                  <select value={form.linkedBomId} onChange={(event) => updateForm("linkedBomId", event.target.value)}>
                    <option value="">No linked BOM item</option>
                    {bomItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="span-two">
                  Onshape drawing link
                  <input
                    placeholder="https://cad.onshape.com/documents/..."
                    type="url"
                    value={form.drawingUrl}
                    onChange={(event) => updateForm("drawingUrl", event.target.value)}
                  />
                </label>
              </>
            )}
          </div>

          {activeSection === "production" && <section className="process-editor">
            <div className="process-heading">
              <span>Processes</span>
            </div>
            <div className="process-add-row">
              <input
                aria-label="New process name"
                placeholder="Router, Laser, Deburr..."
                value={processDraft.name}
                onChange={(event) => setProcessDraft((current) => ({ ...current, name: event.target.value }))}
              />
              <select
                aria-label="New process status"
                value={processDraft.status}
                onChange={(event) =>
                  setProcessDraft((current) => ({ ...current, status: parseProcessStatus(event.target.value) }))
                }
              >
                {processStatuses.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
              <button className="mini-button" disabled={!processDraft.name.trim()} type="button" onClick={addProcess}>
                <Plus size={14} />
                Add
              </button>
            </div>
            {form.processes.map((process, index) => (
              <div className="process-row" key={`${index}-${process.name}`}>
                <input
                  aria-label="Process name"
                  placeholder="Router, Laser, Deburr..."
                  value={process.name}
                  onChange={(event) => updateProcess(index, "name", event.target.value)}
                />
                <select
                  aria-label="Process status"
                  value={process.status}
                  onChange={(event) => updateProcess(index, "status", event.target.value)}
                >
                  {processStatuses.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => removeProcess(index)}
                  title="Remove process"
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            {form.processes.length === 0 && <div className="process-empty">No processes added yet.</div>}
          </section>}

          <label>
            Notes
            <textarea value={form.notes} onChange={(event) => updateForm("notes", event.target.value)} />
          </label>

          <button className="button primary wide" disabled={isSheetLoading || !sheetWebAppUrl} type="submit">
            {editingId ? <Database size={16} /> : <PackagePlus size={16} />}
            {editingId ? "Save Item" : activeSection === "bom" ? "Add BOM Item" : "Add Production Item"}
          </button>
        </form>

        <aside className="folder-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Folders</p>
              <h2>Organize</h2>
            </div>
          </div>
          <button
            className={[
              "folder-button",
              folderFilter === "All" ? "active" : "",
              folderDropIndicator?.path === "All" ? "drop-inside" : ""
            ].filter(Boolean).join(" ")}
            type="button"
            onDragOver={(event) => updateFolderDragIndicator(event, "All", false)}
            onDrop={(event) => handleFolderDrop(event, "All", "inside")}
            onDragEnd={clearDragState}
            onClick={() => setFolderFilter("All")}
          >
            {folderDropIndicator?.path === "All" && <Folder size={14} />}
            <span>Root</span>
            <strong>{getFolderDirectCount("")}</strong>
          </button>
          <div className="folder-tree">
            {folderTree.map((folder) => renderFolderNode(folder))}
          </div>
        </aside>

        <section className="library-panel">
          <div className="toolbar">
            <div className="search-box">
              <Search size={16} />
              <input
                aria-label="Search parts"
                placeholder={activeSection === "bom" ? "Search BOM items, numbers, materials..." : "Search drawings, part numbers, processes..."}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {activeSection === "production" && <div className="filters">
              <Filter size={16} />
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as ProcessStatus | "All")}
              >
                <option>All</option>
                {processStatuses.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
              <select value={processFilter} onChange={(event) => setProcessFilter(event.target.value)}>
                {processes.map((process) => (
                  <option key={process}>{process}</option>
                ))}
              </select>
            </div>}
          </div>

          <div
            className="folder-browser"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleFolderDrop(event, folderFilter)}
          >
            <div className="folder-command-row">
              <button className="mini-button" type="button" onClick={() => void createFolder()}>
                <Plus size={14} />
                New Folder
              </button>
              {folderFilter !== "All" && (
                <>
                  <button className="mini-button" type="button" onClick={() => void renameFolder(folderFilter)}>
                    Rename
                  </button>
                  <button className="mini-button" type="button" onClick={() => void unpackFolder(folderFilter)}>
                    Unpack
                  </button>
                  <button className="mini-button danger-text" type="button" onClick={() => void removeFolder(folderFilter)}>
                    Delete
                  </button>
                </>
              )}
            </div>
            <div className="breadcrumb-row">
              <button className="breadcrumb" type="button" onClick={() => setFolderFilter("All")}>
                Root
              </button>
              {breadcrumbFolders.map((folder) => (
                <button
                  className="breadcrumb"
                  key={folder.id}
                  type="button"
                  onClick={() => setFolderFilter(folder.id)}
                >
                  / {folder.name}
                </button>
              ))}
            </div>

            {folderFilter !== "All" && (
              <button
                className="folder-tile parent-folder"
                type="button"
                onClick={() => setFolderFilter(getParentFolder(folderFilter, folders))}
              >
                <span>..</span>
                <small>Parent folder</small>
              </button>
            )}

            <div className="folder-tile-grid">
              {childFolders.map((folder) => {
                return (
                  <div
                    className="folder-tile"
                    draggable
                    key={folder.id}
                    onClick={() => setFolderFilter(folder.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setFolderFilter(folder.id);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/json", JSON.stringify({ type: "folder", path: folder.id }));
                    }}
                    onDrop={(event) => handleFolderDrop(event, folder.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <span>{folder.name}</span>
                    <small>{getFolderDirectCount(folder.id)} direct part(s)</small>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="table-heading">
            <span>
              {activeSection === "bom" ? "Bill of Materials" : "Production Tracker"} ({filteredParts.length} item(s))
            </span>
            <div>
              {selected.size > 0 && (
                <button className="ghost-danger" type="button" onClick={deleteSelected}>
                  <Trash2 size={14} />
                  Delete selected
                </button>
              )}
              <button className="ghost" type="button" onClick={toggleAllFiltered}>
                Select all
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Folder</th>
                  {activeSection === "production" && <th>Part #</th>}
                  {activeSection === "bom" ? <th>Material / Stock</th> : <th>Linked BOM Item</th>}
                  {activeSection === "production" && <th>Processes</th>}
                  {activeSection === "production" ? <th>Drawing</th> : (
                    <>
                      <th>Qty</th>
                      <th>Price</th>
                    </>
                  )}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredParts.map((part) => {
                  const partDropPosition = partDropIndicator?.id === part.id ? partDropIndicator.position : null;
                  return (
                  <tr
                    className={[
                      draggingPartId === part.id ? "dragging" : "",
                      partDropPosition ? `drop-${partDropPosition}` : ""
                    ].filter(Boolean).join(" ")}
                    draggable
                    key={part.id}
                    onClick={(event) => handlePartRowClick(part, event)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      const draggedIds = selected.has(part.id)
                        ? filteredParts.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id)
                        : [part.id];
                      event.dataTransfer.setData(
                        "application/json",
                        JSON.stringify({ type: "part", id: part.id, ids: draggedIds })
                      );
                      if (!selected.has(part.id)) {
                        setSelected(new Set([part.id]));
                        setLastSelectedPartId(part.id);
                      }
                      setDraggingPartId(part.id);
                      setDragPosition({ x: event.clientX, y: event.clientY });
                    }}
                    onDrag={(event) => {
                      if (event.clientX || event.clientY) setDragPosition({ x: event.clientX, y: event.clientY });
                    }}
                    onDragOver={(event) => updatePartDragIndicator(event, part.id)}
                    onDrop={(event) => handlePartDrop(event, part.id)}
                    onDragEnd={clearDragState}
                  >
                    <td>
                      <input
                        aria-label={`Select ${part.name}`}
                        type="checkbox"
                        checked={selected.has(part.id)}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectPartLikeFileManager(part.id, event);
                        }}
                        onChange={() => undefined}
                      />
                    </td>
                    <td>
                      <button className="part-name" type="button" onClick={() => editPart(part)}>
                        <span>{part.name}</span>
                        <small>
                          {activeSection === "bom"
                            ? `${part.vendor || "No vendor"} - ${part.location || "No location"}`
                            : part.drawingUrl ? "Drawing linked" : "No drawing"}
                        </small>
                      </button>
                    </td>
                    <td>{part.folder ? getFolderDisplayPath(part.folder, folders) || "Unknown folder" : "Root"}</td>
                    {activeSection === "production" && <td>{part.partNumber}</td>}
                    <td>
                      {activeSection === "bom" ? (
                        <>
                          <div>{part.material}</div>
                          <small>{part.thickness}</small>
                        </>
                      ) : (
                        <>
                          <div>{bomItems.find((item) => item.id === part.linkedBomId)?.name || "No BOM link"}</div>
                          <small>{bomItems.find((item) => item.id === part.linkedBomId)?.material || ""}</small>
                        </>
                      )}
                    </td>
                    {activeSection === "production" && (
                      <td>
                        <div className="process-chips">
                          {part.processes.map((process) => (
                            <span
                              className={`process-chip ${process.status.toLowerCase().replace(/\s+/g, "-")}`}
                              key={`${part.id}-${process.name}-${process.status}`}
                            >
                              {process.name}: {process.status}
                            </span>
                          ))}
                        </div>
                      </td>
                    )}
                    {activeSection === "production" ? (
                      <td>{part.drawingUrl ? "Linked" : "Missing"}</td>
                    ) : (
                      <>
                        <td>{part.quantity}</td>
                        <td>${part.unitPrice.toFixed(2)}</td>
                      </>
                    )}
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => editPart(part)}>Edit</button>
                        <button className="danger" type="button" onClick={() => deletePart(part.id)} title="Delete part">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {previewPart && previewPart.itemKind === "production" && (
            <section className="drawing-preview">
              <div className="preview-heading">
                <div>
                  <p className="eyebrow">Drawing preview</p>
                  <h2>{previewPart.name}</h2>
                </div>
                <div className="preview-actions">
                  {previewPart.drawingUrl && (
                    <a
                      className="icon-button"
                      href={previewPart.drawingUrl}
                      rel="noreferrer"
                      target="_blank"
                      title="Open drawing"
                    >
                      <ExternalLink size={16} />
                    </a>
                  )}
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => setPreviewPartId(null)}
                    title="Close preview"
                  >
                    <X size={17} />
                  </button>
                </div>
              </div>
              {previewPart.drawingUrl ? (
                <iframe
                  allowFullScreen
                  loading="lazy"
                  src={previewPart.drawingUrl}
                  title={`${previewPart.name} Onshape drawing`}
                  referrerPolicy="no-referrer-when-downgrade"
                />
              ) : (
                <div className="empty-preview">
                  <span>No Onshape drawing link saved for this part.</span>
                </div>
              )}
            </section>
          )}
        </section>
      </section>
    </main>
  );
}
