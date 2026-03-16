export default function Toast({ title, message, onClose }) {
  if (!title && !message) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div className="pointer-events-auto w-[420px] max-w-[92vw] rounded-xl border border-white/10 bg-[#2b2d31] p-6 shadow-float">
        <h3 className="text-xl font-semibold text-[#f2f3f5]">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-[#c4c9ce]">{message}</p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[#5865f2] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4752c4]"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
