const EXTRACTION_METADATA_ESCAPE_PATTERN = /([\\`*_[\]<>])/g;
const EXTRACTION_METADATA_UNESCAPE_PATTERN = /\\([\\`*_[\]<>])/g;

export function escapeExtractionMetadataValue(value: string): string {
  return value.replace(EXTRACTION_METADATA_ESCAPE_PATTERN, "\\$1");
}

export function unescapeExtractionMetadataValue(value: string): string {
  return value.replace(EXTRACTION_METADATA_UNESCAPE_PATTERN, "$1");
}
