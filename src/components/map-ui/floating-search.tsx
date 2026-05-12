"use client";

import { FormEvent, useEffect, useRef } from "react";

import { SearchIcon } from "./icons";

interface FloatingSearchProps {
  isOpen: boolean;
  query: string;
  isLoading: boolean;
  error: string | null;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
}

export function FloatingSearch(props: FloatingSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (props.isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [props.isOpen]);

  useEffect(() => {
    if (!props.isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-mobile-search-root]")) {
        return;
      }
      props.onClose();
    };

    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () => window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
  }, [props]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onSubmit();
  };

  if (!props.isOpen) {
    return (
      <button
        type="button"
        className="absolute right-4 top-4 z-[500] grid h-14 w-14 place-items-center rounded-full border border-white/70 bg-white/70 text-slate-900 shadow-xl shadow-slate-900/10 backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-white/88 hover:shadow-2xl lg:hidden"
        aria-label="Rechercher un lieu"
        onClick={props.onOpen}
      >
        <SearchIcon className="h-7 w-7" />
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      data-mobile-search-root
      className="mobile-search-panel absolute left-4 right-4 top-4 z-[500] grid gap-2 rounded-[1.75rem] border border-white/65 bg-white/58 p-2 text-slate-900 shadow-2xl shadow-slate-900/16 backdrop-blur-2xl lg:hidden"
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-2 rounded-[1.35rem] border border-white/70 bg-white/42 p-1 shadow-inner shadow-white/30">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-100/85 text-slate-950 ring-1 ring-inset ring-amber-200/80">
          <SearchIcon className="h-5 w-5" />
        </span>
        <input
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent px-1 py-2 text-base font-medium text-slate-950 outline-none placeholder:text-slate-500"
          value={props.query}
          placeholder="Chercher une adresse ou un lieu"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <button
          type="submit"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-950 text-white shadow-sm transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
          aria-label={props.isLoading ? "Recherche en cours" : "Lancer la recherche"}
          disabled={props.isLoading || props.query.trim().length === 0}
        >
          <SearchIcon className="h-5 w-5" />
        </button>
      </div>
      {props.error ? (
        <p className="px-4 pb-1 text-xs font-semibold text-rose-700">{props.error}</p>
      ) : null}
    </form>
  );
}
