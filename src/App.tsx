import {
  ArrowDownToLine,
  Database,
  ExternalLink,
  FileJson,
  Filter,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useState } from "react";

type ProcessStatus = "Not Started" | "Queued" | "In Progress" | "Done" | "Blocked" | "Outsourced";

type ProcessStep = {
  name: string;
  status: ProcessStatus;
};

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

const SHEET_WEB_APP_URL_KEY = "parts-tracker.sheetWebAppUrl";
const SHEET_URL_KEY = "parts-tracker.sheetUrl";
const WORKSPACE_CACHE_KEY = "parts-tracker.workspaceCache.v1";
const SYNC_INTERVAL_MS = 30000;

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
  notes: ""
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
  "notes"
] as const;

function normalizePart(part: LegacyPart): Part {
  const legacyMaterial = [part.material, part.profile].filter(Boolean).join(", ");
  const processes =
    typeof part.processes === "string"
      ? parseProcesses(part.processes, part.status)
      : Array.isArray(part.processes) && part.processes.length > 0
        ? part.processes
        : [{ name: part.process || "Unassigned", status: part.status || "Not Started" }];

  return {
    id: part.id || crypto.randomUUID(),
    name: part.name || "",
    partNumber: part.partNumber || "",
    originalPartNumber: part.originalPartNumber || part.partNumber || "",
    folder: part.folder === "Unfiled" ? "" : part.folder || "",
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
    notes: part.notes || ""
  };
}

type SheetResult = {
  ok: boolean;
  parts?: LegacyPart[];
  folders?: string[];
  error?: string;
};

type WorkspaceCache = {
  parts: LegacyPart[];
  folders: string[];
  dirty: boolean;
  updatedAt: string;
};

