import { openDB } from "idb";

const DATABASE_NAME = "sawitvision-local";
const DATABASE_VERSION = 1;
const SAVED_PHOTOS_STORE = "savedPhotos";

const INDEX_OWNER = "by-owner-user-id";
const INDEX_OWNER_CREATED_AT = "by-owner-created-at";
const INDEX_OWNER_STATUS = "by-owner-status";

export const SAVED_PHOTO_SCHEMA_VERSION = 1;

export const SAVED_PHOTO_STATUSES = Object.freeze({
  SAVED: "saved",
  PROCESSING: "processing",
  FAILED: "failed",
  SERVER_SAVED_INCOMPLETE: "server_saved_incomplete",
});

export const SAVED_PHOTO_ERROR_CODES = Object.freeze({
  QUOTA_EXCEEDED: "quota_exceeded",
  UNSUPPORTED: "unsupported_indexed_db",
  INVALID_RECORD: "invalid_record",
  NOT_FOUND: "record_not_found",
  OWNERSHIP_MISMATCH: "ownership_mismatch",
  STORAGE_FAILURE: "storage_failure",
});

const ALLOWED_STATUSES = new Set(Object.values(SAVED_PHOTO_STATUSES));
const ALLOWED_INPUT_SOURCES = new Set(["camera", "gallery"]);

/**
 * Expected SavedPhoto record shape:
 * {
 *   id, schemaVersion, ownerUserId,
 *   imageBlob, fileName, mimeType, sizeBytes, lastModified, inputSource,
 *   capturedAt,
 *   location: { latitude, longitude, accuracy, capturedAt, autoName, label } | null,
 *   status, createdAt, updatedAt, lastAttemptAt, attemptCount,
 *   lastError, serverRecordId
 * }
 *
 * imageBlob is stored directly as a Blob. Preview object URLs are deliberately
 * excluded because they are temporary browser-process resources.
 */

export class SavedPhotoStorageError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "SavedPhotoStorageError";
    this.code = code;
  }
}

let databasePromise = null;

function storageError(code, message, cause) {
  return new SavedPhotoStorageError(code, message, cause);
}

function normalizeStorageError(error) {
  if (error instanceof SavedPhotoStorageError) {
    return error;
  }

  if (
    error?.name === "QuotaExceededError" ||
    error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
  ) {
    return storageError(
      SAVED_PHOTO_ERROR_CODES.QUOTA_EXCEEDED,
      "Penyimpanan perangkat tidak cukup untuk menyimpan foto.",
      error,
    );
  }

  if (error?.name === "InvalidStateError" || error?.name === "NotSupportedError") {
    return storageError(
      SAVED_PHOTO_ERROR_CODES.UNSUPPORTED,
      "IndexedDB tidak tersedia pada browser ini.",
      error,
    );
  }

  return storageError(
    SAVED_PHOTO_ERROR_CODES.STORAGE_FAILURE,
    "Penyimpanan foto lokal gagal diakses.",
    error,
  );
}

function assertIndexedDbSupport() {
  if (!globalThis.indexedDB || !globalThis.IDBKeyRange) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.UNSUPPORTED,
      "IndexedDB tidak tersedia pada browser ini.",
    );
  }
}

function getDatabase() {
  assertIndexedDbSupport();

  if (!databasePromise) {
    databasePromise = openDB(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          const store = database.createObjectStore(SAVED_PHOTOS_STORE, {
            keyPath: "id",
          });
          store.createIndex(INDEX_OWNER, "ownerUserId", { unique: false });
          store.createIndex(
            INDEX_OWNER_CREATED_AT,
            ["ownerUserId", "createdAt"],
            { unique: false },
          );
          store.createIndex(
            INDEX_OWNER_STATUS,
            ["ownerUserId", "status"],
            { unique: false },
          );
        }
      },
    }).catch((error) => {
      databasePromise = null;
      throw normalizeStorageError(error);
    });
  }

  return databasePromise;
}

function requireNonEmptyString(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      `${fieldName} wajib diisi.`,
    );
  }

  return normalized;
}

function normalizeIsoDate(value, fieldName, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) {
    return null;
  }

  const normalized = requireNonEmptyString(value, fieldName);
  const timestamp = Date.parse(normalized);

  if (!Number.isFinite(timestamp)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      `${fieldName} harus berupa waktu ISO yang valid.`,
    );
  }

  return new Date(timestamp).toISOString();
}

function normalizeOwnerUserId(ownerUserId) {
  return requireNonEmptyString(ownerUserId, "ownerUserId");
}

function normalizeRecordId(id) {
  return requireNonEmptyString(id, "id");
}

function normalizeStatus(status) {
  if (!ALLOWED_STATUSES.has(status)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "Status foto tersimpan tidak valid.",
    );
  }

  return status;
}

