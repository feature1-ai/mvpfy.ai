import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { MobilePreview } from '../../lib/mobile';

export default function MobilePreviewCard({ preview }: { preview: MobilePreview | null }) {
  if (!preview) return null;
  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Mobile preview{preview.kind ? ` (${preview.kind})` : ''}
      </h4>
      <div className="flex items-start gap-4">
        {preview.expoUrl && <ExpoQr url={preview.expoUrl} />}
        <div className="text-xs text-slate-600">
          {preview.expoUrl && (
            <p className="mb-1">
              Install <span className="font-medium">Expo Go</span> on your phone and scan the QR
              code (phone must be on the same Wi-Fi).
            </p>
          )}
          {preview.expoUrl && (
            <p className="mb-1 select-all font-mono text-slate-500">{preview.expoUrl}</p>
          )}
          {preview.note && <p>{preview.note}</p>}
        </div>
      </div>
    </div>
  );
}

function ExpoQr({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { width: 132, margin: 1 }).then((d) => {
      if (!cancelled) setDataUrl(d);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!dataUrl) return null;
  return <img src={dataUrl} alt={`QR code for ${url}`} className="h-32 w-32 rounded bg-white" />;
}
