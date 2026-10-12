/** Derivatives owned by a page, including the pre-rotation PDF cache name. */
export function reportPagePreviewPaths(reportId: string, pageId: string) {
  return [
    `previews/${reportId}/${pageId}.jpg`,
    ...[0,90,180,270].map(rotation => `previews/${reportId}/${pageId}.r${rotation}.jpg`),
    ...[0,90,180,270].map(rotation => `previews/vision/${reportId}/${pageId}.r${rotation}.jpg`),
  ];
}
