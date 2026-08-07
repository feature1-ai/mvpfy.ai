import { useState } from 'react';
import type { DemoCredential } from '../../lib/credentials';

interface Props {
  credentials: DemoCredential[];
  onOpenExternal: (url: string) => void;
}

export default function DemoCredentialsCard({ credentials, onOpenExternal }: Props) {
  if (credentials.length === 0) return null;
  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Demo credentials
      </h4>
      <div className="flex flex-col gap-3">
        {credentials.map((cred) => (
          <div key={cred.label}>
            <p className="mb-1 text-xs font-medium text-slate-600">{cred.label}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {cred.fields.map((f) => (
                <CredField
                  key={f.key}
                  fieldKey={f.key}
                  value={f.value}
                  onOpenExternal={onOpenExternal}
                />
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function CredField({
  fieldKey,
  value,
  onOpenExternal,
}: {
  fieldKey: string;
  value: string;
  onOpenExternal: (url: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const isUrl = /^https?:\/\//.test(value);
  return (
    <>
      <dt className="text-xs text-slate-500">{fieldKey}</dt>
      <dd className="flex items-center gap-2 text-xs">
        {isUrl ? (
          <button
            onClick={() => onOpenExternal(value)}
            className="font-mono text-brand hover:underline"
          >
            {value}
          </button>
        ) : (
          <span className="select-all font-mono text-slate-800">{value}</span>
        )}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-100"
          title="Copy to clipboard"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </dd>
    </>
  );
}