function buildScriptUrl(webAppUrl: string, params: Record<string, string>) {
  const url = new URL(webAppUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function loadWorkspaceCache(): { parts: Part[]; folders: string[]; dirty: boolean } {
  const saved = localStorage.getItem(WORKSPACE_CACHE_KEY);
  if (!saved) return { parts: [], folders: [], dirty: false };

  try {
    const cache = JSON.parse(saved) as WorkspaceCache;
    const parts = Array.isArray(cache.parts) ? cache.parts.map(normalizePart) : [];
    const folders = Array.isArray(cache.folders) ? cache.folders.filter(Boolean) : [];
    return { parts, folders, dirty: Boolean(cache.dirty) };
  } catch {
    return { parts: [], folders: [], dirty: false };
  }
}

function saveWorkspaceCache(parts: Part[], folders: string[], dirty: boolean) {
  const cache: WorkspaceCache = {
    parts,
    folders,
    dirty,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(cache));
}

function readWorkspaceFromSheet(webAppUrl: string): Promise<{ parts: Part[]; folders: string[] }> {
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
      resolve({
        parts: (result.parts || []).map(normalizePart),
        folders: (result.folders || []).map((folder) => folder.trim()).filter(Boolean)
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

async function writeWorkspaceToSheet(webAppUrl: string, parts: Part[], folders: string[]) {
  await fetch(webAppUrl, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify({
      action: "replaceAll",
      parts,
      folders
    })
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
  const highest = parts.reduce((max, part) => {
    const match = part.originalPartNumber.match(/(\d+)$/) || part.partNumber.match(/(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return `PT-${String(highest + 1).padStart(4, "0")}`;
}

type FolderNode = {
  path: string;
  name: string;
  count: number;
  totalCount: number;
  children: FolderNode[];
};

function buildFolderTree(folders: string[], parts: Part[]) {
  const root: FolderNode[] = [];
  const countForPath = (path: string) => parts.filter((part) => (part.folder || "") === path).length;

  folders.forEach((folder) => {
    const pieces = folder.split("/").map((piece) => piece.trim()).filter(Boolean);
    let currentLevel = root;
    let currentPath = "";

    pieces.forEach((piece) => {
      currentPath = currentPath ? `${currentPath} / ${piece}` : piece;
      let node = currentLevel.find((candidate) => candidate.name === piece);
      if (!node) {
        node = {
          path: currentPath,
          name: piece,
          count: countForPath(currentPath),
          totalCount: 0,
          children: []
        };
        currentLevel.push(node);
      }

      currentLevel = node.children;
    });
  });

  function finalize(nodes: FolderNode[]): FolderNode[] {
    return nodes
      .map((node) => {
        const children = finalize(node.children);
        return {
          ...node,
          children,
          totalCount: node.count + children.reduce((sum, child) => sum + child.totalCount, 0)
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return finalize(root);
}

function splitFolderPath(path: string) {
  return path.split("/").map((piece) => piece.trim()).filter(Boolean);
}

function getParentFolder(path: string) {
  const pieces = splitFolderPath(path);
  return pieces.length <= 1 ? "All" : pieces.slice(0, -1).join(" / ");
}

function getDirectChildFolders(currentFolder: string, folders: string[]) {
  const children = new Map<string, string>();

  folders.forEach((folder) => {
    const pieces = splitFolderPath(folder);
    if (currentFolder === "All") {
      if (pieces[0]) children.set(pieces[0], pieces[0]);
      return;
    }

    const currentPieces = splitFolderPath(currentFolder);
    const isChild = pieces.length > currentPieces.length && currentPieces.every((piece, index) => pieces[index] === piece);
    if (isChild) {
      const childPath = pieces.slice(0, currentPieces.length + 1).join(" / ");
      children.set(childPath, childPath);
    }
  });

  return Array.from(children.values()).sort();
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
  const [folderPaths, setFolderPaths] = useState<string[]>(cachedWorkspace.folders);
  const [form, setForm] = useState<PartForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sheetWebAppUrl, setSheetWebAppUrl] = useState(() => localStorage.getItem(SHEET_WEB_APP_URL_KEY) || "");
  const [sheetUrlDraft, setSheetUrlDraft] = useState(() => localStorage.getItem(SHEET_WEB_APP_URL_KEY) || "");
  const [sheetUrl, setSheetUrl] = useState(() => localStorage.getItem(SHEET_URL_KEY) || "");
  const [sheetLinkDraft, setSheetLinkDraft] = useState(() => localStorage.getItem(SHEET_URL_KEY) || "");
  const [isSheetLoading, setIsSheetLoading] = useState(false);
  const [hasPendingSync, setHasPendingSync] = useState(cachedWorkspace.dirty);
  const [sheetMessage, setSheetMessage] = useState(
    cachedWorkspace.parts.length
      ? cachedWorkspace.dirty
        ? "Loaded local changes. Sync is pending."
        : "Loaded local cache."
      : "Connect the Google Apps Script web app to load parts."
  );
  const [query, setQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState<"All" | ProcessStatus>("All");
  const [processFilter, setProcessFilter] = useState("All");
  const [processDraft, setProcessDraft] = useState<ProcessStep>({ name: "", status: "Not Started" });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(["Subsystem", "Material"]));
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
  }, [folderPaths, hasPendingSync, isSheetLoading, parts, sheetWebAppUrl]);

  async function refreshFromSheet(url = sheetWebAppUrl) {
    if (!url) {
      setSheetMessage("Connect the Google Apps Script web app to load parts.");
      setParts([]);
      return;
    }

    setIsSheetLoading(true);
    setSheetMessage("Loading from Google Sheet...");
    try {
      const workspace = await readWorkspaceFromSheet(url);
      const nextParts = workspace.parts;
      const nextFolders = Array.from(
        new Set([
          ...workspace.folders.filter((folder) => folder !== "Unfiled"),
          ...nextParts.map((part) => part.folder).filter(Boolean)
        ])
      ).sort() as string[];
      setParts(nextParts);
      setFolderPaths(nextFolders);
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

  function persist(nextParts: Part[], nextFolders = folderPaths) {
    setParts(nextParts);
    setFolderPaths(nextFolders);
    setHasPendingSync(true);
    saveWorkspaceCache(nextParts, nextFolders, true);
    setSheetMessage(sheetWebAppUrl ? "Saved locally. Google Sheet sync pending." : "Saved locally. Connect the Sheet to sync.");
    return true;
  }

  async function syncToSheet() {
    if (!sheetWebAppUrl) {
      setSheetMessage("Connect the Google Apps Script web app before syncing.");
      return false;
    }

    setIsSheetLoading(true);
    setSheetMessage("Syncing local changes to Google Sheet...");
    try {
      await writeWorkspaceToSheet(sheetWebAppUrl, parts, folderPaths);
      saveWorkspaceCache(parts, folderPaths, false);
      setHasPendingSync(false);
      setSheetMessage(`Synced ${parts.length} parts to the Google Sheet.`);
      return true;
    } catch (error) {
      setSheetMessage(error instanceof Error ? error.message : "Could not save to Google Sheet.");
      return false;
    } finally {
      setIsSheetLoading(false);
    }
  }

  function connectSheet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = sheetUrlDraft.trim();
    const sheetLink = sheetLinkDraft.trim();
    if (!url) return;
    if (!url.includes("script.google.com") || !url.includes("/exec")) {
      setSheetMessage("Paste the deployed Apps Script web app URL ending in /exec.");
      return;
    }
    localStorage.setItem(SHEET_WEB_APP_URL_KEY, url);
    if (sheetLink) localStorage.setItem(SHEET_URL_KEY, sheetLink);
    setSheetWebAppUrl(url);
    setSheetUrl(sheetLink);
  }

  const processes = useMemo(
    () => [
      "All",
      ...Array.from(new Set(parts.flatMap((part) => part.processes.map((process) => process.name)).filter(Boolean))).sort()
    ],
    [parts]
  );

  const folders = useMemo(
    () => Array.from(new Set([...folderPaths, ...parts.map((part) => part.folder).filter(Boolean)])).sort() as string[],
    [folderPaths, parts]
  );
  const folderTree = useMemo(() => buildFolderTree(folders, parts), [folders, parts]);
  const childFolders = useMemo(() => getDirectChildFolders(folderFilter, folders), [folderFilter, folders]);
  const breadcrumbFolders = useMemo(() => {
    if (folderFilter === "All") return [];
    const pieces = splitFolderPath(folderFilter);
    return pieces.map((piece, index) => ({
      name: piece,
      path: pieces.slice(0, index + 1).join(" / ")
    }));
  }, [folderFilter]);

  const filteredParts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return parts.filter((part) => {
      const partFolder = part.folder || "";
      const folderMatches = normalizedQuery
        ? folderFilter === "All" || partFolder === folderFilter || partFolder.startsWith(`${folderFilter} / `)
        : folderFilter === "All"
          ? partFolder === ""
          : partFolder === folderFilter;
      const statusMatches =
        statusFilter === "All" || part.processes.some((process) => process.status === statusFilter);
      const processMatches =
        processFilter === "All" || part.processes.some((process) => process.name === processFilter);
      const searchable = {
        ...part,
        processes: serializeProcesses(part.processes)
      };
      const queryMatches =
        !normalizedQuery ||
        Object.values(searchable).some((value) => String(value).toLowerCase().includes(normalizedQuery));

      return folderMatches && statusMatches && processMatches && queryMatches;
    });
  }, [folderFilter, parts, processFilter, query, statusFilter]);

  const totalValue = parts.reduce((sum, part) => sum + part.quantity * part.unitPrice, 0);
  const lowStockCount = parts.filter((part) => part.quantity <= 2).length;
  const blockedCount = parts.filter((part) => part.processes.some((process) => process.status === "Blocked")).length;
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
    const draft = folderName?.trim();
    if (!draft) return;
    const folder = draft.includes("/") || parent === "All" ? draft : `${parent} / ${draft}`;
    const nextFolders = Array.from(new Set([...folders, folder])).sort();
    setFolderFilter(folder);
    setExpandedFolders((current) => {
      const next = new Set(current);
      const pieces = folder.split("/").map((piece) => piece.trim()).filter(Boolean);
      pieces.slice(0, -1).reduce((path, piece) => {
        const nextPath = path ? `${path} / ${piece}` : piece;
        next.add(nextPath);
        return nextPath;
      }, "");
      return next;
    });
    persist(parts, nextFolders);
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function removeFolder(path: string) {
    const parent = getParentFolder(path);
    const parentPath = parent === "All" ? "" : parent;
    const affectedParts = parts.filter((part) => {
      const folder = part.folder || "";
      return folder === path || folder.startsWith(`${path} / `);
    });

    const confirmed = window.confirm(
      `Delete "${path}" and its nested folders? ${affectedParts.length} affected part(s) will move to the parent folder.`
    );
    if (!confirmed) return;

    const nextParts = parts.map((part) => {
      const folder = part.folder || "";
      if (folder === path || folder.startsWith(`${path} / `)) {
        return { ...part, folder: parentPath };
      }
      return part;
    });
    const nextFolders = folders.filter((folder) => folder !== path && !folder.startsWith(`${path} / `));

    const saved = persist(nextParts, nextFolders);
    if (saved && (folderFilter === path || folderFilter.startsWith(`${path} / `))) {
      setFolderFilter(parent);
    }
  }

  function renameFolderPath(folder: string, targetParent: string) {
    const pieces = folder.split("/").map((piece) => piece.trim()).filter(Boolean);
    const name = pieces[pieces.length - 1] || folder;
    return !targetParent || targetParent === "All" ? name : `${targetParent} / ${name}`;
  }

  async function moveFolder(folder: string, targetParent: string) {
    if (folder === targetParent || targetParent.startsWith(`${folder} / `)) return;

    const nextBasePath = renameFolderPath(folder, targetParent);
    const rewrite = (path: string) => {
      if (path === folder) return nextBasePath;
      if (path.startsWith(`${folder} / `)) return `${nextBasePath}${path.slice(folder.length)}`;
      return path;
    };
    const nextParts = parts.map((part) => ({ ...part, folder: rewrite(part.folder || "") }));
    const nextFolders = Array.from(new Set(folders.map(rewrite))).sort();
    persist(nextParts, nextFolders);
    setFolderFilter((current) => rewrite(current));
    setExpandedFolders((current) => {
      const next = new Set(Array.from(current).map(rewrite));
      next.add(targetParent);
      next.add(nextBasePath);
      return next;
    });
  }

  async function movePartToFolder(partId: string, folder: string) {
    const nextParts = parts.map((part) => (part.id === partId ? { ...part, folder } : part));
    persist(nextParts, folders);
  }

  async function renameFolder(path: string) {
    const pieces = splitFolderPath(path);
    const currentName = pieces[pieces.length - 1] || path;
    const nextName = window.prompt("Rename folder", currentName)?.trim();
    if (!nextName || nextName === currentName) return;

    const parent = getParentFolder(path);
    const nextBasePath = parent === "All" ? nextName : `${parent} / ${nextName}`;
    const rewrite = (folder: string) => {
      if (folder === path) return nextBasePath;
      if (folder.startsWith(`${path} / `)) return `${nextBasePath}${folder.slice(path.length)}`;
      return folder;
    };

    const nextParts = parts.map((part) => ({ ...part, folder: rewrite(part.folder || "") }));
    const nextFolders = Array.from(new Set(folders.map(rewrite))).sort();
    const saved = persist(nextParts, nextFolders);
    if (saved) setFolderFilter((current) => rewrite(current));
  }

  async function unpackFolder(path: string) {
    const parent = getParentFolder(path);
    const parentPath = parent === "All" ? "" : parent;
    const rewrite = (folder: string) => {
      if (folder === path) return parentPath;
      if (folder.startsWith(`${path} / `)) {
        const suffix = folder.slice(path.length + 3);
        return parentPath ? `${parentPath} / ${suffix}` : suffix;
      }
      return folder;
    };

    const confirmed = window.confirm(`Unpack "${path}" into its parent folder?`);
    if (!confirmed) return;

    const nextParts = parts.map((part) => ({ ...part, folder: rewrite(part.folder || "") }));
    const nextFolders = Array.from(
      new Set(folders.filter((folder) => folder !== path).map(rewrite).filter(Boolean))
    ).sort();
    const saved = persist(nextParts, nextFolders);
    if (saved) setFolderFilter(parent);
  }

  function handleFolderDrop(event: DragEvent<HTMLElement>, targetFolder: string) {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/json");
    if (!raw) return;

    try {
      const payload = JSON.parse(raw) as { type: string; id?: string; path?: string };
      if (payload.type === "part" && payload.id) {
        void movePartToFolder(payload.id, targetFolder === "All" ? "" : targetFolder);
      }
      if (payload.type === "folder" && payload.path) {
        void moveFolder(payload.path, targetFolder === "All" ? "" : targetFolder);
      }
    } catch {
      setSheetMessage("Could not read dragged item.");
    }
  }

  function getFolderDirectCount(path: string) {
    return parts.filter((part) => (part.folder || "") === path).length;
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
    const generatedPartNumber = editingId ? originalPartNumber : nextPartNumber;
    const nextPart = formToPart(
      {
        ...form,
        partNumber: visiblePartNumber,
        originalPartNumber: form.originalPartNumber || generatedPartNumber,
        folder: editingId ? form.folder : folderFilter === "All" ? "" : folderFilter
      },
      editingId ?? undefined
    );
    if (nextPart.processes.length === 0) nextPart.processes = [{ name: "Unassigned", status: "Not Started" }];
    const nextParts = editingId
      ? parts.map((part) => (part.id === editingId ? nextPart : part))
      : [nextPart, ...parts];

    const saved = persist(nextParts);
    if (saved) {
      setForm({
        ...emptyForm,
        partNumber: generateNextPartNumber(nextParts),
        originalPartNumber: generateNextPartNumber(nextParts)
      });
      setEditingId(null);
    }
  }

  function editPart(part: Part) {
    setPreviewPartId(part.id);
    setEditingId(part.id);
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
  }

  function downloadCsv() {
    const csv = [
      csvHeaders.join(","),
      ...parts.map((part) =>
        csvHeaders
          .map((header) => escapeCsv(header === "processes" ? serializeProcesses(part.processes) : part[header]))
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

    const importedParts = rows.slice(1).map((row) => {
      const record = Object.fromEntries(headerRow.map((header, index) => [header, row[index] ?? ""]));
      const material = [record.material, record.profile].filter(Boolean).join(", ");

      return formToPart(
        {
          name: record.name ?? "",
          partNumber: record.partNumber ?? "",
          originalPartNumber: record.originalPartNumber || record.partNumber || "",
        folder: record.folder === "Unfiled" ? "" : record.folder ?? "",
          quantity: record.quantity ?? "0",
          unitPrice: record.unitPrice ?? "0",
          material,
          thickness: record.thickness ?? "",
          processes: parseProcesses(record.processes || record.process || "", record.status),
          drawingUrl: record.drawingUrl ?? "",
          vendor: record.vendor ?? "",
          location: record.location ?? "",
          notes: record.notes ?? ""
        },
        record.id || undefined
      );
    });

    persist([...importedParts, ...parts]);
    event.target.value = "";
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    const isExpanded = expandedFolders.has(node.path);
    const hasChildren = node.children.length > 0;

    return (
      <div
        className="folder-node"
        key={node.path}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => handleFolderDrop(event, node.path)}
      >
        <div className="folder-row" style={{ paddingLeft: `${depth * 14}px` }}>
          <button
            className="folder-toggle"
            disabled={!hasChildren}
            type="button"
            onClick={() => toggleFolder(node.path)}
            title={hasChildren ? "Expand folder" : "No nested folders"}
          >
            {hasChildren ? (isExpanded ? "v" : ">") : ""}
          </button>
          <button
            className={`folder-button ${folderFilter === node.path ? "active" : ""}`}
            draggable
            type="button"
            onDragStart={(event) => {
              event.dataTransfer.setData("application/json", JSON.stringify({ type: "folder", path: node.path }));
            }}
            onClick={() => setFolderFilter(node.path)}
          >
            <span>{node.name}</span>
            <strong>{node.totalCount}</strong>
          </button>
          <button
            className="icon-button folder-remove"
            type="button"
            onClick={() => void removeFolder(node.path)}
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
        <form className="sheet-form" onSubmit={connectSheet}>
          <label>
            Apps Script web app URL
            <input
              placeholder="https://script.google.com/macros/s/.../exec"
              value={sheetUrlDraft}
              onChange={(event) => setSheetUrlDraft(event.target.value)}
            />
          </label>
          <label>
            Google Sheet URL
            <input
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={sheetLinkDraft}
              onChange={(event) => setSheetLinkDraft(event.target.value)}
            />
          </label>
          <button className="button primary" type="submit">
            <Database size={16} />
            Connect
          </button>
        </form>
        <div className="sheet-status">
          <span>{hasPendingSync ? "Unsynced local changes" : "Synced"} - {sheetMessage}</span>
          <a
            aria-disabled={!sheetUrl}
            href={sheetUrl || undefined}
            rel="noreferrer"
            target="_blank"
          >
            Open Sheet
          </a>
        </div>
      </section>

      <section className="stats-grid">
        <article>
          <span>Total Parts</span>
          <strong>{parts.length}</strong>
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
          <span>Blocked Routes</span>
          <strong>{blockedCount}</strong>
        </article>
      </section>

      <section className="workspace">
        <form className="editor-panel" onSubmit={handleSubmit}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{editingId ? "Editing part" : "New part"}</p>
              <h2>{editingId ? form.name || "Untitled Part" : "Add Inventory"}</h2>
            </div>
            {editingId && (
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm({
                    ...emptyForm,
                    partNumber: nextPartNumber,
                    originalPartNumber: nextPartNumber
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
              Part name
              <input required value={form.name} onChange={(event) => updateForm("name", event.target.value)} />
            </label>
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
              Thickness
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
            <label className="span-two">
              Onshape drawing link
              <input
                placeholder="https://cad.onshape.com/documents/..."
                type="url"
                value={form.drawingUrl}
                onChange={(event) => updateForm("drawingUrl", event.target.value)}
              />
            </label>
          </div>

          <section className="process-editor">
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
          </section>

          <label>
            Notes
            <textarea value={form.notes} onChange={(event) => updateForm("notes", event.target.value)} />
          </label>

          <button className="button primary wide" disabled={isSheetLoading || !sheetWebAppUrl} type="submit">
            {editingId ? <Database size={16} /> : <PackagePlus size={16} />}
            {editingId ? "Save Part" : "Add Part"}
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
            className={`folder-button ${folderFilter === "All" ? "active" : ""}`}
            type="button"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleFolderDrop(event, "All")}
            onClick={() => setFolderFilter("All")}
          >
            <span>Root</span>
            <strong>{parts.length}</strong>
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
                placeholder="Search names, numbers, materials, processes..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="filters">
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
            </div>
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
                  key={folder.path}
                  type="button"
                  onClick={() => setFolderFilter(folder.path)}
                >
                  / {folder.name}
                </button>
              ))}
            </div>

            {folderFilter !== "All" && (
              <button
                className="folder-tile parent-folder"
                type="button"
                onClick={() => setFolderFilter(getParentFolder(folderFilter))}
              >
                <span>..</span>
                <small>Parent folder</small>
              </button>
            )}

            <div className="folder-tile-grid">
              {childFolders.map((folder) => {
                const name = splitFolderPath(folder).slice(-1)[0] || folder;
                return (
                  <div
                    className="folder-tile"
                    draggable
                    key={folder}
                    onClick={() => setFolderFilter(folder)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") setFolderFilter(folder);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/json", JSON.stringify({ type: "folder", path: folder }));
                    }}
                    onDrop={(event) => handleFolderDrop(event, folder)}
                    role="button"
                    tabIndex={0}
                  >
                    <span>{name}</span>
                    <small>{getFolderDirectCount(folder)} direct part(s)</small>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="table-heading">
            <span>
              {query.trim() ? "Search Results" : "Current Folder"} ({filteredParts.length} part(s))
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
                  <th>Part #</th>
                  <th>Material / Profile</th>
                  <th>Processes</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredParts.map((part) => (
                  <tr
                    draggable
                    key={part.id}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/json", JSON.stringify({ type: "part", id: part.id }));
                    }}
                  >
                    <td>
                      <input
                        aria-label={`Select ${part.name}`}
                        type="checkbox"
                        checked={selected.has(part.id)}
                        onChange={() => toggleSelected(part.id)}
                      />
                    </td>
                    <td>
                      <button className="part-name" type="button" onClick={() => editPart(part)}>
                        <span>{part.name}</span>
                        <small>{part.vendor || "No vendor"} - {part.location || "No location"}</small>
                      </button>
                    </td>
                    <td>{part.folder || "Root"}</td>
                    <td>{part.partNumber}</td>
                    <td>
                      <div>{part.material}</div>
                      <small>{part.thickness}</small>
                    </td>
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
                    <td>{part.quantity}</td>
                    <td>${part.unitPrice.toFixed(2)}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" onClick={() => editPart(part)}>Edit</button>
                        <button className="danger" type="button" onClick={() => deletePart(part.id)} title="Delete part">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {previewPart && (
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
