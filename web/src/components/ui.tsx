import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";

type Tone = "up" | "down" | "warn" | "info";
interface Toast {
  id: number;
  text: ReactNode;
  tone: Tone;
}

const ToastCtx = createContext<(text: ReactNode, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

let nextToast = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: ReactNode, tone: Tone = "info") => {
    const id = nextToast++;
    setToasts((t) => [...t.slice(-4), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "down" ? 7000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function Stat({
  label,
  children,
  title,
}: {
  label: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="stat" title={title}>
      <span className="label">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  liquidation: "warn",
  bankrupt: "down",
  haircut: "down",
  adl: "warn",
  settlement: "info",
  graduation: "up",
  gap: "info",
  listing: "",
  open: "up",
  ipo: "info",
};

export function KindBadge({ kind }: { kind: string }) {
  const label =
    kind === "adl" ? "ADL close" : kind === "open" ? "coin open" : kind === "ipo" ? "IPO" : kind;
  return <span className={`badge ${KIND_TONE[kind] ?? ""}`}>{label}</span>;
}
