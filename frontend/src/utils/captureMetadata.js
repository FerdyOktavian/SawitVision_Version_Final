export const GEOLOCATION_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 60000,
});

export const GEOLOCATION_STATUSES = Object.freeze({
  AVAILABLE: "available",
  DENIED: "denied",
  TIMEOUT: "timeout",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
});

const TRANSIENT_GEOLOCATION_ERROR_CODES = new Set([2, 3]);
const ALLOWED_INPUT_SOURCES = new Set(["camera", "gallery"]);

export function createCaptureMetadata(inputSource) {
  if (!ALLOWED_INPUT_SOURCES.has(inputSource)) {
    throw new TypeError("Sumber foto harus camera atau gallery.");
  }

  return {
    source: inputSource,
    capturedAt: new Date().toISOString(),
  };
}

export function createEmptyCaptureMetadata(inputSource = "camera") {
  if (!ALLOWED_INPUT_SOURCES.has(inputSource)) {
    throw new TypeError("Sumber foto harus camera atau gallery.");
  }

  return {
    source: inputSource,
    capturedAt: null,
  };
}

function normalizeGeolocationError(error) {
  const errorCode = Number.isInteger(error?.code) ? error.code : null;
  let status = GEOLOCATION_STATUSES.UNAVAILABLE;

  if (errorCode === 1) {
    status = GEOLOCATION_STATUSES.DENIED;
  } else if (errorCode === 3) {
    status = GEOLOCATION_STATUSES.TIMEOUT;
  }

  return {
    ok: false,
    status,
    errorCode,
    location: null,
  };
}

export async function captureOptionalLocation() {
  const geolocation = globalThis.navigator?.geolocation;

  if (!geolocation?.getCurrentPosition) {
    return {
      ok: false,
      status: GEOLOCATION_STATUSES.UNSUPPORTED,
      errorCode: null,
      location: null,
    };
  }

  const requestPosition = () =>
    new Promise((resolve) => {
      geolocation.getCurrentPosition(
        (position) => resolve({ position, error: null }),
        (error) => resolve({ position: null, error }),
        GEOLOCATION_OPTIONS,
      );
    });

  try {
    let result = await requestPosition();

    if (
      !result.position &&
      TRANSIENT_GEOLOCATION_ERROR_CODES.has(result.error?.code)
    ) {
      result = await requestPosition();
    }

    if (!result.position) {
      return normalizeGeolocationError(result.error);
    }

    return {
      ok: true,
      status: GEOLOCATION_STATUSES.AVAILABLE,
      errorCode: null,
      location: {
        latitude: result.position.coords.latitude,
        longitude: result.position.coords.longitude,
        accuracy: result.position.coords.accuracy,
        capturedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: GEOLOCATION_STATUSES.UNAVAILABLE,
      errorCode: Number.isInteger(error?.code) ? error.code : null,
      location: null,
    };
  }
}
