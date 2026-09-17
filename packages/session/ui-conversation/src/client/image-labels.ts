import type { ImageAttachmentLimits } from "@deepseek-ai/dsh-attachment";
import type { Translate } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConversationKey } from "./locales.ts";

export function imageSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`;
}

export function attachmentErrorText(
  t: Translate<ConversationKey>,
  reason: string,
  limits?: ImageAttachmentLimits,
): string {
  switch (reason) {
    case "MODEL_DOES_NOT_SUPPORT_IMAGES":
      return t("image.modelUnsupported");

    case "FILE_NOT_STAGED":
      return t("file.notStaged");
    case "IMAGE_TOO_MANY_PIXELS":
      return t("image.tooManyPixels");
    case "IMAGE_DIMENSION_TOO_LARGE":
      if (limits !== undefined)
        return t("image.dimensionTooLarge", { size: limits.maxImageDimension });
      break;

    case "INVALID_IMAGE":
    case "IMAGE_TYPE_MISMATCH":
      return t("image.unsupportedType");
    case "TOO_MANY_IMAGES":
      if (limits !== undefined) return t("image.tooMany", { count: limits.maxImagesPerMessage });
      break;
    case "IMAGE_TOO_LARGE":
      if (limits !== undefined)
        return t("image.fileTooLarge", { size: imageSizeText(limits.maxImageBytes) });
      break;
    case "IMAGES_TOO_LARGE":
      if (limits !== undefined)
        return t("image.totalTooLarge", { size: imageSizeText(limits.maxMessageImageBytes) });
      break;
    default:
      break;
  }
  return t("image.sendFailed", { reason });
}
