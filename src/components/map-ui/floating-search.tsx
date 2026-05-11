"use client";

import { FormEvent, useEffect, useRef } from "react";

import { CloseIcon, SearchIcon } from "./icons";

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

  useEffect(() => {
    if (props.isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [props.isOpen]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.onSubmit();
  };

  if (!props.isOpen) {
    return (
      <button
        type="button"
        className="absolute right-4 top-4 z-[500] grid h-12 w-12 place-items-center rounded-full border border-white/70 bg-white/80 text-slate-900 shadow-xl backdrop-blur transition hover:bg-white/95 lg:hidden"
        aria-label="Rechercher un lieu"
        onClick={props.onOpen}
      >
        <SearchIcon />
      </button>
    );
  }

  return (
    <form
      className="mobile-search-panel absolute left-4 right-4 top-4 z-[500] grid gap-2 rounded-full border border-white/70 bg-white/82 p-2 text-slate-900 shadow-2xl backdrop-blur lg:hidden"
      onSubmit={handleSubmit}
    >
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          className="min-w-0 flex-1 rounded-full border border-transparent bg-white/70 px-4 py-2 text-base text-slate-950 outline-none placeholder:text-slate-500 focus:border-amber-300"
          value={props.query}
          placeholder="Chercher une adresse ou un lieu"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <button
          type="submit"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-950 text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
          aria-label={props.isLoading ? "Recherche en cours" : "Lancer la recherche"}
          disabled={props.isLoading || props.query.trim().length === 0}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-500 transition hover:bg-white/70 hover:text-slate-900"
          aria-label="Fermer la recherche"
          onClick={props.onClose}
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </div>
      {props.error ? <p className="px-4 text-xs font-medium text-rose-600">{props.error}</p> : null}
    </form>
  );
}
