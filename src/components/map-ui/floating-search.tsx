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
        className="absolute right-4 top-4 z-[500] grid h-14 w-14 place-items-center rounded-full border border-slate-200 bg-white text-slate-900 shadow-xl shadow-slate-900/10 transition hover:-translate-y-0.5 hover:shadow-2xl lg:hidden"
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
      className="mobile-search-panel absolute left-4 right-4 top-4 z-[500] grid gap-2 text-slate-900 lg:hidden"
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-2 rounded-[1.75rem] border border-white/[0.68] bg-white/[0.42] p-1 pl-4 shadow-2xl shadow-slate-900/[0.16] backdrop-blur-2xl backdrop-saturate-150">
        <input
          ref={inputRef}
          className="min-w-0 flex-1 bg-transparent px-1 py-2 text-base font-medium text-slate-950 outline-none placeholder:text-slate-500"
          value={props.query}
          placeholder="Chercher une adresse ou un lieu"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <button
          type="submit"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-amber-200/80 bg-amber-300/85 text-slate-950 shadow-sm shadow-amber-900/10 transition [-webkit-tap-highlight-color:transparent] hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 active:bg-amber-300 disabled:cursor-not-allowed disabled:border-white/50 disabled:bg-white/45 disabled:text-slate-400 disabled:shadow-none"
          aria-label={props.isLoading ? "Recherche en cours" : "Lancer la recherche"}
          disabled={props.isLoading || props.query.trim().length === 0}
        >
          <SearchIcon className="h-5 w-5" />
        </button>
      </div>
      {props.error ? (
        <p className="mx-2 rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 shadow-lg shadow-slate-900/[0.08]">
          {props.error}
        </p>
      ) : null}
    </form>
  );
}
