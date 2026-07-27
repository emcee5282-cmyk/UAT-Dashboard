'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, FilePlus2, Upload, Download } from 'lucide-react';
import { downloadTemplate, type TemplateModule } from '../lib/templates';

// Generic "+ Add" toolbar dropdown — New Record / Bulk Import / Download
// Template. Deliberately not hardcoded to Settlement: templateModule keys
// into the shared TEMPLATE_PATHS registry (app/lib/templates.ts), and
// onNewRecord/onBulkImport are plain callbacks, so the same component
// serves any future module (Users, Agents, Wallets, ...) by just passing a
// different templateModule + a different pair of handlers.
type AddRecordDropdownProps = {
  templateModule: TemplateModule;
  onNewRecord: () => void;
  onBulkImport: () => void;
  buttonClassName: string;
  newRecordLabel?: string;
};

export default function AddRecordDropdown({
  templateModule,
  onNewRecord,
  onBulkImport,
  buttonClassName,
  newRecordLabel = 'New Record',
}: AddRecordDropdownProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        ref={btnRef}
        onClick={(event) => {
          event.stopPropagation();
          const rect = btnRef.current?.getBoundingClientRect();
          if (rect) setPos({ top: rect.bottom + 6, left: rect.right - 176 });
          setOpen((current) => !current);
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Add"
        title="Add"
        className={`inline-flex h-9 items-center gap-1.5 rounded-[8px] px-3 text-[13px] font-semibold text-white transition-colors duration-150 ease-out ${buttonClassName}`}
      >
        <Plus size={15} />
        Add
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className="z-[9999] w-44 rounded-xl border border-[#e5e5e7] bg-white p-1 shadow-xl dark:border-[#3a3a3d] dark:bg-[#2a2a2d]"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { setOpen(false); onNewRecord(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <FilePlus2 size={13} />
            {newRecordLabel}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); onBulkImport(); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <Upload size={13} />
            Bulk Import
          </button>
          <div className="my-1 border-t border-[#F1F5F9] dark:border-[#2f2f32]" />
          <button
            type="button"
            onClick={() => { setOpen(false); downloadTemplate(templateModule); }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-normal text-[#475569] transition-colors hover:bg-[#F1F5F9] dark:text-[#9CA3AF] dark:hover:bg-white/5"
          >
            <Download size={13} />
            Download Template
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
