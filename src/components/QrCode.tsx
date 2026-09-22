import { useEffect, useRef, useState } from 'react';
import { toCanvas } from 'qrcode';

/**
 * A link, as something a phone can point at.
 *
 * The addresses this shows are the ones nobody can type: a quick tunnel is
 * four random words and a domain, and an Expo URL is worse. Reading one off a
 * laptop screen into a phone is the kind of small friction that stops a thing
 * being tried at all.
 *
 * Drawn to a canvas rather than an img, so there is no data URI to build, no
 * intermediate string the size of the image, and it redraws when the theme
 * changes without refetching anything.
 */
export default function QrCode({
  value,
  size = 132,
  label,
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !value) return;
    let cancelled = false;
    // Always drawn dark-on-white, whatever the app's theme: a scanner needs
    // the contrast the code was designed for, and an inverted code is one
    // many readers refuse outright.
    void toCanvas(canvas, value, {
      width: size,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      // Medium recovers from a thumb over the corner without making the
      // modules so dense that a phone camera struggles at this size.
      errorCorrectionLevel: 'M',
    })
      .then(() => {
        if (!cancelled) setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!value) return null;
  if (failed) {
    // The link itself still works; only the picture of it did not.
    return (
      <span className="text-[11.5px] text-muted">
        Could not draw a code — copy the link instead
      </span>
    );
  }
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <canvas
        ref={ref}
        width={size}
        height={size}
        aria-label={label ?? `QR code for ${value}`}
        role="img"
        className="rounded-md bg-white p-1.5"
        style={{ width: size, height: size }}
      />
      {label && <figcaption className="text-[10.5px] text-muted">{label}</figcaption>}
    </figure>
  );
}
