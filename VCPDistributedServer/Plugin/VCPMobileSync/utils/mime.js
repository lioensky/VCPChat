/**
 * MIME type utilities
 */

const MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/x-icon": ".ico",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/x-gzip": ".gz",
  "application/x-rar-compressed": ".rar",
  "application/x-7z-compressed": ".7z",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/x-msvideo": ".avi",
  "video/quicktime": ".mov",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
};

function getExtensionFromType(type) {
  if (!type || typeof type !== "string") {
    return ".bin";
  }

  const normalizedType = type.toLowerCase().trim();

  const ext = MIME_TO_EXT[normalizedType];
  if (ext) return ext;

  const parts = normalizedType.split("/");
  if (parts.length === 2 && parts[1]) {
    const subtype = parts[1].split("+")[0];
    if (subtype && subtype !== "octet-stream") {
      return "." + subtype;
    }
  }

  return ".bin";
}

module.exports = {
  getExtensionFromType,
};
