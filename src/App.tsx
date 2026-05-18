import {
  ArrowDownToLine,
  Check,
  Database,
  ExternalLink,
  FileJson,
  Filter,
  Folder,
  Lock,
  LogOut,
  LoaderCircle,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  Upload,
  X
} from "lucide-react";
import { ChangeEvent, CSSProperties, DragEvent, FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { initializeApp, type FirebaseApp } from "firebase/app";
import { collection, doc, getDocs, getFirestore, serverTimestamp, writeBatch, type Firestore, type WriteBatch } from "firebase/firestore";

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
  discountPercent: number;
  material: string;
  thickness: string;
  processes: ProcessStep[];
  drawingUrl: string;
  vendor: string;
  location: string;
  notes: string;
  itemKind: ItemKind;
  linkedBomId: string;
  attachmentFileName: string;
  attachmentMimeType: string;
  attachmentDataUrl: string;
  createdAt: string;
};

type FolderRecord = {
  id: string;
  name: string;
  parentId: string;
  itemKind: ItemKind;
  createdAt: string;
};

type LegacyPart = Omit<Partial<Part>, "processes"> & {
  profile?: string;
  process?: string;
  processes?: ProcessStep[] | string;
  status?: ProcessStatus;
};

type PartForm = Omit<Part, "id" | "quantity" | "unitPrice" | "discountPercent" | "createdAt"> & {
  quantity: string;
  unitPrice: string;
  discountPercent: string;
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

type ListEntry =
  | { type: "folder"; folder: FolderRecord; depth: number; isLast: boolean; ancestorContinues: boolean[] }
  | { type: "part"; part: Part; depth: number; isLast: boolean; ancestorContinues: boolean[] };

type SortKey = "name" | "createdAt" | "type" | "folder" | "number" | "material" | "process" | "drawing" | "quantity" | "price" | "actions";

type SortState = {
  key: SortKey;
  direction: "asc" | "desc";
} | null;

type FolderContextMenu = {
  folderId: string;
  x: number;
  y: number;
};

type UndoSnapshot = {
  parts: Part[];
  folders: FolderRecord[];
  deletedPartIds: string[];
  deletedFolderIds: string[];
};

const WORKSPACE_CACHE_KEY = "parts-tracker.workspaceCache.v1";
const LOGIN_CACHE_KEY = "parts-tracker.login.v1";
const MAX_UNDO_STEPS = 30;
const APP_USERS = [
  { username: "HudsonM", password: "1648" }
] as const;
const FIREBASE_WORKSPACE_ID = import.meta.env.VITE_FIREBASE_WORKSPACE_ID || "parts-tracker";
const FIREBASE_ATTACHMENT_CHUNK_SIZE = 700_000;
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ""
};

let firebaseApp: FirebaseApp | null = null;
let firebaseDb: Firestore | null = null;

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
  discountPercent: "0",
  material: "",
  thickness: "",
  processes: [],
  drawingUrl: "",
  vendor: "",
  location: "",
  notes: "",
  itemKind: "bom",
  linkedBomId: "",
  attachmentFileName: "",
  attachmentMimeType: "",
  attachmentDataUrl: ""
};

const csvHeaders = [
  "id",
  "name",
  "partNumber",
  "originalPartNumber",
  "folder",
  "quantity",
  "unitPrice",
  "discountPercent",
  "material",
  "thickness",
  "processes",
  "drawingUrl",
  "vendor",
  "location",
  "notes",
  "itemKind",
  "linkedBomId",
  "attachmentFileName",
  "attachmentMimeType",
  "createdAt"
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
    discountPercent: clampNumber(Number(part.discountPercent) || 0, 0, 100),
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
    linkedBomId: part.linkedBomId || "",
    attachmentFileName: part.attachmentFileName || "",
    attachmentMimeType: part.attachmentMimeType || "",
    attachmentDataUrl: part.attachmentDataUrl || "",
    createdAt: String(part.createdAt || "")
  };
}

function stripLocalAttachmentData(parts: Part[]) {
  return parts.map((part) => ({ ...part, attachmentDataUrl: "" }));
}

type WorkspaceCache = {
  parts: LegacyPart[];
  folders: LegacyFolder[];
  dirty: boolean;
  deletedPartIds?: string[];
  deletedFolderIds?: string[];
  updatedAt: string;
};

type LegacyFolder = string | Partial<FolderRecord>;

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function safeHostname(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function normalizeExternalUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^data:application\/pdf/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return "";
}

