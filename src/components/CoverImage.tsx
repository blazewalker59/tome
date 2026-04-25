import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";

/**
 * Renders a book cover with two failure modes collapsed into one:
 *
 * 1. `src` is null — book has no cover URL on file.
 * 2. `src` is set but the request fails — Hardcover's CDN 404s, the
 *    URL has gone stale, the image is hotlink-blocked beyond what
 *    `referrer-policy: no-referrer` can fix, etc.
 *
 * In either case we render `fallback` instead of a broken-image icon.
 * Callers that already have a styled bg on the wrapping container
 * (e.g. Card's `bg-[var(--sand)]` or PackContentsSheet's
 * `bg-[var(--track-bg)]`) can omit `fallback` and let the parent's
 * own background show through.
 *
 * The `referrer-policy: no-referrer` default is load-bearing — without
 * it, Hardcover's CDN returns 403 because of hotlink protection.
 * Every cover render in the app needs this; folding it into the
 * component is what stops us from re-discovering that bug each time
 * we add a new <img>.
 *
 * `src` changes reset the `failed` flag so the same component can be
 * reused across list re-renders (e.g. the Hardcover search panel
 * swapping out hits) without sticking on a previous error.
 */
export type CoverImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | null | undefined;
  fallback?: ReactNode;
};

export function CoverImage({ src, fallback = null, alt = "", ...rest }: CoverImageProps) {
  const [failed, setFailed] = useState(false);

  // Reset on src change. Without this, a list row that was reused for
  // a different book would stay in the failed state and never try
  // loading the new src.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return <>{fallback}</>;
  }

  return (
    <img
      {...rest}
      src={src}
      alt={alt}
      // Hardcover serves cover images with hotlink protection that
      // 403s when a Referer header is sent. Stripping the referrer
      // is what lets covers actually load in production.
      referrerPolicy={rest.referrerPolicy ?? "no-referrer"}
      onError={(e) => {
        setFailed(true);
        rest.onError?.(e);
      }}
    />
  );
}
