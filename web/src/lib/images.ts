// Images attached in the assistant: reduced in the browser before sending,
// so that a phone photo or a large screenshot stays light (1568 px at most on
// the long side, the size the AI services read best).

import type { ChatImage } from "@shared/types";

export interface Attached extends ChatImage {
  /** For the preview in the composer. */
  preview: string;
  name: string;
}

const MAX_SIDE = 1568;
export const MAX_IMAGES = 4;

export async function prepareImage(file: File): Promise<Attached> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} n'est pas une image.`);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Screenshots stay sharp in PNG when they are small enough, photos go to JPEG.
  let url = canvas.toDataURL("image/png");
  let mediaType: ChatImage["mediaType"] = "image/png";
  if (file.type !== "image/png" || url.length > 2_500_000) {
    url = canvas.toDataURL("image/jpeg", 0.88);
    mediaType = "image/jpeg";
  }
  return { mediaType, data: url.slice(url.indexOf(",") + 1), preview: url, name: file.name || "image" };
}
