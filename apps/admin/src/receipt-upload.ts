import { type ApiClient, compressImage } from '@ash/client'

/** Compress once, upload raw bytes, and return the immutable non-shift media id. */
export async function uploadExpenseReceipt(api: ApiClient, file: File): Promise<string> {
  const prepared = await compressImage(file)
  const uploaded = await api.uploadReceipt(prepared.bytes, prepared.mimeType, file.lastModified)
  return uploaded.mediaId
}