function renderLinkedValue(value: string, fallback = "") {
  const text = value.trim();
  if (!text) return fallback;
  const href = normalizeExternalUrl(text);
  if (!href) return text;

  return (
    <a
      className="list-link"
      draggable={false}
      href={href}
      rel={href.startsWith("data:") ? undefined : "noreferrer"}
      target="_blank"
      title={text}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.open(href, "_blank", href.startsWith("data:") ? "noopener" : "noopener,noreferrer");
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {href.startsWith("data:") ? fallback || "Open PDF" : text.replace(/^https?:\/\//i, "")}
    </a>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(value: string) {
  const [metadata, data = ""] = value.split(",");
  const mimeType = metadata.match(/^data:([^;]+)/)?.[1] || "application/octet-stream";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function parseItemKind(value: unknown): ItemKind {
  return value === "production" ? "production" : "bom";
}

function makeFolderId() {
  return `folder-${crypto.randomUUID()}`;
}

function legacyFolderId(path: string, itemKind: ItemKind) {
  return `legacy-${itemKind}-${normalizeFolderPath(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
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
      parentId: record.parentId || "",
      itemKind: parseItemKind(record.itemKind),
      createdAt: String(record.createdAt || "")
    };
    folderById.set(normalizedRecord.id, normalizedRecord);
    records.push(normalizedRecord);
    return normalizedRecord.id;
  }

  function ensurePath(path: string, itemKind: ItemKind) {
    const pieces = splitFolderPath(path);
    let parentId = "";
    let currentPath = "";

    pieces.forEach((piece) => {
      currentPath = currentPath ? `${currentPath} / ${piece}` : piece;
      const pathKey = `${itemKind}:${currentPath}`;
      const existingId = idByPath.get(pathKey);
      if (existingId) {
        parentId = existingId;
        return;
      }

      const id = legacyFolderId(currentPath, itemKind);
      parentId = addRecord({ id, name: piece, parentId, itemKind, createdAt: "" });
      idByPath.set(pathKey, id);
    });

    return parentId;
  }

  rawFolders.forEach((folder) => {
    if (typeof folder === "string") {
      ensurePath(folder, "bom");
      return;
    }

    const id = String(folder.id || "").trim();
    const name = String(folder.name || "").trim();
    if (id && name) {
      addRecord({
        id,
        name,
        parentId: String(folder.parentId || "").trim(),
        itemKind: parseItemKind(folder.itemKind),
        createdAt: String(folder.createdAt || "")
      });
    }
  });

  rawParts.forEach((part) => {
    const folder = String(part.folder || "").trim();
    const itemKind = parseItemKind(part.itemKind);
    if (folder && folder !== "Unfiled" && !folderById.has(folder)) ensurePath(folder, itemKind);
  });

  records.forEach((folder) => {
    const path = getFolderDisplayPath(folder.id, records);
    if (path) idByPath.set(`${folder.itemKind}:${path}`, folder.id);
  });

  return { folders: records, idByPath, folderIds: new Set(records.map((folder) => folder.id)) };
}

function migratePartFolder(part: Part, idByPath: Map<string, string>, folderIds: Set<string>) {
  if (!part.folder) return part;
  if (folderIds.has(part.folder)) return part;
  const normalizedPath = normalizeFolderPath(part.folder);
  return { ...part, folder: idByPath.get(`${part.itemKind}:${normalizedPath}`) || idByPath.get(`bom:${normalizedPath}`) || "" };
}

function loadWorkspaceCache(): {
  parts: Part[];
  folders: FolderRecord[];
  dirty: boolean;
  deletedPartIds: string[];
  deletedFolderIds: string[];
} {
  const saved = localStorage.getItem(WORKSPACE_CACHE_KEY);
  if (!saved) return { parts: [], folders: [], dirty: false, deletedPartIds: [], deletedFolderIds: [] };

  try {
    const cache = JSON.parse(saved) as WorkspaceCache;
    const rawParts = Array.isArray(cache.parts) ? cache.parts : [];
    const { folders, idByPath, folderIds } = normalizeFolders(Array.isArray(cache.folders) ? cache.folders : [], rawParts);
    const parts = rawParts.map(normalizePart).map((part) => migratePartFolder(part, idByPath, folderIds));
    return {
      parts,
      folders,
      dirty: Boolean(cache.dirty),
      deletedPartIds: Array.isArray(cache.deletedPartIds) ? cache.deletedPartIds.filter(Boolean) : [],
      deletedFolderIds: Array.isArray(cache.deletedFolderIds) ? cache.deletedFolderIds.filter(Boolean) : []
    };
  } catch {
    return { parts: [], folders: [], dirty: false, deletedPartIds: [], deletedFolderIds: [] };
  }
}

function isValidTeamUsername(username: string) {
  return APP_USERS.some((user) => user.username === username.trim());
}

function loadLoginSession() {
  const username = localStorage.getItem(LOGIN_CACHE_KEY) || "";
  return isValidTeamUsername(username) ? username : "";
}

function saveLoginSession(username: string) {
  localStorage.setItem(LOGIN_CACHE_KEY, username);
}

function isValidLogin(username: string, password: string) {
  return APP_USERS.some((user) => user.username === username.trim() && user.password === password);
}

function saveWorkspaceCache(
  parts: Part[],
  folders: FolderRecord[],
  dirty: boolean,
  deletedPartIds: string[] = [],
  deletedFolderIds: string[] = []
) {
  const cache: WorkspaceCache = {
    parts: dirty ? parts : stripLocalAttachmentData(parts),
    folders,
    dirty,
    deletedPartIds,
    deletedFolderIds,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(cache));
}

function hasFirebaseConfig() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

function getFirebaseApp() {
  if (!hasFirebaseConfig()) {
    throw new Error("Firebase is not configured. Add the VITE_FIREBASE_* values to your environment.");
  }
  if (!firebaseApp) firebaseApp = initializeApp(firebaseConfig);
  return firebaseApp;
}

function getFirebaseDatabase() {
  if (!firebaseDb) firebaseDb = getFirestore(getFirebaseApp());
  return firebaseDb;
}

function workspaceCollection(db: Firestore, name: "parts" | "folders" | "attachmentChunks") {
  return collection(db, "workspaces", FIREBASE_WORKSPACE_ID, name);
}

function partDocumentForFirestore(part: Part) {
  const { attachmentDataUrl: _attachmentDataUrl, ...documentPart } = part;
  return documentPart;
}

function rebuildAttachments(chunks: Array<{ partId: string; fileName: string; mimeType: string; chunkIndex: number; data: string }>) {
  const grouped = new Map<string, Array<{ fileName: string; mimeType: string; chunkIndex: number; data: string }>>();
  chunks.forEach((chunk) => {
    grouped.set(chunk.partId, [...(grouped.get(chunk.partId) || []), chunk]);
  });

  const attachments = new Map<string, { fileName: string; mimeType: string; dataUrl: string }>();
  grouped.forEach((partChunks, partId) => {
    const sortedChunks = [...partChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    attachments.set(partId, {
      fileName: sortedChunks[0]?.fileName || "",
      mimeType: sortedChunks[0]?.mimeType || "application/pdf",
      dataUrl: sortedChunks.map((chunk) => chunk.data).join("")
    });
  });
  return attachments;
}

async function readWorkspaceFromFirebase(): Promise<{ parts: Part[]; folders: FolderRecord[] }> {
  const db = getFirebaseDatabase();
  const [partsSnapshot, foldersSnapshot, attachmentSnapshot] = await Promise.all([
    getDocs(workspaceCollection(db, "parts")),
    getDocs(workspaceCollection(db, "folders")),
    getDocs(workspaceCollection(db, "attachmentChunks"))
  ]);

  const rawParts = partsSnapshot.docs.map((partDoc) => ({ id: partDoc.id, ...partDoc.data() }) as LegacyPart);
  const rawFolders = foldersSnapshot.docs.map((folderDoc) => ({ id: folderDoc.id, ...folderDoc.data() }) as LegacyFolder);
  const attachments = rebuildAttachments(
    attachmentSnapshot.docs.map((attachmentDoc) => attachmentDoc.data() as {
      partId: string;
      fileName: string;
      mimeType: string;
      chunkIndex: number;
      data: string;
    })
  );

  const { folders, idByPath, folderIds } = normalizeFolders(rawFolders, rawParts);
  const parts = rawParts.map(normalizePart).map((part) => {
    const attachment = attachments.get(part.id);
    const normalizedPart = migratePartFolder(part, idByPath, folderIds);
    if (!attachment) return normalizedPart;
    return {
      ...normalizedPart,
      attachmentFileName: attachment.fileName,
      attachmentMimeType: attachment.mimeType,
      attachmentDataUrl: attachment.dataUrl
    };
  });

  return { parts, folders };
}

async function writeWorkspaceToFirebase(parts: Part[], folders: FolderRecord[]) {
  const db = getFirebaseDatabase();
  const existingSnapshots = await Promise.all([
    getDocs(workspaceCollection(db, "parts")),
    getDocs(workspaceCollection(db, "folders")),
    getDocs(workspaceCollection(db, "attachmentChunks"))
  ]);

  let batch = writeBatch(db);
  let operationCount = 0;

  async function queueOperation(addToBatch: (targetBatch: WriteBatch) => void) {
    addToBatch(batch);
    operationCount += 1;
    if (operationCount >= 450) {
      await batch.commit();
      batch = writeBatch(db);
      operationCount = 0;
    }
  }

  for (const snapshot of existingSnapshots) {
    for (const existingDoc of snapshot.docs) {
      await queueOperation((targetBatch) => targetBatch.delete(existingDoc.ref));
    }
  }

  for (const part of parts) {
    await queueOperation((targetBatch) =>
      targetBatch.set(doc(workspaceCollection(db, "parts"), part.id), partDocumentForFirestore(part))
    );

    const dataUrl = part.attachmentDataUrl.trim();
    if (dataUrl) {
      for (let index = 0; index < dataUrl.length; index += FIREBASE_ATTACHMENT_CHUNK_SIZE) {
        const chunkIndex = Math.floor(index / FIREBASE_ATTACHMENT_CHUNK_SIZE);
        await queueOperation((targetBatch) =>
          targetBatch.set(doc(workspaceCollection(db, "attachmentChunks"), `${part.id}_${String(chunkIndex).padStart(4, "0")}`), {
            partId: part.id,
            fileName: part.attachmentFileName,
            mimeType: part.attachmentMimeType || "application/pdf",
            chunkIndex,
            data: dataUrl.slice(index, index + FIREBASE_ATTACHMENT_CHUNK_SIZE)
          })
        );
      }
    }
  }

  for (const folder of folders) {
    await queueOperation((targetBatch) => targetBatch.set(doc(workspaceCollection(db, "folders"), folder.id), folder));
  }

  await queueOperation((targetBatch) =>
    targetBatch.set(doc(db, "workspaces", FIREBASE_WORKSPACE_ID), {
      updatedAt: serverTimestamp(),
      partCount: parts.length,
      folderCount: folders.length
    })
  );

  if (operationCount > 0) await batch.commit();
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
  remoteFolders: FolderRecord[],
  deletedPartIds: string[] = [],
  deletedFolderIds: string[] = []
) {
  const remoteById = new Map(remoteParts.map((part) => [part.id, part]));
  const localById = new Map(localParts.map((part) => [part.id, part]));
  const deletedPartIdSet = new Set(deletedPartIds);
  const deletedFolderIdSet = new Set(deletedFolderIds);
  const mergedParts = remoteParts
    .filter((part) => !localById.has(part.id) && !deletedPartIdSet.has(part.id))
    .map((part) => (deletedFolderIdSet.has(part.folder) ? { ...part, folder: "" } : part));
  const usedPartNumbers = new Set(
    mergedParts.filter((part) => part.itemKind === "production").map((part) => part.partNumber).filter(Boolean)
  );
  let renumberedCount = 0;

  localParts.forEach((part) => {
    const remotePart = remoteById.get(part.id);
    const isNewToBackend = !remotePart;
    const needsProductionNumber = part.itemKind === "production";
    const hasCollision = Boolean(needsProductionNumber && part.partNumber && usedPartNumbers.has(part.partNumber));
    let nextPart = !part.attachmentDataUrl && remotePart?.attachmentDataUrl
      ? {
        ...part,
        attachmentDataUrl: remotePart.attachmentDataUrl,
        attachmentFileName: part.attachmentFileName || remotePart.attachmentFileName,
        attachmentMimeType: part.attachmentMimeType || remotePart.attachmentMimeType
      }
      : part;

    if (needsProductionNumber && (!nextPart.partNumber || hasCollision)) {
      const nextNumber = nextAvailablePartNumber(usedPartNumbers);
      nextPart = {
        ...nextPart,
        partNumber: nextNumber,
        originalPartNumber: isNewToBackend || !nextPart.originalPartNumber ? nextNumber : nextPart.originalPartNumber
      };
      renumberedCount += 1;
    }

    if (nextPart.itemKind === "production") usedPartNumbers.add(nextPart.partNumber);
    mergedParts.push(nextPart);
  });

  const mergedFolders = uniqueFoldersById([
    ...remoteFolders.filter((folder) => !deletedFolderIdSet.has(folder.id)),
    ...localFolders
  ]);

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

function getRelevantFolders(folders: FolderRecord[], sectionItems: Part[], itemKind: ItemKind) {
  const relevantIds = new Set(folders.filter((folder) => folder.itemKind === itemKind).map((folder) => folder.id));
  sectionItems.forEach((part) => {
    if (part.folder) relevantIds.add(part.folder);
  });

  let changed = true;
  while (changed) {
    changed = false;
    folders.forEach((folder) => {
      if (relevantIds.has(folder.id) && folder.parentId && !relevantIds.has(folder.parentId)) {
        relevantIds.add(folder.parentId);
        changed = true;
      }
    });
  }

  return folders.filter((folder) => relevantIds.has(folder.id));
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

function getBomLineCost(part: Part) {
  const discountMultiplier = 1 - clampNumber(part.discountPercent || 0, 0, 100) / 100;
  return part.quantity * part.unitPrice * discountMultiplier;
}

function formatCreatedDate(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function compareValues(first: string | number, second: string | number) {
  if (typeof first === "number" && typeof second === "number") return first - second;
  return String(first).localeCompare(String(second), undefined, { numeric: true, sensitivity: "base" });
}

function stableSort<T>(items: T[], compare: (first: T, second: T) => number) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((first, second) => compare(first.item, second.item) || first.index - second.index)
    .map(({ item }) => item);
}

function TreeGuideLines({
  ancestorContinues,
  continuesToChildren,
  depth,
  isLast
}: {
  ancestorContinues: boolean[];
  continuesToChildren?: boolean;
  depth: number;
  isLast: boolean;
}) {
  if (depth === 0 && !continuesToChildren) return null;

  const indent = 22;
  const control = 22;
  const gap = 7;
  const rowHeight = 56;
  const midY = rowHeight / 2;
  const lineColor = "rgba(0, 0, 0, 0.28)";
  const controlCenter = (level: number) => level * indent + gap + control / 2;
  const ownControlLeft = depth * indent + gap;
  const parentX = depth > 0 ? controlCenter(depth - 1) : controlCenter(0);
  const width = Math.max(controlCenter(depth) + control + gap, parentX + control + gap);
  const points: Array<{ x: number; y: number }> = [];

  function addPoint(x: number, y: number) {
    if (!points.some((point) => point.x === x && point.y === y)) points.push({ x, y });
  }

  ancestorContinues.forEach((continues, level) => {
    if (!continues || level >= depth - 1) return;
    const x = controlCenter(level);
    addPoint(x, 0);
    addPoint(x, rowHeight);
  });

  if (depth > 0) {
    addPoint(parentX, 0);
    addPoint(parentX, midY);
    addPoint(ownControlLeft, midY);
    if (!isLast) addPoint(parentX, rowHeight);
  }

  if (continuesToChildren) {
    const x = controlCenter(depth);
    addPoint(x, midY);
    addPoint(x, rowHeight);
  }

  return (
    <svg
      aria-hidden="true"
      className="tree-guide-svg"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${rowHeight}`}
    >
      {ancestorContinues.map((continues, level) => {
        if (!continues || level >= depth - 1) return null;
        const x = controlCenter(level);
        return <line key={`ancestor-${level}`} x1={x} x2={x} y1={0} y2={rowHeight} />;
      })}
      {depth > 0 && (
        <>
          <line x1={parentX} x2={parentX} y1={0} y2={isLast ? midY : rowHeight} />
          <line x1={parentX} x2={ownControlLeft} y1={midY} y2={midY} />
        </>
      )}
      {continuesToChildren && <line x1={controlCenter(depth)} x2={controlCenter(depth)} y1={midY} y2={rowHeight} />}
      {points.map((point) => (
        <circle cx={point.x} cy={point.y} key={`${point.x}-${point.y}`} r="1.35" style={{ fill: lineColor }} />
      ))}
    </svg>
  );
}

function partToForm(part: Part): PartForm {
  return {
    ...part,
    quantity: String(part.quantity),
    unitPrice: String(part.unitPrice),
    discountPercent: String(part.discountPercent)
  };
}

function formToPart(form: PartForm, id: string = crypto.randomUUID()): Part {
  return {
    ...form,
    id,
    createdAt: new Date().toISOString(),
    partNumber: form.partNumber.trim(),
    originalPartNumber: form.originalPartNumber.trim(),
    folder: form.folder,
    quantity: Number(form.quantity) || 0,
    unitPrice: Number(form.unitPrice) || 0,
    discountPercent: clampNumber(Number(form.discountPercent) || 0, 0, 100),
    processes: form.processes
      .filter((process) => process.name.trim())
      .map((process) => ({ name: process.name.trim(), status: process.status }))
  };
}

export function App() {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const backendSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const backendSaveVersionRef = useRef(0);
  const cachedWorkspace = useMemo(loadWorkspaceCache, []);
  const [parts, setParts] = useState<Part[]>(cachedWorkspace.parts);
  const [folderRecords, setFolderRecords] = useState<FolderRecord[]>(cachedWorkspace.folders);
  const [form, setForm] = useState<PartForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const firebaseReady = hasFirebaseConfig();
  const [authUser, setAuthUser] = useState(loadLoginSession);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isBackendLoading, setIsBackendLoading] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(cachedWorkspace.dirty);
  const [deletedPartIds, setDeletedPartIds] = useState<string[]>(cachedWorkspace.deletedPartIds);
  const [deletedFolderIds, setDeletedFolderIds] = useState<string[]>(cachedWorkspace.deletedFolderIds);
  const [backendMessage, setBackendMessage] = useState(
    cachedWorkspace.parts.length
      ? cachedWorkspace.dirty
        ? "Loaded local changes. Saving to Firebase..."
        : "Loaded local cache."
      : firebaseReady
        ? "Firebase connection ready."
        : "Firebase is not configured."
  );
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState<ItemKind>("bom");
  const [statusFilter, setStatusFilter] = useState<"All" | ProcessStatus>("All");
  const [processFilter, setProcessFilter] = useState("All");
  const [processDraft, setProcessDraft] = useState<ProcessStep>({ name: "", status: "Not Started" });
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [sortState, setSortState] = useState<SortState>(null);
  const [isBomSelectorOpen, setIsBomSelectorOpen] = useState(false);
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null);
  const [draggingPartId, setDraggingPartId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [folderDropIndicator, setFolderDropIndicator] = useState<FolderDropIndicator | null>(null);
  const [partDropIndicator, setPartDropIndicator] = useState<PartDropIndicator | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenu | null>(null);
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = useState("");
  const [drawingFrameFailed, setDrawingFrameFailed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedPartId, setLastSelectedPartId] = useState<string | null>(null);
  const [panelWidths, setPanelWidths] = useState({ editor: 380 });
  const [undoCount, setUndoCount] = useState(0);

  useEffect(() => {
    if (!authUser) setBackendMessage("Sign in to load the Firebase workspace.");
  }, [authUser]);

  useEffect(() => {
    if (!firebaseReady || !authUser) return;
    if (cachedWorkspace.dirty) {
      scheduleImmediateBackendSave({
        parts,
        folders: folderRecords,
        deletedPartIds,
        deletedFolderIds
      });
      return;
    }
    void refreshFromBackend();
  }, [firebaseReady, authUser]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditableTarget = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (isEditableTarget) return;
      if (event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      undoLastAction();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [firebaseReady]);

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firebaseReady) {
      setAuthError("Firebase is not configured. Add the VITE_FIREBASE_* values before using the app.");
      return;
    }

    setIsAuthLoading(true);
    setAuthError("");
    const username = authUsername.trim();
    if (!isValidLogin(username, authPassword)) {
      setAuthError("Incorrect username or password.");
      setIsAuthLoading(false);
      return;
    }

    saveLoginSession(username);
    setAuthUser(username);
    setAuthPassword("");
    setBackendMessage(`Signed in as ${username}. Loading workspace...`);
    setIsAuthLoading(false);
  }

  function handleLogout() {
    setParts([]);
    setFolderRecords([]);
    setSelected(new Set());
    setLastSelectedPartId(null);
    setPreviewPartId(null);
    setDeletedPartIds([]);
    setDeletedFolderIds([]);
    setHasUnsavedChanges(false);
    undoStackRef.current = [];
    setUndoCount(0);
    localStorage.removeItem(LOGIN_CACHE_KEY);
    localStorage.removeItem(WORKSPACE_CACHE_KEY);
    setAuthUser("");
    setAuthUsername("");
    setBackendMessage("Signed out.");
  }

  async function refreshFromBackend() {
    if (!firebaseReady) {
      setBackendMessage("Firebase is not configured.");
      setParts([]);
      return;
    }
    if (!authUser) {
      setBackendMessage("Sign in to load the Firebase workspace.");
      return;
    }

    setIsBackendLoading(true);
    setBackendMessage("Loading from Firebase...");
    try {
      const workspace = await readWorkspaceFromFirebase();
      const nextParts = workspace.parts;
      const nextFolders = workspace.folders;
      setParts(nextParts);
      setFolderRecords(nextFolders);
      setDeletedPartIds([]);
      setDeletedFolderIds([]);
      saveWorkspaceCache(nextParts, nextFolders, false);
      setHasUnsavedChanges(false);
      setSelected(new Set());
      undoStackRef.current = [];
      setUndoCount(0);
      setPreviewPartId((current) => (nextParts.some((part) => part.id === current) ? current : null));
      setBackendMessage(`Loaded ${nextParts.length} parts from Firebase.`);
    } catch (error) {
      setBackendMessage(error instanceof Error ? error.message : "Could not load from Firebase.");
    } finally {
      setIsBackendLoading(false);
    }
  }

  function persist(
    nextParts: Part[],
    nextFolders = folderRecords,
    nextDeletedPartIds = deletedPartIds,
    nextDeletedFolderIds = deletedFolderIds
  ) {
    undoStackRef.current = [
      ...undoStackRef.current.slice(-(MAX_UNDO_STEPS - 1)),
      {
        parts,
        folders: folderRecords,
        deletedPartIds,
        deletedFolderIds
      }
    ];
    setUndoCount(undoStackRef.current.length);
    setParts(nextParts);
    setFolderRecords(nextFolders);
    setDeletedPartIds(nextDeletedPartIds);
    setDeletedFolderIds(nextDeletedFolderIds);
    setHasUnsavedChanges(true);
    saveWorkspaceCache(nextParts, nextFolders, true, nextDeletedPartIds, nextDeletedFolderIds);
    scheduleImmediateBackendSave({
      parts: nextParts,
      folders: nextFolders,
      deletedPartIds: nextDeletedPartIds,
      deletedFolderIds: nextDeletedFolderIds
    });
    return true;
  }

  function undoLastAction() {
    const snapshot = undoStackRef.current[undoStackRef.current.length - 1];
    if (!snapshot) {
      setBackendMessage("Nothing to undo.");
      return;
    }

    undoStackRef.current = undoStackRef.current.slice(0, -1);
    setUndoCount(undoStackRef.current.length);
    setParts(snapshot.parts);
    setFolderRecords(snapshot.folders);
    setDeletedPartIds(snapshot.deletedPartIds);
    setDeletedFolderIds(snapshot.deletedFolderIds);
    setHasUnsavedChanges(true);
    setSelected(new Set());
    setLastSelectedPartId(null);
    setPreviewPartId((current) => (snapshot.parts.some((part) => part.id === current) ? current : null));
    saveWorkspaceCache(snapshot.parts, snapshot.folders, true, snapshot.deletedPartIds, snapshot.deletedFolderIds);
    scheduleImmediateBackendSave(snapshot, "Undo saved locally. Firebase is not configured.");
  }

  function scheduleImmediateBackendSave(snapshot: UndoSnapshot, unconfiguredMessage = "Saved locally. Firebase is not configured.") {
    if (!firebaseReady) {
      setBackendMessage(unconfiguredMessage);
      return;
    }
    if (!authUser) {
      setBackendMessage("Saved locally. Sign in to save to Firebase.");
      return;
    }

    const saveVersion = backendSaveVersionRef.current + 1;
    backendSaveVersionRef.current = saveVersion;
    setIsBackendLoading(true);
    setBackendMessage("Saving to Firebase...");

    backendSaveQueueRef.current = backendSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveSnapshotToBackend(snapshot, saveVersion));
  }

  async function saveSnapshotToBackend(snapshot: UndoSnapshot, saveVersion: number) {
    if (!firebaseReady || !authUser) {
      return false;
    }

    try {
      const remoteWorkspace = await readWorkspaceFromFirebase();
      const reconciled = reconcileWorkspaceForSync(
        snapshot.parts,
        remoteWorkspace.parts,
        snapshot.folders,
        remoteWorkspace.folders,
        snapshot.deletedPartIds,
        snapshot.deletedFolderIds
      );

      await writeWorkspaceToFirebase(reconciled.parts, reconciled.folders);

      if (saveVersion === backendSaveVersionRef.current) {
        setParts(reconciled.parts);
        setFolderRecords(reconciled.folders);
        setDeletedPartIds([]);
        setDeletedFolderIds([]);
        saveWorkspaceCache(reconciled.parts, reconciled.folders, false);
        setHasUnsavedChanges(false);
        setBackendMessage(
          reconciled.renumberedCount
            ? `Saved to Firebase. Renumbered ${reconciled.renumberedCount} conflicting part(s).`
            : "Saved to Firebase."
        );
      }
      return true;
    } catch (error) {
      if (saveVersion === backendSaveVersionRef.current) {
        setHasUnsavedChanges(true);
        saveWorkspaceCache(snapshot.parts, snapshot.folders, true, snapshot.deletedPartIds, snapshot.deletedFolderIds);
        setBackendMessage(error instanceof Error ? error.message : "Could not save to Firebase.");
      }
      return false;
    } finally {
      if (saveVersion === backendSaveVersionRef.current) setIsBackendLoading(false);
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
  const activeFolders = useMemo(
    () => getRelevantFolders(folders, sectionItems, activeSection),
    [activeSection, folders, sectionItems]
  );
  const tableColumnCount = activeSection === "production" ? 9 : 8;
  const selectedBomItem = bomItems.find((item) => item.id === form.linkedBomId) || null;

  function partSortValue(part: Part, key: SortKey) {
    const linkedBom = bomItems.find((item) => item.id === part.linkedBomId);
    switch (key) {
      case "createdAt":
        return part.createdAt || "";
      case "type":
        return part.itemKind === "bom" ? part.thickness || part.material || "BOM item" : "Production item";
      case "folder":
        return part.folder ? getFolderDisplayPath(part.folder, folders) : "Root";
      case "number":
        return part.partNumber;
      case "material":
        return part.itemKind === "bom" ? `${part.material} ${part.thickness}` : linkedBom?.name || "";
      case "process":
        return serializeProcesses(part.processes);
      case "drawing":
        return part.drawingUrl || part.material || part.attachmentFileName;
      case "quantity":
        return part.quantity;
      case "price":
        return getBomLineCost(part);
      case "actions":
        return part.name;
      default:
        return part.name;
    }
  }

  function compareParts(first: Part, second: Part) {
    if (!sortState) return 0;
    const multiplier = sortState.direction === "asc" ? 1 : -1;
    return compareValues(partSortValue(first, sortState.key), partSortValue(second, sortState.key)) * multiplier;
  }

  useEffect(() => {
    setSelected(new Set());
    setLastSelectedPartId(null);
    setPreviewPartId(null);
    setExpandedFolders(new Set());
  }, [activeSection]);

  const filteredParts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return parts.filter((part) => {
      if (part.itemKind !== activeSection) return false;
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

      return statusMatches && processMatches && queryMatches;
    });
  }, [activeSection, folders, parts, processFilter, query, statusFilter]);

  const bomTreeEntries = useMemo(() => {
    const entries: ListEntry[] = [];
    const bomFolders = getRelevantFolders(folders, bomItems, "bom");
    const foldersByParent = new Map<string, FolderRecord[]>();
    const partsByFolder = new Map<string, Part[]>();

    bomFolders.forEach((folder) => {
      const parentId = folder.parentId || "";
      foldersByParent.set(parentId, [...(foldersByParent.get(parentId) || []), folder]);
    });
    bomItems.forEach((part) => {
      const folderId = part.folder || "";
      partsByFolder.set(folderId, [...(partsByFolder.get(folderId) || []), part]);
    });

    function appendFolderContents(parentId: string, depth: number, ancestorContinues: boolean[] = []) {
      const childFolders = stableSort(foldersByParent.get(parentId) || [], (first, second) => compareValues(first.name, second.name));
      const childParts = stableSort(partsByFolder.get(parentId) || [], (first, second) => compareValues(first.name, second.name));
      const childCount = childFolders.length + childParts.length;
      let childIndex = 0;

      childFolders.forEach((folder) => {
        const isLast = childIndex === childCount - 1;
        entries.push({ type: "folder", folder, depth, isLast, ancestorContinues });
        childIndex += 1;
        appendFolderContents(folder.id, depth + 1, [...ancestorContinues, !isLast]);
      });
      childParts.forEach((part) => {
        const isLast = childIndex === childCount - 1;
        entries.push({ type: "part", part, depth, isLast, ancestorContinues });
        childIndex += 1;
      });
    }

    appendFolderContents("", 0);
    return entries;
  }, [bomItems, folders]);

  const listEntries = useMemo(() => {
    const entries: ListEntry[] = [];
    const foldersByParent = new Map<string, FolderRecord[]>();
    const partsByFolder = new Map<string, Part[]>();

    activeFolders.forEach((folder) => {
      const parentId = folder.parentId || "";
      foldersByParent.set(parentId, [...(foldersByParent.get(parentId) || []), folder]);
    });
    filteredParts.forEach((part) => {
      const folderId = part.folder || "";
      partsByFolder.set(folderId, [...(partsByFolder.get(folderId) || []), part]);
    });

    function appendFolderContents(parentId: string, depth: number, ancestorContinues: boolean[] = []) {
      const childFolders = foldersByParent.get(parentId) || [];
      const childParts = sortState ? stableSort(partsByFolder.get(parentId) || [], compareParts) : partsByFolder.get(parentId) || [];
      const childCount = childFolders.length + childParts.length;
      let childIndex = 0;

      childFolders.forEach((folder) => {
        const isLast = childIndex === childCount - 1;
        entries.push({ type: "folder", folder, depth, isLast, ancestorContinues });
        childIndex += 1;
        if (expandedFolders.has(folder.id)) appendFolderContents(folder.id, depth + 1, [...ancestorContinues, !isLast]);
      });
      childParts.forEach((part) => {
        const isLast = childIndex === childCount - 1;
        entries.push({ type: "part", part, depth, isLast, ancestorContinues });
        childIndex += 1;
      });
    }

    appendFolderContents("", 0);
    return entries;
  }, [activeFolders, expandedFolders, filteredParts, sortState]);
  const visibleParts = useMemo(
    () => listEntries.filter((entry): entry is Extract<ListEntry, { type: "part" }> => entry.type === "part").map((entry) => entry.part),
    [listEntries]
  );

  const totalValue = bomItems.reduce((sum, part) => sum + getBomLineCost(part), 0);
  const previewPart = parts.find((part) => part.id === previewPartId) ?? null;
  const previewSourceUrl =
    previewPart?.itemKind === "production"
      ? previewPart.drawingUrl.trim()
      : previewPart?.attachmentDataUrl || normalizeExternalUrl(previewPart?.material || "") || normalizeExternalUrl(previewPart?.location || "");
  const previewIsPdf = Boolean(previewSourceUrl?.startsWith("data:application/pdf") || previewPart?.attachmentMimeType === "application/pdf");
  const previewFrameUrl = previewIsPdf && previewBlobUrl ? previewBlobUrl : previewSourceUrl;
  const isOnshapeDrawingUrl = /(^|\.)onshape\.com$/i.test(safeHostname(previewSourceUrl || ""));
  const nextPartNumber = useMemo(() => generateNextPartNumber(parts), [parts]);
  const visiblePartNumber = form.partNumber || (!editingId ? nextPartNumber : "");
  const originalPartNumber = form.originalPartNumber || (!editingId ? nextPartNumber : form.partNumber);
  const canRevertPartNumber = Boolean(originalPartNumber && visiblePartNumber !== originalPartNumber);

  useEffect(() => {
    setDrawingFrameFailed(false);
    if (!previewSourceUrl?.startsWith("data:application/pdf")) {
      setPreviewBlobUrl("");
      return;
    }

    const blobUrl = URL.createObjectURL(dataUrlToBlob(previewSourceUrl));
    setPreviewBlobUrl(blobUrl);

    return () => {
      URL.revokeObjectURL(blobUrl);
    };
  }, [previewSourceUrl]);

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

  async function createFolder(parent = "") {
    const folderName = window.prompt("Folder name");
    const draft = normalizeFolderPath(folderName || "");
    if (!draft) return;
    const parentId = parent === "All" ? "" : parent;
    let activeParentId = parentId;
    const newFolders = splitFolderPath(draft).map((name) => {
      const folder = { id: makeFolderId(), name, parentId: activeParentId, itemKind: activeSection, createdAt: new Date().toISOString() };
      activeParentId = folder.id;
      return folder;
    });
    if (newFolders.length === 0) return;
    const nextFolders = [...folders, ...newFolders];
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (parentId) next.add(parentId);
      newFolders.slice(0, -1).forEach((folder) => next.add(folder.id));
      return next;
    });
    persist(parts, nextFolders);
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
    const nextDeletedFolderIds = Array.from(new Set([...deletedFolderIds, ...affectedFolderIds]));

    persist(nextParts, nextFolders, deletedPartIds, nextDeletedFolderIds);
    setExpandedFolders((current) => {
      const next = new Set(current);
      affectedFolderIds.forEach((id) => next.delete(id));
      return next;
    });
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
    const nextDeletedFolderIds = Array.from(new Set([...deletedFolderIds, folderId]));
    persist(nextParts, nextFolders, deletedPartIds, nextDeletedFolderIds);
    setExpandedFolders((current) => {
      const next = new Set(current);
      next.delete(folderId);
      if (parentId) next.add(parentId);
      return next;
    });
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
      setBackendMessage("Could not read dragged item.");
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
      setBackendMessage("Could not read dragged part.");
    } finally {
      clearDragState();
    }
  }

  function getFolderDirectCount(folderId: string) {
    if (!folderId) return sectionItems.length;
    return parts.filter((part) => part.itemKind === activeSection && (part.folder || "") === folderId).length;
  }

  function toggleFolderExpanded(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function openFolderContextMenu(event: MouseEvent<HTMLElement>, folderId: string) {
    event.preventDefault();
    event.stopPropagation();
    setFolderContextMenu({ folderId, x: event.clientX, y: event.clientY });
  }

  function closeFolderContextMenu() {
    setFolderContextMenu(null);
  }

  function startPanelResize(panel: "editor" | "folders", event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const containerWidth = workspaceRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const startX = event.clientX;
    const startWidths = { editor: panelWidths.editor };
    const reservedForHandlesAndGaps = 64;
    const minimums = { editor: 300, library: 520 };

    function handleMouseMove(moveEvent: globalThis.MouseEvent) {
      const delta = moveEvent.clientX - startX;
      setPanelWidths(() => {
        const maxEditor = containerWidth - minimums.library - reservedForHandlesAndGaps;
        return {
          editor: clampNumber(startWidths.editor + delta, minimums.editor, Math.max(minimums.editor, maxEditor))
        };
      });
    }

    function handleMouseUp() {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.classList.remove("is-resizing-panels");
    }

    document.body.classList.add("is-resizing-panels");
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
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
        discountPercent: nextItemKind === "bom" ? form.discountPercent : "0",
        folder: editingId ? form.folder : ""
      },
      editingId ?? undefined
    );
    if (editingId) {
      nextPart.createdAt = parts.find((part) => part.id === editingId)?.createdAt || nextPart.createdAt;
    }
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
    setDrawingFrameFailed(false);
    setEditingId(part.id);
    setActiveSection(part.itemKind);
    setForm(partToForm(part));
    setProcessDraft({ name: "", status: "Not Started" });
  }

  async function deletePart(id: string) {
    const nextDeletedPartIds = Array.from(new Set([...deletedPartIds, id]));
    persist(parts.filter((part) => part.id !== id), folderRecords, nextDeletedPartIds);
    if (previewPartId === id) setPreviewPartId(null);
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  async function deleteSelected() {
    const nextDeletedPartIds = Array.from(new Set([...deletedPartIds, ...selected]));
    persist(parts.filter((part) => !selected.has(part.id)), folderRecords, nextDeletedPartIds);
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

  function addBomSourceItem(sourceUrl: string, sourceType: "cart" | "pdf", label?: string) {
    const href = normalizeExternalUrl(sourceUrl);
    if (!href) return;

    const host = sourceType === "cart" ? safeHostname(href) || "Cart" : "PDF";
    const name = sourceType === "cart" ? `Cart: ${host}` : `PDF: ${label || "Checkout list"}`;
    const nextPart = formToPart({
      ...emptyForm,
      name,
      folder: "",
      quantity: "1",
      unitPrice: "0",
      discountPercent: "0",
      material: sourceType === "cart" ? href : "Checkout PDF",
      thickness: label || (sourceType === "cart" ? "Cart link" : "Uploaded PDF"),
      vendor: host,
      location: sourceType === "cart" ? href : "",
      notes: sourceType === "cart" ? "BOM source cart link." : `BOM source PDF${label ? `: ${label}` : ""}.`,
      itemKind: "bom",
      attachmentFileName: sourceType === "pdf" ? label || "checkout.pdf" : "",
      attachmentMimeType: sourceType === "pdf" ? "application/pdf" : "",
      attachmentDataUrl: sourceType === "pdf" ? href : ""
    });

    persist([nextPart, ...parts]);
    setActiveSection("bom");
    if (sourceType === "pdf") setPreviewPartId(nextPart.id);
  }

  function addCartLinkBomItem() {
    const url = window.prompt("Paste cart or checkout link");
    if (!url?.trim()) return;
    addBomSourceItem(url, "cart");
  }

  async function addPdfBomItem(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      window.alert("Please choose a PDF file.");
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    addBomSourceItem(dataUrl, "pdf", file.name);
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
        const folder = { id: makeFolderId(), name, parentId, itemKind: activeSection, createdAt: new Date().toISOString() };
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
          discountPercent: record.discountPercent ?? "0",
          material,
          thickness: record.thickness ?? "",
          processes: parseProcesses(record.processes || record.process || "", record.status),
          drawingUrl: record.drawingUrl ?? "",
          vendor: record.vendor ?? "",
          location: record.location ?? "",
          notes: record.notes ?? "",
          itemKind: record.itemKind === "production" ? "production" : "bom",
          linkedBomId: record.linkedBomId ?? "",
          attachmentFileName: record.attachmentFileName ?? "",
          attachmentMimeType: record.attachmentMimeType ?? "",
          attachmentDataUrl: ""
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
    const anchorIndex = visibleParts.findIndex((part) => part.id === anchorId);
    const targetIndex = visibleParts.findIndex((part) => part.id === targetId);
    if (anchorIndex < 0 || targetIndex < 0) return [targetId];

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return visibleParts.slice(start, end + 1).map((part) => part.id);
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

  function togglePartCheckbox(id: string, event: MouseEvent<HTMLInputElement>) {
    event.stopPropagation();

    if (event.shiftKey && lastSelectedPartId) {
      const rangeIds = selectPartRange(lastSelectedPartId, id);
      setSelected((current) => {
        const next = new Set(current);
        rangeIds.forEach((partId) => next.add(partId));
        return next;
      });
      return;
    }

    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelectedPartId(id);
  }

  function handlePartRowClick(part: Part, event: MouseEvent<HTMLTableRowElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button,a,input,select,textarea")) return;
    selectPartLikeFileManager(part.id, event);
  }

  function toggleAllFiltered() {
    const allSelected = visibleParts.length > 0 && visibleParts.every((part) => selected.has(part.id));
    setSelected((current) => {
      const next = new Set(current);
      visibleParts.forEach((part) => {
        if (allSelected) next.delete(part.id);
        else next.add(part.id);
      });
      return next;
    });
  }

  function updateSort(key: SortKey) {
    setSortState((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      return { key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }

  function renderSortHeader(label: string, key: SortKey) {
    const isActive = sortState?.key === key;
    return (
      <button
        className={["sort-header", isActive ? "active" : ""].filter(Boolean).join(" ")}
        type="button"
        onClick={() => updateSort(key)}
        title={`Sort by ${label}`}
      >
        <span>{label}</span>
        <span aria-hidden="true">{isActive ? (sortState.direction === "asc" ? "^" : "v") : ""}</span>
      </button>
    );
  }

  if (!firebaseReady || !authUser) {
    return (
      <main className="auth-shell">
        <form className="auth-card" onSubmit={handleLogin}>
          <div className="auth-mark" aria-hidden="true">
            <Lock size={22} />
          </div>
          <div>
            <p className="eyebrow">Firebase workspace</p>
            <h1>Parts Library</h1>
            <p className="auth-copy">
              {firebaseReady
                ? "Sign in to view or change the production workspace."
                : "Firebase is not configured yet. Add the VITE_FIREBASE_* values before using the app."}
            </p>
          </div>

          <label>
            Username
            <input
              autoComplete="username"
              disabled={!firebaseReady || isAuthLoading}
              placeholder="Username"
              type="text"
              value={authUsername}
              onChange={(event) => setAuthUsername(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              disabled={!firebaseReady || isAuthLoading}
              type="password"
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
            />
          </label>

          {authError && <div className="auth-error">{authError}</div>}

          <button
            className="button primary wide"
            disabled={!firebaseReady || isAuthLoading}
            type="submit"
          >
            {isAuthLoading ? <LoaderCircle className="spin-icon" size={16} /> : <Lock size={16} />}
            Sign in
          </button>
        </form>
      </main>
    );
  }

  return (
    <main
      className="app-shell"
      onClick={() => {
        closeFolderContextMenu();
        setIsBomSelectorOpen(false);
      }}
    >
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
      {folderContextMenu && (
        <div
          className="context-menu"
          style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              void renameFolder(folderContextMenu.folderId);
              closeFolderContextMenu();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              void unpackFolder(folderContextMenu.folderId);
              closeFolderContextMenu();
            }}
          >
            Unpack
          </button>
          <button
            className="context-danger"
            type="button"
            onClick={() => {
              void removeFolder(folderContextMenu.folderId);
              closeFolderContextMenu();
            }}
          >
            Delete
          </button>
        </div>
      )}
      <section className="hero">
        <div>
          <p className="eyebrow">Firebase workspace</p>
          <h1>Parts Library</h1>
        </div>
        <div className="hero-actions">
          <div
            className={["save-indicator", isBackendLoading ? "saving" : hasUnsavedChanges ? "unsaved" : "saved"].join(" ")}
            title={backendMessage}
            aria-label={isBackendLoading ? "Saving changes" : hasUnsavedChanges ? "Unsaved changes" : "Saved"}
          >
            {isBackendLoading || hasUnsavedChanges ? <LoaderCircle size={17} /> : <Check size={17} />}
          </div>
          <button
            className="button secondary"
            disabled={isBackendLoading || !firebaseReady}
            type="button"
            onClick={() => void refreshFromBackend()}
            title="Reload from Firebase"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          <button
            className="button secondary"
            disabled={undoCount === 0}
            type="button"
            onClick={undoLastAction}
            title="Undo last action"
          >
            <Undo2 size={16} />
            Undo
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={handleLogout}
            title={`Signed in as ${authUser}`}
          >
            <LogOut size={16} />
            Sign out
          </button>
          <label className="button secondary" title="Import CSV into Firebase-backed workspace">
            <Upload size={16} />
            Import CSV
            <input type="file" accept=".csv,text/csv" onChange={importCsv} />
          </label>
          <button className="button primary" type="button" onClick={downloadCsv} title="Export CSV backup">
            <ArrowDownToLine size={16} />
            Download CSV
          </button>
        </div>
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

      <section
        className="workspace"
        ref={workspaceRef}
        style={{
          "--editor-width": `${panelWidths.editor}px`
        } as CSSProperties}
      >
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
                  Discount %
                  <input
                    max="100"
                    min="0"
                    step="0.01"
                    type="number"
                    value={form.discountPercent}
                    onChange={(event) => updateForm("discountPercent", event.target.value)}
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
                  <div className="compact-tree-select" onClick={(event) => event.stopPropagation()}>
                    <button
                      className="compact-tree-trigger"
                      type="button"
                      onClick={() => setIsBomSelectorOpen((current) => !current)}
                    >
                      <span>{selectedBomItem?.name || "No linked BOM item"}</span>
                      <span aria-hidden="true">v</span>
                    </button>
                    {isBomSelectorOpen && (
                      <div className="compact-tree-menu">
                        <button
                          className={!form.linkedBomId ? "selected" : ""}
                          type="button"
                          onClick={() => {
                            updateForm("linkedBomId", "");
                            setIsBomSelectorOpen(false);
                          }}
                        >
                          No linked BOM item
                        </button>
                        {bomTreeEntries.map((entry) =>
                          entry.type === "folder" ? (
                            <div
                              className="compact-tree-folder"
                              key={entry.folder.id}
                              style={{ "--tree-depth": entry.depth } as CSSProperties}
                              title={entry.folder.name}
                            >
                              <Folder size={13} />
                              <span>{entry.folder.name}</span>
                            </div>
                          ) : (
                            <button
                              className={form.linkedBomId === entry.part.id ? "selected" : ""}
                              key={entry.part.id}
                              style={{ "--tree-depth": entry.depth } as CSSProperties}
                              type="button"
                              title={entry.part.name}
                              onClick={() => {
                                updateForm("linkedBomId", entry.part.id);
                                setIsBomSelectorOpen(false);
                              }}
                            >
                              <span>{entry.part.name}</span>
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
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

          <button className="button primary wide" disabled={isBackendLoading} type="submit">
            {editingId ? <Database size={16} /> : <PackagePlus size={16} />}
            {editingId ? "Save Item" : activeSection === "bom" ? "Add BOM Item" : "Add Production Item"}
          </button>

          {activeSection === "bom" && (
            <div className="bom-source-actions" aria-label="BOM source actions">
              <button className="button secondary" type="button" onClick={addCartLinkBomItem} title="Add one BOM item for a cart or checkout link">
                <ExternalLink size={16} />
                Cart Link
              </button>
              <label className="button secondary" title="Add one BOM item for a checkout PDF">
                <Upload size={16} />
                PDF Item
                <input type="file" accept="application/pdf,.pdf" onChange={addPdfBomItem} />
              </label>
            </div>
          )}
        </form>

        <div
          aria-label="Resize editor panel"
          className="panel-resize-handle"
          onMouseDown={(event) => startPanelResize("editor", event)}
          role="separator"
        />

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

          <div className="table-heading">
            <div className="list-heading">
              <span className="heading-metric">
                <span className="list-title">
                  {activeSection === "bom" ? "Bill of Materials" : "Production Tracker"}
                </span>
                <small>{sectionItems.length} total item(s)</small>
              </span>
              <span className="heading-metric">
                <span className="list-title">Inventory Value</span>
                <small>${totalValue.toFixed(2)}</small>
              </span>
            </div>
            <div className="table-actions">
              <button className="ghost" type="button" onClick={() => void createFolder()}>
                <Plus size={14} />
                New folder
              </button>
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

          <div
            className="table-scroll"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleFolderDrop(event, "All")}
          >
            <table className={`parts-table ${activeSection === "production" ? "production-table" : "bom-table"}`}>
              <colgroup>
                <col className="col-tree-control" />
                <col className="col-name" />
                <col className="col-folder" />
                {activeSection === "production" && <col className="col-part-number" />}
                <col className="col-material" />
                {activeSection === "production" && <col className="col-processes" />}
                {activeSection === "production" ? (
                  <col className="col-drawing" />
                ) : (
                  <>
                    <col className="col-qty" />
                    <col className="col-price" />
                  </>
                )}
                <col className="col-created" />
                <col className="col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="cell-name" colSpan={2}>{renderSortHeader("Name", "name")}</th>
                  <th className="cell-folder">{renderSortHeader("Folder", "folder")}</th>
                  {activeSection === "production" && <th className="cell-part-number">{renderSortHeader("Part #", "number")}</th>}
                  {activeSection === "bom" ? <th className="cell-material">{renderSortHeader("Material / Stock", "material")}</th> : <th className="cell-material">{renderSortHeader("Linked BOM Item", "material")}</th>}
                  {activeSection === "production" && <th className="cell-processes">{renderSortHeader("Processes", "process")}</th>}
                  {activeSection === "production" ? <th className="cell-drawing">{renderSortHeader("Drawing", "drawing")}</th> : (
                    <>
                      <th className="cell-qty">{renderSortHeader("Qty", "quantity")}</th>
                      <th className="cell-price">{renderSortHeader("Price", "price")}</th>
                    </>
                  )}
                  <th className="cell-created">{renderSortHeader("Created", "createdAt")}</th>
                  <th className="cell-actions">{renderSortHeader("Actions", "actions")}</th>
                </tr>
              </thead>
              <tbody>
                {listEntries.map((entry) => {
                  if (entry.type === "folder") {
                    const { ancestorContinues, folder, depth, isLast } = entry;
                  const dropPosition = folderDropIndicator?.path === folder.id ? folderDropIndicator.position : null;
                  const isExpanded = expandedFolders.has(folder.id);
                  const hasChildren =
                    activeFolders.some((candidate) => candidate.parentId === folder.id) ||
                    filteredParts.some((part) => part.folder === folder.id);
                  return (
                    <tr
                      className={[
                        "folder-list-row",
                        draggingFolder === folder.id ? "dragging" : "",
                        dropPosition ? `drop-${dropPosition}` : ""
                      ].filter(Boolean).join(" ")}
                      draggable
                      key={folder.id}
                      onContextMenu={(event) => openFolderContextMenu(event, folder.id)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/json", JSON.stringify({ type: "folder", path: folder.id }));
                        setDraggingFolder(folder.id);
                        setDragPosition({ x: event.clientX, y: event.clientY });
                      }}
                      onDrag={(event) => {
                        if (event.clientX || event.clientY) setDragPosition({ x: event.clientX, y: event.clientY });
                      }}
                      onDragOver={(event) => updateFolderDragIndicator(event, folder.id)}
                      onDrop={(event) => handleFolderDrop(event, folder.id, draggingFolder ? getFolderDropPosition(event) : "inside")}
                      onDragEnd={clearDragState}
                    >
                      <td className="cell-name" colSpan={2}>
                        <div
                          className={[
                            "tree-cell",
                            "folder-tree-cell",
                            depth === 0 ? "tree-root-cell" : "",
                            isExpanded && hasChildren ? "tree-expanded-entry" : "",
                            isLast ? "tree-last-entry" : ""
                          ].filter(Boolean).join(" ")}
                          style={{ "--tree-depth": depth } as CSSProperties}
                        >
                          <span className="tree-guides" aria-hidden="true">
                            <TreeGuideLines
                              ancestorContinues={ancestorContinues}
                              continuesToChildren={isExpanded && hasChildren}
                              depth={depth}
                              isLast={isLast}
                            />
                          </span>
                          <button
                            className="icon-button folder-expand-button"
                            disabled={!hasChildren}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleFolderExpanded(folder.id);
                            }}
                            title={isExpanded ? "Collapse folder" : "Expand folder"}
                          >
                            {isExpanded ? "v" : ">"}
                          </button>
                          <button className="part-name folder-name" type="button" title={folder.name}>
                            <span><Folder size={15} /> {folder.name}</span>
                          </button>
                        </div>
                      </td>
                      <td className="folder-fill-cell" colSpan={tableColumnCount - 2}></td>
                    </tr>
                  );
                  }

                  const { ancestorContinues, part, depth, isLast } = entry;
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
                        ? visibleParts.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.id)
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
                    <td className="cell-name" colSpan={2}>
                      <div
                        className={[
                          "tree-cell",
                          depth === 0 ? "tree-root-cell" : "",
                          isLast ? "tree-last-entry" : ""
                        ].filter(Boolean).join(" ")}
                        style={{ "--tree-depth": depth } as CSSProperties}
                      >
                        <span className="tree-guides" aria-hidden="true">
                          <TreeGuideLines ancestorContinues={ancestorContinues} depth={depth} isLast={isLast} />
                        </span>
                        <span className="tree-select-slot">
                          <input
                            aria-label={`Select ${part.name}`}
                            type="checkbox"
                            checked={selected.has(part.id)}
                            onClick={(event) => togglePartCheckbox(part.id, event)}
                            readOnly
                          />
                        </span>
                        <div className="part-name">
                          <button
                            className="part-title-button"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              editPart(part);
                            }}
                          >
                            <span title={part.name}>{part.name}</span>
                          </button>
                          <small
                            className="list-subtext"
                            title={
                              activeSection === "bom"
                                ? `${part.vendor || "No vendor"} - ${part.location || "No location"}`
                                : part.drawingUrl || "No drawing"
                            }
                          >
                            {activeSection === "bom"
                              ? (
                                <>
                                  {renderLinkedValue(part.vendor, "No vendor")}
                                  <span> - </span>
                                  {renderLinkedValue(part.location, "No location")}
                                </>
                              )
                              : part.drawingUrl ? renderLinkedValue(part.drawingUrl, "Drawing linked") : "No drawing"}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td className="cell-folder" title={part.folder ? getFolderDisplayPath(part.folder, folders) || "Unknown folder" : "Root"}>
                      {part.folder ? getFolderDisplayPath(part.folder, folders) || "Unknown folder" : "Root"}
                    </td>
                    {activeSection === "production" && <td className="cell-part-number">{part.partNumber}</td>}
                    <td className="cell-material">
                      {activeSection === "bom" ? (
                        <>
                          <div title={part.attachmentFileName || part.material}>
                            {part.attachmentDataUrl
                              ? renderLinkedValue(part.attachmentDataUrl, part.attachmentFileName || "Open PDF")
                              : renderLinkedValue(part.material)}
                          </div>
                          <small title={part.thickness}>{renderLinkedValue(part.thickness)}</small>
                        </>
                      ) : (
                        <>
                          <div title={bomItems.find((item) => item.id === part.linkedBomId)?.name || "No BOM link"}>
                            {bomItems.find((item) => item.id === part.linkedBomId)?.name || "No BOM link"}
                          </div>
                          <small title={bomItems.find((item) => item.id === part.linkedBomId)?.material || ""}>
                            {renderLinkedValue(bomItems.find((item) => item.id === part.linkedBomId)?.material || "")}
                          </small>
                        </>
                      )}
                    </td>
                    {activeSection === "production" && (
                      <td className="cell-processes">
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
                      <td className="cell-drawing">{part.drawingUrl ? renderLinkedValue(part.drawingUrl, "Open") : "Missing"}</td>
                    ) : (
                      <>
                        <td className="cell-qty">{part.quantity}</td>
                        <td className="cell-price" title={part.discountPercent ? `${part.discountPercent}% discount applied` : "No discount"}>
                          ${getBomLineCost(part).toFixed(2)}
                        </td>
                      </>
                    )}
                    <td className="cell-created" title={part.createdAt ? new Date(part.createdAt).toLocaleString() : "No created date"}>
                      {formatCreatedDate(part.createdAt) || "-"}
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        <button type="button" onClick={() => editPart(part)} title="Edit part">
                          <Pencil size={14} />
                        </button>
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

          {previewPart && (
            <section className="drawing-preview">
              <div className="preview-heading">
                <div>
                  <p className="eyebrow">{previewIsPdf ? "PDF preview" : previewPart.itemKind === "production" ? "Drawing preview" : "BOM source preview"}</p>
                  <h2>{previewPart.name}</h2>
                </div>
                <div className="preview-actions">
                  {previewFrameUrl && (
                    <a
                      className="icon-button"
                      href={previewFrameUrl}
                      rel={previewFrameUrl.startsWith("blob:") || previewFrameUrl.startsWith("data:") ? undefined : "noreferrer"}
                      target="_blank"
                      title="Open source"
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
              {previewFrameUrl ? (
                <div className="drawing-frame-wrap">
                  {isOnshapeDrawingUrl && (
                    <div className="drawing-notice">
                      Onshape may block embedded previews for private documents. Use the open button if the frame asks you to sign in or stays blank.
                    </div>
                  )}
                  {drawingFrameFailed ? (
                    <div className="empty-preview">
                      <span>Preview could not load in the app.</span>
                      <a
                        href={previewFrameUrl}
                        rel={previewFrameUrl.startsWith("blob:") || previewFrameUrl.startsWith("data:") ? undefined : "noreferrer"}
                        target="_blank"
                      >
                        Open source
                      </a>
                    </div>
                  ) : (
                    <iframe
                      allow="fullscreen"
                      allowFullScreen
                      key={previewFrameUrl}
                      loading="lazy"
                      src={previewFrameUrl}
                      title={`${previewPart.name} preview`}
                      referrerPolicy="no-referrer-when-downgrade"
                      onError={() => setDrawingFrameFailed(true)}
                    />
                  )}
                </div>
              ) : (
                <div className="empty-preview">
                  <span>No preview link saved for this item.</span>
                </div>
              )}
            </section>
          )}
        </section>
      </section>
    </main>
  );
}