function normalizeNullableText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeLocation(location) {
  if (location === null || location === undefined) {
    return null;
  }

  if (typeof location !== "object" || Array.isArray(location)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "Metadata lokasi harus berupa object atau null.",
    );
  }

  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = location.accuracy === null || location.accuracy === undefined
    ? null
    : Number(location.accuracy);

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))
  ) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "Metadata koordinat foto tidak valid.",
    );
  }

  return {
    latitude,
    longitude,
    accuracy,
    capturedAt: normalizeIsoDate(location.capturedAt, "location.capturedAt"),
    autoName: normalizeNullableText(location.autoName),
    label: normalizeNullableText(location.label),
  };
}

function normalizeLastError(lastError) {
  if (lastError === null || lastError === undefined) {
    return null;
  }

  if (typeof lastError !== "object" || Array.isArray(lastError)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "lastError harus berupa object atau null.",
    );
  }

  return {
    kind: normalizeNullableText(lastError.kind) || "unknown",
    status: Number.isInteger(lastError.status) ? lastError.status : null,
    message: normalizeNullableText(lastError.message) || "Proses foto gagal.",
  };
}

function normalizeSavedPhoto(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "Data foto tersimpan tidak valid.",
    );
  }

  if (typeof Blob === "undefined" || !(input.imageBlob instanceof Blob)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "imageBlob harus berupa Blob.",
    );
  }

  const id = normalizeRecordId(input.id);
  const ownerUserId = normalizeOwnerUserId(input.ownerUserId);
  const createdAt = normalizeIsoDate(input.createdAt, "createdAt");
  const capturedAt = normalizeIsoDate(input.capturedAt, "capturedAt");
  const inputSource = requireNonEmptyString(input.inputSource, "inputSource");

  if (!ALLOWED_INPUT_SOURCES.has(inputSource)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "inputSource harus camera atau gallery.",
    );
  }

  const lastModified = input.lastModified === null || input.lastModified === undefined
    ? null
    : Number(input.lastModified);
  const attemptCount = Number(input.attemptCount ?? 0);

  return {
    id,
    schemaVersion: SAVED_PHOTO_SCHEMA_VERSION,
    ownerUserId,
    imageBlob: input.imageBlob,
    fileName: requireNonEmptyString(input.fileName, "fileName"),
    mimeType: normalizeNullableText(input.imageBlob.type)
      || normalizeNullableText(input.mimeType)
      || "application/octet-stream",
    sizeBytes: input.imageBlob.size,
    lastModified: lastModified !== null
      && Number.isFinite(lastModified)
      && lastModified >= 0
      ? lastModified
      : null,
    inputSource,
    capturedAt,
    location: normalizeLocation(input.location),
    status: normalizeStatus(input.status),
    createdAt,
    updatedAt: input.updatedAt
      ? normalizeIsoDate(input.updatedAt, "updatedAt")
      : createdAt,
    lastAttemptAt: normalizeIsoDate(
      input.lastAttemptAt,
      "lastAttemptAt",
      { nullable: true },
    ),
    attemptCount: Number.isInteger(attemptCount) && attemptCount >= 0
      ? attemptCount
      : 0,
    lastError: normalizeLastError(input.lastError),
    serverRecordId: normalizeNullableText(input.serverRecordId),
  };
}

function ownerCreatedAtRange(ownerUserId) {
  return IDBKeyRange.bound(
    [ownerUserId, ""],
    [ownerUserId, "\uffff"],
  );
}

function notFoundError() {
  return storageError(
    SAVED_PHOTO_ERROR_CODES.NOT_FOUND,
    "Foto tersimpan tidak ditemukan.",
  );
}

function ownershipMismatchError() {
  return storageError(
    SAVED_PHOTO_ERROR_CODES.OWNERSHIP_MISMATCH,
    "Foto tersimpan dimiliki oleh pengguna lain.",
  );
}

async function getOwnedRecordFromStore(store, ownerUserId, id) {
  const record = await store.get(id);

  if (!record) {
    throw notFoundError();
  }

  if (record.ownerUserId !== ownerUserId) {
    throw ownershipMismatchError();
  }

  return record;
}

