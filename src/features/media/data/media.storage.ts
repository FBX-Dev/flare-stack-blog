import { generateKey } from "@/features/media/utils/media.utils";

/**
 * Media storage adapter.
 *
 * NOTE: This project originally persisted media in Cloudflare R2. R2 requires a
 * payment method on file even for the free tier, so this adapter now stores
 * objects in a dedicated Workers KV namespace (`env.MEDIA`) instead. That keeps
 * the whole blog runnable on the Workers Free plan with no billing setup.
 *
 * The exported function names are kept as-is on purpose: the media tests and the
 * service layer already depend on them, and renaming would only add diff noise.
 *
 * KV constraints to be aware of:
 * - one value is capped at 25 MiB (fine for blog images)
 * - writes are limited to 1,000/day on the free plan
 * - reads are eventually consistent, so a freshly uploaded image may take up
 *   to ~60s to become visible from every edge location
 */

type MediaMeta = {
  contentType?: string;
  originalName?: string;
  size?: number;
  etag?: string;
};

/**
 * The subset of the R2 object shape that `media.service.ts` relies on.
 * Keeping this surface identical means the service layer needs no rework.
 */
export type MediaObject = {
  body: ReadableStream | null;
  httpMetadata?: { contentType?: string };
  httpEtag: string;
  writeHttpMetadata: (headers: Headers) => void;
};

/**
 * Keys are UUID-based and therefore immutable, so a stable etag can be derived
 * from the key plus the payload length without hashing the bytes.
 */
function buildEtag(key: string, size: number): string {
  return `"kv-${key}-${size}"`;
}

async function putObject(
  env: Env,
  key: string,
  bytes: ArrayBuffer,
  meta: MediaMeta,
) {
  const size = bytes.byteLength;
  await env.MEDIA.put(key, bytes, {
    metadata: {
      ...meta,
      size,
      etag: buildEtag(key, size),
    } satisfies MediaMeta,
  });
}

export async function putToR2(
  env: Env,
  image: File,
  key = generateKey(image.name),
) {
  const contentType = image.type;
  const url = `/images/${key}`;
  const bytes = await image.arrayBuffer();

  await putObject(env, key, bytes, {
    contentType,
    originalName: image.name,
  });

  return {
    key,
    url,
    fileName: image.name,
    mimeType: contentType,
    sizeInBytes: image.size,
  };
}

export async function deleteFromR2(env: Env, key: string) {
  await env.MEDIA.delete(key);
}

export async function getFromR2(
  env: Env,
  key: string,
): Promise<MediaObject | null> {
  const { value, metadata } = await env.MEDIA.getWithMetadata<MediaMeta>(
    key,
    "arrayBuffer",
  );

  if (value === null) {
    return null;
  }

  const meta = metadata ?? {};
  const contentType = meta.contentType;

  return {
    body: new Response(value).body,
    httpMetadata: contentType ? { contentType } : undefined,
    httpEtag: meta.etag ?? buildEtag(key, value.byteLength),
    writeHttpMetadata(headers: Headers) {
      if (contentType) {
        headers.set("Content-Type", contentType);
      }
    },
  };
}

/**
 * Upload a site asset (favicon, theme images) with a fixed key.
 * No DB record; overwrites in place on re-upload.
 */
export async function putSiteAsset(
  env: Env,
  file: File,
  assetPath: string,
): Promise<{ key: string; url: string }> {
  const key = `asset/${assetPath}`;
  const bytes = await file.arrayBuffer();

  await putObject(env, key, bytes, { contentType: file.type });

  return { key, url: `/images/${key}` };
}