export async function saveSavedPhoto(input) {
  const record = normalizeSavedPhoto(input);

  try {
    const database = await getDatabase();
    const transaction = database.transaction(SAVED_PHOTOS_STORE, "readwrite");
    const existing = await transaction.store.get(record.id);

    if (existing) {
      if (existing.ownerUserId !== record.ownerUserId) {
        throw ownershipMismatchError();
      }

      throw storageError(
        SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
        "ID foto tersimpan sudah digunakan.",
      );
    }

    await transaction.store.add(record);
    await transaction.done;
    return record;
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function getSavedPhoto(ownerUserId, id) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
  const normalizedId = normalizeRecordId(id);

  try {
    const database = await getDatabase();
    return await getOwnedRecordFromStore(
      database.transaction(SAVED_PHOTOS_STORE).store,
      normalizedOwnerUserId,
      normalizedId,
    );
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function listSavedPhotosByOwner(ownerUserId) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);

  try {
    const database = await getDatabase();
    const transaction = database.transaction(SAVED_PHOTOS_STORE);
    const index = transaction.store.index(INDEX_OWNER_CREATED_AT);
    const records = [];
    let cursor = await index.openCursor(
      ownerCreatedAtRange(normalizedOwnerUserId),
      "prev",
    );

    while (cursor) {
      records.push(cursor.value);
      cursor = await cursor.continue();
    }

    await transaction.done;
    return records;
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function countSavedPhotosByOwner(ownerUserId) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);

  try {
    const database = await getDatabase();
    return await database.countFromIndex(
      SAVED_PHOTOS_STORE,
      INDEX_OWNER,
      normalizedOwnerUserId,
    );
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function getSavedPhotosTotalBytes(ownerUserId) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);

  try {
    const database = await getDatabase();
    const transaction = database.transaction(SAVED_PHOTOS_STORE);
    const index = transaction.store.index(INDEX_OWNER);
    let totalBytes = 0;
    let cursor = await index.openCursor(normalizedOwnerUserId);

    while (cursor) {
      totalBytes += Number(cursor.value.sizeBytes) || 0;
      cursor = await cursor.continue();
    }

    await transaction.done;
    return totalBytes;
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function deleteSavedPhoto(ownerUserId, id) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
  const normalizedId = normalizeRecordId(id);

  try {
    const database = await getDatabase();
    const transaction = database.transaction(SAVED_PHOTOS_STORE, "readwrite");
    await getOwnedRecordFromStore(
      transaction.store,
      normalizedOwnerUserId,
      normalizedId,
    );
    await transaction.store.delete(normalizedId);
    await transaction.done;
    return true;
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function deleteSavedPhotosByOwner(ownerUserId) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);

  try {
    const database = await getDatabase();
    const transaction = database.transaction(SAVED_PHOTOS_STORE, "readwrite");
    const index = transaction.store.index(INDEX_OWNER);
    let deletedCount = 0;
    let cursor = await index.openCursor(normalizedOwnerUserId);

    while (cursor) {
      await cursor.delete();
      deletedCount += 1;
      cursor = await cursor.continue();
    }

    await transaction.done;
    return deletedCount;
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function updateSavedPhotoStatus(ownerUserId, id, patch) {
  const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId);
  const normalizedId = normalizeRecordId(id);

  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw storageError(
      SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
      "Perubahan status foto tidak valid.",
    );
  }

  const status = normalizeStatus(patch.status);

  try {
    const database = await getDatabase();
    const transaction = database.transaction(SAVED_PHOTOS_STORE, "readwrite");
    const record = await getOwnedRecordFromStore(
      transaction.store,
      normalizedOwnerUserId,
      normalizedId,
    );
    const attemptCount = Object.hasOwn(patch, "attemptCount")
      ? Number(patch.attemptCount)
      : record.attemptCount;

    if (!Number.isInteger(attemptCount) || attemptCount < 0) {
      throw storageError(
        SAVED_PHOTO_ERROR_CODES.INVALID_RECORD,
        "attemptCount harus berupa bilangan non-negatif.",
      );
    }

    const updatedRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      lastAttemptAt: Object.hasOwn(patch, "lastAttemptAt")
        ? normalizeIsoDate(
          patch.lastAttemptAt,
          "lastAttemptAt",
          { nullable: true },
        )
        : record.lastAttemptAt,
      attemptCount,
      lastError: Object.hasOwn(patch, "lastError")
        ? normalizeLastError(patch.lastError)
        : record.lastError,
      serverRecordId: Object.hasOwn(patch, "serverRecordId")
        ? normalizeNullableText(patch.serverRecordId)
        : record.serverRecordId,
    };

    await transaction.store.put(updatedRecord);
    await transaction.done;
    return updatedRecord;
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

export async function getLocalStorageEstimate() {
  const storageManager = globalThis.navigator?.storage;

  if (!storageManager?.estimate) {
    return {
      supported: false,
      usageBytes: null,
      quotaBytes: null,
      availableBytes: null,
    };
  }

  try {
    const estimate = await storageManager.estimate();
    const usageBytes = Number.isFinite(estimate.usage) ? estimate.usage : null;
    const quotaBytes = Number.isFinite(estimate.quota) ? estimate.quota : null;

    return {
      supported: true,
      usageBytes,
      quotaBytes,
      availableBytes: usageBytes !== null && quotaBytes !== null
        ? Math.max(quotaBytes - usageBytes, 0)
        : null,
    };
  } catch (error) {
    throw normalizeStorageError(error);
  }
}
